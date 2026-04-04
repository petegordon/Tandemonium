const { app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;
let clickThrough = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 400,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  // DevTools: Cmd+Shift+I to open manually (auto-open triggers Autofill errors)

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function toggleClickThrough() {
  clickThrough = !clickThrough;
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
    mainWindow.webContents.send('click-through-changed', clickThrough);
  }
  updateTrayMenu();
}

function createTray() {
  // Use a simple icon — on production builds, replace with a proper icon
  tray = new Tray(path.join(__dirname, '..', 'src', 'assets', 'tray-icon.png'));
  updateTrayMenu();
  tray.setToolTip('3D Controller Overlay');
}

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: clickThrough ? 'Disable Click-Through' : 'Enable Click-Through',
      click: toggleClickThrough,
    },
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: mainWindow?.isAlwaysOnTop() ?? true,
      click: () => {
        if (mainWindow) {
          const current = mainWindow.isAlwaysOnTop();
          mainWindow.setAlwaysOnTop(!current);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Show Settings',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('toggle-settings');
          if (clickThrough) toggleClickThrough();
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// Suppress Chromium Autofill DevTools errors
app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication,Autofill');

app.whenReady().then(() => {
  createWindow();

  // Create tray icon if asset exists
  try {
    createTray();
  } catch (e) {
    console.log('Tray icon not found, skipping system tray');
  }

  // Handle quit from renderer
  ipcMain.on('quit-app', () => app.quit());

  // Global shortcut: Ctrl+Shift+T to toggle click-through
  globalShortcut.register('CommandOrControl+Shift+T', toggleClickThrough);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tray) tray.destroy();
});

// Handle WebHID permission requests from renderer
app.on('web-contents-created', (_, contents) => {
  contents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'hid') return true;
    return true;
  });
  contents.session.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'hid') return true;
    return false;
  });

  // Auto-select HID devices for requestDevice() calls.
  // Also listen for hid-device-added to grant persistent permission so
  // getDevices() returns them on subsequent connections.
  let selectTimeout = null;

  contents.session.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    console.log('select-hid-device: deviceList length =', details.deviceList?.length || 0);
    if (details.deviceList && details.deviceList.length > 0) {
      if (selectTimeout) { clearTimeout(selectTimeout); selectTimeout = null; }
      const d = details.deviceList[0];
      console.log('select-hid-device: selecting', d.name || d.productId);
      try {
        callback(d.deviceId);
      } catch (e) {
        // Callback already used by a prior firing
      }
    } else if (!selectTimeout) {
      selectTimeout = setTimeout(() => {
        selectTimeout = null;
        console.log('select-hid-device: timeout — no device appeared');
        try { callback(''); } catch (e) { /* already resolved */ }
      }, 8000);
    }
  });

  // Grant persistent permission for HID devices so getDevices() returns them.
  // This fires when a device matching an active requestDevice() filter appears.
  contents.session.on('hid-device-added', (event, device) => {
    console.log('hid-device-added:', device.name || device.productId);
  });

  contents.session.on('hid-device-removed', (event, device) => {
    console.log('hid-device-removed:', device.name || device.productId);
  });
});
