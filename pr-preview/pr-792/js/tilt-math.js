// @ts-check
// ============================================================
// tilt-math — phone orientation → the game's raw tilt angle (degrees)
// ============================================================
//
// Shared by InputManager (a phone playing the game) and the phone remote
// (#421), so a remote phone feeds the game the exact same angle it would if
// the game ran on it. Pure functions; no DOM.
// ============================================================

/**
 * deviceorientation (beta, gamma) + screen angle → raw tilt in degrees.
 * Landscape uses beta; portrait uses gamma, blending through 80°–100° of
 * beta because gamma's left-right flips once the phone tips past vertical.
 * @param {number|null} beta
 * @param {number|null} gamma
 * @param {number} orient  screen.orientation.angle (0, 90, 180, 270 / -90)
 * @returns {number|null}
 */
export function orientationToRawTilt(beta, gamma, orient) {
  if (orient === 90) return beta;
  if (orient === 270 || orient === -90) return beta == null ? null : -beta;
  if (gamma == null) return null;
  const absBeta = Math.abs(beta || 0);
  if (absBeta > 100) return -gamma;
  if (absBeta > 80) {
    const t = (absBeta - 80) / 20;
    return gamma * (1 - 2 * t);
  }
  return gamma;
}

/**
 * Low-passed gravity vector (devicemotion fallback) + screen angle → raw tilt.
 * @param {number} gx @param {number} gy @param {number} orient
 * @returns {number}
 */
export function gravityToRawTilt(gx, gy, orient) {
  let rollRad;
  if (orient === 90) rollRad = Math.atan2(gy, -gx);
  else if (orient === 270 || orient === -90) rollRad = Math.atan2(-gy, gx);
  else rollRad = Math.atan2(gx, gy);
  return -rollRad * 180 / Math.PI;
}
