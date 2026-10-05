// ============================================================
// DEBRIS WORLD — the one Rapier world, shared by every effect
// ============================================================
//
// A short-lived rigid-body world for things that are purely seen: the crash
// tumble, a knocked pylon, a clobbered goose. It drives THREE transforms and
// nothing else. It does not know what a bike is, it never reads or writes ride
// state, and nothing it computes reaches BikeCodec — so multiplayer neither
// knows nor cares that it exists, and no determinism guarantee is needed.
//
// It is also allowed to not exist. Every entry point tolerates a missing world
// and the game plays exactly as it did before. See issue #388.
//
// ── Ground, and why each body carries its own patch ──
//
// The road has elevation (RoadPath.getHeightAtWorld), so a single flat plane
// would float debris above a dip and bury it on a crest. Tracking one plane to
// the bike is worse: debris is left behind within a second, so the plane walks
// out from under the very thing it's supporting.
//
// So each body gets a small ground patch stamped at the terrain height where it
// spawned, destroyed when it dies. To stop a goose landing on a neighbour's
// patch — they overlap, and on a slope they sit at different heights — each
// body is isolated to its own patch with a collision group.
//
// The cost of that is debris-vs-debris contact: two struck geese pass through
// each other. That is a deliberate trade. Correct ground height on a hill is
// visible on every single tumble; two birds clipping for a third of a second,
// mid-scatter, with feathers in the air, is not.
// ============================================================

import * as THREE from 'three';

// Rapier offers 16 collision groups. We round-robin over them, so with more
// than 16 live bodies two of them start sharing a patch again — harmless, and
// well past the cap below anyway.
const GROUP_COUNT = 16;

// Each patch only has to catch one tumbling object for a few seconds.
const PATCH_HALF = 3.0;
const PATCH_THICK = 0.5;

// A hard ceiling on simulated bodies. Debris is garnish; it is never allowed to
// become the reason a frame is slow. Past this, new spawns are simply dropped.
const MAX_BODIES = 24;

// Fixed timestep. Rapier is stepped at a constant rate regardless of frame
// time — a variable timestep makes contacts pop and tumbles look different on
// different machines. Leftover time accumulates into the next frame.
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 3;

const FADE_TIME = 0.6;

export class DebrisWorld {
  /**
   * @param {object} RAPIER initialised Rapier namespace (see ensureRapier)
   * @param {THREE.Scene} scene where driven objects live
   */
  constructor(RAPIER, scene) {
    this.RAPIER = RAPIER;
    this.scene = scene;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;
    this._bodies = [];
    this._accum = 0;
    this._nextGroup = 0;
    // Rapier allocates a fresh object per translation()/rotation() call unless
    // handed a target. This runs every frame per body, so it gets targets.
    this._readT = { x: 0, y: 0, z: 0 };
    this._readR = { x: 0, y: 0, z: 0, w: 1 };
  }

  get liveCount() { return this._bodies.length; }

