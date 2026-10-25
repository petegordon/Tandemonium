// ============================================================
// grandma-finish — Grandma waving the riders in at her house (#475)
// ============================================================
//
// At the end of Grandma's (and Today's Road, which rides to Grandma's too):
//   - Grandma stands at the roadside on the house's side, just before the
//     finish, facing the riders. She idles, and waves while the bike is on its final approach.
//   - Three Timber Tandem props near the house: her outhouse (the privy with
//     a crescent moon on the door), a woodpile and a big pine.
//
// Grandma is tandem-3d/goose/goose_grandma.glb (from timber-tandem, commit
// ea16087). She has no gestures of her own, so she borrows the studio clips
// of the Georgian lady (tandem-3d/goose/show/), retargeted to her shorter bones
// the way Timber Tandem does it: rotations only. The wave is the goose
// wardrobe's "wave".
//
// Each piece is its own race marker ({ mesh, roadD, type }), so World shows,
// hides, grounds and disposes it with the other markers.
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export const GRANDMA_MODEL_PATH = 'tandem-3d/goose/goose_grandma.glb';
export const GRANDMA_CLIPS_PATH = 'tandem-3d/goose/show/goose_stoker_georgian_clips.glb';

/** World units per metre: the tandem (≈2.4 m) is modelled 4.4 units long. */
const UNITS_PER_M = 1.8;
/** Grandma's world height: the 1.72 m rig at Timber Tandem's true-size scale. */
const GRANDMA_HEIGHT = 1.6 * UNITS_PER_M;

/**
 * Where everything stands, relative to the finish (roadD) and the road
 * (lateral: World's offset, +6 is where the house billboard stands, on the
 * riders' left; the road is 5 units wide, so ±2.5 is its edge). `face` turns the piece: 0 faces the way the road runs,
 * π faces back toward the riders.
 */
export const LAYOUT = {
  grandma: { along: -7, lateral: 3.8, face: Math.PI },
  woodpile: { along: -2, lateral: 10.5, face: Math.PI / 2 },
  outhouse: { along: 6, lateral: 12, face: -Math.PI / 2 },
  tree: { along: 11, lateral: 8.5, face: 0 },
};

/** Start waving when the bike is this many units from Grandma; stop once it's this far past her. */
const WAVE_FROM = 70, WAVE_UNTIL = 12;

// ── shared helpers (ported from timber-tandem public/js/screen/scene) ──

const PAL = {
  bark: 0x6b4a2f, barkDark: 0x4a3220, woodCut: 0xe8c48c, pine: 0x2f5a3a, pineLight: 0x3d7048,
};

/** Paint a geometry one colour (vertex colours). */
function paint(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
  return g;
}
const M = (x = 0, y = 0, z = 0, ry = 0, s = 1, rx = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(s, s, s));
const placed = (g, m) => { g.applyMatrix4(m); return g; };
const flatMat = () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0 });
const merge = (parts) => mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false);

/** A log: bark sides, pale cut ends. */
function log(len, rad, m4) {
  const side = paint(new THREE.CylinderGeometry(rad, rad, len, 7, 1), PAL.bark);
  const col = side.attributes.color, pos = side.attributes.position;
  const cap = new THREE.Color(PAL.woodCut);
  for (let i = 0; i < pos.count; i += 3) {
    const y0 = pos.getY(i), y1 = pos.getY(i + 1), y2 = pos.getY(i + 2);
    if (Math.abs(y0 - y1) < 1e-6 && Math.abs(y1 - y2) < 1e-6) for (let k = 0; k < 3; k++) col.setXYZ(i + k, cap.r, cap.g, cap.b);
  }
  return placed(side, m4);
}

