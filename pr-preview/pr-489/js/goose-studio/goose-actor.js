// ============================================================
// GOOSE ACTOR — one dressed goose for the Goose Studio tools (wardrobe + stage)
// ============================================================
//
// Loads an in-game rider GLB (tandem-3d/goose/<name>.glb) plus its studio clips
// (tandem-3d/goose/show/<name>_clips.glb + .json, baked by tandemonium-claude-3d scripts/show_clips.py)
// and layers, every frame:
//   1. body clips (walk / turns / gestures) played as SEGMENTS back to back -- every clip starts and ends at
//      the rest pose (turns: rest rotated by yaw_end), so they chain without blending; idle_shift fills gaps.
//      Walk clips carry root motion on the Hips; it is stripped and moves the actor instead (feet planted).
//   2. face: blinks (the rider's blink clip on the lids), honk (its honk clip: jaw + tongue, neck additive),
//      look-at (eyes lead, head and upper neck follow with a lag; saccades while the target is still).
//   3. spring bones on the cloth chains (coat tails, skirts) and the tail: secondary motion, no cloth sim (D4).
// Wardrobe: every garment is its own mesh; "<piece>__<a+b>" sub-meshes are hidden while any of a, b is worn
// (dress_goose.py). Hats ride the HatSocket bone here (re-weighted from Head) so a hat tip can lift them,
// and hats / neckwear can be borrowed from another goose (re-bound to this skeleton by bone name).

import * as THREE from 'three';
import { applyColourway, colourwayParams } from '../goose-colourways.js';

export const GOOSE_DIR = '../tandem-3d/goose/';

/** The eight in-game geese: pair (Goose Outfits key) + seat (colourway params); pieceLabels renames a piece for this goose. */
export const GEESE = {
  goose_captain: { label: 'Gent', pair: 'victorian', seat: 'Captain', sex: 'm' },
  goose_stoker_victorian: { label: 'Lady in tweed', pair: 'victorian', seat: 'Stoker', sex: 'f' },
  goose_captain_cyclist: { label: 'Cyclist', pair: 'cyclists', seat: 'Captain', sex: 'm' },
  goose_stoker_cyclist: { label: 'Lady cyclist', pair: 'cyclists', seat: 'Stoker', sex: 'f' },
  goose_captain_fancy: { label: 'Victorian gent', pair: 'fancy', seat: 'Captain', sex: 'm' },
  goose_stoker: { label: 'Lady in red', pair: 'fancy', seat: 'Stoker', sex: 'f' },
  goose_captain_georgian: { label: 'Georgian gent', pair: 'georgian', seat: 'Captain', sex: 'm' },
  goose_stoker_georgian: { label: 'Lady in damask', pair: 'georgian', seat: 'Stoker', sex: 'f',
    pieceLabels: { bowtie: 'Choker', cuffs: 'Sleeve flounces', lace: 'Lace ruffles' } },
};

const FACE = new Set(['Jaw', 'Tongue', 'LeftEye', 'RightEye', 'LeftEyelidUpper', 'LeftEyelidLower',
  'RightEyelidUpper', 'RightEyelidLower']);
const NOT_GARMENT = /^(body|eyeball|lid_|catchlight)/;
const trackBone = (name) => name.slice(0, name.lastIndexOf('.'));

// shared eye asset (tandemonium-claude-3d out/base-goose/base_rig.json): rest gaze of the left eye bone,
// Blender (0.022, -0.012, -0.0026) -> three (x, z, -y); the right eye is the mirror
const EYE_GAZE = { LeftEye: new THREE.Vector3(0.022, -0.0026, 0.012).normalize(),
  RightEye: new THREE.Vector3(-0.022, -0.0026, 0.012).normalize() };

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const IDENT = new THREE.Quaternion();

function clampQuat(q, maxRad) {
  const a = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
  if (a > maxRad) q.slerpQuaternions(IDENT, q, maxRad / a);
  return q;
}

/** Rotate a bone by a WORLD-space rotation q (about its own pivot), keeping its parent fixed. */
function rotateBoneWorld(bone, q) {
  bone.parent.getWorldQuaternion(_q2);
  bone.getWorldQuaternion(_q);
  _q.premultiply(q);                       // new world rotation
  bone.quaternion.copy(_q2.invert().multiply(_q));
  bone.updateMatrixWorld(true);
}

