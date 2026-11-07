// ============================================================
// APP QUIT — leave the game from the lobby, desktop app only (#172)
//
// The web build is a browser tab (the tab's close box quits it) and a phone
// has no pad, so the lobby's QUIT pill shows only where the Electron preload
// bridge (electron/preload.js) exposes electronApp.quit. No pad chord: every
// pad family differs and Start/Options already opens Settings, so QUIT is an
// ordinary bar button the pad reaches like any other, behind a confirm sheet.
//
// Pure + DOM-free so node tests can import it: pass `window` (or a stand-in).
// ============================================================

/**
 * Whether this build can quit the app: the Electron bridge is present and
 * offers quit(). False on the web build, on phones, and on an older desktop
 * preload without the method.
 * @param {any} win  window, or an object with the same globals
 */
export function canQuitApp(win) {
  const api = win && win.electronApp;
  return !!(api && typeof api.quit === 'function');
}

/**
 * Ask the main process to quit (app.quit(): will-quit hooks still run).
 * @param {any} win
 * @returns {boolean} true if the request was sent
 */
export function requestAppQuit(win) {
  if (!canQuitApp(win)) return false;
  try { win.electronApp.quit(); } catch (e) { return false; }
  return true;
}
