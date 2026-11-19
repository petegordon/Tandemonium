// ============================================================
// FINISH CAMERA ANIMATION — cinematic, slow-motion swing to the
// front of the bike with a final artistic zoom-in. Runs after the
// race is won and before the victory overlay is revealed.
// ============================================================

import * as THREE from 'three';

const PHASE = {
  SWING: 0,    // sweep from behind → side → front of the bike
  ZOOM: 1,     // hold near the front and dolly in close
  HOLD: 2,     // brief breath frame before victory UI appears
  DONE: 3,
};

// The frontal three-quarter pose the swing lands on and the two later phases
// hold. theta=0 is directly in front of the bike.
//
// Camera and aim both sit higher than the geometry alone would ask for: the
// riders' heads are the tallest thing on the bike, and a pose framed on the
// bike centre pushed them into the top ~10% of a portrait screen — straight
// under the HUD's top strip, which clipped their faces at the moment the shot
// exists to show them. Lifting the camera and lifting the aim further still
// drops the heads to roughly a third down the frame and flattens the downward
// tilt from ~20° to ~9°, which is a kinder angle for a victory frame anyway.
const END_THETA = -0.35;
const END_RADIUS = 4.2;
const END_HEIGHT = 2.0;
const END_LOOK_FWD = 1.4;
const END_LOOK_Y = 1.55;
/** The goose tandem's riderViewScale (bike-model.js): the end pose above was set on it. */
const TANDEM_RIDER_SCALE = 1.02;
/** The screen shape the end pose was set on (a desk or a TV). */
const LANDSCAPE_ASPECT = 1.5;

/**
 * The end pose for this bike. A taller bike (the Solo Flight's riders sit 24% higher) is framed from as much higher
 * and further off, and a captain sitting further forward (the Solo Flight's, 1.25 m) is allowed for, so no rider's
 * head leaves the frame (Pete, 2026-11-18: "the camera at the end zooms in and cuts the heads of the riders off").
 */
export function endPoseFor(bike, aspect = LANDSCAPE_ASPECT) {
  const k = Math.max(1, Math.min(2, ((bike && bike.riderViewScale) || TANDEM_RIDER_SCALE) / TANDEM_RIDER_SCALE));
  const ahead = Math.max(0, (bike && bike.frontViewAhead) || 0);
  // a narrow screen (a phone held upright) sees less from side to side: stand further off, and aim nearer the
  // middle of the bike, so the rider behind is in the picture too
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : LANDSCAPE_ASPECT;
  const w = Math.max(1, Math.min(2, Math.sqrt(LANDSCAPE_ASPECT / a)));
  return { radius: (END_RADIUS * k + ahead) * w, height: END_HEIGHT * k * (1 + (w - 1) * 0.5), lookFwd: (END_LOOK_FWD + ahead * 0.5) / w, lookY: END_LOOK_Y * k };
}

export class FinishCameraAnimation {
  /**
   * @param {THREE.Camera} camera
   * @param {object} bike
   * @param {{ via?: 1 | -1 }} [opts] which side the swing passes: 1 (default)
   *   round the bike's right, -1 round its left. #478: Grandma's 3D house
   *   stands on the right at the finish, so those levels swing left.
   */
  constructor(camera, bike, { via = 1 } = {}) {
    this.camera = camera;
    this.bike = bike;
    this.startTheta = via < 0 ? -Math.PI : Math.PI;
    this.end = endPoseFor(bike, camera && camera.aspect);

    // Capture the camera's starting pose so the swing eases out from
    // wherever the chase cam left it instead of snapping.
    this.startPos = camera.position.clone();
    this.startLook = new THREE.Vector3();
    camera.getWorldDirection(this.startLook);
    this.startLook.multiplyScalar(10).add(camera.position);
    this.startFov = camera.fov;

    // Phase durations — generous timings sell the slow-motion feel.
    this.tSwing = 2.6;
    this.tZoom = 1.6;
    this.tHold = 0.5;
    this.totalDuration = this.tSwing + this.tZoom + this.tHold;
    this.elapsed = 0;
    this.phase = PHASE.SWING;

    // Slow-motion factor applied to the bike's residual roll-out. 0.18
    // keeps wheels turning gently without the world racing past.
    this.timeScale = 0.18;

    // Reusable temporaries.
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._orbitPos = new THREE.Vector3();
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    this._blendedLook = new THREE.Vector3();
  }

  _easeInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  _easeOutQuint(t) {
    return 1 - Math.pow(1 - t, 5);
  }

  _lerp(a, b, t) { return a + (b - a) * t; }

  /** Slow-mo dt scale — game.js multiplies its physics dt by this. */
  getTimeScale() {
    // Slight ramp from full speed → slow-mo over the first 0.4s so the
    // transition itself feels deliberate, not a stutter.
    const ramp = Math.min(1, this.elapsed / 0.4);
    return this._lerp(1, this.timeScale, ramp);
  }

