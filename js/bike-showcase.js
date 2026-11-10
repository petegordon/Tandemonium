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
/** The greetings each goose picks from (a gander tips his hat, a lady curtsies). */
const MOVES = { m: ['wave', 'bow', 'hat_tip', 'celebrate', 'admire', 'twirl'], f: ['wave', 'bow', 'curtsy', 'celebrate', 'admire', 'twirl'] };

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
    this._entries = items.map(({ key, canvas }) => {
      const e = { key, canvas, ctx: canvas.getContext('2d'), scene: this._scene(), camera: new THREE.PerspectiveCamera(30, 1.5, 0.05, 80),
        turntable: new THREE.Group(), bike: null, riders: null, actors: [], fit: null, crank: 0, dist: 0, drawn: false };
      e.scene.add(e.turntable);
      this._build(e, mode, looks, random, gen).catch((err) => console.warn('New bike picture failed to load:', key, err));
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
    if (!looks) { e.fit = { w: len, h: height, cx: 0 }; return; }
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
    // standing: the bike turns on the left; the geese walk in on its right and greet you
    e.fit = { w: len + 1.7, h: Math.max(height, 1.35), cx: 0.85 };
    const half = len / 2;
    const seats = ['Captain', 'Stoker'];
    const orders = greetingOrder(seats.map((s) => looks[s].body), random);
    seats.forEach(async (seat, i) => {
      try {
        const actor = await GooseActor.load(cachedLoader, studioGooseFor(looks[seat]), { dir: GOOSE_DIR, random });
        if (gen !== this._gen) return;
        try { actor.setColourway(looks[seat].colourway || 'default'); } catch (err) { /* the outfit's own colours */ }
        const x = half + 0.5 + i * 0.8;
        actor.setHeading(-Math.PI / 2);   // walking in from the right
        actor.root.position.set(x + 4, 0, 0.3 - i * 0.15);   // off to the side until it walks
        e.scene.add(actor.root);
        e.actors.push(actor);
        await new Promise((r) => setTimeout(r, i * 450));
        if (gen !== this._gen) return;
        const w = actor.walk(1.8);
        actor.root.position.x = x + w.distance;
        await w.done;
        await actor.turnTo(0);   // face the camera
        for (let k = 0; gen === this._gen; k++) {
          await actor.play(orders[i][k % orders[i].length]);
          await new Promise((r) => setTimeout(r, 900 + random() * 1600));
        }
      } catch (err) { console.warn('New bike goose failed to load:', seat, err); }
    });
  }

  /** The camera on the card's box (w wide, h tall, centred cx right of the bike), for this aspect. */
  _aim(e, aspect) {
    const { w, h, cx } = e.fit;
    const tan = Math.tan((e.camera.fov * Math.PI / 180) / 2);
    const dist = Math.max((h * 1.15 / 2) / tan, (w * 1.08 / 2) / (tan * aspect));
    e.camera.aspect = aspect;
    e.camera.position.set(cx, h * 0.55 + dist * 0.12, dist);
    e.camera.lookAt(cx, h * 0.45, 0);
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
      e.turntable.rotation.y += TURN_RATE * dt;
      if (e.riders) {
        e.crank += CRANK_RATE * dt; e.dist += 1.2 * dt;
        e.riders.setCrank(e.crank); e.riders.setDistance(e.dist); e.riders.update();
      }
      for (const a of e.actors) a.update(dt);
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

  /** How many geese a card shows (for the smoke): standing geese or seated riders. */
  geese(key) {
    const e = this._entries.find((x) => x.key === key);
    if (!e) return 0;
    return e.riders ? Object.keys(e.riders.riders).length : e.actors.length;
  }
}
