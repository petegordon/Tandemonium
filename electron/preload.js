const { contextBridge, ipcRenderer } = require('electron');

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
