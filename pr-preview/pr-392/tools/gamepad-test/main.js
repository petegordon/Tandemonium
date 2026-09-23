// ============================================================
// Gamepad API Test Bench — isolated
//
// Smallest possible Electron window whose only purpose is to verify
// that `navigator.getGamepads()` sees a DualSense / Steam Controller.
// No Steamworks. No HID. No IPC. No preload. If THIS doesn't see the
// pad, the problem is below Chromium (driver / OS / Steam Input
// hiding it). If this DOES see the pad but the bigger test bench
// doesn't, the problem is inside the bigger test bench.
//
// Run from repo root:  npm run gamepadtest
// ============================================================
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'Gamepad API Test (isolated)',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
