// ============================================================
// GPU WARM-UP — show a new model without a frame freeze
// ============================================================
//
// The first frame that draws a newly loaded model compiles its shaders, uploads its textures and lets the
// graphics driver finish each shader, all at once on the main thread. Measured on an RTX 5070 Ti
// (2026-11-10): the chooser froze 146 ms for a bike and 397 ms for its two outfit geese, a visible hitch on
// any machine. warmUp does that work before the model is shown, a slice per frame:
//   1. textures, a couple per frame (initTexture)
//   2. shaders, compiled in the background (compileAsync with KHR_parallel_shader_compile)
//   3. one first draw per mesh, one mesh per frame (with a WarmQueue): the driver finishes a shader only
//      when it is first drawn (the ~115 ms left after 1 and 2 were all in that first draw). The caller's
//      own loop runs queue.step() just before its normal render, which then paints over the warm draw.
// Hidden objects are fine: the warm draw shows each mesh on a render layer of its own for that one call.

import * as THREE from 'three';

const WARM_LAYER = 31;

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
 * First draws, one per frame, run by the loop that owns the renderer: call step() right before that loop's
 * own render (so the render paints over it). Jobs wait in order; each resolves its promise when drawn.
 */
export class WarmQueue {
  constructor() { this._jobs = []; }
  get size() { return this._jobs.length; }
  /** @param {() => void} draw @returns {Promise<void>} */
  add(draw) { return new Promise((resolve) => this._jobs.push({ draw, resolve })); }
  /** Run the next first draw (call right before the loop's own render). */
  step() {
    const job = this._jobs.shift();
    if (!job) return;
    try { job.draw(); } catch (e) { /* drawn for real later, as before */ }
    job.resolve();
  }
  /** Let every waiting job go (its loop has stopped). */
  flush() { for (const j of this._jobs.splice(0)) j.resolve(); }
}

/** Is root under scene (or the scene itself)? */
function inScene(root, scene) {
  for (let o = root; o; o = o.parent) if (o === scene) return true;
  return false;
}

/** One mesh drawn on its own, in the scene's light (so its shader is the one the real draw uses). */
function drawAlone(renderer, mesh, root, camera, scene) {
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
  const cam = camera.clone();
  cam.layers.set(WARM_LAYER);
  const shadows = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;   // (the shadow map is the real render's)
  try {
    root.updateMatrixWorld(true);
    renderer.render(scene, cam);
  } finally {
    renderer.shadowMap.autoUpdate = shadows;
    mesh.frustumCulled = culled;
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
 * @param {{perFrame?: number, queue?: WarmQueue}} [opts]
 */
export async function warmUp(renderer, object, camera, scene, { perFrame = 2, queue = null } = {}) {
  if (!renderer || !object) return;
  const list = texturesOf(object);
  for (let i = 0; i < list.length; i += perFrame) {
    for (const t of list.slice(i, i + perFrame)) { try { renderer.initTexture(t); } catch (e) { /* drawn later as before */ } }
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
  for (const m of meshes) await queue.add(() => drawAlone(renderer, m, object, camera, scene));
}
