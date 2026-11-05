// ============================================================
// DRESSING ROOM PREVIEW (#548) — each card's goose ON the tandem, drawn by ONE shared renderer
// ============================================================
//
// One WebGL context for the whole room (a context per card would exhaust the browser's limit
// with four players and cost a renderer each). Every card owns a plain 2D <canvas>; each frame
// the shared renderer draws that card's scene at the card's size and the result is copied onto
// the card's canvas (drawImage).
//
// Each card's scene is the game's goose tandem (GOOSE_BIKE_MODEL_PATH, loaded once and cloned per
// card the way versus clones it) with ONE rider seated at the player's seat by js/goose-riders.js —
// the exact rider GLB the ride will seat (goose-outfits.js resolveRider), pedalling slowly on a
// gentle turntable, in the player's colourway; the other seat stays empty and the bike is dimmed
// so the goose is the subject. Lazy: nothing loads until a card asks; dispose() frees the riders
// when the room closes (the bike stays cached for the next open). Capped at 30 fps.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { dracoDecoderPath } from './draco-path.js';
import { GOOSE_BIKE_MODEL_PATH } from './config.js';
import { resolveRider } from './goose-outfits.js';
import { colourwayParamsForBody, applyColourway } from './goose-colourways.js';
import { GooseRiders, disposeTree } from './goose-riders.js';

const FRAME_MS = 1000 / 30;
const TURN_RATE = 0.25;        // rad/s turntable
const CRANK_RATE = 1.5;        // rad/s pedalling
const ROLL_SPEED = 1.2;        // m/s the wheels roll at
const BIKE_DIM = 0.45;         // the bike's colours × this, so the goose stays the subject

let _bikePromise = null;       // the goose tandem, fetched once per page
let _loader = null;

function getLoader() {
  if (!_loader) {
    const draco = new DRACOLoader();
    draco.setDecoderPath(dracoDecoderPath('libs/draco/'));
    _loader = new GLTFLoader();
    _loader.setDRACOLoader(draco);
  }
  return _loader;
}

function loadBike() {
  if (!_bikePromise) _bikePromise = getLoader().loadAsync(GOOSE_BIKE_MODEL_PATH).then((gltf) => ({ scene: gltf.scene, animations: gltf.animations }));
  return _bikePromise;
}

