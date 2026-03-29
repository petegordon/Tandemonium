const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronApp', {
  toggleDevTools: () => ipcRenderer.invoke('app:toggleDevTools'),
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
});