/** Deterministic random, so the set looks the same every ride. */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** The woodpile: four rows of logs and a chopping block with a split round. One mesh. */
export function buildWoodpile() {
  const parts = [];
  for (let row = 0; row < 4; row++) for (let i = 0; i < 7 - row; i++) {
    parts.push(log(1.1, 0.13, M(-0.8 + i * 0.27 + row * 0.13, 0.13 + row * 0.23, 0, 0, 1, Math.PI / 2, 0)));
  }
  parts.push(log(0.55, 0.32, M(1.6, 0.27, 0.6)));
  parts.push(log(0.35, 0.18, M(1.6, 0.72, 0.6)));
  const mesh = new THREE.Mesh(merge(parts), flatMat());
  mesh.scale.setScalar(UNITS_PER_M);
  const g = new THREE.Group();
  g.name = 'grandma-woodpile';
  g.add(mesh);
  return g;
}

/** Grandma's privy: a plank outhouse with a crescent moon on the door (faces +z). */
export function buildOuthouse() {
  const parts = [], dark = [];
  const box = (w, h, d, hex, x, y, z, rx = 0) => placed(paint(new THREE.BoxGeometry(w, h, d), hex), M(x, y, z, 0, 1, rx));
  const W1 = 0x8a5a33, W2 = 0x7a4e2c, D = 0x4a2f1c;
  parts.push(box(0.5, 2, 0.05, W1, -0.25, 1, -0.48), box(0.5, 2, 0.05, W2, 0.25, 1, -0.48));
  parts.push(box(0.05, 2, 0.5, W2, -0.48, 1, -0.25), box(0.05, 2, 0.5, W1, -0.48, 1, 0.25));
  parts.push(box(0.05, 2, 0.5, W1, 0.48, 1, -0.25), box(0.05, 2, 0.5, W2, 0.48, 1, 0.25));
  parts.push(box(0.19, 2, 0.05, W1, -0.405, 1, 0.48), box(0.19, 2, 0.05, W1, 0.405, 1, 0.48));
  parts.push(box(0.62, 0.4, 0.05, W2, 0, 1.8, 0.48));
  dark.push(box(1.25, 0.12, 1.3, D, 0, 2.08, 0, 0.18));
  dark.push(box(0.62, 1.6, 0.04, D, 0, 0.82, 0.51));
  const g = new THREE.Group();
  g.name = 'grandma-outhouse';
  const inner = new THREE.Group();
  inner.scale.setScalar(UNITS_PER_M);
  inner.add(new THREE.Mesh(merge([...parts, ...dark]), flatMat()));
  // The crescent: a bright disc with a door-coloured disc over one side.
  const moon = new THREE.Mesh(new THREE.CircleGeometry(0.1, 16), new THREE.MeshBasicMaterial({ color: 0xffe08a }));
  moon.position.set(0, 1.42, 0.535);
  const bite = new THREE.Mesh(new THREE.CircleGeometry(0.085, 16), new THREE.MeshBasicMaterial({ color: 0x4a2f1c }));
  bite.position.set(0.05, 1.45, 0.537);
  inner.add(moon, bite);
  g.add(inner);
  return g;
}

/** A big Timber Tandem pine: bark trunk and layered low-poly foliage cones. One mesh. */
export function buildTimberTree() {
  const r = rng(11);
  const height = 9, R = 0.4, tiers = 7;
  const parts = [];
  const trunk = paint(new THREE.CylinderGeometry(R * 0.35, R * 1.1, height, 9, 1), PAL.bark);
  trunk.translate(0, height / 2, 0);
  parts.push(trunk);
  const foliageStart = height * 0.28;
  for (let i = 0; i < tiers; i++) {
    const f = i / (tiers - 1);
    const rad = THREE.MathUtils.lerp(height * 0.2, height * 0.06, f);
    const h = THREE.MathUtils.lerp(height * 0.22, height * 0.14, f);
    const y = foliageStart + f * (height - foliageStart - h * 0.4);
    const shade = new THREE.Color(PAL.pineLight).multiplyScalar(0.85 + r() * 0.3).getHex();
    parts.push(placed(paint(new THREE.ConeGeometry(rad, h, 7, 1), shade), M(0, y + h / 2, 0, r() * 6)));
  }
  const g = new THREE.Group();
  g.name = 'grandma-tree';
  const mesh = new THREE.Mesh(merge(parts), flatMat());
  mesh.scale.setScalar(UNITS_PER_M * 0.75);
  g.add(mesh);
  return g;
}

