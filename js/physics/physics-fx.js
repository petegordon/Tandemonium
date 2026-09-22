// ============================================================
// PHYSICS FX — the three effects that earn a solver (issue #388)
// ============================================================
//
// One facade over the Rapier sidecar so that game.js, obstacles.js and
// geese.js never import Rapier, never await anything, and never have to know
// whether physics is available. Every method here is synchronous, returns a
// boolean, and returning false means "I did nothing" — the caller then does
// what it did before this file existed.
//
// The world is built lazily on the first warm() and torn down when the ride
// ends. Nothing here writes ride state: not bike.lean, not bike.speed, not
// bike.position, not anything BikeCodec serialises. It moves visuals.
//
// ── Billboards ──
//
// Almost everything in this game that could tumble is a camera-facing
// PlaneGeometry: the pylons are chromakey video planes, the geese are drawn
// sprites. A flat plane given a real 3D rotation turns edge-on twice per
// revolution and disappears, so those two effects do NOT let the solver drive
// their quaternion. Instead they keep facing the camera, exactly as they do
// today, and take their roll from billboardRoll() — the body's genuine
// rotation projected into that camera's screen plane.
//
// So the arc, the bounce off the verge, the spin rate and the settle are all
// simulated; only the final screen-space orientation is flattened. That is why
// "the geese are generated images, not 3D models" is not an obstacle: a rigid
// body drives a transform and does not care what is drawn at it.
// ============================================================

import * as THREE from 'three';
import { ensureRapier } from './rapier-runtime.js';
import { DebrisWorld } from './debris-world.js';

const _axis = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camFwd = new THREE.Vector3();

/**
 * The screen-space roll of a simulated body, for a billboard that is still
 * facing the camera.
 *
 * Takes the body's local +X axis, projects it onto the camera's right/up
 * basis, and reports its angle there. A body spinning about the view axis
 * gives a full turn; one spinning about the view direction gives little, which
 * is correct — that rotation genuinely isn't visible on a flat sprite.
 *
 * @returns {number|null} roll in radians, or null when the axis points too
 *   near the camera for the angle to mean anything (the projection collapses
 *   and atan2 turns to noise). Callers hold their previous roll on null.
 */
export function billboardRoll(quat, camera) {
  _axis.set(1, 0, 0).applyQuaternion(quat);
  camera.matrixWorld.extractBasis(_camRight, _camUp, _camFwd);
  const x = _axis.dot(_camRight);
  const y = _axis.dot(_camUp);
  if (x * x + y * y < 0.04) return null;
  return Math.atan2(y, x);
}