  /**
   * Hand an object to the simulation.
   *
   * The object3d is driven, not owned: its position and quaternion are
   * overwritten every step. Callers that want it removed from the scene
   * afterwards do that in onExpire.
   *
   * fadeOut mutates material.opacity, so the caller must pass an object with
   * its OWN material — pooled billboards share one, and fading a shared
   * material fades every pylon on the road at once.
   *
   * @returns {object|null} an opaque handle, or null if the world is full
   */
  spawn({
    object3d,
    halfExtents = { x: 0.3, y: 0.3, z: 0.3 },
    // Bikes and geese put their object origin on the ground, not at their
    // centre, so the box has to be lifted off the origin or it spawns
    // half-buried in its own ground patch.
    colliderOffset = null,
    position,
    quaternion = null,
    linvel = { x: 0, y: 0, z: 0 },
    angvel = { x: 0, y: 0, z: 0 },
    groundY = 0,
    lifetime = 4,
    restitution = 0.25,
    friction = 0.8,
    linearDamping = 0.15,
    angularDamping = 0.4,
    fadeOut = false,
    // Billboards must NOT have their quaternion driven: a PlaneGeometry
    // tumbling in 3D turns edge-on twice a revolution and vanishes. Those
    // callers pass false, keep facing the camera themselves, and read the
    // body's true rotation off handle.quat via billboardRoll(). See
    // physics-fx.js.
    driveRotation = true,
    onExpire = null,
  }) {
    if (this._bodies.length >= MAX_BODIES) return null;
    const R = this.RAPIER;

    const group = this._nextGroup;
    this._nextGroup = (this._nextGroup + 1) % GROUP_COUNT;
    const mask = 1 << group;
    const groups = ((mask << 16) | mask) >>> 0;

    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setLinvel(linvel.x, linvel.y, linvel.z)
      .setAngvel(angvel)
      .setLinearDamping(linearDamping)
      .setAngularDamping(angularDamping)
      // Debris leaves the bike at ride speed — up to ~0.3 m per step, which is
      // the same order as the colliders themselves. Without CCD the fast ones
      // tunnel straight through their own ground patch on the first step.
      .setCcdEnabled(true);
    if (quaternion) {
      bodyDesc.setRotation({
        x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w,
      });
    }
    const body = this.world.createRigidBody(bodyDesc);

    const colDesc = R.ColliderDesc
      .cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setRestitution(restitution)
      .setFriction(friction)
      .setCollisionGroups(groups);
    if (colliderOffset) {
      colDesc.setTranslation(colliderOffset.x, colliderOffset.y, colliderOffset.z);
    }
    this.world.createCollider(colDesc, body);

    // This body's private floor, at the terrain height where it spawned.
    const patchDesc = R.RigidBodyDesc.fixed()
      .setTranslation(position.x, groundY - PATCH_THICK, position.z);
    const patch = this.world.createRigidBody(patchDesc);
    this.world.createCollider(
      R.ColliderDesc.cuboid(PATCH_HALF, PATCH_THICK, PATCH_HALF)
        .setFriction(friction)
        .setCollisionGroups(groups),
      patch,
    );

    const entry = {
      body, patch, object3d, onExpire, fadeOut, driveRotation,
      age: 0, lifetime,
      // Always published, driven or not — billboards read it to derive roll.
      quat: new THREE.Quaternion(),
      baseOpacity: fadeOut && object3d && object3d.material
        ? object3d.material.opacity : 1,
    };
    this._bodies.push(entry);
    return entry;
  }

  /**
   * Advance the simulation and write transforms back onto the driven objects.
   * @param {number} dt seconds since last frame
   */
  step(dt) {
    if (this._bodies.length === 0) return;

    // Clamp the accumulator rather than letting it run: after a tab-switch or a
    // GL context restore, dt can be seconds, and draining that honestly means
    // hundreds of steps in one frame — a freeze, to catch up debris nobody saw.
    this._accum = Math.min(this._accum + dt, FIXED_DT * MAX_SUBSTEPS);
    let steps = 0;
    while (this._accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.world.step();
      this._accum -= FIXED_DT;
      steps++;
    }

    for (let i = this._bodies.length - 1; i >= 0; i--) {
      const e = this._bodies[i];
      e.age += dt;

      const t = e.body.translation(this._readT);
      const r = e.body.rotation(this._readR);
      e.quat.set(r.x, r.y, r.z, r.w);
      if (e.object3d) {
        e.object3d.position.set(t.x, t.y, t.z);
        if (e.driveRotation) e.object3d.quaternion.copy(e.quat);
        if (e.fadeOut && e.object3d.material) {
          const left = e.lifetime - e.age;
          if (left < FADE_TIME) {
            e.object3d.material.opacity = e.baseOpacity * Math.max(0, left / FADE_TIME);
            e.object3d.material.transparent = true;
          }
        }
      }

      if (e.age >= e.lifetime) this._retire(i);
    }
  }

  /** Remove one body early (a goose recovering into flight, say). */
  release(handle) {
    const i = this._bodies.indexOf(handle);
    if (i >= 0) this._retire(i);
  }

  _retire(i) {
    const e = this._bodies[i];
    this._bodies.splice(i, 1);

    // Sample anything a caller might want BEFORE the body is freed. Reading a
    // removed RigidBody handle is a use-after-free straight into WASM memory,
    // and callers legitimately want the final state — a goose recovering into
    // flight should beat away along the momentum it was thrown with.
    let final = null;
    if (e.onExpire) {
      const t = e.body.translation();
      const v = e.body.linvel();
      final = {
        position: { x: t.x, y: t.y, z: t.z },
        linvel: { x: v.x, y: v.y, z: v.z },
      };
    }

    // Colliders attached to a body are removed with it.
    this.world.removeRigidBody(e.body);
    this.world.removeRigidBody(e.patch);

    if (e.onExpire) {
      try { e.onExpire(e.object3d, final); }
      catch (err) { console.warn('[physics] onExpire threw:', err); }
    }
  }

  /** Retire everything, firing each onExpire so callers can clean up. */
  clear() {
    while (this._bodies.length) this._retire(this._bodies.length - 1);
  }

  /** Release the world and its WASM memory. The instance is dead after this. */
  dispose() {
    this.clear();
    if (this.world && this.world.free) this.world.free();
    this.world = null;
  }
}
