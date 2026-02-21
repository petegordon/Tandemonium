const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('path');

// --- Steamworks initialization (before app.ready) ---
let steamworks = null;
try {
  const { init, electronEnableSteamOverlay } = require('steamworks.js');
  electronEnableSteamOverlay();
  steamworks = init(480); // 480 = Spacewar test app; replace with real App ID
  console.log('Steamworks initialized');
} catch (err) {
  console.log('Steamworks unavailable, running without Steam:', err.message);
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreenable: true,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'desktop', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  // F11 fullscreen toggle
  globalShortcut.register('F11', () => {
    if (mainWindow) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  // F12 DevTools toggle
  globalShortcut.register('F12', () => {
    if (mainWindow) {
      mainWindow.webContents.toggleDevTools();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
