// @ts-check
// ============================================================
// RowFocusController (#517) — the kit's FocusController with two TV fixes.
// ============================================================
//
// 0. Left / right stay in the ROW. The kit scores every item in the pressed
//    direction, so from a full-width centre button (JOIN WITH KEYBOARD,
//    CHOOSE LEVEL on the versus step) the only thing "to the left" is a
//    bottom-bar pill, and the highlight dropped into the bar — while the
//    same stick push was Player 1's team switch (#581). Nothing beside you
//    in the row = no move; only down reaches the bar.
// 1. Up / down go to the NEAREST ROW first. The kit picks the neighbour with
//    the best centre-to-centre score, so on the level step a card on the far
//    left jumped past the difficulty row to the Help pill right under it, and
//    Chill Ride skipped START RIDE for Profile. Here the row whose edge is
//    closest in the pressed direction wins, and within that row the item
//    closest sideways. Left / right keep the kit's rule.
// 2. The focused item scrolls into view, so a long list (Settings) or a
//    scrolling sheet never leaves the highlight off-screen.
// 3. Opt-in hold-to-repeat on up / down (`repeat`): a press moves one row, a
//    held d-pad or left stick repeats after REPEAT.delay and speeds up, so a
//    long sheet (the 100 achievements) runs top to bottom in a couple of
//    seconds. See holdRepeatStep() for the curve.
//
// shared/ui is vendored from the controller lab (npm run check:ui guards it),
// so this lives in the game until the rule is upstreamed to the kit.

import { FocusController } from '../shared/ui/focus-controller.js';

/** @typedef {{ left: number, right: number, top: number, bottom: number }} Box */

/**
 * Hold-to-repeat feel (ms). First repeat after `delay`; each gap then shrinks
 * by `accel` down to `min`; from the `burstAfter`-th repeat on, every step moves
 * `burst` rows. About 8 rows/s at first, 20 rows/s after ~1 s of holding, 40
 * rows/s after ~1.5 s — the achievements sheet (about 32 rows) in about 2 s —
 * and a release stops on the row you're on.
 */
export const REPEAT = { delay: 350, first: 120, accel: 0.82, min: 50, burstAfter: 20, burst: 2 };

/**
 * The repeat schedule, pure for the unit test: after `n` repeats (0-based),
 * how long until the next one and how many rows it moves.
 * @param {number} n @returns {{ gap: number, rows: number }}
 */
export function holdRepeatStep(n) {
  return {
    gap: Math.max(REPEAT.min, REPEAT.first * Math.pow(REPEAT.accel, n)),
    rows: n >= REPEAT.burstAfter ? REPEAT.burst : 1,
  };
}

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

/**
 * The item to move to from `from` going `dir` ('left' | 'right') WITHIN its
 * row, or -1. A candidate is in the row when it overlaps `from` vertically
 * (its centre lies within `from`'s span, or vice versa). Nearest by the gap
 * along the move, then by vertical offset. Pure geometry, exported for the test.
 * @param {Box} from @param {'left'|'right'} dir @param {Box[]} boxes
 * @returns {number} index into `boxes`, or -1
 */
export function sameRowIndex(from, dir, boxes) {
  const cy = (from.top + from.bottom) / 2;
  let best = -1, bestGap = Infinity, bestOff = Infinity;
  boxes.forEach((b, i) => {
    const by = (b.top + b.bottom) / 2;
    const inRow = (by >= from.top && by <= from.bottom) || (cy >= b.top && cy <= b.bottom);
    if (!inRow) return;
    const gap = dir === 'right' ? b.left - from.right : from.left - b.right;
    const centreGap = dir === 'right' ? (b.left + b.right) / 2 - (from.left + from.right) / 2 : (from.left + from.right) / 2 - (b.left + b.right) / 2;
    if (centreGap < 1) return;   // must lie in the pressed direction
    const off = Math.abs(by - cy);
    if (gap < bestGap || (gap === bestGap && off < bestOff)) { best = i; bestGap = gap; bestOff = off; }
  });
  return best;
}

