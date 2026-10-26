// @ts-check
// ============================================================
// UI SHELL (#459) — the game's conventions on top of the kit's <uf-sheet>.
// ============================================================
//
// Two shapes, both drawn by <uf-sheet> (shared/ui, vendored — not edited here):
//
//  RESULT SCREEN  <uf-sheet headline tone=… heading=…> with a stats body and
//                 ONE action row (slot="actions"). The row is read in DOM
//                 order, so the markup IS the order: the primary action (the
//                 `variant="accent"` button) first, then the other ride
//                 actions, then RETURN TO ROOM / END RIDE, then the extras
//                 (clip, garage, share, wishlist, invite). Focus starts on the
//                 primary (#467). Game over, victory, tutorial complete, demo
//                 end, partner left, versus results and the Slingshot results
//                 all use it (css/end-screens.css lays the row out).
//
//  MODAL          a sheet the pad's B, Esc, the scrim or the header's Close
//                 all dismiss, with the FocusController's scope and Back
//                 handler put back afterwards. The pause menu, the Garage, Help
//                 and the tutorial intro use it. One open modal at a time per
//                 controller; Options (its own overlay) may open over it and
//                 the caller re-focuses with `refocus()` when it closes.
//
// Only Player 1's pad drives these: the FocusController handed in is the
// game's `_overlayFocus` (its input is P1's InputManager).

/** What the pad can land on inside a sheet. */
const FOCUSABLE = 'uf-button, button, a[href], input[type="range"], [data-focusable]';

/** @param {Element} el */
function shown(el) {
  const h = /** @type {HTMLElement} */ (el);
  if (h.hidden || h.hasAttribute('disabled') || h.getAttribute('aria-disabled') === 'true') return false;
  if (h.style && h.style.display === 'none') return false;
  const r = h.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * The visible buttons of a sheet's action row, in DOM order (= the order on
 * screen, = the pad's order). `root` is the <uf-sheet> or any element holding
 * a `[slot="actions"]`; without one, every visible focusable in `root`.
 * @param {Element | null} root
 * @returns {HTMLElement[]}
 */
export function shellActions(root) {
  if (!root) return [];
  const row = root.querySelector('[slot="actions"]') || root;
  return /** @type {HTMLElement[]} */ (Array.from(row.querySelectorAll(FOCUSABLE))).filter(shown);
}

/**
 * Where focus starts: the given primary, else the first accent button, else
 * the first item. Pure — exported for the unit test.
 * @param {HTMLElement[]} items @param {HTMLElement | null} [primary]
 */
export function primaryIndex(items, primary = null) {
  if (primary) { const i = items.indexOf(primary); if (i >= 0) return i; }
  const i = items.findIndex((el) => el.getAttribute && el.getAttribute('variant') === 'accent');
  return i >= 0 ? i : 0;
}

/**
 * A result screen's action row onto the FocusController: DOM order, primary
 * focused. Returns the items it registered.
 * @param {import('../shared/ui/focus-controller.js').FocusController} fc
 * @param {Element | null} root @param {{ primary?: HTMLElement | null, extra?: HTMLElement[] }} [opts]
 */
export function focusResult(fc, root, { primary = null, extra = [] } = {}) {
  const items = [...shellActions(root), ...extra.filter((el) => el && shown(el))];
  fc.setItems(items, primaryIndex(items, primary));
  return items;
}

/**
 * Open a sheet as a modal on the FocusController.
 *
 *   const m = openModal(sheet, fc, { onClose: (reason) => … });
 *   m.close();        // programmatic: onClose('api')
 *   m.refocus();      // after something (Options) borrowed the controller
 *
 * `onClose(reason)` runs once, after the sheet has closed: 'back' (pad B),
 * 'escape', 'scrim', 'close' (the header control) are the player dismissing
 * it; 'api' is the game closing it. A non-dismissible sheet still closes on B
 * and Esc here (the kit only wires those for dismissible ones) — the caller
 * decides what dismissing means (the tutorial intro: SKIP).
 *
 * @param {any} sheet  the <uf-sheet>
 * @param {import('../shared/ui/focus-controller.js').FocusController} fc
 * @param {{ onClose?: (reason: string) => void, items?: HTMLElement[] | null, primary?: HTMLElement | null }} [opts]
 */
export function openModal(sheet, fc, { onClose = () => {}, items = null, primary = null } = {}) {
  const prevBack = fc._onBack;
  let done = false;
  const pick = () => {
    const list = items || /** @type {HTMLElement[]} */ (sheet.focusables()).filter((el) => !el.classList.contains('uf-sheet__close'));
    return list.filter(shown);
  };
  const refocus = () => {
    if (done || !sheet.open) return;
    const list = pick();
    fc.setItems(list, primaryIndex(list, primary));
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !sheet.open) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    sheet.close('escape');
  };
  const finish = (/** @type {CustomEvent} */ e) => {
    if (done) return;
    done = true;
    document.removeEventListener('keydown', onKey);
    if (fc._onBack === back) fc._onBack = prevBack;
    fc.clear();
    fc.reprime();
    onClose((e && e.detail && e.detail.reason) || 'api');
  };
  const back = () => { if (sheet.open) sheet.close('back'); };

  sheet.addEventListener('uf-sheet:close', finish, { once: true });
  // The kit's own Esc only closes dismissible sheets; ours closes every modal.
  if (!sheet.dismissible) document.addEventListener('keydown', onKey);
  fc._onBack = back;
  sheet.show();
  refocus();
  return {
    sheet,
    refocus,
    /** @param {string} [reason] */
    close(reason = 'api') { if (sheet.open) sheet.close(reason); else finish(/** @type {any} */ ({ detail: { reason } })); },
    get open() { return !done && !!sheet.open; },
  };
}
