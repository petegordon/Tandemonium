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
   * @param {'both'|'vertical'} [opts.orientation='both'] — which axes move
   *   focus. 'both' (default): up/down AND left/right step the flat list (for
   *   narrow button stacks). 'vertical': only up/down move focus, leaving
   *   left/right for a registered slider.
   * @param {()=>boolean} [opts.canConfirm] — optional gate; confirm is ignored
   *   while it returns false (e.g. an overlay's "can't dismiss yet" cooldown).
   */
  constructor({ input, focusClass = 'gamepad-focus', onConfirm = null, onBack = null, onChange = null, orientation = 'both', canConfirm = null } = {}) {
    this.input = input;
    this.focusClass = focusClass;
    this._onConfirm = onConfirm;
    this._onBack = onBack;
    this._onChange = onChange;
    this._orientation = orientation;
    this._canConfirm = canConfirm;
    this.items = [];
    this.index = 0;
    this._edge = { ...NO_EDGES };
    // Optional range <input> driven by left/right (analog + d-pad repeat).
    this._slider = null;
    this._sliderRepeatAt = 0;
  }

  /**
   * Register (or clear) a range <input> that left/right drives instead of
   * moving focus — analog stick is continuous/proportional, d-pad steps with a
   * press-then-repeat cadence. Pass null to detach.
   */
  setSlider(el) {
    this._slider = el || null;
    this._sliderRepeatAt = 0;
    return this;
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

  /** Remove focus styling, drop the item list, and detach any slider. */
  clear() {
    this._clearFocus();
    this.items = [];
    this.index = 0;
    this._slider = null;
  }

  /**
   * Read the pad once and dispatch nav / slider / confirm / back via edge
   * detection. The caller drives this each frame; the controller does not
   * schedule.
   */
  poll() {
    const e = this._readEdges();
    if (!e) return;
    const prev = this._edge;

    if (this._slider) {
      // Slider consumes the horizontal axis; focus moves on up/down only.
      this._driveSlider(e, prev);
    } else if (this._orientation === 'both') {
      if (e.left && !prev.left) this.move(-1);
      if (e.right && !prev.right) this.move(1);
    }
    if (e.up && !prev.up) this.move(-1);
    if (e.down && !prev.down) this.move(1);
    if (e.a && !prev.a && (!this._canConfirm || this._canConfirm())) this.confirm();
    if (e.b && !prev.b) this.back();

    this._edge = e;
  }

  /** Drive the registered slider from the horizontal axis (analog + d-pad). */
  _driveSlider(e, prev) {
    const s = this._slider;
    const min = Number(s.min), max = Number(s.max);
    const clampS = (v) => Math.min(max, Math.max(min, v));
    let changed = false;

    // Analog stick: continuous proportional movement (~full sweep in ~1s @60Hz).
    if (Math.abs(e.axisX) > 0.12) {
      s.value = clampS(Number(s.value) + e.axisX * 1.5);
      changed = true;
    }
    // D-pad: discrete step on press, then repeat while held (400ms → 80ms).
    const now = performance.now();
    const step = (dir, firstMag, repMag) => {
      if (!(dir === -1 ? e.left : e.right)) return;
      const held = dir === -1 ? prev.left : prev.right;
      if (!held) { s.value = clampS(Number(s.value) + dir * firstMag); changed = true; this._sliderRepeatAt = now + 400; }
      else if (now > this._sliderRepeatAt) { s.value = clampS(Number(s.value) + dir * repMag); changed = true; this._sliderRepeatAt = now + 80; }
    };
    step(-1, 3, 2);
    step(1, 3, 2);

    if (changed) s.dispatchEvent(new Event('input'));
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
      axisX: gp.axes[0] || 0, // raw, for slider control
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
