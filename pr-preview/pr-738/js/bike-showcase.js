// ============================================================
// BIKE SHOWCASE — the "New bike!" cards' turning bikes (#736)
// ============================================================
//
// Pete, 2026-11-09: the celebration shows the bike itself, turning, with its name (icon first) below.
// One WebGL renderer draws every card's bike in turn and copies each frame into that card's own 2D
// canvas, so a screen of five bikes still costs one GL context. Paint and holiday bikes are the
// chooser's recolourable frame (CHOOSER_MODEL_PATH) with their preset; the special bikes load their
// own GLB, mirror gold given something to reflect like the chooser does.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CHOOSER_MODEL_PATH } from './config.js';
import { SPECIAL_BIKES } from './special-bikes.js';
import { mirrorEnvTexture, isMirrorMaterial } from './mirror-env.js';

const GOLD_WARM = new THREE.Color(1.0, 0.8, 0.5);
const GOLD_ENV = 0.8;
const W = 360, H = 240;   // the drawing size of each card's picture (CSS sizes the canvas)

/** A paint preset (tandem-3d/bike-presets*.json) on a model's materials (the chooser's rule). */
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

/** Scale to 3 m across, centred, standing on the ground. */
function fit(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  model.scale.setScalar(3.0 / Math.max(size.x, size.y, size.z));
  model.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(model);
  const c = b2.getCenter(new THREE.Vector3());
  model.position.set(-c.x, -b2.min.y, -c.z);
}

export class BikeShowcase {
  /** @param {Record<string, object>} presetData the chooser's paint presets, by bike key */
  constructor(presetData = {}) {
    this._presets = presetData || {};
    this._entries = [];   // { key, canvas, ctx, pivot }
    this._raf = 0;
    this._renderer = null;
  }

  _setup() {
    if (this._renderer) return;
    const r = this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setSize(W, H, false);
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.2;
    this._scene = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(32, W / H, 0.1, 100);
    this._camera.position.set(0, 1.25, 4.1);
    this._camera.lookAt(0, 0.6, 0);
    this._scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.3); key.position.set(5, 8, 5); this._scene.add(key);
    const rim = new THREE.DirectionalLight(0x8899cc, 0.6); rim.position.set(-3, 4, -4); this._scene.add(rim);
    this._loader = new GLTFLoader();
    this._chooser = null;   // the recolourable frame, loaded once and cloned per paint bike
  }

  _chooserModel() {
    if (!this._chooser) this._chooser = this._loader.loadAsync(CHOOSER_MODEL_PATH).then((g) => g.scene);
    return this._chooser;
  }

  async _buildModel(key) {
    const sp = SPECIAL_BIKES[key];
    let model;
    if (sp) {
      model = (await this._loader.loadAsync(sp.model)).scene;
      const env = sp.mirror ? mirrorEnvTexture() : null;
      model.traverse((o) => {
        if (!o.isMesh || !env || !isMirrorMaterial(o.material)) return;
        o.material = o.material.clone();
        o.material.envMap = env;
        o.material.color.multiply(GOLD_WARM);
        o.material.envMapIntensity = GOLD_ENV;
      });
    } else {
      model = (await this._chooserModel()).clone(true);
      model.traverse((o) => { if (o.isMesh) o.material = o.material.clone(); });
      if (key !== 'default') applyPresetMaterials(model, this._presets[key]);
    }
    fit(model);
    return model;
  }

  /**
   * Turn a bike in each canvas.
   * @param {{key: string, canvas: HTMLCanvasElement}[]} items
   */
  show(items) {
    this.stop();
    this._setup();
    this._entries = items.map(({ key, canvas }, i) => {
      canvas.width = W; canvas.height = H;
      const entry = { key, canvas, ctx: canvas.getContext('2d'), pivot: new THREE.Group(), phase: i * 0.9 };
      entry.pivot.visible = false;
      this._scene.add(entry.pivot);
      this._buildModel(key).then((m) => { if (this._entries.includes(entry)) entry.pivot.add(m); })
        .catch((e) => console.warn('New bike picture failed to load:', key, e));
      return entry;
    });
    const t0 = performance.now();
    const frame = () => {
      this._raf = requestAnimationFrame(frame);
      const t = (performance.now() - t0) / 1000;
      for (const e of this._entries) {
        if (!e.pivot.children.length) continue;
        for (const o of this._entries) o.pivot.visible = o === e;
        e.pivot.rotation.y = e.phase + t * 0.8;
        this._renderer.render(this._scene, this._camera);
        e.ctx.clearRect(0, 0, W, H);
        e.ctx.drawImage(this._renderer.domElement, 0, 0, W, H);
      }
    };
    frame();
  }

  /** Stop turning and let the bikes go (the renderer stays for next time). */
  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    for (const e of this._entries) {
      this._scene.remove(e.pivot);
      e.pivot.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.dispose(); });   // (geometry is shared with the cached frame)
    }
    this._entries = [];
  }

  /** Is a bike's picture drawn yet (for the smoke)? */
  drawn(key) {
    const e = this._entries.find((x) => x.key === key);
    return !!(e && e.pivot.children.length);
  }
}
