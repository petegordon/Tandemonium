// ============================================================
// BIKE SHOWCASE — the "New bike!" cards' pictures (#736)
// ============================================================
//
// Pete, 2026-11-09: the celebration shows the bike itself, turning, with its name (icon first) below,
// and the player's outfit geese with it:
//   one or two new bikes  the geese walk in beside the turning bike, turn to face you, and greet you:
//                         wave, bow, hat tip (a lady curtsies), celebrate, admire, twirl. Each goose's
//                         moves are shuffled every time the screen shows, so no two showings match.
//                         (the Goose Studio's actor and clips: js/goose-studio/goose-actor.js)
//   three or more         the geese ride each bike, pedalling (js/goose-riders.js, as the Dressing Room does)
// The geese wear the player's own look (config.js getSeatLooks: Player 1's outfit, colourway and body;
// the stoker in the same outfit).
//
// One WebGL renderer draws every card in turn and copies each frame into that card's own 2D canvas,
// so a screen of five bikes still costs one GL context. GLBs are fetched once per page and cloned.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { dracoDecoderPath } from './draco-path.js';
import { GOOSE_BIKE_MODEL_PATH, getSeatLooks } from './config.js';
import { SPECIAL_BIKES } from './special-bikes.js';
import { resolveRider } from './goose-outfits.js';
import { colourwayParamsForBody, applyColourway } from './goose-colourways.js';
import { GooseRiders } from './goose-riders.js';
import { GooseActor, GEESE } from './goose-studio/goose-actor.js';
import { applyMirrorEnv } from './mirror-env.js';

const GOOSE_DIR = 'tandem-3d/goose/';
const FRAME_MS = 1000 / 30;
const TURN_RATE = 0.6;      // rad/s, the bike's turntable
const CRANK_RATE = 2.2;     // rad/s, the riders' pedalling
const THREE_QUARTER = 0.8;  // rad the standing scene's bike settles at, off side-on
const ROLL_DELAY = 0.3;     // s after the goose on its side stops walking (plus up to 0.8 s at random) that the bike rolls in
const ROLL_FALLBACK = 3.5;  // s: it rolls in by then anyway (geese still loading walk out after it)
const ROLL_TIME = 2.6;      // s it takes to roll in and stop
const ROLL_FROM = 7;        // m out of shot it starts
const GOOSE_Z = 0.6;        // m the standing geese stand in front of the bike's line (it rolls behind them)
const GOOSE_ANGLE = 0.45;   // rad each standing goose turns in toward the bike
/** The greetings each goose picks from (a gander tips his hat, a lady curtsies). */
const MOVES = { m: ['wave', 'bow', 'hat_tip', 'celebrate', 'admire', 'twirl'], f: ['wave', 'bow', 'curtsy', 'celebrate', 'admire', 'twirl'] };

const PATH_STEP = 0.05, PATH_MAX = 40, PATH_CURVE = 1.7;   // m: the roll-in path's samples, length, and its curve (Pete: in straight from the side, close to you)

/**
 * The roll-in path, traced back from the stop: heading hEnd at the stop (a three-quarter view), turning
 * over the last PATH_CURVE metres from hSide (straight across the screen). [i] = PATH_STEP * i metres
 * before the stop: {x, z, h}. Headings as the geese use them (0 = toward the camera, x = sin h, z = cos h).
 */
export function rollPath(hEnd, hSide) {
  const pts = [{ x: 0, z: 0, h: hEnd }];
  let x = 0, z = 0;
  for (let b = PATH_STEP; b <= PATH_MAX + 1e-9; b += PATH_STEP) {
    const u = Math.min(1, b / PATH_CURVE), s = u * u * (3 - 2 * u);
    const h = hEnd + (hSide - hEnd) * s;
    x -= Math.sin(h) * PATH_STEP; z -= Math.cos(h) * PATH_STEP;
    pts.push({ x, z, h });
  }
  return pts;
}

/** The path's point a distance back metres before the stop. */
export function pathAt(pts, back) {
  const i = Math.max(0, Math.min(pts.length - 1, Math.round(back / PATH_STEP)));
  return pts[i];
}

/** Standing geese for one or two new bikes; riders for three or more. */
export function showcaseMode(count) { return count <= 2 ? 'standing' : 'riding'; }

