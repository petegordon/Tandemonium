// @ts-check
// ============================================================
// join-poll — one join card for a pad the game sees twice (#581)
// ============================================================
//
// A DualSense switched on after the game started shows up twice: Chromium's
// Gamepad API lists it from its first compat-mode reports, then our driver
// flips it to full-report (0x31) mode — which freezes that Gamepad entry
// (Chromium can't parse 0x31) while every press from then on lands in the
// WebHID pool entry's synthetic. The join screens used to keep the Gamepad
// entry and drop the WebHID one, so ✕ on the pad did nothing, forever.
// Polling both as one pad makes a press on either source count.

/**
 * A Gamepad-shaped poll object whose buttons are pressed when EITHER source
 * has them pressed, and whose axes take the larger deflection of the two.
 * @param {{ buttons?: ArrayLike<{ pressed?: boolean }|undefined>, axes?: ArrayLike<number> }|null|undefined} gp
 * @param {{ buttons?: ArrayLike<{ pressed?: boolean }|undefined>, axes?: ArrayLike<number> }|null|undefined} synthetic
 * @returns {{ buttons: { pressed: boolean, value: number }[], axes: number[] }}
 */
export function mergedPollGp(gp, synthetic) {
  const a = (gp && gp.buttons) || [];
  const b = (synthetic && synthetic.buttons) || [];
  const buttons = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const pressed = !!((a[i] && a[i].pressed) || (b[i] && b[i].pressed));
    buttons.push({ pressed, value: pressed ? 1 : 0 });
  }
  const ax = (gp && gp.axes) || [];
  const bx = (synthetic && synthetic.axes) || [];
  const axes = [];
  for (let i = 0; i < Math.max(ax.length, bx.length, 4); i++) {
    const x = Number(ax[i]) || 0, y = Number(bx[i]) || 0;
    axes.push(Math.abs(y) > Math.abs(x) ? y : x);
  }
  return { buttons, axes };
}
