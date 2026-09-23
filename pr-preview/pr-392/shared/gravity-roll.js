// ============================================================
// GRAVITY ROLL — drift-free bank/roll angle from the gravity vector (#314)
// ============================================================
//
// Roll (bank / lean) extracted purely from the accelerometer-anchored gravity
// vector, NOT from the integrated orientation quaternion. Decomposing the full
// orientation to Euler-Z to get roll mixes in YAW — and yaw is the one axis a
// 6-axis IMU can never anchor (no magnetometer), so it drifts without bound and
// the roll "fuses to one side." Reading roll straight from the gravity vector
// sidesteps that entirely: it depends only on which way is currently DOWN, which
// the accelerometer measures directly, so it cannot drift, is naturally bounded
// (no ±180° wrap runaway), and never touches the gyro (so it is also immune to
// any gyro bias/sign error).
//
// This is the steering axis for lean-to-steer games (Tandemonium): the control
// input is roll, yaw is irrelevant, so we never read yaw at all.
//
// Deliberately THREE-free (like yaw-return.js): the core test job runs
// dependency-free (see .github/workflows/ci.yml), so this module and its tests
// must not import three. The gravity vector is passed as plain components.
// ============================================================

/**
 * Roll (bank) angle in radians from the sensor-local gravity/down vector.
 *
 * The vector is gravity expressed in the controller's OWN frame (≈ (0, -1, 0)
 * at rest, world up = +Y) — exactly what SensorFusion tracks in `_gravityVec`.
 * Roll is its tilt about the forward (Z) axis: the projection into the local
 * X–Y plane, measured from straight-down. Depends ONLY on the current down
 * direction, so it is immune to yaw drift and to gyro bias/sign errors.
 *
 * Sign matches the Euler-Z convention SensorFusion consumers already use
 * (`leanDeg = -eulerZ`): for a pure roll of φ about Z the orientation is
 * R_z(φ), the local gravity vector is (-sinφ, -cosφ, 0), and this returns -φ —
 * exactly what `-eulerZ` gives. So it is a drop-in replacement that removes the
 * drift WITHOUT changing steering direction. Pitch does not leak in (a pure
 * pitch θ gives gravity (0, -cosθ, sinθ) → atan2(0, cosθ) = 0).
 *
 * @param {number} gravX local gravity vector X
 * @param {number} gravY local gravity vector Y (≈ -1 at rest)
 * @returns {number} roll in radians, in (-π, π]
 */
export function rollFromGravity(gravX, gravY) {
  return Math.atan2(gravX, -gravY);
}
