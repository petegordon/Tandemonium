// ============================================================
// FocusController — controller-driven focus engine (nav-core)
// ============================================================
//
// A single, framework-agnostic abstraction for "poll gamepad → edge-detect →
// move a focus index → toggle .gamepad-focus", replacing the copy-pasted
// polling loops across the lobby, in-game overlays, and the clip preview.
// See issue #318 (Step 1, @usersfirst/nav-core). In-repo first; this is the
// seam that later lifts to its own package.
//
// Design notes:
//  - Fed by an InputManager (getGamepadState() + the _gpSwapAB A/B-swap
//    quirk), NOT a per-call-site navigator.getGamepads(). One input owner.
//  - Caller-driven: it exposes poll() and the caller decides scheduling (a
//    self-scheduling RAF loop, or the game loop) — RAF ownership varies across
//    the existing call sites, so the controller never owns it.
//  - Linear list semantics (up/left = previous, down/right = next, clamped) —
//    this matches every flat-list call site. Richer geometries (2D grids,
//    multi-column, sliders) layer on top in later migrations.
// ============================================================

const NO_EDGES = { up: false, down: false, left: false, right: false, a: false, b: false };

export class FocusController {
  /**
   * @param {Object} opts
   * @param {Object} opts.input — InputManager: needs `gamepadConnected`,
   *   `getGamepadState()`, and the `_gpSwapAB` quirk flag.
   * @param {string} [opts.focusClass='gamepad-focus'] — CSS class toggled on
   *   the focused element.
   * @param {(el:Element, index:number)=>void} [opts.onConfirm] — A-button
   *   action. Defaults to `el.click()`.
   * @param {()=>void} [opts.onBack] — B-button action. No-op if omitted.
   * @param {(el:Element, index:number)=>void} [opts.onChange] — fired after
   *   focus moves to a new item.
   */
  constructor({ input, focusClass = 'gamepad-focus', onConfirm = null, onBack = null, onChange = null } = {}) {
    this.input = input;
    this.focusClass = focusClass;
    this._onConfirm = onConfirm;
    this._onBack = onBack;
    this._onChange = onChange;
    this.items = [];
    this.index = 0;
    this._edge = { ...NO_EDGES };
  }

  /**
   * Set the focusable list and highlight `initialIndex`. Falsy entries are
   * dropped (callers can pass a sparse list of maybe-hidden buttons). Primes
   * edge-state from the current pad so a button already held when the scope
   * opens doesn't immediately fire.
   */
  setItems(items, initialIndex = 0) {
    this._clearFocus();
    this.items = (items || []).filter(Boolean);
    this.index = this._clamp(initialIndex);
    this._edge = this._readEdges() || { ...NO_EDGES };
    this._applyFocus();
    return this;
  }

  /** Remove focus styling and drop the item list. */
  clear() {
    this._clearFocus();
    this.items = [];
    this.index = 0;
  }

  /**
   * Read the pad once and dispatch nav / confirm / back via edge detection.
   * The caller drives this each frame; the controller does not schedule.
   */
  poll() {
    const e = this._readEdges();
    if (!e) return;
    if ((e.up && !this._edge.up) || (e.left && !this._edge.left)) this.move(-1);
    if ((e.down && !this._edge.down) || (e.right && !this._edge.right)) this.move(1);
    if (e.a && !this._edge.a) this.confirm();
    if (e.b && !this._edge.b) this.back();
    this._edge = e;
  }

  /** Move focus by `dir` (clamped — no wrap, matching the existing loops). */
  move(dir) {
    if (!this.items.length) return;
    this._clearFocus();
    this.index = this._clamp(this.index + dir);
    this._applyFocus();
    if (this._onChange) this._onChange(this.items[this.index], this.index);
  }

  /** Trigger the focused item's action (onConfirm, else `el.click()`). */
  confirm() {
    const el = this.items[this.index];
    if (!el) return;
    if (this._onConfirm) this._onConfirm(el, this.index);
    else el.click();
  }

  /** Trigger the back action, if any. */
  back() {
    if (this._onBack) this._onBack();
  }

  /** Currently focused element, or null. */
  get focused() {
    return this.items[this.index] || null;
  }

  // ── internals ──

  _clamp(i) {
    return Math.max(0, Math.min(this.items.length - 1, i));
  }

  /** Read the current pad into a normalized edge snapshot, honoring A/B swap. */
  _readEdges() {
    if (!this.input || !this.input.gamepadConnected) return null;
    const gp = this.input.getGamepadState();
    if (!gp) return null;
    const aIdx = this.input._gpSwapAB ? 1 : 0;
    const bIdx = this.input._gpSwapAB ? 0 : 1;
    return {
      up:    !!((gp.buttons[12] && gp.buttons[12].pressed) || gp.axes[1] < -0.5),
      down:  !!((gp.buttons[13] && gp.buttons[13].pressed) || gp.axes[1] > 0.5),
      left:  !!((gp.buttons[14] && gp.buttons[14].pressed) || gp.axes[0] < -0.5),
      right: !!((gp.buttons[15] && gp.buttons[15].pressed) || gp.axes[0] > 0.5),
      a: !!(gp.buttons[aIdx] && gp.buttons[aIdx].pressed),
      b: !!(gp.buttons[bIdx] && gp.buttons[bIdx].pressed),
    };
  }

  _applyFocus() {
    const el = this.items[this.index];
    if (el) el.classList.add(this.focusClass);
  }

  _clearFocus() {
    for (const el of this.items) {
      if (el) el.classList.remove(this.focusClass);
    }
  }
}
