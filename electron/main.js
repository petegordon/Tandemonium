const { app, BrowserWindow, globalShortcut, ipcMain, session, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');

// Prevent Chromium from opening listening sockets that trigger Windows Firewall prompt.
// The game only uses outbound connections (WebRTC, HTTPS) — no inbound listening needed.
app.commandLine.appendSwitch('remote-debugging-port', '-1');
app.commandLine.appendSwitch('disable-background-networking');

// --- Steamworks initialization (before app.ready) ---
let steamworks = null;
try {
  const { init, electronEnableSteamOverlay } = require('steamworks.js');
  electronEnableSteamOverlay();
  // Read app ID from steam_appid.txt (playtest: 4510250, release: 4482940)
  let appId = 4482940;
  try {
    // extraResource copies steam_appid.txt into resources/ when packaged
    const idPath = app.isPackaged
      ? path.join(process.resourcesPath, 'steam_appid.txt')
      : path.join(__dirname, '..', 'steam_appid.txt');
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
ipcMain.handle('steam:getAuthTicket', async () => {
  if (!steamworks) return null;
  try {
    // steamworks.js 0.4.0: use getAuthTicketForWebApi for server-side verification
    const ticket = await steamworks.auth.getAuthTicketForWebApi('tandemonium');
    return Buffer.from(ticket.getBytes()).toString('hex');
  } catch (e) {
    console.error('Steam auth ticket error:', e.message);
    return null;
  }
});
ipcMain.handle('steam:storeStats', () => {
  if (!steamworks) return false;
  try {
    steamworks.stats.store();
    return true;
  } catch (e) {
    console.warn('Steam storeStats error:', e.message);
    return false;
  }
});

ipcMain.handle('app:toggleDevTools', () => {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.toggleDevTools();
    return mainWindow.webContents.isDevToolsOpened();
  }
  return false;
});

let mainWindow;

// ── Custom protocol (replaces local HTTP server) ─────────────────
// Serve game files via a custom 'tandemonium://' protocol instead of
// http://localhost. This avoids opening a listening socket, which
// triggers the Windows Firewall prompt on first launch. The scheme is
// registered as privileged so WebRTC, fetch(), and CORS work normally.
protocol.registerSchemesAsPrivileged([{
  scheme: 'tandemonium',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

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
  // Load via custom protocol (no network socket → no Windows Firewall prompt)
  mainWindow.loadURL('tandemonium://app/index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // WebHID permissions (required for PlayStation gyro via WebHID)
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setDevicePermissionHandler((details) => {
    return details.deviceType === 'hid';
  });

  // Fix CORS for custom protocol: the tandemonium:// origin isn't whitelisted by
  // API workers. Rewrite outgoing Origin to production URL, and rewrite incoming
  // Access-Control-Allow-Origin back to match the actual page origin so the
  // browser's CORS check passes.
  const API_MATCH = /workers\.dev|jimandi\.love/;
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (API_MATCH.test(details.url)) {
      details.requestHeaders['Origin'] = 'https://tandemonium.jimandi.love';
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (API_MATCH.test(details.url)) {
      const headers = details.responseHeaders || {};
      // Remove any existing ACAO header (case-insensitive) before setting ours,
      // otherwise Electron keeps both and the browser rejects "multiple values".
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'access-control-allow-origin') delete headers[key];
        if (key.toLowerCase() === 'access-control-allow-credentials') delete headers[key];
      }
      headers['Access-Control-Allow-Origin'] = ['tandemonium://app'];
      headers['Access-Control-Allow-Credentials'] = ['true'];
    }
    callback({ responseHeaders: details.responseHeaders });
  });

  // Register custom protocol handler to serve game files without a network socket
  const rootDir = path.join(__dirname, '..');
  protocol.handle('tandemonium', (request) => {
    const url = new URL(request.url);
    let filePath = decodeURIComponent(url.pathname);
    if (filePath === '/' || filePath === '') filePath = '/index.html';
    const fullPath = path.join(rootDir, filePath);
    // Security: prevent path traversal
    if (!fullPath.startsWith(rootDir)) {
      return new Response('Forbidden', { status: 403 });
    }
    // Serve via net.fetch for proper streaming and MIME handling
    return net.fetch('file://' + fullPath);
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

  // DevTools shortcuts (dev only)
  if (!app.isPackaged) {
    globalShortcut.register('F12', () => {
      if (mainWindow) mainWindow.webContents.toggleDevTools();
    });
    globalShortcut.register('CmdOrCtrl+Shift+I', () => {
      if (mainWindow) mainWindow.webContents.toggleDevTools();
    });
  }

  // Right-click context menu — enabled in all builds during playtest phase
  const { Menu } = require('electron');
  mainWindow.webContents.on('context-menu', (_event, params) => {
    Menu.buildFromTemplate([
      { label: 'Inspect Element', click: () => {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
        mainWindow.webContents.inspectElement(params.x, params.y);
      }},
      { label: 'Open DevTools', click: () => mainWindow.webContents.openDevTools({ mode: 'detach' }) },
      { type: 'separator' },
      { label: 'Reload', click: () => mainWindow.webContents.reload() },
      { label: 'Toggle Fullscreen', click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
    ]).popup();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();  // no port needed — custom protocol handles serving
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
