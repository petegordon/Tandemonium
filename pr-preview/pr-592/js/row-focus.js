// @ts-check
// ============================================================
// RowFocusController (#517) — the kit's FocusController with two TV fixes.
// ============================================================
//
// 1. Up / down go to the NEAREST ROW first. The kit picks the neighbour with
//    the best centre-to-centre score, so on the level step a card on the far
//    left jumped past the difficulty row to the Help pill right under it, and
//    Chill Ride skipped START RIDE for Profile. Here the row whose edge is
//    closest in the pressed direction wins, and within that row the item
//    closest sideways. Left / right keep the kit's rule.
// 2. The focused item scrolls into view, so a long list (Settings) or a
//    scrolling sheet never leaves the highlight off-screen.
//
// shared/ui is vendored from the controller lab (npm run check:ui guards it),
// so this lives in the game until the rule is upstreamed to the kit.

import { FocusController } from '../shared/ui/focus-controller.js';

/** @typedef {{ left: number, right: number, top: number, bottom: number }} Box */

/**
 * The item to move to from `from` going `dir` ('up' | 'down'), or null.
 * Pure geometry, exported for the unit test.
 * @param {Box} from @param {'up'|'down'} dir @param {Box[]} boxes
 * @returns {number} index into `boxes`, or -1
 */
export function nearestRowIndex(from, dir, boxes) {
  const cx = (from.left + from.right) / 2, cy = (from.top + from.bottom) / 2;
  const cand = [];
  boxes.forEach((b, i) => {
    const by = (b.top + b.bottom) / 2;
    if (dir === 'down' ? by - cy < 1 : cy - by < 1) return;   // must lie in the pressed direction
    // Gap between the edges along the move (0 when they overlap).
    const gap = Math.max(0, dir === 'down' ? b.top - from.bottom : from.top - b.bottom);
    // Sideways: 0 when the columns overlap, else the distance between edges.
    const side = Math.max(0, b.left - from.right, from.left - b.right);
    const off = Math.abs((b.left + b.right) / 2 - cx);
    cand.push({ i, gap, side, off, h: b.bottom - b.top });
  });
  if (!cand.length) return -1;
  const minGap = Math.min(...cand.map((c) => c.gap));
  // One row = within half an item's height of the nearest edge.
  const tol = Math.max(12, (from.bottom - from.top) / 2);
  const row = cand.filter((c) => c.gap <= minGap + tol);
  row.sort((a, b) => (a.side - b.side) || (a.off - b.off) || (a.gap - b.gap));
  return row[0].i;
}

export class RowFocusController extends FocusController {
  /**
   * The kit's options, plus `onEdge(dir)`: up / down with nothing further that
   * way (a result screen's button row under a scrolling body) — scroll there.
   * @param {ConstructorParameters<typeof FocusController>[0] & { onEdge?: ((dir: 'up'|'down') => void) | null }} opts
   */
  constructor(opts) {
    super(opts);
    this._onEdge = opts.onEdge || null;
    /** @type {HTMLElement | null} */ this._lastScrolled = null;
  }

  /**
   * @override
   * @param {HTMLElement} el @param {'up'|'down'|'left'|'right'} dir
   * @returns {HTMLElement | null}
   */
  _spatialNeighbor(el, dir) {
    if (dir === 'left' || dir === 'right') return super._spatialNeighbor(el, dir);
    const others = this.items.filter((o) => o !== el && this._visible(o));
    const i = nearestRowIndex(el.getBoundingClientRect(), dir, others.map((o) => o.getBoundingClientRect()));
    if (i < 0 && this._onEdge) this._onEdge(dir);
    return i < 0 ? null : others[i];
  }

  /** @override */
  poll() {
    super.poll();
    const el = this.focused;
    if (el && el !== this._lastScrolled) {
      this._lastScrolled = el;
      scrollIntoViewIfNeeded(el);
    } else if (!el) this._lastScrolled = null;
  }
}

/** Right stick Y (axis 3) scrolls `box` smoothly. @param {HTMLElement | null | undefined} box @param {number | undefined} axis */
export function scrollWithStick(box, axis) {
  if (box && Math.abs(axis || 0) > 0.15) box.scrollTop += /** @type {number} */ (axis) * 14;
}

/** One d-pad press: scroll `box` most of a screen up or down. @param {HTMLElement | null | undefined} box @param {'up'|'down'} dir */
export function scrollPage(box, dir) {
  if (!box || box.scrollHeight <= box.clientHeight + 1) return;
  box.scrollBy({ top: (dir === 'down' ? 1 : -1) * Math.max(60, box.clientHeight * 0.6), behavior: 'smooth' });
}

/** Scroll `el`'s scrolling ancestors just enough to show it (no page jump when it already shows). @param {HTMLElement} el */
export function scrollIntoViewIfNeeded(el) {
  if (!el || typeof el.scrollIntoView !== 'function') return;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return;
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (!/(auto|scroll)/.test(cs.overflowY) || a.scrollHeight <= a.clientHeight + 1) continue;
    const ar = a.getBoundingClientRect();
    if (r.top < ar.top || r.bottom > ar.bottom) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
}
