const { contextBridge, ipcRenderer } = require('electron');

// Forward uncaught renderer errors to the main-process diag log so we can
// debug headless launches without DevTools. Fires on syntax/runtime errors
// during module evaluation AND on unhandled promise rejections.
window.addEventListener('error', (ev) => {
  try {
    ipcRenderer.send('renderer:diag', `[renderer error] ${ev.message} @ ${ev.filename}:${ev.lineno}:${ev.colno}${ev.error?.stack ? '\n' + ev.error.stack : ''}`);
  } catch (e) {}
});
window.addEventListener('unhandledrejection', (ev) => {
  try {
    const reason = ev.reason && ev.reason.stack ? ev.reason.stack : String(ev.reason);
    ipcRenderer.send('renderer:diag', `[renderer rejection] ${reason}`);
  } catch (e) {}
});

contextBridge.exposeInMainWorld('electronApp', {
  toggleDevTools: () => ipcRenderer.invoke('app:toggleDevTools'),
  // Devices the renderer already holds, from ControllerManager.heldHidDescriptors().
  // The main-process picker feeds these to the core's pickNewHidDevice so a
  // requestDevice() aimed at pairing a SECOND controller grants one we do NOT
  // have. Same channel and shape as the lab's overlay app.
  setHeldHidDevices: (list) => ipcRenderer.send('hid:held', list),
  // Write a line into tandemonium-diag.log. For the states that only occur on
  // a real machine with real controllers, where DevTools isn't practical.
  diag: (msg) => ipcRenderer.send('renderer:diag', String(msg)),
  // #172: the lobby's QUIT pill (desktop only). main.js calls app.quit(), so
  // the will-quit hooks run as on a window close.
  quit: () => ipcRenderer.send('app:quit'),
  // Perf readout: { label, width, height, scale, hz, internal, count } of the window's display.
  display: () => ipcRenderer.invoke('app:display'),
  // #612: open a Discord sign-in page (our API's /auth/… only) in the system browser.
  openSignIn: (url) => ipcRenderer.invoke('app:openSignIn', url),
});

// #400 B4c: main decides the edition (--demo, TANDEMONIUM_DEMO=1, or the demo
// Steam app id); js/edition.js reads tandemoniumSteam.isDemo. Synchronous so
// it is set before any module asks for the edition rules.
let _isDemo = false;
try { _isDemo = ipcRenderer.sendSync('app:isDemo') === true; } catch (e) {}
contextBridge.exposeInMainWorld('tandemoniumSteam', { isDemo: _isDemo });

// XInput slot → Steam handle/type (#362): which physical pad sits behind each
// virtual XInput device Steam emits. Pushed from main at ~60Hz.
let _steamXInputMap = [];
ipcRenderer.on('steam:input:xinput', (_event, map) => {
  _steamXInputMap = map || [];
});

contextBridge.exposeInMainWorld('steam', {
  isAvailable: () => ipcRenderer.invoke('steam:isAvailable'),
  getPlayerName: () => ipcRenderer.invoke('steam:getPlayerName'),
  getSteamId: () => ipcRenderer.invoke('steam:getSteamId'),
  isSubscribed: () => ipcRenderer.invoke('steam:isSubscribed'),
  activateAchievement: (apiName) => ipcRenderer.invoke('steam:activateAchievement', apiName),
  isAchievementActivated: (apiName) => ipcRenderer.invoke('steam:isAchievementActivated', apiName),
  getAuthTicket: () => ipcRenderer.invoke('steam:getAuthTicket'),
  storeStats: () => ipcRenderer.invoke('steam:storeStats'),
  // #657 · the result card into the Steam screenshot library: { png, rgb, width, height, caption } → { ok, error }.
  saveScreenshot: (req) => ipcRenderer.invoke('steam:saveScreenshot', req),
  input: {
    isAvailable: () => ipcRenderer.invoke('steam:input:isAvailable'),
    getXInputMap: () => _steamXInputMap,
    getFullDiag: () => ipcRenderer.invoke('steam:input:fullDiag'),
    // #617 · Steam Controller haptics, by a Steam Input handle from getXInputMap().
    // strong / weak 0..1; main stops the vibration after ms.
    vibrate: (handle, strong, weak, ms) => ipcRenderer.send('steam:input:vibrate', { handle: String(handle), strong: +strong || 0, weak: +weak || 0, ms: +ms || 0 }),
  },
});