/** Dim a bike clone's own meshes (never the geese): per-instance material clones, like versus's applyPreset. */
function dimBike(model) {
  model.traverse((o) => {
    if (!o.isMesh || (o.userData && o.userData.gooseSeat)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const dimmed = mats.map((m) => {
      if (!m) return m;
      const c = m.clone();
      if (c.color) { const hsl = {}; c.color.getHSL(hsl); c.color.setHSL(hsl.h, hsl.s * 0.35, hsl.l * BIKE_DIM); }
      if ('roughness' in c) c.roughness = Math.min(1, (c.roughness ?? 0.5) + 0.3);
      if ('metalness' in c) c.metalness = (c.metalness ?? 0) * 0.3;
      return c;
    });
    o.material = Array.isArray(o.material) ? dimmed : dimmed[0];
    o.userData.dimmedMaterial = true;
  });
}

export class DressingRoomPreview {
  constructor() {
    this._renderer = null;
    /** @type {Map<string, any>} */ this._slots = new Map();
    this._last = 0;
  }

  _getRenderer() {
    if (!this._renderer) {
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      r.setPixelRatio(1);
      r.setClearColor(0x000000, 0);
      this._renderer = r;
    }
    return this._renderer;
  }

  /**
   * Show `look` on `canvas`: loads the rider when the GLB changes, else recolours in place.
   * @param {string} key one per card
   * @param {HTMLCanvasElement} canvas the card's own canvas
   * @param {'Captain'|'Stoker'} seat the seat the goose takes on the tandem
   * @param {{outfit: string, colourway: string, body: 'm'|'f'}} look
   */
  show(key, canvas, seat, look) {
    let s = this._slots.get(key);
    if (!s) {
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a3a48, 1.5));
      const sun = new THREE.DirectionalLight(0xffffff, 2.2);
      sun.position.set(1.5, 3, 2.5);
      scene.add(sun);
      const fill = new THREE.DirectionalLight(0xbcd4ff, 0.7);
      fill.position.set(-2, 1.5, -1.5);
      scene.add(fill);
      const turntable = new THREE.Group();
      scene.add(turntable);
      const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 80);
      s = { key, canvas, ctx: canvas.getContext('2d'), scene, camera, turntable, bike: null, riders: null, seat, look: null,
        path: null, body: null, gen: 0, crank: 0, dist: 0, framed: false, bikeReady: null };
      this._slots.set(key, s);
      s.bikeReady = loadBike().then(({ scene: src, animations }) => {
        if (!this._slots.has(key)) return;
        const model = cloneSkinned(src);
        dimBike(model);
        model.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
        s.turntable.add(model);
        s.bike = model;
        s.riders = new GooseRiders(model, animations);
        s.riders.measureWheel();
        // Turn about the player's seat, so the rider stays centred while the bike swings.
        const socket = model.getObjectByName('Seat_' + s.seat);
        if (socket) {
          model.updateMatrixWorld(true);
          const p = socket.getWorldPosition(new THREE.Vector3());
          model.position.x -= p.x;
          model.position.z -= p.z;
        }
      }).catch((err) => console.warn('[dressing room] bike preview failed to load', err));
    }
    s.canvas = canvas;
    s.ctx = canvas.getContext('2d');
    s.look = { ...look };
    const r = resolveRider(seat, look.outfit, look.body);
    if (r.path !== s.path || seat !== s.seat) { s.seat = seat; this._load(s, r.path, r.body); }
    else if (s.riders && s.riders.riders[s.seat]) this._colour(s);
  }

  _load(s, path, body) {
    s.path = path;
    s.body = body;
    const gen = ++s.gen;
    return s.bikeReady.then(async () => {
      if (gen !== s.gen || !s.riders) return;
      const paths = { [s.seat]: path };
      // The first goose seats; a later pick swaps it (the old one leaves once the new one is in).
      if (s.riders.riders[s.seat]) await s.riders.swapRiders(getLoader(), paths, true);
      else await s.riders.loadRiders(getLoader(), paths);
      if (gen !== s.gen) return;   // a newer pick won; its own load re-seats
      s.riders.setLeans(0, 0);
      s.riders.setCrank(s.crank);
      s.riders.update();
      this._colour(s);
      this._frame(s);
    }).catch((err) => { console.warn('[dressing room] preview failed to load', path, err); });
  }

  _colour(s) {
    const r = s.riders && s.riders.riders[s.seat];
    if (!r || !s.look) return;
    applyColourway(r.root, colourwayParamsForBody(s.look.outfit, s.look.colourway, s.body) || {});
  }

  /**
   * Frame the camera on the rider: a three-quarter front view with the bike under them, the goose
   * ~75 % of the frame height. The skinned meshes' own bounds are their bind pose, so the frame
   * comes from the posed BONES of the goose.
   */
  _frame(s) {
    const r = s.riders && s.riders.riders[s.seat];
    if (!r) return;
    s.turntable.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    r.root.traverse((o) => { if (o.isBone) box.expandByPoint(o.getWorldPosition(v)); });
    if (box.isEmpty()) box.setFromObject(r.root);
    box.expandByScalar(0.08);   // feathers, hat brim, boots beyond the bones
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const h = Math.max(size.y, size.x * 0.7, size.z * 0.7) || 1;
    // The frame height is the goose / 0.75; aim a little below the goose's centre so the
    // bike shows under them.
    const dist = ((h / 0.75) / 2) / Math.tan((s.camera.fov * Math.PI / 180) / 2);
    const target = new THREE.Vector3(centre.x, centre.y - h * 0.12, centre.z);
    s.camera.position.set(target.x + dist * 0.62, target.y + h * 0.3, target.z + dist * 0.78);
    s.camera.lookAt(target);
    s.framed = true;
  }

  /** Advance and draw every card; call each frame (it rate-limits itself to 30 fps). */
  tick(now) {
    if (now - this._last < FRAME_MS) return false;
    const dt = this._last ? Math.min(0.1, (now - this._last) / 1000) : 1 / 30;
    this._last = now;
    let drew = false;
    for (const s of this._slots.values()) {
      if (!s.bike || !s.canvas || !s.canvas.isConnected) continue;
      const w = s.canvas.clientWidth | 0, h = s.canvas.clientHeight | 0;
      if (!w || !h) continue;
      if (s.canvas.width !== w || s.canvas.height !== h) { s.canvas.width = w; s.canvas.height = h; }
      s.turntable.rotation.y += TURN_RATE * dt;
      s.crank += CRANK_RATE * dt;
      s.dist += ROLL_SPEED * dt;
      if (s.riders) { s.riders.setCrank(s.crank); s.riders.setDistance(s.dist); s.riders.update(); }
      if (!s.framed && s.riders && s.riders.riders[s.seat]) this._frame(s);
      if (!s.framed) continue;   // nothing to show until the rider is seated
      const r = this._getRenderer();
      if (r.domElement.width !== w || r.domElement.height !== h) r.setSize(w, h, false);
      s.camera.aspect = w / h;
      s.camera.updateProjectionMatrix();
      r.render(s.scene, s.camera);
      s.ctx.clearRect(0, 0, w, h);
      s.ctx.drawImage(r.domElement, 0, 0);
      drew = true;
    }
    return drew;
  }

  /** Draw one card now at its current CSS size (no 30 fps cap): a transitioning preview never shows a stretched bitmap. */
  resizeNow(key) {
    const s = this._slots.get(key);
    if (!s || !s.bike || !s.framed || !s.canvas || !s.canvas.isConnected) return false;
    const w = s.canvas.clientWidth | 0, h = s.canvas.clientHeight | 0;
    if (!w || !h || (s.canvas.width === w && s.canvas.height === h)) return false;
    s.canvas.width = w; s.canvas.height = h;
    const r = this._getRenderer();
    if (r.domElement.width !== w || r.domElement.height !== h) r.setSize(w, h, false);
    s.camera.aspect = w / h;
    s.camera.updateProjectionMatrix();
    r.render(s.scene, s.camera);
    s.ctx.clearRect(0, 0, w, h);
    s.ctx.drawImage(r.domElement, 0, 0);
    return true;
  }

  /** Has this card's goose been seated (tests / status)? */
  loaded(key) { const s = this._slots.get(key); return !!(s && s.riders && s.riders.riders[s.seat] && s.framed); }
  pathOf(key) { const s = this._slots.get(key); return s ? s.path : null; }

  remove(key) {
    const s = this._slots.get(key);
    if (!s) return;
    s.gen++;
    if (s.riders) for (const r of Object.values(s.riders.riders)) { r.mixer.stopAllAction(); if (r.root.parent) r.root.parent.remove(r.root); disposeTree(r.root); }
    if (s.bike) {
      // Our own dimmed materials go; the geometry is the cached bike's (shared), so it stays.
      s.bike.traverse((o) => { if (o.isMesh && o.userData.dimmedMaterial) for (const m of [].concat(o.material)) m.dispose(); });
      s.turntable.remove(s.bike);
    }
    this._slots.delete(key);
  }

  dispose() {
    for (const k of [...this._slots.keys()]) this.remove(k);
    if (this._renderer) { this._renderer.dispose(); this._renderer.forceContextLoss?.(); this._renderer = null; }
    this._last = 0;
  }
}
