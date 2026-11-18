// ============================================================
// GPU WARM-UP — show a new model without a frame freeze
// ============================================================
//
// The first frame that draws a newly loaded model compiles its shaders, uploads its textures and lets the
// graphics driver finish each shader, all at once on the main thread. Measured on an RTX 5070 Ti
// (2026-11-10): the chooser froze 146 ms for a bike and 397 ms for its two outfit geese, a visible hitch on
// any machine. warmUp does that work before the model is shown, a slice per frame:
//   1. textures (initTexture), as many as fit in a few milliseconds of each frame
//   2. shaders, compiled in the background (compileAsync with KHR_parallel_shader_compile)
//   3. a first draw per mesh (with a WarmQueue): the driver finishes a shader only when it is first
//      drawn (the ~115 ms left after 1 and 2 were all in that first draw). The caller's own loop runs
//      queue.step() just before its normal render, which then paints over the warm draws.
// Steps 1 and 3 work to a time budget per frame (FRAME_BUDGET_MS), not a count. One texture or one mesh
// a frame kept every frame short but made a bike take 80 frames to show and its geese 140 more
// (2026-11-17): most meshes share a shader that is already finished, and their first draw costs almost
// nothing. A slow one still gets a frame to itself, because the budget is checked after each.
// Hidden objects are fine: the warm draw shows each mesh on a render layer of its own for that one call.

import * as THREE from 'three';

const WARM_LAYER = 31;
/** Warm-up work per frame, in ms: more is started only while less than this has been spent. */
export const FRAME_BUDGET_MS = 5;
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const nextFrame = () => new Promise((r) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r());
  else setTimeout(r, 16);
});

/** Every texture the object's materials use. */
export function texturesOf(object) {
  const out = new Set();
  object.traverse((o) => {
    if (!o.material) return;
    for (const m of [].concat(o.material)) {
      for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) out.add(v); }
    }
  });
  return [...out];
}

/**
 * First draws, run by the loop that owns the renderer: call step() right before that loop's own render
 * (so the render paints over them). Jobs wait in order; each resolves its promise when drawn.
 */
export class WarmQueue {
  constructor() { this._jobs = []; }
  get size() { return this._jobs.length; }
  /** @param {() => void} draw @returns {Promise<void>} */
  add(draw) { return new Promise((resolve) => this._jobs.push({ draw, resolve })); }
  /**
   * Run first draws until budgetMs of this frame is spent: always one, then more only while there is
   * budget left (call right before the loop's own render). → how many ran
   */
  step(budgetMs = FRAME_BUDGET_MS) {
    const t0 = clock();
    let ran = 0;
    while (this._jobs.length) {
      const job = this._jobs.shift();
      try { job.draw(); } catch (e) { /* drawn for real later, as before */ }
      job.resolve();
      ran++;
      if (clock() - t0 >= budgetMs) break;
    }
    return ran;
  }
  /** Let every waiting job go (its loop has stopped). */
  flush() { for (const j of this._jobs.splice(0)) j.resolve(); }
}

/** Is root under scene (or the scene itself)? */
function inScene(root, scene) {
  for (let o = root; o; o = o.parent) if (o === scene) return true;
  return false;
}

const _targets = new WeakMap();
/**
 * A small off-screen target that asks three for the SAME shaders as the screen does. three picks a
 * material's output colour space and tone mapping by where it is drawing: the screen's for the canvas,
 * plain linear for a render target, except one flagged as an XR target, which takes its texture's colour
 * space and the renderer's tone mapping (three 0.161 WebGLPrograms.getParameters / WebGLRenderer.setProgram).
 * So this target is flagged that way and given the screen's colour space. First draws made into it warm the
 * very programs the screen will use, and leave the picture on screen alone.
 */
function offscreenTarget(renderer) {
  let rt = _targets.get(renderer);
  if (!rt) {
    rt = new THREE.WebGLRenderTarget(64, 64, { depthBuffer: true });
    rt.isXRRenderTarget = true;
    _targets.set(renderer, rt);
  }
  rt.texture.colorSpace = renderer.outputColorSpace;
  return rt;
}

