// Pure trackpad coordinate math — kept dependency-free (no three) so it can be
// unit-tested in isolation. Used by ControllerOverlay to place a touch
// indicator on a pad from a raw HID sample.

/**
 * Normalize a raw signed trackpad sample to fractional pad coordinates in
 * [0, 1], where (0, 0) raw → (0.5, 0.5) = pad center.
 *
 * @param {number} rawX  signed raw X (e.g. Steam Controller int16, −range..range)
 * @param {number} rawY  signed raw Y
 * @param {number} range half-scale; raw/range ∈ [−1, 1] (int16 → 32768)
 * @param {object} [opts]
 * @param {boolean} [opts.invertX] mirror horizontally (dot moves opposite the finger → flip)
 * @param {boolean} [opts.invertY] mirror vertically
 * @param {boolean} [opts.swapXY]  swap axes (dot moves perpendicular to the finger → set true)
 * @returns {{fx:number, fy:number}} fractions clamped to [0, 1]
 */
export function normalizeTrackpad(rawX, rawY, range, opts = {}) {
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  let fx = clamp01((rawX + range) / (2 * range));
  let fy = clamp01((rawY + range) / (2 * range));
  if (opts.invertX) fx = 1 - fx;
  if (opts.invertY) fy = 1 - fy;
  return opts.swapXY ? { fx: fy, fy: fx } : { fx, fy };
}
