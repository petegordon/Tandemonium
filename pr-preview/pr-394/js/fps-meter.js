// ============================================================
// FPS METER — tiny frame-rate readout (Options → FPS Display)
// ============================================================
//
// A small pill centered at the very top of the screen, above every mode's
// HUD (solo dashboard sits top-left, versus team panels top-left/right, so
// top-center is free everywhere). Ticked once per _loop frame; the text
// updates twice a second so the readout itself costs nothing measurable.

export class FpsMeter {
  constructor() {
    this.enabled = false;
    this._el = null;
    this._frames = 0;
    this._windowStart = 0;
    this._shownFps = -1;
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'fps-meter';
    el.style.cssText = [
      'position:fixed',
      'top:calc(env(safe-area-inset-top, 0px) + 4px)',
      'left:50%',
      'transform:translateX(-50%)',
      'padding:2px 8px',
      'border-radius:8px',
      'background:rgba(0,0,0,0.55)',
      'font:600 12px/1.4 system-ui,sans-serif',
      'font-variant-numeric:tabular-nums',
      'letter-spacing:0.04em',
      'color:#6f6',
      'pointer-events:none',
      'z-index:200',
    ].join(';');
    el.textContent = '-- FPS';
    document.body.appendChild(el);
    this._el = el;
  }

  /** Options toggle — applies live, persists via the caller. */
  setVisible(on) {
    this.enabled = !!on;
    if (this.enabled && !this._el) this._build();
    if (this._el) this._el.style.display = this.enabled ? 'block' : 'none';
    this._frames = 0;
    this._windowStart = 0;
    this._shownFps = -1;
  }

  /** Call once per rendered frame with the rAF timestamp (ms). */
  tick(timestamp) {
    if (!this.enabled || !this._el) return;
    if (!this._windowStart) {
      this._windowStart = timestamp;
      this._frames = 0;
      return;
    }
    this._frames++;
    const elapsed = timestamp - this._windowStart;
    if (elapsed < 500) return;

    const fps = Math.round((this._frames * 1000) / elapsed);
    this._frames = 0;
    this._windowStart = timestamp;
    if (fps === this._shownFps) return;
    this._shownFps = fps;
    this._el.textContent = `${fps} FPS`;
    // Green when smooth, amber when dipping, red when struggling.
    this._el.style.color = fps >= 50 ? '#6f6' : fps >= 30 ? '#fc6' : '#f66';
  }
}
