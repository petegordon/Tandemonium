// @ts-check
// ============================================================
// inputs.js — input sources for FocusController
// ============================================================
//
// FocusController reads one object with the InputManager shape Tandemonium
// already has: `gamepadConnected`, `getGamepadState()`, `_gpSwapAB`. These
// are the two small sources a host without an InputManager needs:
//
//   GamepadInput  — the first connected Gamepad-API pad (or a fixed index)
//   ManualInput   — edges set from code; for tests and keyboard fallbacks
//
// Both are plain objects by duck-typing; nothing here touches the DOM.

/** @typedef {{ gamepadConnected: boolean, getGamepadState: () => (Gamepad | ManualPad | null), _gpSwapAB: boolean }} FocusInput */
/** @typedef {{ buttons: { pressed: boolean }[], axes: number[] }} ManualPad */

export class GamepadInput {
  /** @param {{ index?: number, swapAB?: boolean }} [opts] index: a fixed pad slot; omit for "first connected" */
  constructor(opts = {}) {
    this.index = opts.index ?? null;
    this._gpSwapAB = !!opts.swapAB;
  }
  /** @returns {Gamepad | null} */
  getGamepadState() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this.index != null) return pads[this.index] || null;
    for (const p of pads) if (p) return p;
    return null;
  }
  get gamepadConnected() { return !!this.getGamepadState(); }
}

/**
 * Edges from code. `press('a')` / `release('a')`, or `set({ up: true })`.
 * Button indices follow the standard mapping FocusController reads
 * (0 A · 1 B · 12–15 d-pad); `axisX` / `axisY` drive the stick.
 */
export class ManualInput {
  constructor() {
    /** @type {Record<string, boolean>} */ this._down = {};
    this.axisX = 0; this.axisY = 0;
    this._gpSwapAB = false;
    this.gamepadConnected = true;
  }
  /** @param {Partial<Record<'a'|'b'|'up'|'down'|'left'|'right', boolean>>} state */
  set(state) { Object.assign(this._down, state); return this; }
  /** @param {'a'|'b'|'up'|'down'|'left'|'right'} k */ press(k) { this._down[k] = true; return this; }
  /** @param {'a'|'b'|'up'|'down'|'left'|'right'} k */ release(k) { this._down[k] = false; return this; }
  releaseAll() { this._down = {}; this.axisX = 0; this.axisY = 0; return this; }
  /** @returns {ManualPad} */
  getGamepadState() {
    const d = this._down;
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false }));
    buttons[0].pressed = !!d.a; buttons[1].pressed = !!d.b;
    buttons[12].pressed = !!d.up; buttons[13].pressed = !!d.down; buttons[14].pressed = !!d.left; buttons[15].pressed = !!d.right;
    return { buttons, axes: [this.axisX, this.axisY, 0, 0] };
  }
}
