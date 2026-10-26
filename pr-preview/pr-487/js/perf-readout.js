// @ts-check
// ============================================================
// PERF READOUT — on-screen diagnostics for display testing
// ============================================================
//
// Options → Display Testing → Perf Readout (or ?debug=perf). A small panel at
// the top left: frame rate, quality tier, the size actually rendered, edge
// smoothing, the GPU the browser is really using (a "SwiftShader" here means
// it fell back to drawing on the CPU), draw calls / triangles of the last
// frame, GPU objects and JS heap. Text updates twice a second.

export class PerfReadout {
  /** @param {any} game */
  constructor(game) {
    this.game = game;
    this._frames = 0;
    this._t0 = 0;
    this._fps = 0;
    const gl = game.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    this._gpu = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '?');
    this._aa = !!(gl.getContextAttributes() || {}).antialias;
    const el = document.createElement('div');
    el.id = 'perf-readout';
    el.style.cssText = [
      'position:fixed', 'top:calc(env(safe-area-inset-top, 0px) + 28px)', 'left:8px',
      'max-width:min(92vw, 520px)', 'padding:6px 10px', 'border-radius:8px',
      'background:rgba(0,0,0,0.7)', 'color:#cfe', 'white-space:pre-wrap',
      'font:600 13px/1.45 ui-monospace,Consolas,monospace', 'pointer-events:none', 'z-index:201',
    ].join(';');
    document.body.appendChild(el);
    this.el = el;
    // Count every render in a frame (main view + rider cam + split screens).
    game.renderer.info.autoReset = false;
    this._calls = 0;
    this._tris = 0;
    this._timer = setInterval(() => this._update(), 500);
  }

  /** Once per game frame, with the rAF timestamp (ms). */
  tick(ts) {
    const info = this.game.renderer.info;
    if (info.render.calls) { this._calls = info.render.calls; this._tris = info.render.triangles; }
    info.reset();
    if (!this._t0) { this._t0 = ts; this._frames = 0; return; }
    this._frames++;
    if (ts - this._t0 >= 500) {
      this._fps = Math.round((this._frames * 1000) / (ts - this._t0));
      this._t0 = ts;
      this._frames = 0;
    }
  }

  _update() {
    const g = this.game, r = g.renderer;
    const c = r.domElement;
    const info = r.info;
    const mem = /** @type {any} */ (performance).memory;
    const tier = g._quality + (g._qualityAuto ? ' (auto)' : '');
    const lines = [
      `FPS ${this._fps}   tier ${tier}   ${g.state}`,
      `render ${c.width}×${c.height} (${r.getPixelRatio().toFixed(2)}× of ${innerWidth}×${innerHeight})`,
      `edge smoothing ${this._aa ? 'on' : 'off'}   shadows ${r.shadowMap.enabled ? 'on' : 'off'}   riders ${g._showRiders ? 'on' : 'off'}`,
      `draws ${this._calls}   tris ${Math.round(this._tris / 1000)}k   geo ${info.memory.geometries}   tex ${info.memory.textures}`,
      `GPU ${this._gpu}`,
    ];
    if (mem) lines.push(`JS heap ${Math.round(mem.usedJSHeapSize / 1048576)} / ${Math.round(mem.jsHeapSizeLimit / 1048576)} MB`);
    this.el.textContent = lines.join('\n');
  }
}
