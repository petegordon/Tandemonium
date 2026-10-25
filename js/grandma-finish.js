// ============================================================
// grandma-finish — Grandma waving the riders in at her house (#475)
// ============================================================
//
// At the end of Grandma's (and Today's Road, which rides to Grandma's too):
//   - Grandma stands at the roadside on the house's side, just before the
//     finish, facing the riders. She idles, and waves while the bike is on its final approach.
//     Once they pass, she turns round and walks to the finish line, so the finish
//     cinematic's front view catches her behind the riders (GrandmaRoute).
//   - Three Timber Tandem props near the house: her outhouse (the privy with
//     a crescent moon on the door), a woodpile and a big pine.
//   - #478 · the present stack: after the finish, the ride's presents fly
//     off the bike into a pile at Grandma's feet (present-stack.js).
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
import { PresentStack } from './present-stack.js';

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
  grandma: { along: -4, lateral: 3.8, face: Math.PI },
  woodpile: { along: -2, lateral: 10.5, face: Math.PI / 2 },
  outhouse: { along: 6, lateral: 12, face: -Math.PI / 2 },
  tree: { along: 11, lateral: 8.5, face: 0 },
  // #478 · the ride's presents pile up here, at Grandma's side (the riders reach it just before her)
  stack: { along: 0.2, lateral: 3.9, face: Math.PI },   // #481: in front of the door, beside where Grandma ends up, in the finish shot
};

/** Start waving when the bike is this many units from Grandma. */
const WAVE_FROM = 70;

/**
 * Once the riders pass her, Grandma turns round and walks along the shoulder,
 * drifting out toward her house, to just past the finish line (`toAlong`,
 * `toLateral`, same frame as LAYOUT), then turns to the riders. #481: that's
 * where the finish cinematic's front view sees her beside the bike, between
 * it and her house with the present pile; nearer the road the captain hid her.
 * She walks on real time, not the cinematic's slow motion (see World.update),
 * so `speed` (units/s) is a grandma's stroll that gets her there as the shot lands.
 */
export const WALK = { toAlong: 2.2, toLateral: 3.4, speed: 2.6, turnTime: 0.6, returnGap: 2 };

/**
 * #481 · she watches the riders: her head turns up to maxYaw toward them (on
 * top of whatever clip plays), and while she waves her body turns up to
 * bodyYaw off facing straight back up the road. ease is how fast (1/s).
 */
export const LOOK = { maxYaw: 1.2, bodyYaw: 0.8, ease: 5 };
const _v1 = new THREE.Vector3();
const _vUp = new THREE.Vector3(0, 1, 0);
const _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion();

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
    /** @type {string|null} the clip playing now */
    this.clip = null;
    this.ready = false;
    this.disposed = false;
    /** World point she watches (the riders), or null. @type {THREE.Vector3|null} */
    this.lookTarget = null;
    this._lookYaw = 0;        // smoothed head turn (rad), relative to her body
    /** @type {THREE.Bone[]} neck → head, sharing the turn */
    this._lookBones = [];
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
    /** @type {Record<string, THREE.Bone>} */
    const byName = {};
    model.traverse((o) => { if (/** @type {any} */ (o).isBone) { bones.add(o.name); byName[o.name] = /** @type {any} */ (o); } });
    this._lookBones = ['Neck1', 'Neck2', 'Neck3', 'Head'].map((n) => byName[n]).filter(Boolean);
    this.mixer = new THREE.AnimationMixer(model);
    for (const name of ['idle_shift', 'wave', 'walk']) {
      const src = clips.find((c) => c.name === name);
      if (!src) continue;
      const a = this.mixer.clipAction(retargetClip(src, bones));
      a.setLoop(THREE.LoopRepeat, Infinity);
      this.actions[name] = a;
    }
    this.ready = true;
    this.play(this.actions.idle_shift ? 'idle_shift' : 'wave');
  }

  /** Crossfade to one of her clips ('idle_shift' | 'wave' | 'walk'). */
  play(name) {
    if (!this.ready || name === this.clip) return;
    const to = this.actions[name];
    if (!to) return;
    const from = this.clip ? this.actions[this.clip] : null;
    to.reset().play();
    if (from) from.crossFadeTo(to, 0.35, false);
    this.clip = name;
    this.waving = name === 'wave';
  }

  /** Wave (true) or idle (false), with a short crossfade. */
  setWaving(on) {
    this.play(on ? 'wave' : 'idle_shift');
  }

  update(dt) {
    if (this.mixer) this.mixer.update(dt);
    this._applyLook(dt);
  }

  /**
   * #481 · turn her head toward lookTarget (the riders) on top of the clip:
   * the yaw to the target, relative to where her body faces, clamped to
   * LOOK.maxYaw and eased, shared out along the neck and head.
   */
  _applyLook(dt) {
    if (!this.ready || !this._lookBones.length) return;
    let want = 0;
    if (this.lookTarget) {
      this.group.updateMatrixWorld(true);
      // the riders in her own frame (she faces +z): the yaw that turns +z to them
      const local = this.group.worldToLocal(_v1.copy(this.lookTarget));
      want = Math.atan2(local.x, local.z);
      want = Math.max(-LOOK.maxYaw, Math.min(LOOK.maxYaw, want));
    }
    this._lookYaw += (want - this._lookYaw) * Math.min(1, dt * LOOK.ease);
    if (Math.abs(this._lookYaw) < 1e-4) return;
    const share = this._lookYaw / this._lookBones.length;
    const up = _vUp;
    for (const b of this._lookBones) {
      if (!b.parent) continue;
      b.parent.updateMatrixWorld(true);
      // a turn about world up, expressed in the bone's parent frame
      const pw = b.parent.getWorldQuaternion(_q2);
      const turn = _q3.setFromAxisAngle(up, share);
      const local = _q4.copy(pw).invert().multiply(turn).multiply(pw);
      b.quaternion.premultiply(local);
    }
  }

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
 * @returns {{ markers: Array<{mesh: THREE.Object3D, roadD: number, type: string}>, grandma: GrandmaGoose, grandmaD: number, update: (bikeD: number, dt: number, bikePos?: THREE.Vector3|null) => void, route: GrandmaRoute, stack: PresentStack }}
 */
