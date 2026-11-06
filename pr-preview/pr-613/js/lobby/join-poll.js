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

/**
 * Gamepad-API candidates minus the twins of pads a manager slot already holds
 * over WebHID (#581). A seated DualSense is listed through its slot; Chromium
 * keeps listing the same pad's (frozen, compat-mode) Gamepad entry too, which
 * showed as a second "DualSense · seats full" in the roster. A slot that
 * adopted its pad's Gamepad entry (gamepadIndex set) drops that index; a
 * WebHID-only slot drops the one Gamepad candidate named like its device —
 * and none when two are (two identical pads: better a phantom than hiding a
 * real controller). Pure; exported for the unit test.
 * @template {{ gpIndex: number, gp: { id: string } }} C
 * @param {C[]} gpCandidates
 * @param {{ state: string, hidDevice?: { productName?: string } | null, gamepadIndex?: number | null }[]} slots
 * @returns {C[]}
 */
export function withoutHeldTwins(gpCandidates, slots) {
  const held = (slots || []).filter((s) => s && s.state === 'claimed' && s.hidDevice);
  const dropIdx = new Set(held.filter((s) => s.gamepadIndex != null).map((s) => s.gamepadIndex));
  let out = gpCandidates.filter((c) => !dropIdx.has(c.gpIndex));
  for (const s of held) {
    if (s.gamepadIndex != null) continue;
    const name = String((s.hidDevice && s.hidDevice.productName) || '').trim().toLowerCase();
    if (!name) continue;
    const twins = out.filter((c) => String(c.gp && c.gp.id || '').toLowerCase().includes(name));
    if (twins.length === 1) out = out.filter((c) => c !== twins[0]);
  }
  return out;
}
