// @ts-check
// ============================================================
// PERF READOUT — on-screen diagnostics for display testing
// ============================================================
//
// Options → Display Testing → Perf Readout (or ?debug=perf). A small panel at
// the top left: frame rate, quality tier, the size actually rendered, edge
// smoothing, the GPU the browser is really using (a "SwiftShader" here means
// it fell back to drawing on the CPU), draw calls / triangles of the last
// frame, GPU objects and JS heap, and the display: what kind of device this is
// (desktop app, TV browser, phone, desktop browser), its model when the browser
// says, and the screen (the desktop app names the monitor or TV it is on).
// Text updates twice a second.

import { isMobile, isTV } from './config.js';

/** Device model from the user agent: Android puts it before " Build/" (e.g. "BRAVIA 4K VH2"). @param {string} ua */
export function uaModel(ua) {
  const m = /Android[^;)]*;\s*([^;)]+?)\s+Build\//.exec(ua) || /;\s*(AFT[A-Z0-9]+)\b/.exec(ua);
  if (m && m[1] !== 'K') return m[1].trim();
  const tv = /(Web0S|webOS|Tizen|SmartTV|SMART-TV|NetCast|Roku|CrKey)/i.exec(ua);
  return tv ? tv[1] : '';
}

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
    const w = /** @type {any} */ (window);
    this._kind = w.electronApp ? 'desktop app' : isTV ? 'TV browser' : isMobile ? 'phone/tablet' : 'desktop browser';
    this._model = uaModel(navigator.userAgent);
    /** @type {any} */ this._display = null;
    // The browser's frozen user agent hides the model; ask for it where supported.
    /** @type {any} */ (navigator).userAgentData?.getHighEntropyValues?.(['model'])
      .then((/** @type {any} */ v) => { if (v && v.model) this._model = v.model; }).catch(() => {});
    w.electronApp?.display?.().then((/** @type {any} */ d) => { this._display = d; }).catch(() => {});
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

  /** e.g. "display TV browser · BRAVIA 4K VH2 · screen 960×540 @2x", or in the app the monitor's name and Hz. */
  _displayLine() {
    const parts = [this._kind];
    if (this._model) parts.push(this._model);
    const d = this._display;
    if (d) {
      parts.push(`${d.label || (d.internal ? 'built-in screen' : 'external screen')} ${d.width}×${d.height} @${d.scale}x${d.hz ? ' ' + Math.round(d.hz) + 'Hz' : ''}`);
      if (d.count > 1) parts.push(`${d.count} displays`);
    } else {
      parts.push(`screen ${screen.width}×${screen.height} @${+(devicePixelRatio || 1).toFixed(2)}x`);
    }
    return `display ${parts.join(' · ')}`;
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
      this._displayLine(),
    ];
    if (mem) lines.push(`JS heap ${Math.round(mem.usedJSHeapSize / 1048576)} / ${Math.round(mem.jsHeapSizeLimit / 1048576)} MB`);
    this.el.textContent = lines.join('\n');
  }
}
