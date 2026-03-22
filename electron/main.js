const { app, BrowserWindow, globalShortcut, ipcMain, session } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

// --- Steamworks initialization (before app.ready) ---
let steamworks = null;
try {
  const { init, electronEnableSteamOverlay } = require('steamworks.js');
  electronEnableSteamOverlay();
  // Read app ID from steam_appid.txt (playtest: 4510250, release: 4482940)
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

let mainWindow;
let localServer;
let localPort;

// ── Local HTTP server ────────────────────────────────────────────
// Serve the game over http://localhost:PORT instead of file:// so that
// WebRTC, PeerJS, TURN credentials, and CORS all work identically to
// the browser version.
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

function startLocalServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Strip query string and decode URI
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';

      const filePath = path.join(rootDir, urlPath);

      // Security: prevent path traversal
      if (!filePath.startsWith(rootDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      });
    });

    // Listen on a random available port
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      console.log(`Local server running at http://127.0.0.1:${port}`);
      resolve({ server, port });
    });

    server.on('error', reject);
  });
}

function createWindow(port) {
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
  // Load via local HTTP server (not file://) for proper WebRTC/CORS behavior
  mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);

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

  // Start local HTTP server to serve game files
  // Resolves WebRTC/PeerJS/CORS issues that occur with file:// protocol
  const rootDir = path.join(__dirname, '..');
  const { server, port } = await startLocalServer(rootDir);
  localServer = server;
  localPort = port;

  createWindow(port);

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
  mainWindow.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: 'Open DevTools', click: () => mainWindow.webContents.openDevTools({ mode: 'detach' }) },
      { type: 'separator' },
      { label: 'Reload', click: () => mainWindow.webContents.reload() },
      { label: 'Toggle Fullscreen', click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
    ]).popup();
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
  if (localServer) localServer.close();
});
