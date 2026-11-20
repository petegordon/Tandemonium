// ============================================================
// CRASH TUMBLE (pure) — the canned fall a crashed bike plays
// ============================================================
//
// #483: the tumble used to ease from lean 0 to the fallen side, so a bike that
// crashed by leaning out (already nearly flat on the impact frame) popped
// upright for a few frames and then fell over again. It must start from the
// lean the bike crashed at. (With Physics FX on, Rapier owns the group and hid
// this; with it off — low tier, the setting, or Rapier not loaded yet — it
// showed on every lean-out crash.)

/** Seconds to ease over onto the fallen side. */
export const FALL_EASE_S = 0.4;

/**
 * The drawn lean `elapsed` seconds into a fall.
 * @param {number} startLean the lean at impact (radians)
 * @param {number} targetLean the fallen-side lean (radians)
 * @param {number} elapsed seconds since the fall began
 */
export function fallLean(startLean, targetLean, elapsed) {
  const t = Math.min(1, Math.max(0, elapsed) / FALL_EASE_S);
  const eased = 1 - Math.pow(1 - t, 3);
  // a small bounce once it lands
  const after = elapsed - FALL_EASE_S;
  const bounce = t >= 1 ? Math.sin(after * 18) * 0.05 * Math.max(0, 1 - after * 3) : 0;
  return startLean + (targetLean - startLean) * eased + bounce;
}
