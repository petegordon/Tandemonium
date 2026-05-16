const { contextBridge, ipcRenderer } = require('electron');

let latest = { ready: false, controllers: [], handles: {} };
ipcRenderer.on('steam:tick', (_e, snap) => { latest = snap || latest; });

contextBridge.exposeInMainWorld('steamTest', {
  // Steam Input snapshot pushed at ~60Hz from main; read synchronously per frame.
  getLatest: () => latest,
  // One-shot diagnostics
  checkIGA: () => ipcRenderer.invoke('steam:iga-check'),
  controllerLogTail: () => ipcRenderer.invoke('steam:controller-log-tail'),
});