export class RowFocusController extends FocusController {
  /**
   * The kit's options, plus `onEdge(dir)`: up / down with nothing further that
   * way (a result screen's button row under a scrolling body) — scroll there.
   * And `repeat`: true (or a function checked each frame) turns on
   * hold-to-repeat for up / down (REPEAT).
   * @param {ConstructorParameters<typeof FocusController>[0] & { onEdge?: ((dir: 'up'|'down') => void) | null, repeat?: boolean | (() => boolean) }} opts
   */
  constructor(opts) {
    super(opts);
    this._onEdge = opts.onEdge || null;
    /** @type {HTMLElement | null} */ this._lastScrolled = null;
    this._repeat = opts.repeat || false;
    /** @type {'up'|'down'|null} */ this._holdDir = null;
    this._holdBlocked = false;   // a direction already held when the scope opened: no repeat until it's released
    this._holdNext = 0;
    this._holdCount = 0;
    this._repeating = false;     // a repeat step is moving: onEdge stays quiet (only a fresh press scrolls past the end)
  }

  /** @override @param {(HTMLElement | null | undefined)[]} items @param {HTMLElement | null} [initialEl] */
  setSpatial(items, initialEl = null) { super.setSpatial(items, initialEl); this._blockHold(); return this; }

  /** @override @param {(HTMLElement | null | undefined)[]} items @param {number} [initialIndex] */
  setItems(items, initialIndex = 0) { super.setItems(items, initialIndex); this._blockHold(); return this; }

  /** @override */
  reprime() { super.reprime(); this._blockHold(); }

  /** Move the focus straight to `el` (one of the items), e.g. a section jump. @param {HTMLElement | null} el */
  focusElement(el) {
    const i = el ? this.items.indexOf(el) : -1;
    if (!el || i < 0) return;
    if (this._spatial) {
      if (this.focusedEl) this.focusedEl.classList.remove(this.focusClass);
      this.focusedEl = el;
      el.classList.add(this.focusClass);
    } else {
      this._clearFocus();
      this.index = i;
      this._applyFocus();
    }
    if (this._onChange) this._onChange(el, i);
  }

  _blockHold() {
    this._holdDir = null;
    this._holdCount = 0;
    this._holdBlocked = !!(this._edge.up || this._edge.down);
  }

  _repeatOn() {
    return typeof this._repeat === 'function' ? !!this._repeat() : !!this._repeat;
  }

  /** After the kit's edge-detected poll: repeat a held up / down. */
  _pollRepeat() {
    const e = this._edge;   // the kit keeps this frame's read here
    const live = !!(this.input && this.input.gamepadConnected && this.input.getGamepadState());   // a dropped pad leaves _edge stale
    const dir = !live ? null : e.up && !e.down ? 'up' : e.down && !e.up ? 'down' : null;
    if (!dir) { this._holdDir = null; this._holdBlocked = false; return; }
    if (this._holdBlocked || !this._repeatOn()) { this._holdDir = null; return; }
    const now = performance.now();
    if (dir !== this._holdDir) {   // a fresh press: the kit already moved one row
      this._holdDir = dir; this._holdCount = 0; this._holdNext = now + REPEAT.delay;
      return;
    }
    if (now < this._holdNext) return;
    const { gap, rows } = holdRepeatStep(this._holdCount++);
    this._holdNext = now + gap;
    this._repeating = true;
    try {
      for (let k = 0; k < rows; k++) {
        if (this._spatial) this._moveDir(dir);
        else this.move(dir === 'up' ? -1 : 1);
      }
    } finally { this._repeating = false; }
  }

  /**
   * @override
   * @param {HTMLElement} el @param {'up'|'down'|'left'|'right'} dir
   * @returns {HTMLElement | null}
   */
  _spatialNeighbor(el, dir) {
    const others = this.items.filter((o) => o !== el && this._visible(o));
    if (dir === 'left' || dir === 'right') {
      const j = sameRowIndex(el.getBoundingClientRect(), dir, others.map((o) => o.getBoundingClientRect()));
      return j < 0 ? null : others[j];
    }
    const i = nearestRowIndex(el.getBoundingClientRect(), dir, others.map((o) => o.getBoundingClientRect()));
    if (i < 0 && this._onEdge && !this._repeating) this._onEdge(dir);
    return i < 0 ? null : others[i];
  }

  /** @override */
  poll() {
    super.poll();
    this._pollRepeat();
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
