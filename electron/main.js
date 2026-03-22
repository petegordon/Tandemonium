const { app, BrowserWindow, globalShortcut, ipcMain, session } = require('electron');
const path = require('path');

// --- Steamworks initialization (before app.ready) ---
let steamworks = null;
try {
  const { init, electronEnableSteamOverlay } = require('steamworks.js');
  electronEnableSteamOverlay();
  // Read app ID from steam_appid.txt (playtest: 4510250, release: 4482940)
  const fs = require('fs');
  let appId = 4482940;
  try {
    const idPath = path.join(app.isPackaged ? process.resourcesPath : __dirname, '..', 'steam_appid.txt');
    const raw = fs.readFileSync(idPath, 'utf-8').trim();
    if (raw) appId = parseInt(raw, 10);
  } catch (e) {
    console.warn('Could not read steam_appid.txt, using default app ID:', e.message);
  }
  steamworks = init(appId);
  console.log('Steamworks initialized');
} catch (err) {
  console.log('Steamworks unavailable, running without Steam:', err.message);
}

// --- IPC handlers for Steam API calls from renderer ---
ipcMain.handle('steam:isAvailable', () => !!steamworks);
ipcMain.handle('steam:getPlayerName', () => {
  if (!steamworks) return null;
  return steamworks.localplayer.getName();
});
ipcMain.handle('steam:getSteamId', () => {
  if (!steamworks) return null;
  return steamworks.localplayer.getSteamId().steamId64.toString();
});
ipcMain.handle('steam:isSubscribed', () => {
  if (!steamworks) return false;
  return steamworks.apps.isSubscribed();
});
ipcMain.handle('steam:activateAchievement', (_event, apiName) => {
  if (!steamworks) return false;
  try {
    steamworks.achievement.activate(apiName);
    return true;
  } catch (e) {
    console.error('Steam achievement error:', e.message);
    return false;
  }
});
ipcMain.handle('steam:isAchievementActivated', (_event, apiName) => {
  if (!steamworks) return false;
  try {
    return steamworks.achievement.isActivated(apiName);
  } catch (e) {
    return false;
  }
});
ipcMain.handle('steam:getAuthTicket', () => {
  if (!steamworks) return null;
  try {
    const ticket = steamworks.auth.getSessionTicket();
    // Convert ticket buffer to hex string for transmission
    return Buffer.from(ticket.getBytes()).toString('hex');
  } catch (e) {
    console.error('Steam auth ticket error:', e.message);
    return null;
  }
});
ipcMain.handle('steam:storeStats', () => {
  if (!steamworks) return false;
  try {
    steamworks.stats.storeStats();
    return true;
  } catch (e) {
    return false;
  }
});

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreen: true,
    fullscreenable: true,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setMenu(null);
  // Load root index.html directly (desktop/index.html had path rewriting issues)
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));


  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // WebHID permissions (required for PlayStation gyro via WebHID)
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setDevicePermissionHandler((details) => {
    return details.deviceType === 'hid';
  });

  createWindow();

  // Auto-select first matching HID device (skip the browser picker dialog)
  mainWindow.webContents.session.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    if (details.deviceList && details.deviceList.length > 0) {
      callback(details.deviceList[0].deviceId);
    } else {
      callback('');
    }
  });

  // F11 fullscreen toggle
  globalShortcut.register('F11', () => {
    if (mainWindow) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  // Ctrl+Shift+F12: DevTools in any build (hidden shortcut for debugging)
  globalShortcut.register('CmdOrCtrl+Shift+F12', () => {
    if (mainWindow) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // DevTools (dev only — disabled in packaged builds)
  if (!app.isPackaged) {
    // F12 and Ctrl+Shift+I both toggle DevTools
    globalShortcut.register('F12', () => {
      if (mainWindow) mainWindow.webContents.toggleDevTools();
    });
    globalShortcut.register('CmdOrCtrl+Shift+I', () => {
      if (mainWindow) mainWindow.webContents.toggleDevTools();
    });

    // Right-click context menu with DevTools option
    const { Menu } = require('electron');
    mainWindow.webContents.on('context-menu', () => {
      Menu.buildFromTemplate([
        { label: 'Open DevTools', click: () => mainWindow.webContents.openDevTools({ mode: 'detach' }) },
        { type: 'separator' },
        { label: 'Reload', click: () => mainWindow.webContents.reload() },
        { label: 'Toggle Fullscreen', click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
      ]).popup();
    });
  }

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
