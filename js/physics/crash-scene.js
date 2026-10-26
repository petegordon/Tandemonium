// ============================================================
// CRASH SCENE — one crash: the tumbling bike, two goose rag dolls, two hats (#484)
// ============================================================
//
// Every crash gets its own small Rapier world, built on the impact frame and
// freed when the riders are put back on the bike at the checkpoint. Its own
// world (not the shared DebrisWorld) for two reasons:
//   - it is stepped with the CRASHING VIEW's dt, so the slow-mo moment slows
//     this crash only (in split-screen versus the other team's crash, pylons
//     and geese keep real time);
//   - the bodies are joined, and need a real ground under a goose thrown
//     several metres, not DebrisWorld's 3 m per-body patches.
//
// Visual only, like everything in js/physics: it drives the bike group's
// transform and the riders' bones, and never reads or writes lean, speed,
// position or anything the netcode carries.
//
// ── Driving bones ──
// A segment's body starts exactly where its bone is; we remember the bone's
// world matrix relative to the body (O = B0^-1 * M0), and every step set the
// bone so its world matrix is B * O. Bones between driven bones keep their
// seated local pose. Hats ride their HatSocket bone (GooseRiders rebinds the
// hat's skin from Head to HatSocket), driven by a body of their own.
// ============================================================

import * as THREE from 'three';
import { segmentsFor, throwFor, hatThrow } from './ragdoll-spec.js';

const GROUND = 1, DEBRIS = 2;   // collision membership bits
const grp = (member, filter) => ((member << 16) | filter) >>> 0;
const GROUND_GROUPS = grp(GROUND, DEBRIS);
const DEBRIS_GROUPS = grp(DEBRIS, GROUND);     // debris meets the ground, never itself (no tangles)

const GROUND_HALF = 14;   // metres of ground sampled around the crash, each way
const GROUND_STEP = 1;
const SUBSTEP = 1 / 120;  // the joints want small steps; slow-mo gets them for free

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _inv = new THREE.Matrix4();
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

function bonesOf(root) {
  const out = {};
  root.traverse((o) => { if (o.isBone && !out[o.name]) out[o.name] = o; });
  return out;
}

function bodyMatrix(body, target) {
  const t = body.translation(), r = body.rotation();
  return target.compose(_p.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), ONE);
}