/** One mesh drawn on its own, in the scene's light (so its shader is the one the real draw uses). */
function drawAlone(renderer, mesh, root, camera, scene, offscreen = false) {
  const added = !inScene(root, scene);
  if (added && root.parent) return;   // (somewhere else: never taken from its parent)
  if (added) scene.add(root);
  const hidden = [];
  for (let o = mesh; o; o = o.parent) if (!o.visible) { hidden.push(o); o.visible = true; }
  const lights = [];
  scene.traverse((o) => { if (o.isLight && !o.layers.isEnabled(WARM_LAYER)) { lights.push(o); o.layers.enable(WARM_LAYER); } });
  const hadLayer = mesh.layers.isEnabled(WARM_LAYER), culled = mesh.frustumCulled;
  mesh.layers.enable(WARM_LAYER);
  mesh.frustumCulled = false;
  // an instanced mesh with nothing in it yet (a pile that fills later) is not drawn at all: one instance, for this draw
  const empty = mesh.isInstancedMesh && mesh.count === 0;
  if (empty) mesh.count = 1;
  const cam = camera.clone();
  cam.layers.set(WARM_LAYER);
  const shadows = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;   // (the shadow map is the real render's)
  const target = offscreen ? renderer.getRenderTarget() : null;
  try {
    root.updateMatrixWorld(true);
    if (offscreen) renderer.setRenderTarget(offscreenTarget(renderer));
    renderer.render(scene, cam);
  } finally {
    if (offscreen) renderer.setRenderTarget(target);
    renderer.shadowMap.autoUpdate = shadows;
    mesh.frustumCulled = culled;
    if (empty) mesh.count = 0;
    if (!hadLayer) mesh.layers.disable(WARM_LAYER);
    for (const l of lights) l.layers.disable(WARM_LAYER);
    for (const o of hidden) o.visible = false;
    if (added) scene.remove(root);
  }
}

/**
 * Upload the object's textures, compile its shaders and (with a queue) give each mesh its first draw,
 * before the object is shown.
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Object3D} object the new model (in the scene hidden, or not added yet)
 * @param {THREE.Camera} camera
 * @param {THREE.Scene} scene the scene it will be drawn in (its lights pick the shaders)
 * @param {{budgetMs?: number, queue?: WarmQueue, offscreen?: boolean}} [opts] offscreen: the first draws go to
 *   an off-screen target (for a loop that is not going to paint over them)
 */
export async function warmUp(renderer, object, camera, scene, { budgetMs = FRAME_BUDGET_MS, queue = null, offscreen = false } = {}) {
  if (!renderer || !object) return;
  const list = texturesOf(object);
  for (let i = 0; i < list.length;) {
    const t0 = clock();
    do {
      try { renderer.initTexture(list[i]); } catch (e) { /* drawn later as before */ }
      i++;
    } while (i < list.length && clock() - t0 < budgetMs);
    await nextFrame();
  }
  try {
    if (renderer.compileAsync) await renderer.compileAsync(object, camera, scene);
    else renderer.compile(object, camera, scene);
  } catch (e) { /* compiled on its first draw, as before */ }
  if (!queue) return;
  const meshes = [];
  const seen = new Set();
  object.traverse((o) => {
    if (!o.isMesh) return;
    const key = [].concat(o.material).map((m) => m.uuid).join() + (o.isSkinnedMesh ? ':s' : '');
    if (seen.has(key)) return;
    seen.add(key);
    meshes.push(o);
  });
  // all queued at once, so a frame can take several (queued one by one, each waited a frame for the last)
  await Promise.all(meshes.map((m) => queue.add(() => drawAlone(renderer, m, object, camera, scene, offscreen))));
}

/**
 * A geometry's vertex layout, as the driver sees it: which attributes, their sizes and number types. On
 * Windows the driver (ANGLE on Direct3D) builds a vertex shader variant per layout at the first draw, so
 * two meshes on one shader program still each stall their first frame if their layouts differ (measured:
 * the stack of presents at Grandma's, 80 to 110 ms, its program already warm from another mesh).
 */