/** A shuffled copy (Fisher-Yates). */
export function shuffled(list, random = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * Each goose's greetings for this showing: shuffled, and the two geese never open with the same move.
 * @param {('m'|'f')[]} bodies @returns {string[][]}
 */
export function greetingOrder(bodies, random = Math.random) {
  const out = [];
  for (const b of bodies) {
    let order = shuffled(MOVES[b === 'f' ? 'f' : 'm'], random);
    if (out.length && order[0] === out[0][0]) order = [...order.slice(1), order[0]];
    out.push(order);
  }
  return out;
}

/** The Goose Studio goose for a look (its outfit, in this body). */
export function studioGooseFor(look) {
  const body = look && look.body === 'f' ? 'f' : 'm';
  const all = Object.entries(GEESE);
  const hit = all.find(([, g]) => g.pair === look.outfit && g.sex === body) || all.find(([, g]) => g.pair === look.outfit) || all[0];
  return hit[0];
}

/** A paint preset (tandem-3d/bike-presets*.json) on a bike's own materials. */
export function applyPresetMaterials(model, preset) {
  if (!preset) return;
  model.traverse((child) => {
    if (!child.isMesh) return;
    const entry = preset[child.name];
    if (!entry) return;
    const mat = child.material;
    if (entry.color && mat.color) mat.color.set(entry.color);
    if (entry.emissive && mat.emissive) mat.emissive.set(entry.emissive);
    if (entry.metalness !== undefined) mat.metalness = entry.metalness;
    if (entry.roughness !== undefined) mat.roughness = entry.roughness;
    if (entry.opacity !== undefined) { mat.opacity = entry.opacity; mat.transparent = entry.opacity < 1; }
    if (entry.wireframe !== undefined) mat.wireframe = entry.wireframe;
    if (entry.side !== undefined) mat.side = entry.side;
    if (entry.disabledTextures) for (const tk of entry.disabledTextures) mat[tk] = null;
    mat.needsUpdate = true;
  });
}

let _loader = null;
const _cache = new Map();   // path -> Promise<gltf>
/** A loader that fetches each GLB once and hands out skinned clones (GooseRiders / GooseActor take it as theirs). */
const cachedLoader = {
  loadAsync(path) {
    if (!_loader) {
      const draco = new DRACOLoader();
      draco.setDecoderPath(dracoDecoderPath('libs/draco/'));
      _loader = new GLTFLoader();
      _loader.setDRACOLoader(draco);
    }
    if (!_cache.has(path)) _cache.set(path, _loader.loadAsync(path).catch((e) => { _cache.delete(path); throw e; }));
    return _cache.get(path).then((g) => ({ ...g, scene: cloneSkinned(g.scene), animations: g.animations }));
  },
};

/** A promise that gives up after ms. */
function within(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
}

/**
 * A Goose Studio goose, from the shared cache; a load that hangs (seen once in the smoke, two big GLBs
 * at once) is tried again with a loader of its own instead of leaving the card without that goose.
 */
async function loadActor(name, random) {
  try { return await within(GooseActor.load(cachedLoader, name, { dir: GOOSE_DIR, random }), 12000); }
  catch (err) {
    console.warn('New bike goose slow to load, trying again:', name, err && err.message);
    const draco = new DRACOLoader();
    draco.setDecoderPath(dracoDecoderPath('libs/draco/'));
    const fresh = new GLTFLoader();
    fresh.setDRACOLoader(draco);
    return within(GooseActor.load(fresh, name, { dir: GOOSE_DIR, random }), 20000);
  }
}

export class BikeShowcase {
  /** @param {Record<string, object>} presetData the chooser's paint presets, by bike key */
  constructor(presetData = {}) {
    this._presets = presetData || {};
    this._entries = [];
    this._raf = 0;
    this._renderer = null;
    this._gen = 0;
    this._last = 0;
    this.mode = null;
  }

  _getRenderer() {
    if (!this._renderer) {
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      r.setPixelRatio(1);
      r.setClearColor(0x000000, 0);
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = 1.1;
      this._renderer = r;
    }
    return this._renderer;
  }

  _scene() {
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a3a48, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(1.5, 3, 2.5); scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbcd4ff, 0.7); fill.position.set(-2, 1.5, -1.5); scene.add(fill);
    return scene;
  }

  async _bike(key) {
    const sp = SPECIAL_BIKES[key];
    const gltf = await cachedLoader.loadAsync(sp ? sp.model : GOOSE_BIKE_MODEL_PATH);
    const model = gltf.scene;
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      if (o.isSkinnedMesh) o.frustumCulled = false;
    });
    if (!sp && key !== 'default') applyPresetMaterials(model, this._presets[key]);
    if (sp && sp.mirror) applyMirrorEnv(model);
    return { model, animations: gltf.animations };
  }

  /**
   * Show each bike in its canvas, with the player's geese.
   * @param {{key: string, canvas: HTMLCanvasElement}[]} items
   * @param {{looks?: {Captain: object, Stoker: object}, random?: () => number}} [opts]
   */
  show(items, opts = {}) {
    this.stop();
    const gen = this._gen;
    const mode = showcaseMode(items.length);
    let looks = opts.looks;
    if (!looks) { try { looks = getSeatLooks('solo'); } catch (e) { looks = null; } }
    const random = opts.random || Math.random;
    this.mode = mode;
    this._entries = items.map(({ key, canvas, outfit, hero }) => {
      const e = { key, canvas, ctx: canvas.getContext('2d'), scene: this._scene(), camera: new THREE.PerspectiveCamera(30, 1.5, 0.05, 80),
        turntable: new THREE.Group(), bike: null, riders: null, actors: [], fit: null, crank: 0, dist: 0, drawn: false };
      e.scene.add(e.turntable);
      // a holiday bike's card: the geese wear the outfit it just brought (its own colours)
      // Pete, 2026-11-09: geese only when the bike brings an outfit (they wear it); otherwise just the bike
      const own = outfit && looks ? { Captain: { ...looks.Captain, outfit, colourway: 'default' }, Stoker: { ...looks.Stoker, outfit, colourway: 'default' } } : null;
      e.hero = !!hero;
      this._build(e, mode, own, random, gen).catch((err) => console.warn('New bike picture failed to load:', key, err));
      return e;
    });
    this._last = 0;
    const frame = (now) => {
      this._raf = requestAnimationFrame(frame);
      this._tick(now);
    };
    this._raf = requestAnimationFrame(frame);
  }

  async _build(e, mode, looks, random, gen) {
    const { model, animations } = await this._bike(e.key);
    if (gen !== this._gen) return;
    e.turntable.add(model);
    e.bike = model;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const c = box.getCenter(new THREE.Vector3());
    model.position.x -= c.x; model.position.z -= c.z; model.position.y -= box.min.y;
    const size = box.getSize(new THREE.Vector3());
    const len = Math.max(size.x, size.z), height = size.y;
    if (!looks && mode === 'riding') { e.fit = { w: len, h: height + 0.3, cx: 0 }; return; }
    if (mode === 'riding') {
      e.riders = new GooseRiders(model, animations);
      e.riders.measureWheel();
      const paths = {}, bodies = {};
      for (const seat of ['Captain', 'Stoker']) { const r = resolveRider(seat, looks[seat].outfit, looks[seat].body); paths[seat] = r.path; bodies[seat] = r.body; }
      e.fit = { w: len * 0.85, h: height + 0.55, cx: 0 };   // (the bike turns alone until the geese are seated)
      await e.riders.loadRiders(cachedLoader, paths);
      if (gen !== this._gen) return;
      for (const seat of ['Captain', 'Stoker']) {
        const r = e.riders.riders[seat];
        if (r) applyColourway(r.root, colourwayParamsForBody(looks[seat].outfit, looks[seat].colourway, bodies[seat]) || {});
      }
      e.riders.setLeans(0, 0);
      e.riders.update();
      return;
    }
    // Standing (Pete, 2026-11-09): the geese walk out from either side, each at its own random moment,
    // and stand beside the spot angled toward you; then the bike rolls in from the left or the right
    // (random), wheels turning, passes behind the goose on that side, and stops in a three-quarter view
    // that is a little different every time (its angle, the camera's height and aim). Each card draws
    // its own, so two new bikes never play alike.
    const half = len / 2;
    const side = half * 0.8 + 0.55;    // where each goose stands, either side of the bike
    e.fit = looks ? { w: side * 2 + 1.3, h: Math.max(height, 1.85), cx: (random() - 0.5) * 0.25, lift: 0.08 + random() * 0.1 }
      : { w: len * 1.25, h: height * 1.3, cx: (random() - 0.5) * 0.15, lift: 0.08 + random() * 0.1 };   // the bike alone
    // the bike's forward (its captain's seat is in front of the stoker's), as a heading
    const cap = model.getObjectByName('Seat_Captain'), sto = model.getObjectByName('Seat_Stoker');
    let fwd = size.x >= size.z ? Math.PI / 2 : 0;
    if (cap && sto) {
      const pc = cap.getWorldPosition(new THREE.Vector3()), ps = sto.getWorldPosition(new THREE.Vector3());
      fwd = Math.atan2(pc.x - ps.x, pc.z - ps.z);
    }
    const from = random() < 0.5 ? -1 : 1;                   // -1: rolls in from the left
    const travel = -from * (Math.PI / 2 - (THREE_QUARTER + (random() - 0.5) * 0.3));   // across, angled toward you
    e.turntable.rotation.y = travel - fwd;
    e.path = rollPath(travel, Math.sign(travel) * Math.PI / 2);   // in from the side, curving to the final view
    e.fwd = fwd;
    e.bikeRadius = Math.hypot(size.x, size.z) / 2;
    e.wheels = new GooseRiders(model, animations);
    e.wheels.measureWheel();
    // it rolls once the goose on its side has taken its spot (so it passes behind them); a fallback if that goose never comes
    e.roll = { t: 0, delay: looks ? ROLL_FALLBACK : 0.4 + random() * 0.4, dur: ROLL_TIME * (e.hero ? 1.4 : 1), from: ROLL_FROM,
      dx: Math.sin(travel), dz: Math.cos(travel), dist: 0 };
    e.turntable.visible = false;
    if (!looks) return;   // no outfit with this bike: it rolls in alone
    const seats = ['Captain', 'Stoker'];
    const orders = greetingOrder(seats.map((s) => looks[s].body), random);
    const fromLeft = random() < 0.5;   // which goose comes out on which side
    seats.forEach(async (seat, i) => {
      try {
        const actor = await loadActor(studioGooseFor(looks[seat]), random);
        if (gen !== this._gen) return;
        try { actor.setColourway(looks[seat].colourway || 'default'); } catch (err) { /* the outfit's own colours */ }
        const dir = (i === 0) === fromLeft ? -1 : 1;    // -1: the left side
        const x = dir * side;
        actor.setHeading(-dir * Math.PI / 2);            // walking in toward the bike
        actor.root.position.set(x + dir * 6, 0, GOOSE_Z);   // out of shot until it walks
        e.scene.add(actor.root);
        e.actors.push(actor);
        await new Promise((r) => setTimeout(r, 300 + random() * 1500));
        if (gen !== this._gen) return;
        const w = actor.walk(1.6 + random() * 0.8);
        actor.root.position.x = x + dir * w.distance;
        await w.done;
        if (dir === from && e.roll) e.roll.delay = Math.min(e.roll.delay, e.roll.t + ROLL_DELAY + random() * 0.8);   // now the bike
        await actor.turnTo(0);                           // face the camera...
        actor.easeHeading = -dir * GOOSE_ANGLE;          // ...then a three-quarter turn in toward the bike
        await new Promise((r) => setTimeout(r, 200 + random() * 600));
        for (let k = 0; gen === this._gen; k++) {
          await actor.play(orders[i][k % orders[i].length]);
          await new Promise((r) => setTimeout(r, 900 + random() * 1600));
        }
      } catch (err) { console.warn('New bike goose failed to load:', seat, err); }
    });
  }

  /**
   * How far back along its line the bike must start to be wholly out of shot (Pete: it starts off screen):
   * the nearest distance at which its bounding sphere clears the frame's side, plus a little.
   */
  _offscreenStart(e) {
    const r = (e.bikeRadius || 1.5) * 1.1;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(e.camera.quaternion);
    const c = new THREE.Vector3(), edge = new THREE.Vector3();
    e.camera.updateMatrixWorld(true);
    for (let back = 2; back < PATH_MAX; back += 0.25) {
      const p = pathAt(e.path, back);
      c.set(p.x, 0.6, p.z);
      edge.copy(c).addScaledVector(right, Math.sign(e.roll.dx) * r);    // the bike's leading side, nearest the frame
      if (Math.abs(edge.clone().project(e.camera).x) > 1.02 && Math.abs(c.clone().project(e.camera).x) > 1) return back + 0.5;
    }
    return ROLL_FROM;
  }

  /** The camera on the card's box (w wide, h tall, centred cx right of the bike), for this aspect. */
  _aim(e, aspect) {
    const { w, h, cx } = e.fit;   // (lift: the camera's height, a little different each showing)
    const tan = Math.tan((e.camera.fov * Math.PI / 180) / 2);
    const dist = Math.max((h * 1.3 / 2) / tan, (w * 1.08 / 2) / (tan * aspect));
    e.camera.aspect = aspect;
    e.camera.position.set(cx, h * 0.55 + dist * (e.fit.lift != null ? e.fit.lift : 0.12), dist);
    e.camera.lookAt(cx, h * 0.42, 0.2);
    e.camera.updateProjectionMatrix();
  }

  _tick(now) {
    if (now - this._last < FRAME_MS) return;
    const dt = this._last ? Math.min(0.1, (now - this._last) / 1000) : 1 / 30;
    this._last = now;
    const r = this._getRenderer();
    for (const e of this._entries) {
      if (!e.fit || !e.canvas.isConnected) continue;
      const w = e.canvas.clientWidth | 0, h = e.canvas.clientHeight | 0;
      if (!w || !h) continue;
      if (e.canvas.width !== w || e.canvas.height !== h) { e.canvas.width = w; e.canvas.height = h; }
      if (e.roll) {
        // roll in along its own line, slowing to a stop on the spot; the wheels turn with the distance
        const ro = e.roll; ro.t += dt;
        if (!ro.sized) { this._aim(e, w / h); ro.from = this._offscreenStart(e); ro.sized = true; }   // starts just out of shot
        const u = Math.max(0, Math.min(1, (ro.t - ro.delay) / ro.dur));
        e.turntable.visible = ro.t >= ro.delay;
        const back = ro.from * Math.pow(1 - u, 3);        // ease out: fast in, gentle stop
        const moved = Math.max(0, (ro.from - back) - ro.dist);
        ro.dist += moved;
        const p = pathAt(e.path, back);
        e.turntable.position.set(p.x, 0, p.z);
        e.turntable.rotation.y = p.h - e.fwd;
        if (e.wheels) { e.wheels.setDistance(ro.dist); e.wheels.setCrank(ro.dist * 1.6); e.wheels.update(); }
      } else e.turntable.rotation.y += TURN_RATE * dt;
      if (e.riders) {
        e.crank += CRANK_RATE * dt; e.dist += 1.2 * dt;
        e.riders.setCrank(e.crank); e.riders.setDistance(e.dist); e.riders.update();
      }
      for (const a of e.actors) {
        if (a.easeHeading != null && !(a.cur && a.cur.c.info.yaw_end)) a.setHeading(a.heading + (a.easeHeading - a.heading) * Math.min(1, dt * 4));
        a.update(dt);
      }
      this._aim(e, w / h);
      if (r.domElement.width !== w || r.domElement.height !== h) r.setSize(w, h, false);
      r.render(e.scene, e.camera);
      e.ctx.clearRect(0, 0, w, h);
      e.ctx.drawImage(r.domElement, 0, 0);
      e.drawn = true;
    }
  }

  /** Stop and let the pictures go (the renderer and the fetched GLBs stay for next time). */
  stop() {
    this._gen++;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    for (const e of this._entries) {
      for (const a of e.actors) a.mixer.stopAllAction();
      if (e.riders) for (const rd of Object.values(e.riders.riders)) rd.mixer.stopAllAction();
      e.scene.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) m.dispose(); });   // (geometry is the cache's)
    }
    this._entries = [];
  }

  /** Is a bike's picture drawn yet (for the smoke)? */
  drawn(key) {
    const e = this._entries.find((x) => x.key === key);
    return !!(e && e.drawn && e.bike);
  }

  /** Has a standing card's bike rolled in and stopped (for the smoke)? */
  rolledIn(key) {
    const e = this._entries.find((x) => x.key === key);
    return !!(e && e.roll && e.roll.t >= e.roll.delay + e.roll.dur);
  }

  /** How many geese a card shows (for the smoke): standing geese or seated riders. */
  geese(key) {
    const e = this._entries.find((x) => x.key === key);
    if (!e) return 0;
    return e.riders ? Object.keys(e.riders.riders).length : e.actors.length;
  }
}