export class CrashScene {
  /**
   * @param {object} RAPIER initialised Rapier namespace
   * @param {object} o
   * @param {object} o.bike the crashing BikeModel (read BEFORE _fall zeroes its speed)
   * @param {(x:number, z:number) => number} o.groundAt terrain height
   * @param {'full'|'lite'} [o.budget]
   * @param {string} [o.cause] 'balance' | 'obstacle' | 'tree'
   * @param {() => number} [o.rand]
   */
  constructor(RAPIER, { bike, groundAt, budget = 'full', cause = 'balance', rand = Math.random }) {
    this.R = RAPIER;
    this.bike = bike;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = SUBSTEP;
    this.riders = [];      // { seat, rider, snap, segs:[{bone, body, O}], hat:{bone, body, O} }
    this.bodyCount = 0;
    this._acc = 0;
    this.age = 0;

    const speed = bike.speed, heading = bike.heading, lean = bike.lean;
    const fx = Math.sin(heading), fz = Math.cos(heading);
    this._ground(bike.position, groundAt);

    // The bike: the same box and launch the plain tumble uses (physics-fx crashTumble).
    bike.group.updateMatrixWorld(true);
    const roll = (3.2 + speed * 0.35) * (lean >= 0 ? 1 : -1);
    const headOn = cause === 'obstacle' || cause === 'tree';
    const carry = headOn ? 0.3 : 0.55;   // a pylon stops the bike; the geese keep going
    const bq = bike.group.quaternion;
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(bike.group.position.x, bike.group.position.y, bike.group.position.z)
      .setRotation({ x: bq.x, y: bq.y, z: bq.z, w: bq.w })
      .setLinvel(fx * speed * carry, 1.1, fz * speed * carry)
      .setAngvel({ x: fx * roll, y: (rand() - 0.5) * 1.6, z: fz * roll })
      .setLinearDamping(0.55).setAngularDamping(0.9).setCcdEnabled(true);
    this.bikeBody = this.world.createRigidBody(bd);
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.28, 0.55, 1.35).setTranslation(0, 0.55, 0)
      .setFriction(1.1).setRestitution(0.12).setCollisionGroups(DEBRIS_GROUPS), this.bikeBody);
    this.bodyCount++;

    const riders = (bike.goose && bike.goose.riders) || {};
    for (const [seat, rider] of Object.entries(riders)) {
      if (!rider || !rider.root) continue;
      const t = throwFor({ seat, cause, speed, heading, lean, rand });
      const r = this._ragdoll(seat, rider, segmentsFor(budget), t, rand);
      if (r) this.riders.push(r);
    }
  }

  /** A terrain-following trimesh around the crash: geese land on the road's real height. */
  _ground(pos, groundAt) {
    const R = this.R, n = Math.round((2 * GROUND_HALF) / GROUND_STEP) + 1;
    const verts = new Float32Array(n * n * 3), idx = new Uint32Array((n - 1) * (n - 1) * 6);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = pos.x - GROUND_HALF + i * GROUND_STEP, z = pos.z - GROUND_HALF + j * GROUND_STEP;
        const k = (i * n + j) * 3;
        verts[k] = x; verts[k + 1] = groundAt(x, z); verts[k + 2] = z;
      }
    }
    let w = 0;
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < n - 1; j++) {
        const a = i * n + j, b = a + 1, c = a + n, d = c + 1;
        idx[w++] = a; idx[w++] = b; idx[w++] = c;
        idx[w++] = b; idx[w++] = d; idx[w++] = c;
      }
    }
    const ground = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    this.world.createCollider(R.ColliderDesc.trimesh(verts, idx).setFriction(0.9)
      .setCollisionGroups(GROUND_GROUPS), ground);
  }

  _ragdoll(seat, rider, segs, launch, rand) {
    const R = this.R, root = rider.root;
    const bones = bonesOf(root);
    if (!bones.Hips || !bones.Head) return null;
    root.updateMatrixWorld(true);
    // the seated pose, to put back at the checkpoint
    const snap = Object.values(bones).map(b => [b, b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
    const hips = bones.Hips.getWorldPosition(new THREE.Vector3());
    const S = hips.distanceTo(bones.Head.getWorldPosition(new THREE.Vector3())) || 0.6;
    const w = new THREE.Vector3(launch.angvel.x, launch.angvel.y, launch.angvel.z);
    const v0 = new THREE.Vector3(launch.linvel.x, launch.linvel.y, launch.linvel.z);
    const made = {};
    const out = { seat, rider, snap, segs: [], hat: null };
    for (const sg of segs) {
      const bone = bones[sg.bone], end = bones[sg.end];
      if (!bone || !end) continue;
      bone.getWorldPosition(_a);
      end.getWorldPosition(_b);
      const len = _a.distanceTo(_b);
      const rad = Math.max(0.012, sg.r * S);
      const half = Math.max(0.005, len / 2 - rad * 0.5);
      const ctr = _a.clone().add(_b).multiplyScalar(0.5);
      _d.copy(_b).sub(_a);
      const q = len > 1e-5 ? new THREE.Quaternion().setFromUnitVectors(UP, _d.normalize()) : new THREE.Quaternion();
      // leave as one piece: v + w x (p - hips)
      const lv = v0.clone().add(w.clone().cross(ctr.clone().sub(hips)));
      const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic()
        .setTranslation(ctr.x, ctr.y, ctr.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinvel(lv.x, lv.y, lv.z).setAngvel({ x: w.x, y: w.y, z: w.z })
        .setLinearDamping(0.12).setAngularDamping(sg.damp).setCcdEnabled(true));
      this.world.createCollider(R.ColliderDesc.capsule(half, rad).setFriction(0.85).setRestitution(0.15)
        .setCollisionGroups(DEBRIS_GROUPS), body);
      this.bodyCount++;
      const B0 = new THREE.Matrix4().compose(ctr, q, ONE);
      const O = B0.clone().invert().multiply(bone.matrixWorld);
      made[sg.id] = { body, B0, anchor: _a.clone() };
      out.segs.push({ bone, body, O });
      const p = sg.parent && made[sg.parent];
      if (p) {
        const la = _a.clone().applyMatrix4(_inv.copy(p.B0).invert());
        const lb = _a.clone().applyMatrix4(_inv.copy(B0).invert());
        this.world.createImpulseJoint(R.JointData.spherical({ x: la.x, y: la.y, z: la.z }, { x: lb.x, y: lb.y, z: lb.z }),
          p.body, body, true);
      }
    }
    // the hat, if this goose wears one bound to its HatSocket
    const hs = bones.HatSocket;
    if (hs && root.userData.hatOnSocket) {
      hs.getWorldPosition(_a);
      hs.getWorldQuaternion(_q);
      const head = made.head ? made.head.body.linvel() : launch.linvel;
      const t = hatThrow(head, rand);
      const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic()
        .setTranslation(_a.x, _a.y, _a.z).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
        .setLinvel(t.linvel.x, t.linvel.y, t.linvel.z).setAngvel(t.angvel)
        .setLinearDamping(0.3).setAngularDamping(0.6).setCcdEnabled(true));
      this.world.createCollider(R.ColliderDesc.cylinder(0.05 * S, 0.17 * S).setFriction(0.8).setRestitution(0.3)
        .setDensity(0.3).setCollisionGroups(DEBRIS_GROUPS), body);
      this.bodyCount++;
      const B0 = new THREE.Matrix4().compose(_a.clone(), _q.clone(), ONE);
      out.hat = { bone: hs, body, O: B0.clone().invert().multiply(hs.matrixWorld) };
    }
    rider.ragdoll = true;   // GooseRiders.update leaves this goose's bones alone
    return out;
  }

  /** Advance by the crashing view's dt (already slowed in the slow-mo moment) and pose everything. */
  step(dt) {
    if (!this.world) return;
    this.age += dt;
    this._acc = Math.min(this._acc + dt, SUBSTEP * 8);
    // whole substeps, then one partial so a slow-mo frame (dt < SUBSTEP) still moves
    while (this._acc >= SUBSTEP) { this.world.timestep = SUBSTEP; this.world.step(); this._acc -= SUBSTEP; }
    if (this._acc > 1e-5) { this.world.timestep = this._acc; this.world.step(); this._acc = 0; }
    this._pose();
  }

  _pose() {
    const g = this.bike.group, t = this.bikeBody.translation(), r = this.bikeBody.rotation();
    g.position.set(t.x, t.y, t.z);
    g.quaternion.set(r.x, r.y, r.z, r.w);
    g.updateMatrixWorld(true);
    for (const rd of this.riders) {
      for (const s of rd.segs) this._drive(s);
      if (rd.hat) this._drive(rd.hat);
    }
  }

  /** Set a bone so its world matrix is body * O. */
  _drive(s) {
    const parent = s.bone.parent;
    parent.updateWorldMatrix(true, false);
    _m.multiplyMatrices(bodyMatrix(s.body, _m2), s.O);
    _m.premultiply(_inv.copy(parent.matrixWorld).invert());
    _m.decompose(s.bone.position, s.bone.quaternion, s.bone.scale);
    s.bone.updateMatrixWorld(true);
  }

  /** Where each rag doll's pelvis is (tests, the review capture). */
  pelvisPositions() {
    return this.riders.map((rd) => {
      const t = rd.segs.length ? rd.segs[0].body.translation() : null;
      return { seat: rd.seat, x: t ? t.x : 0, y: t ? t.y : 0, z: t ? t.z : 0 };
    });
  }

  /** Put the geese back in their seated pose and free the world. Safe to call twice. */
  dispose() {
    for (const rd of this.riders) {
      for (const [b, p, q, sc] of rd.snap) { b.position.copy(p); b.quaternion.copy(q); b.scale.copy(sc); }
      rd.rider.ragdoll = false;
    }
    this.riders = [];
    if (this.world) { this.world.free(); this.world = null; }
  }
}
