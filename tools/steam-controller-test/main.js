// ============================================================
// Steam Controller Test Bench - Electron entry
//
// Standalone tool for exercising Steam Input + WebHID against a
// connected Steam Controller / DualSense WITHOUT the Tandemonium
// game on top. Reuses the repo's root node_modules (steamworks.js,
// electron) - no separate install needed.
//
// Run from repo root:  npm run steamtest
//
// Identifies as Tandemonium Playtest (app 4510250) so Steam Input
// uses the same registered IGA path we set up in Steamworks.
// ============================================================
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

const STEAM_APP_ID = 4510250;

// --- Steamworks init ---
let steamworks = null;
try {
  const { init, electronEnableSteamOverlay } = require('steamworks.js');
  electronEnableSteamOverlay();
  steamworks = init(STEAM_APP_ID);
  console.log('Steamworks initialized for app', STEAM_APP_ID);
} catch (e) {
  console.warn('Steamworks unavailable:', e.message);
}

// --- Steam Input ---
let steamInputReady = false;
let setHandle = 0n;
let steerHandle = 0n;
let confirmHandle = 0n;
// Probe a list of plausible action set + action names so we can tell
// whether Steam parsed our IGA but renamed something (vs. didn't parse
// it at all). Whichever names resolve to non-zero handles are the ones
// Steam actually knows about.
const PROBE_SETS    = ['InGameControls', 'Default', 'default', 'Gameplay', 'gameplay', 'Game', 'Menu', 'MenuControls'];
const PROBE_ANALOG  = ['Steer', 'steer', 'Move', 'move', 'Camera', 'camera'];
const PROBE_DIGITAL = ['Confirm', 'confirm', 'Cancel', 'Action', 'Fire', 'jump'];
const probeResults = { sets: {}, analog: {}, digital: {} };
let snapshot = { ready: false, controllers: [], handles: {}, probe: probeResults };

if (steamworks) {
  try {
    steamworks.input.init();
    steamInputReady = true;
    console.log('Steam Input initialized');
  } catch (e) {
    console.warn('Steam Input init failed:', e.message);
  }
}

function resolveHandles() {
  if (!steamInputReady) return;
  if (setHandle === 0n) {
    try { setHandle = steamworks.input.getActionSet('InGameControls'); } catch (e) {}
  }
  if (steerHandle === 0n) {
    try { steerHandle = steamworks.input.getAnalogAction('Steer'); } catch (e) {}
  }
  if (confirmHandle === 0n) {
    try { confirmHandle = steamworks.input.getDigitalAction('Confirm'); } catch (e) {}
  }
  // Probe a wider name list - whichever resolves non-zero is what Steam
  // actually parsed. Runs continuously since Steam may load lazily.
  for (const name of PROBE_SETS) {
    if (!probeResults.sets[name] || probeResults.sets[name] === '0') {
      try { probeResults.sets[name] = steamworks.input.getActionSet(name).toString(); }
      catch (e) { probeResults.sets[name] = 'error: ' + e.message; }
    }
  }
  for (const name of PROBE_ANALOG) {
    if (!probeResults.analog[name] || probeResults.analog[name] === '0') {
      try { probeResults.analog[name] = steamworks.input.getAnalogAction(name).toString(); }
      catch (e) { probeResults.analog[name] = 'error: ' + e.message; }
    }
  }
  for (const name of PROBE_DIGITAL) {
    if (!probeResults.digital[name] || probeResults.digital[name] === '0') {
      try { probeResults.digital[name] = steamworks.input.getDigitalAction(name).toString(); }
      catch (e) { probeResults.digital[name] = 'error: ' + e.message; }
    }
  }
}

function tickSteamInput() {
  resolveHandles();
  const handles = {
    set: setHandle.toString(),
    steer: steerHandle.toString(),
    confirm: confirmHandle.toString(),
  };
  if (!steamInputReady) return { ready: false, controllers: [], handles };

  const controllers = [];
  try {
    for (const c of steamworks.input.getControllers()) {
      if (setHandle !== 0n) {
        try { c.activateActionSet(setHandle); } catch (e) {}
      }
      const row = {
        handle: c.getHandle().toString(),
        type: c.getType(),
        steerX: 0,
        steerY: 0,
        confirm: false,
      };
      if (steerHandle !== 0n) {
        try {
          const v = c.getAnalogActionVector(steerHandle);
          row.steerX = v.x;
          row.steerY = v.y;
        } catch (e) {}
      }
      if (confirmHandle !== 0n) {
        try { row.confirm = c.isDigitalActionPressed(confirmHandle); } catch (e) {}
      }
      controllers.push(row);
    }
  } catch (e) { /* getControllers threw */ }

  return { ready: true, controllers, handles, probe: probeResults };
}

// --- Window ---
let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Steam Controller Test Bench',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  // Allow WebHID; auto-select first matching device when requestDevice fires.
  // requestDevice itself still needs a user gesture in the renderer.
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setDevicePermissionHandler((details) => details.deviceType === 'hid');

  createWindow();

  mainWindow.webContents.session.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    if (details.deviceList && details.deviceList.length > 0) {
      callback(details.deviceList[0].deviceId);
    } else {
      callback('');
    }
  });

  // Push Steam Input snapshot at ~60Hz
  setInterval(() => {
    snapshot = tickSteamInput();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('steam:tick', snapshot);
    }
  }, 16);
});

ipcMain.handle('steam:snapshot', () => snapshot);

ipcMain.handle('steam:iga-check', () => {
  // Look in places the IGA might live, both in dev and via Steam's install.
  const candidates = [];
  // Steam-managed install (this is where Steam Input actually reads from)
  candidates.push(path.join(
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Tandemonium Playtest',
    'controller_config', `game_actions_${STEAM_APP_ID}.vdf`
  ));
  // Repo packaged output (what our forge hook produces locally)
  candidates.push(path.join(
    __dirname, '..', '..', 'out', 'Tandemonium-win32-x64',
    'controller_config', `game_actions_${STEAM_APP_ID}.vdf`
  ));
  // Repo source VDF
  candidates.push(path.join(
    __dirname, '..', '..', 'steam', `game_actions_${STEAM_APP_ID}.vdf`
  ));
  const result = [];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const stat = fs.statSync(p);
      result.push({ path: p, exists: true, size: stat.size });
    } else {
      result.push({ path: p, exists: false });
    }
  }
  return result;
});

ipcMain.handle('steam:controller-log-tail', () => {
  // Return the last few IGA-relevant lines from Steam's own controller.txt
  // so the UI can show whether Steam recognized our manifest.
  const logPath = 'C:\\Program Files (x86)\\Steam\\logs\\controller.txt';
  if (!fs.existsSync(logPath)) return [];
  try {
    const lines = fs.readFileSync(logPath, 'utf-8').split(/\r?\n/);
    return lines
      .filter(l => /4510250|Found App Manifest|action/i.test(l))
      .slice(-15);
  } catch (e) {
    return ['(error reading log: ' + e.message + ')'];
  }
});

app.on('window-all-closed', () => app.quit());