// ── Grandma ──

/**
 * Fit a clip made for the young geese to Grandma's shorter bones: keep the
 * rotations, drop every position track (she waves on the spot), and drop
 * tracks for bones she doesn't have.
 * @param {THREE.AnimationClip} clip @param {Set<string>} bones
 */
export function retargetClip(clip, bones) {
  const tracks = clip.tracks.filter((t) => {
    const dot = t.name.lastIndexOf('.');
    return bones.has(t.name.slice(0, dot)) && t.name.slice(dot + 1) !== 'position';
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Merge Grandma's skinned pieces that share a material look into one
 * SkinnedMesh each (≈35 meshes → a handful of draws). Same rig for all.
 * @param {THREE.Object3D} root
 */
function mergeSkinned(root) {
  /** @type {THREE.SkinnedMesh[]} */
  const skinned = [];
  root.traverse((o) => { if (/** @type {any} */ (o).isSkinnedMesh) skinned.push(/** @type {any} */ (o)); });
  if (skinned.length < 2) return;
  const skel = skinned[0].skeleton, bind = skinned[0].bindMatrix;
  const same = (m) => m.skeleton.bones.length === skel.bones.length && m.skeleton.bones.every((b, i) => b === skel.bones[i]) && m.bindMatrix.equals(bind);
  if (!skinned.every(same)) return;
  /** @type {Map<string, THREE.SkinnedMesh[]>} */
  const groups = new Map();
  for (const m of skinned) {
    const mat = /** @type {any} */ (m.material);
    const key = [mat.type, mat.map?.source?.uuid ?? '-', mat.normalMap?.source?.uuid ?? '-', mat.color?.getHexString(),
      (mat.roughness ?? 0).toFixed(2), (mat.metalness ?? 0).toFixed(2), mat.transparent, mat.side].join('|');
    if (!groups.has(key)) groups.set(key, []);
    /** @type {THREE.SkinnedMesh[]} */ (groups.get(key)).push(m);
  }
  const KEEP = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight'];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const geos = list.map((m) => {
      const g = m.geometry.clone();
      for (const name of Object.keys(g.attributes)) if (!KEEP.includes(name)) g.deleteAttribute(name);
      if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
      return g;
    });
    if (!geos.every((g) => KEEP.every((k) => !!g.attributes[k] === !!geos[0].attributes[k]))) continue;
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const first = list[0];
    const mesh = new THREE.SkinnedMesh(merged, first.material);
    mesh.name = 'merged:' + first.name;
    mesh.frustumCulled = false;
    first.parent?.add(mesh);
    mesh.position.copy(first.position); mesh.quaternion.copy(first.quaternion); mesh.scale.copy(first.scale);
    mesh.bind(skel, bind);
    for (const m of list) m.parent?.remove(m);
  }
}

/** @type {Promise<{scene: THREE.Object3D, clips: THREE.AnimationClip[]}>|null} */
let _assets = null;
/** Load (once) Grandma's model and the borrowed clips. */
export function loadGrandmaAssets(loader = new GLTFLoader()) {
  if (!_assets) {
    _assets = Promise.all([loader.loadAsync(GRANDMA_MODEL_PATH), loader.loadAsync(GRANDMA_CLIPS_PATH)])
      .then(([model, clips]) => ({ scene: model.scene, clips: clips.animations }))
      .catch((e) => { _assets = null; throw e; });
  }
  return _assets;
}

