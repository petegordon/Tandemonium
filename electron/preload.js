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
});

// Steam Input snapshot: pushed from main at ~60Hz via 'steam:input:tick'.
// Renderer reads `window.steam.input.getLatest()` synchronously each frame —
// no per-frame IPC round-trip.
let _steamInputLatest = [];
ipcRenderer.on('steam:input:tick', (_event, snapshot) => {
  _steamInputLatest = snapshot || [];
});
// XInput slot → Steam handle/type (#362): which physical pad sits behind each
// virtual XInput device Steam emits. Same push cadence as the snapshot.
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
  input: {
    isAvailable: () => ipcRenderer.invoke('steam:input:isAvailable'),
    getLatest: () => _steamInputLatest,
    getXInputMap: () => _steamXInputMap,
    getFullDiag: () => ipcRenderer.invoke('steam:input:fullDiag'),
  },
});
