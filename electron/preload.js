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
});

// Steam Input snapshot: pushed from main at ~60Hz via 'steam:input:tick'.
// Renderer reads `window.steam.input.getLatest()` synchronously each frame —
// no per-frame IPC round-trip.
let _steamInputLatest = [];
ipcRenderer.on('steam:input:tick', (_event, snapshot) => {
  _steamInputLatest = snapshot || [];
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
  },
});