/** Grandma at the roadside: a group that fills in once her model loads. */
export class GrandmaGoose {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'grandma-goose';
    /** @type {THREE.AnimationMixer|null} */
    this.mixer = null;
    /** @type {Record<string, THREE.AnimationAction>} */
    this.actions = {};
    this.waving = false;
    this.ready = false;
    this.disposed = false;
  }

  /** Load and attach the model; resolves when she's in the scene graph. */
  async load(loader) {
    const { scene, clips } = await loadGrandmaAssets(loader);
    if (this.disposed) return;
    const model = /** @type {THREE.Object3D} */ (cloneSkinned(scene));
    mergeSkinned(model);
    // Scale to GRANDMA_HEIGHT, feet on the ground.
    const box = new THREE.Box3().setFromObject(model);
    const h = box.max.y - box.min.y || 1;
    model.scale.setScalar(GRANDMA_HEIGHT / h);
    model.position.y = -box.min.y * (GRANDMA_HEIGHT / h);
    model.traverse((o) => { if (/** @type {any} */ (o).isMesh) /** @type {any} */ (o).frustumCulled = false; });
    this.group.add(model);
    const bones = new Set();
    model.traverse((o) => { if (/** @type {any} */ (o).isBone) bones.add(o.name); });
    this.mixer = new THREE.AnimationMixer(model);
    for (const name of ['idle_shift', 'wave']) {
      const src = clips.find((c) => c.name === name);
      if (!src) continue;
      const a = this.mixer.clipAction(retargetClip(src, bones));
      a.setLoop(THREE.LoopRepeat, Infinity);
      this.actions[name] = a;
    }
    const idle = this.actions.idle_shift || this.actions.wave;
    if (idle) idle.play();
    this.ready = true;
  }

  /** Wave (true) or idle (false), with a short crossfade. */
  setWaving(on) {
    if (!this.ready || on === this.waving) return;
    const wave = this.actions.wave, idle = this.actions.idle_shift;
    if (!wave || !idle) return;
    this.waving = on;
    const from = on ? idle : wave, to = on ? wave : idle;
    to.reset().play();
    from.crossFadeTo(to, 0.35, false);
  }

  update(dt) { if (this.mixer) this.mixer.update(dt); }

  dispose() {
    this.disposed = true;
    if (this.mixer) { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.mixer.getRoot()); }
    this.mixer = null;
  }
}

/**
 * Build the whole set for a finish at road distance `destD`.
 * @param {{ getPointAtDistance: (d: number) => {x: number, y: number, z: number, heading: number}, loopLength: number }} roadPath
 * @param {number} destD
 * @returns {{ markers: Array<{mesh: THREE.Object3D, roadD: number, type: string}>, grandma: GrandmaGoose, grandmaD: number }}
 */
export function buildGrandmaFinish(roadPath, destD) {
  const L = roadPath.loopLength;
  const at = (piece, obj) => {
    const d = ((destD + piece.along) % L + L) % L;
    const pt = roadPath.getPointAtDistance(d);
    const fwdX = Math.sin(pt.heading), fwdZ = Math.cos(pt.heading);
    const rightX = fwdZ, rightZ = -fwdX;
    obj.position.set(pt.x + rightX * piece.lateral, pt.y, pt.z + rightZ * piece.lateral);
    obj.rotation.y = pt.heading + piece.face;
    obj.visible = false;
    return { mesh: obj, roadD: d, type: 'grandma-prop' };
  };
  const grandma = new GrandmaGoose();
  const markers = [
    at(LAYOUT.grandma, grandma.group),
    at(LAYOUT.woodpile, buildWoodpile()),
    at(LAYOUT.outhouse, buildOuthouse()),
    at(LAYOUT.tree, buildTimberTree()),
  ];
  return { markers, grandma, grandmaD: markers[0].roadD };
}

/** Should Grandma be waving, with the bike at road distance bikeD? (loop-aware) */
export function shouldWave(bikeD, grandmaD, loopLength) {
  let ahead = grandmaD - bikeD;          // > 0: she's still ahead of the bike
  if (ahead > loopLength / 2) ahead -= loopLength;
  if (ahead < -loopLength / 2) ahead += loopLength;
  return ahead <= WAVE_FROM && ahead >= -WAVE_UNTIL;
}
