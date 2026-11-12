// ============================================================
// PRESENT STACK — the ride's presents piled up at Grandma's (#478)
// ============================================================
//
// After the finish line on Grandma's and Today's Road, every present the
// riders collected flies off the bike, one after another, and lands in a
// neat pile beside Grandma. The pile's size is the ride's haul.
//
// The layout and the flight are pure functions (unit-tested); PresentStack
// draws them as one InstancedMesh. Tuning knobs are in STACK below.
// ============================================================

import * as THREE from 'three';
import { buildPresentGeometry, presentMaterial, PRESENT } from './props-3d.js';

export const STACK = {
  /** Presents in the pile are this size of the ones on the road. */
  scale: 0.72,
  /** Gap between neighbouring presents (fraction of a present's width). */
  gap: 0.08,
  /** Seconds between one present leaving the bike and the next. */
  stagger: 0.1,
  /** Seconds a present is in the air. */
  flight: 0.75,
  /** Extra height of the arc above the higher of its two ends (world units). */
  arc: 1.6,
  /** Seconds of the little squash when it lands. */
  settle: 0.18,
  /** Most presents a ride can hold (Today's Road on Daredevil tops out at ~27). */
  max: 40,
};

const W = PRESENT.W * STACK.scale;       // one present's footprint
const H = PRESENT.H * STACK.scale;       // and height (its bow pokes into the one above; fine)

/** Pseudo-random in [0,1) from an integer, for the pile's small jitter. */
function hash01(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The pyramid size for n presents: the smallest k with 1² + 2² + … + k² ≥ n.
 * @param {number} n
 */
export function pyramidBase(n) {
  let k = 0, cap = 0;
  while (cap < n) { k++; cap += k * k; }
  return k;
}

/**
 * Where each of n presents sits in the pile, in the pile's own frame (origin
 * on the ground at its centre). A stepped pyramid: the bottom layer is
 * k × k, each layer above one smaller and centred on the gaps below, filled
 * bottom-up and centre-out so a part-built pile still looks deliberate.
 *
 * @param {number} n
 * @returns {Array<{x:number, y:number, z:number, yaw:number, layer:number}>}
 *   y is the present's centre height
 */
export function pileSlots(n) {
  n = Math.max(0, Math.min(STACK.max, Math.floor(n)));
  if (n === 0) return [];
  const k = pyramidBase(n);
  const step = W * (1 + STACK.gap);
  const out = [];
  for (let layer = 0; layer < k && out.length < n; layer++) {
    const m = k - layer;                        // this layer is m × m
    const cells = [];
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) {
      cells.push({ x: (i - (m - 1) / 2) * step, z: (j - (m - 1) / 2) * step });
    }
    // centre-out, ties broken front-to-back then left-to-right (stable)
    cells.sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z) || a.z - b.z || a.x - b.x);
    for (const c of cells) {
      if (out.length >= n) break;
      const idx = out.length;
      out.push({
        x: c.x + (hash01(idx) - 0.5) * 0.04,
        y: H / 2 + layer * H,
        z: c.z + (hash01(idx + 50) - 0.5) * 0.04,
        yaw: (hash01(idx + 100) - 0.5) * 0.5,
        layer,
      });
    }
  }
  return out;
}

/**
 * Where present i is, t seconds after the stack started, flying from `from`
 * to `to` (both in the pile's frame). Before its turn it is at `from` and
 * hidden; after landing it sits at `to`.
 *
 * @returns {{x:number,y:number,z:number, spin:number, s:number, visible:boolean, landed:boolean}}
 *   spin: extra yaw/tumble while in the air; s: scale (squash on landing)
 */