/** Seeded random (mulberry32): reels must replay identically. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleCurve(c, t) {
  const { times, values } = c;
  if (t <= times[0]) return values[0];
  for (let i = 1; i < times.length; i++) {
    if (t <= times[i]) {
      const u = (t - times[i - 1]) / (times[i] - times[i - 1]);
      return values[i - 1] + (values[i] - values[i - 1]) * u;
    }
  }
  return values[values.length - 1];
}

export class GooseActor {
  /**
   * @param {import('three/addons/loaders/GLTFLoader.js').GLTFLoader} loader
   * @param {string} name a GEESE key
   * @param {{dir?: string, random?: () => number}} [opts]
   */
  static async load(loader, name, opts = {}) {
    const dir = opts.dir || GOOSE_DIR;
    const [gltf, clips, meta] = await Promise.all([
      loader.loadAsync(dir + name + '.glb'),
      loader.loadAsync(dir + 'show/' + name + '_clips.glb'),
      fetch(dir + 'show/' + name + '_clips.json').then(r => r.json()),
    ]);
    return new GooseActor(name, gltf, clips.animations, meta, opts);
  }

  constructor(name, gltf, showClips, meta, opts = {}) {
    this.name = name;
    this.info = GEESE[name] || { label: name, pair: 'victorian', seat: 'Captain' };
    this.gltf = gltf;
    this.meta = meta;
    this.random = opts.random || Math.random;
    this.root = new THREE.Group();          // moved / turned by root motion and the director
    this.root.name = 'actor_' + name;
    this.model = gltf.scene;
    this.root.add(this.model);
    this.heading = 0;                       // radians about +Y; 0 = facing +Z
    this.model.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
    });
    this.bones = {};
    this.model.traverse((o) => { if (o.isBone) this.bones[o.name] = o; });
    this.rig = (this.bones.Hips && this.bones.Hips.parent) || this.model;   // the armature node (name varies)
    this.mixer = new THREE.AnimationMixer(this.model);

    this._prepGarments();
    this._prepClips(showClips);
    this._prepFace();
    this._prepSprings();

    this.queue = [];          // pending segments
    this.cur = null;          // playing segment
    this.idleW = 1;           // idle_shift weight (fades out under a segment, back in after)
    this.idleT = 0;
    this.time = 0;
  }

  // ---------------------------------------------------------------- wardrobe
  _prepGarments() {
    this.parts = {};          // node name -> node (direct children of the rig)
    // node names lose Blender's '.001' duplicate suffix as '001' (GLTFLoader sanitizes the dot): canonicalise
    for (const c of this.rig.children) if (!c.isBone) this.parts[c.name.replace(/(\D)\d{3}$/, '$1')] = c;
    this.pieces = Object.keys(this.parts).filter(n => !n.includes('__') && !NOT_GARMENT.test(n));
    this.worn = new Set(this.pieces);
    this.borrowed = {};       // piece -> {node, from}
    this._hatToSocket(this.parts.hat);
    this.applyWorn();
  }

  /** Re-weight a hat from Head to HatSocket (same rest frame), so clips can lift it off the head. */
  _hatToSocket(node) {
    if (!node || !this.bones.HatSocket) return;
    node.traverse((m) => {
      if (!m.isSkinnedMesh) return;
      const bones = m.skeleton.bones;
      const head = bones.findIndex(b => b.name === 'Head');
      const sock = bones.findIndex(b => b.name === 'HatSocket');
      if (head < 0 || sock < 0) return;
      const si = m.geometry.attributes.skinIndex;
      for (let i = 0; i < si.array.length; i++) if (si.array[i] === head) si.array[i] = sock;
      si.needsUpdate = true;
    });
  }

  applyWorn() {
    for (const [name, node] of Object.entries(this.parts)) {
      const [base, cover] = name.split('__');
      const baseOn = base === 'body' || this.worn.has(base);
      node.visible = baseOn && !(cover && cover.split('+').some(p => this.worn.has(p) || this.borrowed[p]));
      if (this.borrowed[base]) node.visible = false;           // own piece replaced by a borrowed one
    }
    for (const [piece, b] of Object.entries(this.borrowed)) b.node.visible = this.worn.has(piece);
  }

  setWorn(piece, on) {
    if (on) this.worn.add(piece); else this.worn.delete(piece);
    this.applyWorn();
  }

  wearAll(on = true) {
    this.worn = new Set(on ? [...this.pieces, ...Object.keys(this.borrowed)] : []);
    this.applyWorn();
  }

  /** Wear another goose's hat / neckwear (null = give it back and wear our own). */
  borrow(piece, other) {
    const old = this.borrowed[piece];
    if (old) { this.rig.remove(old.node); delete this.borrowed[piece]; }
    if (other && other !== this && other.parts[piece]) {
      const src = other.parts[piece];
      const node = src.clone(true);
      node.traverse((m) => {
        if (!m.isSkinnedMesh) return;
        const sk = m.skeleton;
        const bones = sk.bones.map(b => this.bones[b.name] || this.bones.Head);
        m.material = Array.isArray(m.material) ? m.material.map(x => x.clone()) : m.material.clone();
        m.geometry = m.geometry.clone();
        m.bind(new THREE.Skeleton(bones, sk.boneInverses.map(x => x.clone())), m.bindMatrix);
        m.castShadow = true; m.frustumCulled = false;
      });
      this.rig.add(node);
      this.borrowed[piece] = { node, from: other.name };
      if (piece === 'hat') this._hatToSocket(node);
      this.worn.add(piece);
    }
    this.applyWorn();
  }

  setColourway(key) {
    const p = colourwayParams(this.info.pair, key)[this.info.seat] || {};
    applyColourway(this.model, p);
    this.colourway = key;
  }

  // ---------------------------------------------------------------- clips
  _prepClips(showClips) {
    const hips = this.bones.Hips;
    this.hipsRestZ = hips ? hips.position.z : 0;
    this.clips = {};
    for (const clip of showClips) {
      const info = this.meta.clips[clip.name] || { duration: clip.duration, loop: false };
      const c = clip.clone();
      c.tracks = c.tracks.filter((t) => {
        const b = trackBone(t.name);
        if (FACE.has(b) || !this.bones[b]) return false;
        if (t.name.endsWith('.scale')) return b.startsWith('Cloth_');
        if (t.name.endsWith('.position')) return b === 'Hips' || b === 'HatSocket';
        return true;
      });
      let root = null;
      if (info.root_speed || info.root_dist) {
        const t = c.tracks.find(x => x.name === 'Hips.position');
        if (t) {
          const values = [];
          for (let i = 0; i < t.times.length; i++) {
            values.push(t.values[i * 3 + 2] - this.hipsRestZ);
            t.values[i * 3 + 2] = this.hipsRestZ;
          }
          root = { times: Array.from(t.times), values };
        }
      }
      const action = this.mixer.clipAction(c);
      action.play();
      action.paused = true;
      action.weight = 0;
      this.clips[clip.name] = { clip: c, action, info, root, dur: info.duration || c.duration };
    }
    this.idle = this.clips.idle_shift;
    if (this.idle) this.idle.action.weight = 1;
  }

  /** Clip names this goose can play. */
  get clipNames() { return Object.keys(this.clips); }

  /**
   * Queue a clip. opts.loops (walk) repeats it; opts.onStart / onEnd callbacks.
   * @returns {Promise<void>} resolves when the segment ends
   */
  play(name, opts = {}) {
    const c = this.clips[name];
    if (!c) return Promise.resolve();
    return new Promise((resolve) => {
      const n = opts.loops || 1;
      for (let i = 0; i < n; i++) {
        this.queue.push({ c, t: 0, onStart: i === 0 ? opts.onStart : null,
          onEnd: i === n - 1 ? () => { if (opts.onEnd) opts.onEnd(); resolve(); } : null });
      }
    });
  }

  /** Walk forward `dist` m (rounded to whole cycles): start + loops + stop. Returns the distance walked. */
  walk(dist) {
    const s = this.clips.walk_start.info.root_dist, e = this.clips.walk_stop.info.root_dist;
    const cyc = this.clips.walk.info.root_speed * this.clips.walk.dur;
    const loops = Math.max(0, Math.round((dist - s - e) / cyc));
    this.play('walk_start');
    if (loops) this.play('walk', { loops });
    const done = this.play('walk_stop');
    return { distance: s + e + loops * cyc, done, duration: this.walkDuration(loops) };
  }

  walkDuration(loops) {
    return this.clips.walk_start.dur + loops * this.clips.walk.dur + this.clips.walk_stop.dur;
  }

  static walkDistance(meta, loops) {
    const c = meta.clips;
    return c.walk_start.root_dist + c.walk_stop.root_dist + loops * c.walk.root_speed * c.walk.duration;
  }

  /** Turn to face a heading (radians) with 90-degree turn clips. */
  turnTo(heading) {
    let d = THREE.MathUtils.radToDeg(heading - this.heading);
    d = ((d % 360) + 540) % 360 - 180;
    let p = Promise.resolve();
    while (Math.abs(d) > 45) {
      p = this.play(d > 0 ? 'turn_L90' : 'turn_R90');
      d -= d > 0 ? 90 : -90;
    }
    return p;
  }

  setHeading(h) {
    this.heading = h;
    this.root.rotation.y = h;
  }

  _advanceSegments(dt) {
    let left = dt;
    while (left > 0) {
      if (!this.cur) {
        if (!this.queue.length) return;
        this.cur = this.queue.shift();
        this.cur.prevRoot = 0;
        if (this.cur.onStart) this.cur.onStart();
      }
      const s = this.cur, c = s.c;
      const step = Math.min(left, c.dur - s.t);
      s.t += step;
      left -= step;
      if (c.root) {
        const r = sampleCurve(c.root, s.t);
        this._moveForward(r - s.prevRoot);
        s.prevRoot = r;
      }
      if (s.t >= c.dur - 1e-6) {
        if (c.info.yaw_end) this.setHeading(this.heading + THREE.MathUtils.degToRad(c.info.yaw_end));
        c.action.weight = 0;
        this.cur = null;
        if (s.onEnd) s.onEnd();
        if (!this.queue.length) break;
      }
    }
  }

  _moveForward(d) {
    this.root.position.x += Math.sin(this.heading) * d;
    this.root.position.z += Math.cos(this.heading) * d;
  }

  // ---------------------------------------------------------------- face
  _prepFace() {
    const byName = n => (this.gltf.animations || []).find(c => c.name === n);
    const cut = (clip, keep) => {
      if (!clip) return null;
      const c = clip.clone();
      c.tracks = c.tracks.filter(t => keep(trackBone(t.name)) && !t.name.endsWith('.scale'));
      return c;
    };
    const lids = b => /Eyelid/.test(b);
    const mouth = b => b === 'Jaw' || b === 'Tongue';
    const neck = b => b === 'Neck' || b === 'Neck1' || b === 'Head';
    const mk = (clip, additive) => {
      if (!clip) return null;
      if (additive) THREE.AnimationUtils.makeClipAdditive(clip);
      const a = this.mixer.clipAction(clip);
      if (additive) a.blendMode = THREE.AdditiveAnimationBlendMode;
      a.play(); a.paused = true; a.weight = 0;
      return a;
    };
    this.blinkA = mk(cut(byName('blink'), lids));
    this.honkMouth = mk(cut(byName('honk'), mouth));
    this.honkNeck = mk(cut(byName('honk'), b => neck(b) && !b.startsWith('Cloth')), true);
    this.blinkDur = byName('blink') ? byName('blink').duration : 0.5;
    this.honkDur = byName('honk') ? byName('honk').duration : 1.25;
    this.blinkT = -1;
    this.nextBlink = 1 + this.random() * 2;
    this.honkT = -1;
    this.onHonk = null;            // (actor) => void, for sound

    // look-at
    this.look = { target: null, eye: new THREE.Vector3(), head: new THREE.Vector3(), headVel: new THREE.Vector3(),
      jitter: new THREE.Vector3(), nextSaccade: 0.5, eyeMax: THREE.MathUtils.degToRad(32),
      headMax: THREE.MathUtils.degToRad(55), headGain: 0.85, weight: 0, want: 0 };
    this.model.updateMatrixWorld(true);
    this.eyeRest = {};
    for (const n of ['LeftEye', 'RightEye']) {
      const b = this.bones[n];
      if (!b) continue;
      b.parent.getWorldQuaternion(_q);
      this.eyeRest[n] = { q: b.quaternion.clone(), gaze: EYE_GAZE[n].clone().applyQuaternion(_q.invert()) };
    }
    const head = this.bones.Head;
    if (head) {
      head.getWorldQuaternion(_q);
      this.beakFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(_q.invert());   // head-space forward
    }
  }

  /** Look at a world point (Vector3, Object3D, or null to look ahead). */
  lookAt(target) {
    this.look.target = target;
    this.look.want = target ? 1 : 0;
    if (target) this.blink();      // a big gaze shift brings a blink
  }

  blink() { if (this.blinkT < 0) this.blinkT = 0; }

  honk() {
    this.honkT = 0;
    if (this.onHonk) this.onHonk(this);
  }

  _targetPos(out) {
    const t = this.look.target;
    if (!t) return null;
    if (t.isObject3D) return t.getWorldPosition(out);
    return out.copy(t);
  }

  _updateFace(dt) {
    // blinks: random 2-6 s apart, sometimes a double
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) {
      this.blink();
      this.nextBlink = 2 + this.random() * 4;
      if (this.random() < 0.2) this.nextBlink = 0.35;
    }
    if (this.blinkA) {
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        this.blinkA.time = Math.min(this.blinkT, this.blinkDur - 1e-3);
        this.blinkA.weight = 1;
        if (this.blinkT >= this.blinkDur) { this.blinkT = -1; this.blinkA.weight = 0; }
      } else this.blinkA.weight = 0;
    }
    for (const a of [this.honkMouth, this.honkNeck]) {
      if (!a) continue;
      if (this.honkT >= 0) { a.time = Math.min(this.honkT, this.honkDur - 1e-3); a.weight = 1; } else a.weight = 0;
    }
    if (this.honkT >= 0) { this.honkT += dt; if (this.honkT >= this.honkDur) this.honkT = -1; }
  }

  _applyLook(dt) {
    const L = this.look;
    L.weight += (L.want - L.weight) * Math.min(1, dt * 4);
    if (L.weight < 1e-3 || !this.bones.Head) return;
    const tp = this._targetPos(_v);
    if (tp) {
      // saccades: small jumps of the eye target while the head settles
      L.nextSaccade -= dt;
      if (L.nextSaccade <= 0) {
        L.jitter.set(this.random() - 0.5, (this.random() - 0.5) * 0.6, this.random() - 0.5).multiplyScalar(0.08);
        L.nextSaccade = 0.4 + this.random() * 1.6;
      }
      L.eye.copy(tp).add(L.jitter);
      // head target: critically damped follow (eyes lead, head lags)
      if (L.head.lengthSq() === 0) L.head.copy(tp);
      const w = 7;
      _v2.copy(tp).sub(L.head).multiplyScalar(w * w).addScaledVector(L.headVel, -2 * w);
      L.headVel.addScaledVector(_v2, dt);
      L.head.addScaledVector(L.headVel, dt);
    }
    this.model.updateMatrixWorld(true);
    // head + upper neck toward the lagged target
    const head = this.bones.Head;
    head.getWorldQuaternion(_q);
    const fwd = this.beakFwd.clone().applyQuaternion(_q);
    const eyesMid = this.bones.LeftEye.getWorldPosition(new THREE.Vector3())
      .add(this.bones.RightEye.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
    const want = L.head.clone().sub(eyesMid).normalize();
    const total = new THREE.Quaternion().setFromUnitVectors(fwd, want);
    clampQuat(total, L.headMax);
    total.slerpQuaternions(IDENT, total, L.headGain * L.weight);
    for (const [n, share] of [['Neck2', 0.2], ['Neck3', 0.3], ['Head', 0.5]]) {
      const b = this.bones[n];
      if (b) rotateBoneWorld(b, new THREE.Quaternion().slerpQuaternions(IDENT, total, share));
    }
    // eyes: the rest, within their range
    for (const n of ['LeftEye', 'RightEye']) {
      const b = this.bones[n], r = this.eyeRest[n];
      if (!b || !r) continue;
      b.parent.getWorldQuaternion(_q);
      const pos = b.getWorldPosition(new THREE.Vector3());
      const d = L.eye.clone().sub(pos).normalize().applyQuaternion(_q.clone().invert());
      const qd = new THREE.Quaternion().setFromUnitVectors(r.gaze, d);
      clampQuat(qd, L.eyeMax);
      qd.slerpQuaternions(IDENT, qd, L.weight);
      b.quaternion.copy(qd).multiply(r.q);
    }
  }

  // ---------------------------------------------------------------- springs
  _prepSprings() {
    this.springs = [];
    const names = Object.keys(this.bones).filter(n => n.startsWith('Cloth_') || n === 'Tail').sort();
    for (const n of names) {
      const b = this.bones[n];
      const child = b.children.find(c => c.isBone);
      let axis, len;
      if (child) { axis = child.position.clone(); len = axis.length(); axis.normalize(); }
      else {
        const p = b.parent;
        const sib = p && p.isBone && p.name.startsWith('Cloth_') ? b.position.clone() : new THREE.Vector3(0, 1, 0);
        len = Math.max(0.08, sib.length() || 0.15); axis = new THREE.Vector3(0, 1, 0);
      }
      const tail = n === 'Tail';
      this.springs.push({ b, axis, len, pos: null, vel: new THREE.Vector3(),
        k: tail ? 160 : 70, damp: tail ? 14 : 7, gain: tail ? 0.7 : 1 });
    }
    this.springsOn = true;
  }

  _applySprings(dt) {
    if (!this.springsOn || !this.springs.length) return;
    this.model.updateMatrixWorld(true);
    const sub = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / sub;
    for (const s of this.springs) {
      const head = s.b.getWorldPosition(new THREE.Vector3());
      s.b.getWorldQuaternion(_q);
      const goal = s.axis.clone().applyQuaternion(_q).multiplyScalar(s.len).add(head);
      if (!s.pos || dt <= 0 || dt > 0.25) { s.pos = goal.clone(); s.vel.set(0, 0, 0); continue; }
      for (let i = 0; i < sub; i++) {
        _v.copy(goal).sub(s.pos).multiplyScalar(s.k).addScaledVector(s.vel, -s.damp);
        _v.y -= 1.5;                                   // a little gravity
        s.vel.addScaledVector(_v, h);
        s.pos.addScaledVector(s.vel, h);
        _v2.copy(s.pos).sub(head).setLength(s.len);   // keep the bone length
        s.pos.copy(head).add(_v2);
      }
      const from = goal.sub(head).normalize(), to = s.pos.clone().sub(head).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(from, to);
      clampQuat(q, THREE.MathUtils.degToRad(40));
      q.slerpQuaternions(IDENT, q, s.gain);
      rotateBoneWorld(s.b, q);
    }
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    this.time += dt;
    this._advanceSegments(dt);
    const s = this.cur;
    const busy = !!s || this.queue.length > 0;
    // idle fades out under a segment (0.2 s) and back in after
    this.idleW += ((busy ? 0 : 1) - this.idleW) * Math.min(1, dt * (busy ? 12 : 3));
    for (const c of Object.values(this.clips)) if (c !== this.idle && (!s || c !== s.c)) c.action.weight = 0;
    if (s) { s.c.action.time = Math.min(s.t, s.c.dur - 1e-4); s.c.action.weight = 1; }
    if (this.idle) {
      this.idleT = (this.idleT + dt) % this.idle.dur;
      this.idle.action.time = this.idleT;
      this.idle.action.weight = s ? Math.max(0, this.idleW) * 0.999 : 1;
      if (s && this.idleW < 0.02) this.idle.action.weight = 0;
    }
    this._updateFace(dt);
    this.mixer.update(0);
    this._applyLook(dt);
    this._applySprings(dt);
  }

  /** World position of the head (for cameras and other geese to look at). */
  headPosition(out = new THREE.Vector3()) {
    const b = this.bones.Head;
    return b ? b.getWorldPosition(out) : this.root.getWorldPosition(out);
  }
}