export function buildGrandmaFinish(roadPath, destD) {
  const L = roadPath.loopLength;
  const at = (piece, obj) => {
    const d = ((destD + piece.along) % L + L) % L;
    placeBeside(roadPath, d, piece.lateral, piece.face, obj);
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
  const route = new GrandmaRoute(roadPath, grandma, markers[0], destD);
  const stack = new PresentStack();
  const stackMarker = at(LAYOUT.stack, stack.group);
  stackMarker.type = 'present-stack';
  markers.push(stackMarker);
  return { markers, grandma, grandmaD: markers[0].roadD, route, stack, update: (bikeD, dt, bikePos) => route.update(bikeD, dt, bikePos) };
}

/** Stand `obj` beside the road at distance d, `lateral` units to the right, turned by `face`. */
function placeBeside(roadPath, d, lateral, face, obj) {
  const pt = roadPath.getPointAtDistance(d);
  const fwdX = Math.sin(pt.heading), fwdZ = Math.cos(pt.heading);
  const rightX = fwdZ, rightZ = -fwdX;
  obj.position.set(pt.x + rightX * lateral, pt.y, pt.z + rightZ * lateral);
  obj.rotation.y = pt.heading + face;
}

/** How far Grandma's spot is ahead of the bike (> 0: still ahead), loop-aware. */
function aheadOf(bikeD, d, L) {
  let ahead = d - bikeD;
  if (ahead > L / 2) ahead -= L;
  if (ahead < -L / 2) ahead += L;
  return ahead;
}

/**
 * What Grandma should be doing with the bike at road distance bikeD:
 * 'idle' while the riders are far off, 'wave' on their final approach, and
 * 'leave' once they've passed her (turn round and walk to the finish line).
 */
export function grandmaCue(bikeD, grandmaD, loopLength) {
  const ahead = aheadOf(bikeD, grandmaD, loopLength);
  if (ahead < 0) return 'leave';
  return ahead <= WAVE_FROM ? 'wave' : 'idle';
}

/**
 * Grandma's little walk: waits at home (idling, then waving), and once the
 * riders pass she turns round toward the road and walks along the shoulder to
 * WALK.toAlong, keeping her marker's roadD in step so World grounds her on the
 * road's height as she goes. If the bike ends up back before her spot (a
 * reset), she's home again.
 */
export class GrandmaRoute {
  /**
   * @param {{ getPointAtDistance: (d: number) => {x: number, y: number, z: number, heading: number}, loopLength: number }} roadPath
   * @param {GrandmaGoose} grandma @param {{ roadD: number }} marker @param {number} destD
   */
  constructor(roadPath, grandma, marker, destD) {
    this.roadPath = roadPath;
    this.grandma = grandma;
    this.marker = marker;
    this.homeD = marker.roadD;
    this.length = Math.max(0, WALK.toAlong - LAYOUT.grandma.along);   // how far she walks
    /** 'home' | 'turn' | 'walk' | 'arrived' */
    this.mode = 'home';
    this.t = 0;          // seconds into the turn
    this.walked = 0;     // units along the shoulder
  }

  update(bikeD, dt, bikePos = null) {
    const L = this.roadPath.loopLength;
    const cue = grandmaCue(bikeD, this.homeD, L);
    // #481 · she watches the riders all the way in and on to the line
    this.grandma.lookTarget = bikePos && cue !== 'idle' ? bikePos : null;
    if (this.mode === 'home') {
      if (cue === 'leave') { this.mode = 'turn'; this.t = 0; this._turnFrom = this.grandma.group.rotation.y; this.grandma.play('walk'); }
      else {
        this.grandma.setWaving(cue === 'wave');
        if (bikePos && cue === 'wave') this._faceRiders(bikePos, dt);
      }
    } else if (cue !== 'leave' && aheadOf(bikeD, this.homeD, L) > WALK.returnGap) {
      this.goHome();
    }
    if (this.mode === 'turn') this._turn(dt);
    else if (this.mode === 'walk') this._walk(dt);
    else if (this.mode === 'arrived' && bikePos) this._turnToward(bikePos, dt);
    this.grandma.update(dt);
  }

  /** Back to where she stood at the start, facing the riders. */
  goHome() {
    this.mode = 'home';
    this.t = 0;
    this.walked = 0;
    this.marker.roadD = this.homeD;
    placeBeside(this.roadPath, this.homeD, LAYOUT.grandma.lateral, LAYOUT.grandma.face, this.grandma.group);
    this.grandma.setWaving(false);
  }

  /** While waving, turn her body (up to LOOK.bodyYaw off facing the riders) toward the bike. */
  _faceRiders(bikePos, dt) {
    const g = this.grandma.group;
    const pt = this.roadPath.getPointAtDistance(this.homeD);
    const home = pt.heading + LAYOUT.grandma.face;
    // yaw that points her +z at the bike
    const want = Math.atan2(bikePos.x - g.position.x, bikePos.z - g.position.z);
    let off = want - home;
    off = Math.atan2(Math.sin(off), Math.cos(off));
    off = Math.max(-LOOK.bodyYaw, Math.min(LOOK.bodyYaw, off));
    let cur = g.rotation.y - home;
    cur = Math.atan2(Math.sin(cur), Math.cos(cur));
    g.rotation.y = home + cur + (off - cur) * Math.min(1, dt * LOOK.ease * 0.6);
  }

  /** Arrived: turn round, easing, to face the riders (she waves them in). */
  _turnToward(bikePos, dt) {
    const g = this.grandma.group;
    const want = Math.atan2(bikePos.x - g.position.x, bikePos.z - g.position.z);
    let off = want - g.rotation.y;
    off = Math.atan2(Math.sin(off), Math.cos(off));
    g.rotation.y += off * Math.min(1, dt * LOOK.ease * 0.5);
  }

  /** Turn on the spot from where she faces (the riders) to facing the finish, by way of the road. */
  _turn(dt) {
    this.t += dt;
    const k = Math.min(1, this.t / WALK.turnTime);
    const e = k * k * (3 - 2 * k);
    const pt = this.roadPath.getPointAtDistance(this.homeD);
    const to = pt.heading + Math.PI * 2;
    const from0 = this._turnFrom != null ? this._turnFrom : pt.heading + Math.PI;
    // unwrap so she turns the short way round, toward the road
    let from = from0;
    while (from > to) from -= Math.PI * 2;
    while (to - from > Math.PI * 2) from += Math.PI * 2;
    this.grandma.group.rotation.y = from + (to - from) * e;
    if (k >= 1) this.mode = 'walk';
  }

  /** Stroll along the shoulder toward the finish line, following the road's curve. */
  _walk(dt) {
    this.walked = Math.min(this.length, this.walked + WALK.speed * dt);
    const d = ((this.homeD + this.walked) % this.roadPath.loopLength + this.roadPath.loopLength) % this.roadPath.loopLength;
    const k = this.length > 0 ? this.walked / this.length : 1;
    const lat = LAYOUT.grandma.lateral + (WALK.toLateral - LAYOUT.grandma.lateral) * k;
    // face her way: along the road, angled out by the drift
    const drift = Math.atan2(WALK.toLateral - LAYOUT.grandma.lateral, this.length || 1);
    placeBeside(this.roadPath, d, lat, -drift, this.grandma.group);
    this.marker.roadD = d;
    if (this.walked >= this.length) { this.mode = 'arrived'; this.grandma.play('wave'); }
  }
}

