// ============================================================
// YAW RETURN — heading recenter + at-rest return-to-neutral (issue #88)
// ============================================================
//
// Pure heading math for the Steam Controller yaw-drift fix. Gravity correction
// anchors pitch and roll but never yaw (the accelerometer has no reference for
// heading about the gravity axis), so residual yaw-axis gyro bias integrates
// without bound and re-accumulates after every recenter. SensorFusion keeps a
// heading offset `refYaw` and displays `R_y(-refYaw) · orientation`; recenter
// snaps the offset to the current heading and the at-rest return slews it there
// over time.
//
// Deliberately THREE-free: the core test job runs dependency-free (no install —
// see .github/workflows/ci.yml), so this module and its tests must not import
// three. Quaternions are plain { x, y, z, w } objects; THREE.Quaternion is
// structurally compatible, so SensorFusion passes its live quaternions straight
// through (reads via getters, writes via setters).
// ============================================================

// Signed twist angle (radians) of quaternion q about the world-up (Y) axis.
// Swing-twist decomposition: the twist quaternion about (0,1,0) is (0, q.y, 0,
// q.w) before normalization, so its signed angle is 2·atan2(q.y, q.w).
export function twistAngleY(q) {
  return 2 * Math.atan2(q.y, q.w);
}

// Wrap an angle (radians) into (-π, π].
export function wrapPi(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// Advance the heading offset one step so the *displayed* yaw
// (headingNow − refYaw) decays toward zero with the given half-life. Returns the
// new refYaw. No-op (returns refYaw unchanged) when disabled or dt is
// non-positive. dt and halfLife are in seconds.
//
// Pre-multiplying `orientation` by a world-Y rotation shifts its Y-twist by
// exactly that angle, so displayedYaw = headingNow − refYaw, and easing refYaw
// toward headingNow eases displayedYaw toward 0.
export function stepYawReturn(refYaw, orientation, dt, halfLife) {
  if (!(halfLife > 0) || dt <= 0) return refYaw;
  const headingNow = twistAngleY(orientation);
  const displayedYaw = wrapPi(headingNow - refYaw);
  const f = 1 - Math.pow(2, -dt / halfLife);
  return wrapPi(refYaw + displayedYaw * f);
}

// Write R_y(-refYaw) · orientation into `out` (a { x, y, z, w } sink). Removes
// only the heading offset; pitch and roll pass through untouched because a
// rotation about world-up preserves the Y-component of any rotated vector.
// R_y(-refYaw) = (0, sin(-refYaw/2), 0, cos(-refYaw/2)); the product below is
// the Hamilton product of that with `orientation`.
export function composeHeadingOffset(out, refYaw, orientation) {
  const half = -refYaw / 2;
  const ry = Math.sin(half);
  const rw = Math.cos(half);
  const { x, y, z, w } = orientation;
  out.x = rw * x + ry * z;
  out.y = rw * y + ry * w;
  out.z = rw * z - ry * x;
  out.w = rw * w - ry * y;
  return out;
}
