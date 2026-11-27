// #885 · Lay the game out at a 1920×1080 reference viewport on every screen.
//
// Windows gives a 4K TV 300% scaling by default (also under Steam Big Picture),
// so Chromium reports a 1280×720 CSS viewport and the TV layout (css/lobby-tv.css,
// built for 1920) wraps. Browser zoom fixes it in one place: it rescales
// innerWidth/innerHeight, media queries, vw/vh, devicePixelRatio and hit-testing
// together, so the CSS breakpoints and the Three.js pointer maths need no change.
// It is the desktop twin of the `width=1920` viewport the TV-browser build sets
// at the top of index.html.
//
//   4K TV @ 300% (1280×720 DIP)  → zoom 0.667 → 1920×1080 @ 2×
//   4K TV @ 200% (1920×1080 DIP) → zoom 1     → 1920×1080 @ 2×
//   1280×800 @ 100%              → zoom 0.667 → 1920×1200 @ 0.67×
//   3440×1440 @ 100%             → zoom 1.333 → 2580×1080 @ 1.33×
//
// The shorter side always fits the reference, so the layout never has less than
// 1920×1080 CSS px; extra width or height (16:10, 21:9) stays responsive.

const REF_W = 1920;
const REF_H = 1080;
/** Below this a small window's text gets unreadable; it keeps its own layout instead. */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

/** Zoom factor for a content area of w×h DIPs (device-independent pixels, before zoom). */
function uiZoomFor(w, h) {
  if (!(w > 0) || !(h > 0)) return 1;
  const z = Math.min(w / REF_W, h / REF_H);
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 1e6) / 1e6;
}

/**
 * Keep `win` at the reference zoom while it is resized, toggles fullscreen, is
 * dragged to another display, or a display's scaling changes. Changing the zoom
 * fires `resize` in the page, so the game re-sizes its canvas and render scale
 * there. TANDEM_UI_ZOOM=off disables it (to compare against the raw OS scaling).
 */
function keepReferenceZoom(win, { screen, log = () => {} } = {}) {
  if (process.env.TANDEM_UI_ZOOM === 'off') return;
  const wc = win.webContents;
  let last = 0;
  const apply = () => {
    if (win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    const z = uiZoomFor(w, h);
    if (z !== wc.getZoomFactor()) wc.setZoomFactor(z);
    if (z !== last) { last = z; log(`[ui-zoom] ${w}×${h} DIP → zoom ${z}`); }
  };
  for (const ev of ['resize', 'moved', 'enter-full-screen', 'leave-full-screen']) win.on(ev, apply);
  wc.on('did-finish-load', apply);
  // Ctrl+wheel / Ctrl+± would otherwise zoom the page off the reference.
  wc.on('zoom-changed', () => setImmediate(apply));
  if (screen) {
    const onDisplays = () => setImmediate(apply);
    for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, onDisplays);
    win.on('closed', () => {
      for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.removeListener(ev, onDisplays);
    });
  }
  apply();
}

module.exports = { uiZoomFor, keepReferenceZoom, REF_W, REF_H, MIN_ZOOM };