export function flightAt(i, t, from, to) {
  const t0 = i * STACK.stagger;
  const u = (t - t0) / STACK.flight;
  if (u <= 0) return { x: from.x, y: from.y, z: from.z, spin: 0, s: 0.4, visible: false, landed: false };
  if (u >= 1) {
    const k = Math.min(1, (t - t0 - STACK.flight) / STACK.settle);
    const squash = 1 - 0.18 * Math.sin(k * Math.PI);
    return { x: to.x, y: to.y, z: to.z, spin: 0, s: squash, visible: true, landed: true };
  }
  const e = u;                                   // linear along, parabolic up
  const top = Math.max(from.y, to.y) + STACK.arc;
  // a parabola through from (u=0), top (u≈0.5) and to (u=1)
  const y = (1 - e) * (1 - e) * from.y + 2 * e * (1 - e) * (2 * top - (from.y + to.y) / 2) + e * e * to.y;
  return {
    x: from.x + (to.x - from.x) * e,
    y,
    z: from.z + (to.z - from.z) * e,
    spin: (1 - e) * Math.PI * 2.5,
    s: 0.55 + 0.45 * Math.min(1, e * 3),
    visible: true,
    landed: false,
  };
}

/** Seconds from start until the last of n presents has landed and settled. */
export function stackDuration(n) {
  if (n <= 0) return 0;
  return (Math.min(n, STACK.max) - 1) * STACK.stagger + STACK.flight + STACK.settle;
}

/**
 * The pile itself: a Group (place it beside Grandma) holding one
 * InstancedMesh. start(n, fromWorld) launches n presents from a world
 * position (the bike); update(dt) flies them in.
 */
export class PresentStack {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'present-stack';
    this._geo = buildPresentGeometry();
    this._mat = presentMaterial();
    this.mesh = new THREE.InstancedMesh(this._geo, this._mat, STACK.max);
    this.mesh.name = 'present-stack-presents';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.group.add(this.mesh);
    this.count = 0;          // presents in this pile (once started)
    this.t = 0;
    this.running = false;
    this._slots = [];
    this._from = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._sc = new THREE.Vector3();
  }

  /**
   * Fly n presents in from a world position. Calling it again adds a new
   * batch on top (another bike finishing) — the pile is rebuilt for the new
   * total and the earlier presents stay put where they still fit.
   * @param {number} n @param {THREE.Vector3|{x:number,y:number,z:number}} fromWorld
   */
  start(n, fromWorld) {
    n = Math.max(0, Math.min(STACK.max - this.count, Math.floor(n || 0)));
    if (n === 0) return;
    this.group.updateMatrixWorld(true);
    const from = this.group.worldToLocal(new THREE.Vector3(fromWorld.x, fromWorld.y + 1.4, fromWorld.z));
    const before = this.count;
    this.count += n;
    this._slots = pileSlots(this.count);
    // each present remembers its own batch's start time and origin
    if (!this._batches) this._batches = [];
    this._batches.push({ first: before, n, t0: this.t, from });
    this.running = true;
    this._write();
  }

  update(dt) {
    if (!this.running) return;
    this.t += dt;
    this._write();
    const last = this._batches[this._batches.length - 1];
    if (this.t - last.t0 > stackDuration(last.n) + 0.05) this.running = false;
  }

  /** Every present that has landed (tests). */
  landedCount() {
    let n = 0;
    for (const b of this._batches || []) {
      for (let i = 0; i < b.n; i++) if (flightAt(i, this.t - b.t0, b.from, this._slots[b.first + i]).landed) n++;
    }
    return n;
  }

  _write() {
    let k = 0;
    for (const b of this._batches || []) {
      for (let i = 0; i < b.n; i++) {
        const slot = this._slots[b.first + i];
        const f = flightAt(i, this.t - b.t0, b.from, slot);
        if (!f.visible) continue;
        this._e.set(f.spin * 0.35, slot.yaw + f.spin, f.spin * 0.2);
        this._q.setFromEuler(this._e);
        const s = STACK.scale * f.s;
        this._sc.set(s * (f.landed ? 2 - f.s : 1), s, s * (f.landed ? 2 - f.s : 1));
        this._m.compose(this._v.set(f.x, f.y, f.z), this._q, this._sc);
        this.mesh.setMatrixAt(k++, this._m);
      }
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.dispose();
    this._geo.dispose();
    this._mat.dispose();
  }
}