function layoutOf(o) {
  const g = o.geometry;
  if (!g || !g.attributes) return '';
  const parts = Object.keys(g.attributes).sort().map((k) => {
    const a = g.attributes[k];
    return k + ':' + a.itemSize + (a.array ? a.array.constructor.name : '') + (a.normalized ? 'n' : '') + (a.isInstancedBufferAttribute ? 'i' : '') + (a.isInterleavedBufferAttribute ? 'x' : '');
  });
  return parts.join(',') + (g.index ? '#' + g.index.array.constructor.name : '') + (o.isInstancedMesh ? '@inst' : '') + (o.isSkinnedMesh ? '@skin' : '') + (o.isPoints ? '@pts' : o.isLine ? '@line' : '');
}

/** Does three hold a shader program for this material yet? */
function hasProgram(renderer, material) {
  try { return !!renderer.properties.get(material).currentProgram; } catch (e) { return true; }
}

/** Everything under root that three draws with a material, and that has a material with no program yet. */
export function undrawn(renderer, root) {
  const out = [];
  root.traverse((o) => {
    if (!o.material || !(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return;
    if ([].concat(o.material).some((m) => m && !hasProgram(renderer, m))) out.push(o);
  });
  return out;
}

/**
 * Warm whatever in a live scene has not been drawn yet: things just built for a ride (its bike, pickups,
 * props), or built since the last call and still out of view. Their textures, then their shaders compiled
 * a few per frame (building a shader's source is main-thread work too), then, once the driver reports them
 * linked, one first draw per shader program, off-screen. Nothing already drawn is touched, so calling this
 * again and again costs a walk of the scene. → how many first draws were made
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {{budgetMs?: number, queue: WarmQueue, waitFrames?: number}} opts
 */
export async function warmScene(renderer, scene, camera, { budgetMs = FRAME_BUDGET_MS, queue, waitFrames = 90 } = /** @type {any} */ ({})) {
  if (!renderer || !scene || !queue) return 0;
  const fresh = undrawn(renderer, scene);
  if (!fresh.length) return 0;
  const textures = new Set();
  for (const o of fresh) for (const m of [].concat(o.material)) for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) textures.add(v); }
  const list = [...textures];
  for (let i = 0; i < list.length;) {
    const t0 = clock();
    do { try { renderer.initTexture(list[i]); } catch (e) { /* uploaded when drawn, as before */ } i++; } while (i < list.length && clock() - t0 < budgetMs);
    await nextFrame();
  }
  for (let i = 0; i < fresh.length;) {
    const t0 = clock();
    do {
      // (a hidden thing compiles too: three's compile walks every object, shown or not)
      try { if (fresh[i].parent) renderer.compile(fresh[i], camera, scene); } catch (e) { /* compiled when drawn, as before */ }
      i++;
    } while (i < fresh.length && clock() - t0 < budgetMs);
    await nextFrame();
  }
  const programOf = (m) => { try { return renderer.properties.get(m).currentProgram || null; } catch (e) { return null; } };
  // the driver links them in the background (KHR_parallel_shader_compile); without it, isReady() is true at once
  for (let f = 0; f < waitFrames; f++) {
    const waiting = fresh.some((o) => [].concat(o.material).some((m) => { const p = programOf(m); return p && p.isReady && !p.isReady(); }));
    if (!waiting) break;
    await nextFrame();
  }
  const seen = new Set();
  const jobs = [];
  for (const o of fresh) {
    if (!o.parent) continue;   // (gone while we waited)
    const key = [].concat(o.material).map((m) => { const p = programOf(m); return p ? 'p' + p.id : m.uuid; }).join() + '|' + layoutOf(o);
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push(queue.add(() => drawAlone(renderer, o, scene, camera, scene, true)));
  }
  await Promise.all(jobs);
  return jobs.length;
}
