// ============================================================
// DRESSING ROOM PREVIEW (#548) — each card's goose, drawn by ONE shared renderer
// ============================================================
//
// One WebGL context for the whole room (a context per card would exhaust the browser's limit
// with four players and cost a renderer each). Every card owns a plain 2D <canvas>; each frame
// the shared renderer draws that card's scene at the card's size and the result is copied onto
// the card's canvas (drawImage). The goose is the exact rider GLB the ride will seat
// (goose-outfits.js resolveRider) in its seat's Ride pose, pedalling slowly on a turntable over
// a saddle stub, in the player's colourway. Lazy: nothing loads until a card asks; dispose()
// frees everything when the room closes. Capped at 30 fps.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { dracoDecoderPath } from './draco-path.js';
import { resolveRider } from './goose-outfits.js';
import { colourwayParamsForBody, applyColourway } from './goose-colourways.js';
import { disposeTree } from './goose-riders.js';
import { seatOffset, HIP_UP } from './goose-rider-clips.js';

const FRAME_MS = 1000 / 30;
const TURN_RATE = 0.35;        // rad/s turntable
const CRANK_RATE = 1.6;        // rad/s pedalling

export class DressingRoomPreview {
  constructor() {
    this._renderer = null;
    this._loader = null;
    /** @type {Map<string, any>} */ this._slots = new Map();
    this._last = 0;
    this._clock = 0;
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

  _getLoader() {
    if (!this._loader) {
      const draco = new DRACOLoader();
      draco.setDecoderPath(dracoDecoderPath('libs/draco/'));
      this._loader = new GLTFLoader();
      this._loader.setDRACOLoader(draco);
    }
    return this._loader;
  }

  /**
   * Show `look` on `canvas`: loads the rider when the GLB changes, else recolours in place.
   * @param {string} key one per card
   * @param {HTMLCanvasElement} canvas the card's own canvas
   * @param {'Captain'|'Stoker'} seat the seat whose pose the goose takes
   * @param {{outfit: string, colourway: string, body: 'm'|'f'}} look
   */
  show(key, canvas, seat, look) {
    let s = this._slots.get(key);
    if (!s) {
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xfff4e0, 0x404050, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 2.2);
      sun.position.set(1.5, 3, 2.5);
      scene.add(sun);
      const fill = new THREE.DirectionalLight(0xbcd4ff, 0.8);
      fill.position.set(-2, 1.5, -1.5);
      scene.add(fill);
      const turntable = new THREE.Group();
      scene.add(turntable);
      // A saddle stub under the hips, so the goose isn't floating.
      const saddle = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.06, 24), new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 0.8 }));
      saddle.position.y = HIP_UP - 0.08;
      turntable.add(saddle);
      const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50);
      s = { key, canvas, ctx: canvas.getContext('2d'), scene, camera, turntable, root: null, mixer: null, pedal: null, ride: null,
        path: null, seat, look: null, loading: null, crank: 0, framed: false, gen: 0 };
      this._slots.set(key, s);
    }
    s.canvas = canvas;
    s.ctx = canvas.getContext('2d');
    s.seat = seat;
    s.look = { ...look };
    const r = resolveRider(seat, look.outfit, look.body);
    if (r.path !== s.path) this._load(s, r.path, r.body);
    else if (s.root) this._colour(s, r.body);
  }

  _load(s, path, body) {
    s.path = path;
    s.loadedBody = body;
    const gen = ++s.gen;
    s.loading = this._getLoader().loadAsync(path).then((gltf) => {
      if (gen !== s.gen) { disposeTree(gltf.scene); return; }   // a newer pick won
      this._unseat(s);
      const root = gltf.scene;
      root.traverse((o) => {
        if (!o.isMesh) return;
        if (o.isSkinnedMesh) o.frustumCulled = false;
        if (o.name.includes('__')) o.visible = false;
      });
      root.updateMatrixWorld(true);
      const hl = new THREE.Vector3(), hr = new THREE.Vector3();
      const l = root.getObjectByName('LeftUpLeg'), rr = root.getObjectByName('RightUpLeg');
      if (l && rr) {
        l.getWorldPosition(hl); rr.getWorldPosition(hr);
        const o = seatOffset(hl.add(hr).multiplyScalar(0.5));
        root.position.set(o.x, o.y, o.z);
      }
      s.turntable.add(root);
      s.root = root;
      s.mixer = new THREE.AnimationMixer(root);
      const clip = (prefix) => gltf.animations.find((c) => c.name === prefix + s.seat);
      const ride = clip('Ride_'), pedal = clip('Pedal_');
      if (ride) { s.ride = s.mixer.clipAction(ride); s.ride.play(); }
      if (pedal) { s.pedal = s.mixer.clipAction(pedal); s.pedal.play(); s.pedal.paused = true; }
      s.mixer.update(0);
      this._colour(s, body);
      this._frame(s);
    }).catch((err) => { console.warn('[dressing room] preview failed to load', path, err); });
    return s.loading;
  }

  _colour(s, body) {
    if (!s.root || !s.look) return;
    applyColourway(s.root, colourwayParamsForBody(s.look.outfit, s.look.colourway, body) || {});
  }

  /**
   * Aim the camera at the seated goose: front three-quarter, the whole goose in frame. The
   * skinned meshes' own bounds are their bind pose, so the frame comes from the posed BONES.
   */
  _frame(s) {
    s.turntable.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    s.turntable.traverse((o) => { if (o.isBone) box.expandByPoint(o.getWorldPosition(v)); });
    if (box.isEmpty()) box.setFromObject(s.turntable);
    box.expandByScalar(0.06);   // feathers, hat brim, boots beyond the bones
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const h = Math.max(size.y, size.x * 0.8, size.z * 0.8) || 1;
    const dist = (h / 2) / Math.tan((s.camera.fov * Math.PI / 180) / 2) * 1.02;
    s.camera.position.set(centre.x + dist * 0.5, centre.y + h * 0.18, centre.z + dist * 0.87);
    s.camera.lookAt(centre.x, centre.y, centre.z);
    s.framed = true;
  }

  _unseat(s) {
    if (!s.root) return;
    if (s.mixer) s.mixer.stopAllAction();
    s.turntable.remove(s.root);
    disposeTree(s.root);
    s.root = null; s.mixer = null; s.pedal = null; s.ride = null;
  }

  /** Advance and draw every card; call each frame (it rate-limits itself to 30 fps). */
  tick(now) {
    if (now - this._last < FRAME_MS) return false;
    const dt = this._last ? Math.min(0.1, (now - this._last) / 1000) : 1 / 30;
    this._last = now;
    let drew = false;
    for (const s of this._slots.values()) {
      if (!s.root || !s.canvas || !s.canvas.isConnected) continue;
      const w = s.canvas.clientWidth | 0, h = s.canvas.clientHeight | 0;
      if (!w || !h) continue;
      if (s.canvas.width !== w || s.canvas.height !== h) { s.canvas.width = w; s.canvas.height = h; }
      s.turntable.rotation.y += TURN_RATE * dt;
      s.crank += CRANK_RATE * dt;
      if (s.pedal) { const d = s.pedal.getClip().duration; s.pedal.time = ((s.crank % (2 * Math.PI)) / (2 * Math.PI)) * d; }
      if (s.mixer) s.mixer.update(0);
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

  /** Has this card's goose loaded (tests / status)? */
  loaded(key) { const s = this._slots.get(key); return !!(s && s.root); }
  pathOf(key) { const s = this._slots.get(key); return s ? s.path : null; }

  remove(key) {
    const s = this._slots.get(key);
    if (!s) return;
    s.gen++;
    this._unseat(s);
    this._slots.delete(key);
  }

  dispose() {
    for (const k of [...this._slots.keys()]) this.remove(k);
    if (this._renderer) { this._renderer.dispose(); this._renderer.forceContextLoss?.(); this._renderer = null; }
    this._last = 0;
  }
}