  /**
   * Drive the camera through the cinematic. Returns true once the full
   * sequence is complete and the victory overlay should be revealed.
   */
  update(dt) {
    this.elapsed += dt;
    const bike = this.bike;

    // Bike-aligned basis — orbit around the live bike pose so it still
    // works if the bike is rolling forward during the swing.
    this._fwd.set(Math.sin(bike.heading), 0, Math.cos(bike.heading));
    this._right.set(Math.cos(bike.heading), 0, -Math.sin(bike.heading));

    if (this.elapsed < this.tSwing) {
      this.phase = PHASE.SWING;
      this._updateSwing(this.elapsed / this.tSwing);
    } else if (this.elapsed < this.tSwing + this.tZoom) {
      this.phase = PHASE.ZOOM;
      this._updateZoom((this.elapsed - this.tSwing) / this.tZoom);
    } else if (this.elapsed < this.totalDuration) {
      this.phase = PHASE.HOLD;
      this._updateHold();
    } else {
      this.phase = PHASE.DONE;
      return true;
    }

    return false;
  }

  // theta=0 is in front of the bike, π is behind, π/2 is the bike's right.
  _orbitOffset(theta, radius, height, out) {
    const fc = Math.cos(theta) * radius;
    const rc = Math.sin(theta) * radius;
    out.set(
      this._fwd.x * fc + this._right.x * rc,
      height,
      this._fwd.z * fc + this._right.z * rc
    );
    return out;
  }

  // Phase 1: orbit from behind (theta=±π) around the right side (theta=π/2;
  // or the left, -π/2, when constructed with via: -1)
  // to a low frontal three-quarter view (theta ≈ -0.35), pulling in close
  // with a generous height drop.
  _updateSwing(t) {
    const e = this._easeInOut(t);
    const bikePos = this.bike.position;

    const theta = this._lerp(this.startTheta, END_THETA, e);
    const radius = this._lerp(11, this.end.radius, e);
    const height = this._lerp(4.0, this.end.height, e);

    this._orbitOffset(theta, radius, height, this._orbitPos);
    this._desiredPos.copy(bikePos).add(this._orbitPos);

    const lookFwdBias = this._lerp(-0.5, this.end.lookFwd, e);
    this._desiredLook.copy(bikePos);
    this._desiredLook.x += this._fwd.x * lookFwdBias;
    this._desiredLook.z += this._fwd.z * lookFwdBias;
    // Rises through the swing, so the riders sit lower in frame the closer the
    // camera gets rather than climbing towards the top strip.
    this._desiredLook.y += this._lerp(1.2, this.end.lookY, e);

    // Ease out of the chase cam's last pose for the first ~40% of swing.
    const blend = Math.min(1, t * 2.5);
    if (blend < 1) {
      this.camera.position.copy(this.startPos).lerp(this._desiredPos, blend);
      this._blendedLook.copy(this.startLook).lerp(this._desiredLook, blend);
      this.camera.lookAt(this._blendedLook);
    } else {
      this.camera.position.copy(this._desiredPos);
      this.camera.lookAt(this._desiredLook);
    }

    // Subtle FOV widen for cinematic drama.
    this.camera.fov = this._lerp(this.startFov, this.startFov + 6, e);
    this.camera.updateProjectionMatrix();
  }

  /** Park the camera on the held end pose. Shared by the zoom and hold phases. */
  _applyEndPose() {
    const bikePos = this.bike.position;
    this._orbitOffset(END_THETA, this.end.radius, this.end.height, this._orbitPos);
    this._desiredPos.copy(bikePos).add(this._orbitPos);
    this.camera.position.copy(this._desiredPos);

    this._desiredLook.copy(bikePos);
    this._desiredLook.x += this._fwd.x * this.end.lookFwd;
    this._desiredLook.z += this._fwd.z * this.end.lookFwd;
    this._desiredLook.y += this.end.lookY;
    this.camera.lookAt(this._desiredLook);
  }

  // Phase 2: settle on the frontal three-quarter pose the swing landed
  // on — no further dolly-in. FOV eases back from the swing's wide
  // bias to the camera's normal value so the held frame doesn't read
  // as distorted.
  _updateZoom(t) {
    const e = this._easeOutQuint(t);
    this._applyEndPose();
    this.camera.fov = this._lerp(this.startFov + 6, this.startFov, e);
    this.camera.updateProjectionMatrix();
  }

  // Phase 3: hold the same frontal three-quarter pose for a beat
  // before the victory overlay reveals — no zoom past the swing.
  _updateHold() {
    this._applyEndPose();
    this.camera.fov = this.startFov;
    this.camera.updateProjectionMatrix();
  }

  /** Restore the camera FOV when the cinematic ends. */
  cleanup() {
    this.camera.fov = this.startFov;
    this.camera.updateProjectionMatrix();
  }
}
