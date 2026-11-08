// @ts-check
// ============================================================
// join-poll — what counts as a join press on the seat screens
// ============================================================
//
// One join card per physical controller, polling every source of it at once,
// comes from controller-core's units since 0.7 (#607: mgr.units(),
// unit.frame()). The frozen-DualSense merge (mergedPollGp, #590) and the
// held-twin filter (withoutHeldTwins, #601) that lived here moved into core.

/**
 * Does this pad's press mean "join the stoker seat"? Any button does, except
 * the pad's B: B is "stand up", and pressing it to leave must never sit the
 * player straight back down (TV playtest 2026-11-06: B seated the second
 * Steam Controller just like A). B's position is only known on a
 * standard-mapped pad: index 1, or 0 on a Nintendo-order pad (swapAB). A pad
 * Chromium doesn't map reports raw HID order, where ✕ can be index 1, so
 * there every button still joins. Pure; exported for the unit test.
 * @param {{ mapping?: string, buttons?: ArrayLike<{ pressed?: boolean }|undefined> }|null|undefined} gp
 * @param {boolean} [swapAB]
 * @returns {boolean}
 */
export function isJoinPress(gp, swapAB = false) {
  const buttons = (gp && gp.buttons) || [];
  const bIndex = gp && gp.mapping === 'standard' ? (swapAB ? 0 : 1) : -1;
  for (let i = 0; i < buttons.length; i++) {
    if (i === bIndex) continue;
    if (buttons[i] && buttons[i].pressed) return true;
  }
  return false;
}