export class PhysicsFx {
  /**
   * @param {THREE.Scene} scene
   * @param {RoadPath} roadPath for per-spawn ground height
   */
  constructor(scene, roadPath) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.enabled = true;
    this._world = null;
    this._loading = false;
  }

  /** Live only once the WASM has landed AND the flag is on. */
  get ready() { return this.enabled && this._world !== null; }

  /**
   * Begin loading Rapier and build the world. Call somewhere idle — we use the
   * race countdown, so the download overlaps the "3… 2… 1…" rather than
   * landing mid-crash. Never awaited; if it isn't ready when the first crash
   * happens, that crash just uses the old canned fall.
   */
  warm() {
    if (!this.enabled || this._world || this._loading) return;
    this._loading = true;
    ensureRapier().then((RAPIER) => {
      this._loading = false;
      // A ride can end while the megabyte is in flight; don't build a world
      // for a scene that's already gone.
      if (!RAPIER || !this.enabled || !this.scene) return;
      this._world = new DebrisWorld(RAPIER, this.scene);
    });
  }

  /** Advance the sidecar. Free when nothing is live. */
  update(dt) {
    if (this._world) this._world.step(dt);
  }

  _groundAt(x, z, hintD) {
    return this.roadPath ? this.roadPath.getHeightAtWorld(x, z, hintD) : 0;
  }

  // ============================================================
  // 1. CRASH TUMBLE
  // ============================================================

  /**
   * Take over a crashing bike and let it fall properly.
   *
   * Called from BikeModel's onFall hook, which fires BEFORE _fall() snaps lean
   * to ~82° and zeroes speed — so the pre-crash velocity and attitude are still
   * readable here, which is the whole point.
   *
   * The bike's visual group is driven until released. bike.position and
   * bike.lean keep their canned crash values underneath, untouched, so race
   * logic, the HUD, camera shake and the netcode all carry on exactly as
   * before and a released bike snaps back to a state that was always valid.
   *
   * @returns {boolean} true if the tumble was taken over
   */
  crashTumble(bike) {
    if (!this.ready || !bike || !bike.group) return false;

    const speed = bike.speed;
    const heading = bike.heading;
    const lean = bike.lean;
    const pos = bike.position;

    // Bike forward is local +Z — a +Y yaw by heading maps +Z to this. Matches
    // the convention in _resolveVersusBikeContact.
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);

    // Lean is a rotation about that same forward axis, so spinning about it
    // with the lean's sign continues the fall already in progress instead of
    // arguing with it. Faster crashes tumble harder.
    const roll = (3.2 + speed * 0.35) * (lean >= 0 ? 1 : -1);
    const spin = 0.8 + Math.random() * 1.2;

    const handle = this._world.spawn({
      object3d: bike.group,
      // Tandem-sized: long, narrow, and about a metre tall.
      halfExtents: { x: 0.28, y: 0.55, z: 1.35 },
      // The group's origin sits on the road, not at the bike's centre.
      colliderOffset: { x: 0, y: 0.55, z: 0 },
      position: { x: pos.x, y: pos.y, z: pos.z },
      quaternion: bike.group.quaternion,
      linvel: { x: fx * speed, y: 0.4, z: fz * speed },
      angvel: { x: fx * roll, y: (Math.random() - 0.5) * spin, z: fz * roll },
      groundY: this._groundAt(pos.x, pos.z, bike.roadD),
      // Outlives the ~2s fallTimer on purpose: the game releases this on
      // reset, and a body that expired first would drop the group back to the
      // canned 82° pose with a visible pop.
      lifetime: 8,
      restitution: 0.12,
      friction: 1.1,
      angularDamping: 0.9,
      onExpire: () => { bike.transformOverride = false; },
    });
    if (!handle) return false;

    bike.transformOverride = true;
    bike._tumbleHandle = handle;
    return true;
  }

  /** Hand a bike back to its normal transform. Safe to call unconditionally. */
  releaseCrash(bike) {
    if (!bike) return;
    if (bike._tumbleHandle && this._world) {
      this._world.release(bike._tumbleHandle);
    }
    bike._tumbleHandle = null;
    bike.transformOverride = false;
  }

  // ============================================================
  // 2. PROP DEBRIS
  // ============================================================

  /**
   * Knock a struck pylon off its pooled slot and send it tumbling.
   *
   * The pooled billboard is hidden and a clone takes over, because the pool
   * slot is recycled the moment the item leaves the window and would otherwise
   * yank the mesh back mid-flight.
   *
   * @param {THREE.Mesh} sourceMesh the pooled billboard to copy
   * @param {{x,y,z}} position where it stood
   * @param {number} heading bike heading at impact
   * @param {number} speed bike speed at impact
   * @param {number} [hintD] road distance, for the ground lookup
   * @returns {boolean}
   */
  knockProp(sourceMesh, position, heading, speed, hintD) {
    if (!this.ready || !sourceMesh) return false;

    const mesh = sourceMesh.clone();
    mesh.visible = true;
    this.scene.add(mesh);

    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    // Struck square on: most of the bike's speed goes into the pylon, with
    // enough lift to get it off the ground and a hard spin. Light and hollow,
    // so it carries further than its mass says it should — which is what a
    // real traffic cone does, and reads better than a realistic one.
    const launch = Math.max(4, speed * 1.15);

    const handle = this._world.spawn({
      object3d: mesh,
      halfExtents: { x: 0.22, y: 0.3, z: 0.22 },
      colliderOffset: { x: 0, y: 0.3, z: 0 },
      position: { x: position.x, y: position.y, z: position.z },
      linvel: {
        x: fx * launch + (Math.random() - 0.5) * 2,
        y: 3.2 + Math.random() * 1.6,
        z: fz * launch + (Math.random() - 0.5) * 2,
      },
      angvel: {
        x: (Math.random() - 0.5) * 12,
        y: (Math.random() - 0.5) * 12,
        z: (Math.random() - 0.5) * 12,
      },
      groundY: this._groundAt(position.x, position.z, hintD),
      lifetime: 3.5,
      restitution: 0.42,
      friction: 0.55,
      // A billboard: the solver owns the arc, the caller keeps it facing the
      // camera. See the header.
      driveRotation: false,
      onExpire: (obj) => {
        this.scene.remove(obj);
      },
    });
    if (!handle) {
      this.scene.remove(mesh);
      return false;
    }
    handle.camera = null;
    return handle;
  }

  // ============================================================
  // 3. GOOSE STRIKES
  // ============================================================

  /**
   * A goose that left it too late. Tumbles with a real bounce off the verge,
   * then recovers into the existing flight state so pooling and recycling are
   * untouched.
   *
   * @returns {object|null} the handle, or null if physics couldn't take it
   */
  strikeGoose(mesh, position, heading, speed, hintD, onSettle) {
    if (!this.ready || !mesh) return null;

    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    // Clipped rather than squarely hit — geese are light, so they go up and
    // over more than forward, and the sideways component is what sells that it
    // was a glancing blow.
    const launch = Math.max(3, speed * 0.55);
    const side = (Math.random() - 0.5) * 3;

    return this._world.spawn({
      object3d: mesh,
      halfExtents: { x: 0.3, y: 0.25, z: 0.3 },
      colliderOffset: { x: 0, y: 0.25, z: 0 },
      position: { x: position.x, y: position.y, z: position.z },
      linvel: {
        x: fx * launch + fz * side,
        y: 4.0 + Math.random() * 2.0,
        z: fz * launch - fx * side,
      },
      angvel: {
        x: (Math.random() - 0.5) * 16,
        y: (Math.random() - 0.5) * 16,
        z: (Math.random() - 0.5) * 16,
      },
      groundY: this._groundAt(position.x, position.z, hintD),
      // Short: long enough to read as a tumble, short enough that the bird is
      // back under its own power while still on screen.
      lifetime: 1.15,
      restitution: 0.38,
      friction: 0.7,
      driveRotation: false,
      onExpire: onSettle,
    });
  }

  /** Retire one body early, firing its onExpire. Safe with a null handle. */
  releaseHandle(handle) {
    if (handle && this._world) this._world.release(handle);
  }

  /** Drop everything mid-ride (reset, level change, mode switch). */
  clear() {
    if (this._world) this._world.clear();
  }

  /** End of ride: free the world and its WASM memory. */
  dispose() {
    if (this._world) {
      this._world.dispose();
      this._world = null;
    }
    this.scene = null;
    this.roadPath = null;
  }
}
