// ============================================================
// HELPING HAND (pure) — retries get easier, visibly (#403)
// ============================================================
//
// Pete could not get past checkpoint 2 of Today's Road in five attempts: "the
// gust and the distance and the time is too much". The DDA already eased the
// crash threshold and gravity, silently, and offered ASSIST — but it never
// touched the gusts or the clock, and the player never learned it was helping.
//
// The rule (approved on #403, 2026-10-04):
//   - a FAILURE is a checkpoint-ending event: the segment timer running out, or
//     the third crash in a segment that brings up the crash modal;
//   - attempts 1-3 at a checkpoint ride the road as designed;
//   - attempt 4 (after 3 failures): Tier 1, "Lady Victoria sends a tailwind" —
//     gusts at half strength, +25 % segment time;
//   - attempt 5 (after 4 failures): Tier 2, "Sir Winston clears the road" — no
//     gusts in this segment, +50 % time, safety ON;
//   - after 5 failures: SKIP CHECKPOINT ("Take the Royal Shortcut") is offered;
//   - the count resets when the checkpoint is passed.
// Never the distance, the checkpoint positions or the road layout: Today's
// Road is the same road for everyone.
//
// Pure so the schedule can be tested without a bike, a HUD or a browser.

export const HELP_TIER1_AFTER = 3;
export const HELP_TIER2_AFTER = 4;
export const HELP_SKIP_AFTER = 5;

export const HELP_TIERS = Object.freeze({
  0: Object.freeze({ tier: 0, gustScale: 1, timeScale: 1, safety: false, icon: '', label: '' }),
  1: Object.freeze({ tier: 1, gustScale: 0.5, timeScale: 1.25, safety: false, icon: '🪿', label: '🪿 Lady Victoria sends a tailwind' }),
  2: Object.freeze({ tier: 2, gustScale: 0, timeScale: 1.5, safety: true, icon: '🎩', label: '🎩 Sir Winston clears the road' }),
});

export const SKIP_LABEL = '👑 Take the Royal Shortcut';

/** The tier number in effect for a tier-ish value (clamped to 0..2). */
export function helpTier(tier) {
  const t = Math.floor(Number(tier) || 0);
  return t >= 2 ? 2 : t <= 0 ? 0 : 1;
}

/**
 * What the next attempt at a checkpoint gets, given the failures there so far.
 * @param {number} failures  failures recorded at this checkpoint
 * @returns {{ tier: 0|1|2, gustScale: number, timeScale: number, safety: boolean,
 *             offerSkip: boolean, icon: string, label: string, skipLabel: string }}
 */
export function helpingHandFor(failures) {
  const f = Math.max(0, Math.floor(Number(failures) || 0));
  const tier = f >= HELP_TIER2_AFTER ? 2 : f >= HELP_TIER1_AFTER ? 1 : 0;
  return { ...HELP_TIERS[tier], offerSkip: f >= HELP_SKIP_AFTER, skipLabel: SKIP_LABEL };
}
