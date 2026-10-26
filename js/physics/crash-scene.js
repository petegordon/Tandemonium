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
import { PARTS, hasParts, visibleMeshesByPart, boundsIn, partLaunch } from './bike-parts.js';
import { hitWobble, onBike, kickSign, aimAt } from '../crash-wobble.js';
import { realSecondsFor, SLOWMO } from '../crash-slowmo.js';

const GROUND = 1, DEBRIS = 2;   // collision membership bits
const grp = (member, filter) => ((member << 16) | filter) >>> 0;
const GROUND_GROUPS = grp(GROUND, DEBRIS);
const DEBRIS_GROUPS = grp(DEBRIS, GROUND);     // debris meets the ground, never itself (no tangles)

// Ground sampled around the crash, each way. A fast head-on throws the captain 10+ m down the road, and
// past the edge a goose would fall forever: the patch reaches well beyond the furthest throw.
const GROUND_HALF = 26;
const GROUND_STEP = 1.0;   // the verge banks steeply off the road edge: a coarser grid cut its corners
const SUBSTEP = 1 / 120;
// (versus) a thrown part must reach the other team this many real seconds after impact: before the cut
const LAND_BY = SLOWMO.downReal - 0.25;  // the joints want small steps; slow-mo gets them for free

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _inv = new THREE.Matrix4();
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _pq = new THREE.Quaternion();
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
   * @param {object[]} [o.others] versus: the OTHER team's bikes (a part that hits one sends it into a wobble)
   * @param {boolean} [o.slowMo] this crash's view runs slow at first (the throw at another team allows for it)
   * @param {boolean} [o.parts] the tandem comes apart (default: whenever the model has the parts rig)
   */
  constructor(RAPIER, { bike, groundAt, budget = 'full', cause = 'balance', rand = Math.random, others = [],
    slowMo = false, parts = true }) {
    this.R = RAPIER;
    this.bike = bike;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = SUBSTEP;
    // the joints hold under a hard throw: more solver iterations than the default
    const ip = this.world.integrationParameters;
    if (ip && 'numSolverIterations' in ip) ip.numSolverIterations = 8;
    this.parts = [];       // { part, body, group, mass, rad } (#484 step 3: the tandem comes apart)
    this._hidden = [];     // the bike's own meshes hidden while their part flies
    this._others = others.filter(o => o && o !== bike && o.group);
    this._hitTeams = new Set();
    this.hits = [];        // [{ part, bike, kick }] (tests, the review capture)
    this.joints = [];      // [parentBody, childBody, anchorInParent, anchorInChild] (the joint-gap check)
    this.riders = [];      // { seat, rider, snap, segs:[{bone, body, O}], hat:{bone, body, O} }
    this.bodyCount = 0;
    this._acc = 0;
    this.age = 0;

    const speed = bike.speed, heading = bike.heading, lean = bike.lean;
    const fx = Math.sin(heading), fz = Math.cos(heading);
    this._ground(bike.position, groundAt);

    // The bike: the plain tumble's box (physics-fx crashTumble). A lean-out rolls over onto its side; a
    // head-on hit stops the front wheel dead, so the bike PITCHES forward over it (an endo, rear wheel up)
    // with a little roll: that is what makes "it hit something" read, rather than just falling over.
    bike.group.updateMatrixWorld(true);
    const headOn = cause === 'obstacle' || cause === 'tree';
    // (with enough roll and little spin damping that it goes on over and topples: a bike left balanced on its
    // front wheel for a second looked staged)
    const roll = (headOn ? 2.6 : 3.2 + speed * 0.35) * (lean >= 0 ? 1 : -1);
    const pitch = headOn ? 3.5 + speed * 0.3 : 0;              // about -right: the top goes forward
    const carry = headOn ? 0.3 : 0.55;   // a pylon stops the bike; the geese keep going
    const bq = bike.group.quaternion;
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(bike.group.position.x, bike.group.position.y, bike.group.position.z)
      .setRotation({ x: bq.x, y: bq.y, z: bq.z, w: bq.w })
      .setLinvel(fx * speed * carry, headOn ? 2.4 : 1.1, fz * speed * carry)
      .setAngvel({ x: fx * roll + fz * pitch, y: (rand() - 0.5) * 1.6, z: fz * roll - fx * pitch })
      .setLinearDamping(0.55).setAngularDamping(headOn ? 0.35 : 0.9).setCcdEnabled(true);
    this.bikeBody = this.world.createRigidBody(bd);
    const model = bike.group.children[0];
    const byPart = parts && model && hasParts(model) ? visibleMeshesByPart(model) : null;
    const fb = byPart ? boundsIn(byPart.frame, bike.group.matrixWorld) : null;
    if (fb) {
      // the frame alone (the wheels are leaving): its own box, so it lies on the road, not on air wheels
      const c = fb.getCenter(new THREE.Vector3()), h = fb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(Math.max(0.06, h.x), Math.max(0.08, h.y), Math.max(0.3, h.z))
        .setTranslation(c.x, c.y, c.z).setFriction(1.1).setRestitution(0.12).setCollisionGroups(DEBRIS_GROUPS), this.bikeBody);
    } else {
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.28, 0.55, 1.35).setTranslation(0, 0.55, 0)
        .setFriction(1.1).setRestitution(0.12).setCollisionGroups(DEBRIS_GROUPS), this.bikeBody);
    }
    this.bodyCount++;
    if (byPart) {
      // the bare frame is light and narrow: with the tumble's spin damping it could balance on its end for a
      // second (it looked staged). Less damping and a nudge about its length, so it goes over.
      this.bikeBody.setAngularDamping(0.25);
      const av = this.bikeBody.angvel();
      this.bikeBody.setAngvel({ x: av.x + fx * 1.5 * (lean >= 0 ? 1 : -1), y: av.y, z: av.z + fz * 1.5 * (lean >= 0 ? 1 : -1) }, true);
      this._detach(byPart, { headOn, speed, heading, lean, rand, slowMo });
    }

    const riders = (bike.goose && bike.goose.riders) || {};
    for (const [seat, rider] of Object.entries(riders)) {
      if (!rider || !rider.root) continue;
      const t = throwFor({ seat, cause, speed, heading, lean, rand });
      const r = this._ragdoll(seat, rider, segmentsFor(budget), t, rand);
      if (r) { this._lift(r); this.riders.push(r); }
    }
  }

  /**
   * A lean-out leaves the bike lying on the verge, often lower than the road height the ground is sampled
   * from, so a goose can start partly UNDER the ground, and a body that starts under it stays there. Lift
   * the whole rag doll (and its hat) clear on the impact frame; at most 2 m, mid-launch nobody sees it.
   */
  _lift(rd) {
    let dy = 0;
    for (const sg of rd.segs) {
      const t = sg.body.translation();
      dy = Math.max(dy, this.groundHeight(t.x, t.z) + sg.rad - t.y);
    }
    dy = Math.min(dy, 2);
    if (dy <= 0) return;
    for (const b of [...rd.segs.map(sg => sg.body), ...(rd.hat ? [rd.hat.body] : [])]) {
      const t = b.translation();
      b.setTranslation({ x: t.x, y: t.y + dy + 0.01, z: t.z }, true);
    }
  }

  /**
   * The terrain around the crash as a Rapier HEIGHTFIELD: solid below its surface, so a thin limb shoved
   * under it by a joint is pushed back up (a trimesh has no inside, and limbs fell through it on the verge).
   * Rapier's heightfield is centred on its body, spans scale.x by scale.z, and reads heights[row + col *
   * (nrows + 1)] with rows along Z and columns along X.
   */
  _ground(pos, groundAt) {
    const R = this.R, n = Math.round((2 * GROUND_HALF) / GROUND_STEP);   // cells per side
    const span = n * GROUND_STEP;
    const heights = new Float32Array((n + 1) * (n + 1));
    for (let col = 0; col <= n; col++) {
      for (let row = 0; row <= n; row++) {
        const x = pos.x - span / 2 + col * GROUND_STEP, z = pos.z - span / 2 + row * GROUND_STEP;
        heights[row + col * (n + 1)] = groundAt(x, z);
      }
    }
    this._hf = { x0: pos.x - span / 2, z0: pos.z - span / 2, n, heights };
    const ground = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(pos.x, 0, pos.z));
    this.world.createCollider(R.ColliderDesc.heightfield(n, n, heights, { x: span, y: 1, z: span }).setFriction(0.9)
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
      // only the pelvis is placed; every other bone is only TURNED (rotOnly), so a goose can't come apart
      const pw = bone.parent && bone.parent.isBone ? bone.parent.getWorldPosition(new THREE.Vector3()) : null;
      out.segs.push({ bone, body, O, rad, rotOnly: !!sg.parent, rest: pw ? bone.getWorldPosition(new THREE.Vector3()).distanceTo(pw) : null });
      const p = sg.parent && made[sg.parent];
      if (p) {
        const la = _a.clone().applyMatrix4(_inv.copy(p.B0).invert());
        const lb = _a.clone().applyMatrix4(_inv.copy(B0).invert());
        this.world.createImpulseJoint(R.JointData.spherical({ x: la.x, y: la.y, z: la.z }, { x: lb.x, y: lb.y, z: lb.z }),
          p.body, body, true);
        this.joints.push([p.body, body, la, lb]);
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

  /**
   * #484 step 3: the wheels, the bars and the saddles leave the frame, each its own body. The bike's own
   * meshes for those parts are hidden and a copy of each (same geometry and material: no new GPU memory, the
   * same draw calls) rides the part's body until the checkpoint puts the bike back together.
   */
  _detach(byPart, { headOn, speed, heading, lean, rand, slowMo }) {
    const R = this.R, gw = this.bike.group.matrixWorld, root = this.bike.group.parent;
    if (!root) return;
    const gq = this.bike.group.quaternion;
    const fwd = { x: Math.sin(heading), z: Math.cos(heading) };
    const right = { x: Math.cos(heading), z: -Math.sin(heading) };   // the bike's own +x
    const side = lean >= 0 ? -1 : 1;                                   // the side it falls to, in +x terms
    const bv = this.bikeBody.linvel(), bw = this.bikeBody.angvel(), bt = this.bikeBody.translation();
    const c = new THREE.Vector3(), h = new THREE.Vector3();
    for (const part of Object.keys(PARTS)) {
      const meshes = byPart[part];
      const b = meshes && meshes.length ? boundsIn(meshes, gw) : null;
      if (!b) continue;
      b.getCenter(c); b.getSize(h).multiplyScalar(0.5);
      const wc = c.clone().applyMatrix4(gw);
      const B0 = new THREE.Matrix4().compose(wc, gq, ONE);
      const inv = B0.clone().invert();
      const group = new THREE.Group();
      group.name = 'crashPart_' + part;
      for (const m of meshes) {
        const k = new THREE.Mesh(m.geometry, m.material);
        k.castShadow = m.castShadow; k.receiveShadow = m.receiveShadow;
        k.matrixAutoUpdate = false;
        k.matrix.multiplyMatrices(inv, m.matrixWorld);
        group.add(k);
        m.visible = false;
        this._hidden.push(m);
      }
      group.position.copy(wc); group.quaternion.copy(gq);
      root.add(group);
      const wheel = PARTS[part].kind === 'wheel';
      const rad = wheel ? Math.max(h.y, h.z) : Math.max(h.x, h.y, h.z);
      const L = partLaunch({ part, how: headOn ? 'head-on' : 'lean', speed, fwd, side, right, radius: rad, rand });
      // plus some of the frame's own motion at that point (v + w x r), so the parts leave the bike as it moves
      const rx = wc.x - bt.x, ry = wc.y - bt.y, rz = wc.z - bt.z;
      const lv = {
        x: L.linvel.x + bv.x * 0.5 + (bw.y * rz - bw.z * ry) * 0.3,
        y: L.linvel.y + bv.y * 0.5 + (bw.z * rx - bw.x * rz) * 0.3,
        z: L.linvel.z + bv.z * 0.5 + (bw.x * ry - bw.y * rx) * 0.3,
      };
      const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic()
        .setTranslation(wc.x, wc.y, wc.z).setRotation({ x: gq.x, y: gq.y, z: gq.z, w: gq.w })
        .setLinvel(lv.x, lv.y, lv.z).setAngvel(L.angvel)
        .setLinearDamping(wheel ? 0.15 : 0.3).setAngularDamping(wheel ? 0.08 : 0.5).setCcdEnabled(true));
      const cd = wheel
        // a cylinder's axis is its Y: turn it onto the axle (the bike's x)
        ? R.ColliderDesc.cylinder(Math.max(0.03, h.x), Math.max(0.15, rad))
          .setRotation({ x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 }).setFriction(1.2).setRestitution(0.35)
        : R.ColliderDesc.cuboid(Math.max(0.03, h.x), Math.max(0.03, h.y), Math.max(0.03, h.z))
          .setFriction(0.8).setRestitution(0.25);
      this.world.createCollider(cd.setMass(PARTS[part].mass).setCollisionGroups(DEBRIS_GROUPS), body);
      this.bodyCount++;
      this.parts.push({ part, body, group, mass: PARTS[part].mass, rad });
    }
    if (this._others.length) this._aim(rand, slowMo);
  }

  /**
   * Versus: throw one heavy part (the rear wheel; else the bars) at the nearest other team still riding
   * within reach, so the bike coming apart now and then lands on them. A plausible arc, or nothing.
   */
  _aim(rand, slowMo) {
    const t0 = this.bikeBody.translation();
    let best = null, bd = 30;
    for (const o of this._others) {
      if (o.fallen) continue;
      // where it is DRAWN (the group carries the lane offset; bike.position is on the road's line)
      const d = Math.hypot(o.group.position.x - t0.x, o.group.position.z - t0.z);
      if (d < bd) { bd = d; best = o; }
    }
    if (!best) return;
    const p = this.parts.find(x => x.part === 'wheelR') || this.parts.find(x => x.part === 'bars') || this.parts[0];
    if (!p) return;
    const from = p.body.translation();
    const hv = { x: Math.sin(best.heading) * best.speed, z: Math.cos(best.heading) * best.speed };
    // at the riders' middle, a little off so it doesn't look guided
    const gp = best.group.position;
    const tgt = { x: gp.x + (rand() - 0.5) * 0.5, y: gp.y + 1.0, z: gp.z + (rand() - 0.5) * 0.8 };
    // The other team rides on in real time while this crash runs slow, and the whole scene is cleared at the
    // cut to the checkpoint (SLOWMO.downReal after impact). So only flights that land before the cut, and the
    // gentlest of them: a team just ahead at full speed is out of reach; a team beside or behind rides into it.
    let v = null, vs = Infinity;
    for (let T = 0.3; T <= 1.6; T += 0.05) {
      const realT = slowMo ? realSecondsFor(T) : T;
      if (realT > LAND_BY) break;
      const c = aimAt(from, tgt, hv, T, realT);
      const s = c ? Math.hypot(c.x, c.y, c.z) : Infinity;
      if (s < vs) { vs = s; v = c; }
    }
    if (v) { p.body.setLinvel(v, true); this.aimed = { part: p.part, bike: best }; }
  }

  /** Versus: a part that reaches another team's tandem sends it into a wobble (once per team per crash). */
  _hitOthers() {
    for (const o of this._others) {
      if (this._hitTeams.has(o) || o.fallen || !o.group) continue;
      _inv.copy(o.group.matrixWorld).invert();
      for (const p of this.parts) {
        const t = p.body.translation();
        _a.set(t.x, t.y, t.z).applyMatrix4(_inv);
        if (!onBike(_a, Math.min(0.6, p.rad))) continue;
        const v = p.body.linvel();
        const ox = Math.sin(o.heading) * o.speed, oz = Math.cos(o.heading) * o.speed;
        const rel = Math.hypot(v.x - ox, v.y, v.z - oz);
        const w = hitWobble(p.mass, rel);
        this._hitTeams.add(o);
        if (w.kick > 0 && typeof o.addHitWobble === 'function') o.addHitWobble(w.kick * kickSign(_a.x), w.shake);
        this.hits.push({ part: p.part, bike: o, kick: w.kick });
        // it bounced off them: most of its own speed gone, carried along with them
        p.body.setLinvel({ x: ox * 0.6 - (v.x - ox) * 0.25, y: Math.abs(v.y) * 0.3 + 1, z: oz * 0.6 - (v.z - oz) * 0.25 }, true);
        break;
      }
    }
  }

  /** How far the lowest part's centre is above the simulated ground (metres; tests: >= 0 = not sunk). */
  partClearance() {
    let m = Infinity;
    for (const p of this.parts) {
      const t = p.body.translation();
      m = Math.min(m, t.y - this.groundHeight(t.x, t.z));
    }
    return m;
  }

  /** Advance by the crashing view's dt (already slowed in the slow-mo moment) and pose everything. */
  step(dt) {
    if (!this.world) return;
    this.age += dt;
    this._acc = Math.min(this._acc + dt, SUBSTEP * 8);
    // whole substeps, then one partial so a slow-mo frame (dt < SUBSTEP) still moves
    while (this._acc >= SUBSTEP) { this.world.timestep = SUBSTEP; this.world.step(); this._acc -= SUBSTEP; }
    if (this._acc > 1e-5) { this.world.timestep = this._acc; this.world.step(); this._acc = 0; }
    if (this._others.length && this.parts.length) this._hitOthers();
    this._pose();
  }

  _pose() {
    const g = this.bike.group, t = this.bikeBody.translation(), r = this.bikeBody.rotation();
    g.position.set(t.x, t.y, t.z);
    g.quaternion.set(r.x, r.y, r.z, r.w);
    g.updateMatrixWorld(true);
    for (const p of this.parts) {
      const pt = p.body.translation(), pr = p.body.rotation();
      p.group.position.set(pt.x, pt.y, pt.z);
      p.group.quaternion.set(pr.x, pr.y, pr.z, pr.w);
      p.group.updateMatrixWorld(true);
    }
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
    if (s.rotOnly) {
      // Limbs, neck, head: take the body's ORIENTATION only and keep the bone's own offset from its parent.
      // The bodies hang on ball joints that stretch a little under a hard throw; copying their positions
      // too pulled the legs visibly away from the hips. Rotation-only keeps every bone at its rest length.
      _m.decompose(_p, _q, _s);
      parent.getWorldQuaternion(_pq);
      s.bone.quaternion.copy(_pq.invert().multiply(_q));
    } else {
      _m.premultiply(_inv.copy(parent.matrixWorld).invert());
      _m.decompose(s.bone.position, s.bone.quaternion, s.bone.scale);
    }
    s.bone.updateMatrixWorld(true);
  }

  /** The widest gap between any bone and its parent bone vs their seated distance (metres; tests). */
  maxBoneStretch() {
    let m = 0;
    for (const rd of this.riders) for (const sg of rd.segs) {
      const b = sg.bone, p = b.parent;
      if (!sg.rotOnly || !p || !p.isBone) continue;
      if (sg.rest == null) continue;
      const d = b.getWorldPosition(_a).distanceTo(p.getWorldPosition(_b));
      m = Math.max(m, Math.abs(d - sg.rest));
    }
    return m;
  }

  /** The widest a ball joint has pulled apart (metres; the physics side of "the legs came off"). */
  maxJointGap() {
    let m = 0;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), M = new THREE.Matrix4();
    for (const [p, c, la, lb] of this.joints) {
      A.copy(la).applyMatrix4(bodyMatrix(p, M));
      B.copy(lb).applyMatrix4(bodyMatrix(c, M));
      m = Math.max(m, A.distanceTo(B));
    }
    return m;
  }

  /** Where each rag doll's pelvis is (tests, the review capture). */
  pelvisPositions() {
    return this.riders.map((rd) => {
      const t = rd.segs.length ? rd.segs[0].body.translation() : null;
      return { seat: rd.seat, x: t ? t.x : 0, y: t ? t.y : 0, z: t ? t.z : 0 };
    });
  }

  /** The simulated ground's height at (x, z): the heightfield's own grid, bilinear (off it: -Infinity). */
  groundHeight(x, z) {
    const h = this._hf;
    const u = (x - h.x0) / GROUND_STEP, v = (z - h.z0) / GROUND_STEP;
    if (!(u >= 0 && v >= 0 && u <= h.n && v <= h.n)) return -Infinity;
    const c = Math.min(h.n - 1, Math.floor(u)), r = Math.min(h.n - 1, Math.floor(v)), fu = u - c, fv = v - r;
    const H = (cc, rr) => h.heights[rr + cc * (h.n + 1)];
    return (H(c, r) * (1 - fu) + H(c + 1, r) * fu) * (1 - fv) + (H(c, r + 1) * (1 - fu) + H(c + 1, r + 1) * fu) * fv;
  }

  /** How far the deepest rag doll body's surface is above the simulated ground (metres; < 0 = sunk in). */
  minClearance() {
    let m = Infinity;
    for (const rd of this.riders) for (const sg of rd.segs) {
      const t = sg.body.translation();
      m = Math.min(m, t.y - sg.rad - this.groundHeight(t.x, t.z));
    }
    return m;
  }

  /** Put the geese back in their seated pose and free the world. Safe to call twice. */
  dispose() {
    for (const rd of this.riders) {
      for (const [b, p, q, sc] of rd.snap) { b.position.copy(p); b.quaternion.copy(q); b.scale.copy(sc); }
      rd.rider.ragdoll = false;
    }
    this.riders = [];
    for (const p of this.parts) if (p.group.parent) p.group.parent.remove(p.group);
    this.parts = [];
    for (const m of this._hidden) m.visible = true;
    this._hidden = [];
    if (this.world) { this.world.free(); this.world = null; }
  }
}
