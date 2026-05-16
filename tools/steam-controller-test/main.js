// ============================================================
// Steam Controller Test Bench - Electron entry
//
// Standalone tool for exercising Steam Input + WebHID against a
// connected Steam Controller / DualSense WITHOUT the Tandemonium
// game on top. Reuses the repo's root node_modules - no separate
// install needed.
//
// Run from repo root:  npm run steamtest
//
// Identifies as Tandemonium Playtest (app 4510250) so Steam Input
// uses the same registered IGA path we set up in Steamworks.
//
// Migrated 2026-05-16 from steamworks.js@0.4.0 to
// steamworks-ffi-node@0.10.3 (which actually exposes runFrame,
// setInputActionManifestFilePath, getActionSetHandle, etc).
// ============================================================
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

const STEAM_APP_ID = 4510250;

// Resolve the source-of-truth IGA path. In dev we point Steam Input
// straight at the repo's source VDF so editing it doesn't require a
// CI+depot+promote cycle to test.
const DEV_IGA_PATH = path.join(__dirname, '..', '..', 'steam', `game_actions_${STEAM_APP_ID}.vdf`);

// --- Steamworks init ---
let steam = null;
try {
  // Electron Steam Overlay shim (was electronEnableSteamOverlay() upstream).
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-direct-composition');

  const { SteamworksSDK } = require('steamworks-ffi-node');
  steam = SteamworksSDK.getInstance();
  steam.setSdkPath(path.join(__dirname, '..', '..', 'steamworks_sdk'));
  const ok = steam.init({ appId: STEAM_APP_ID });
  if (!ok) throw new Error('SteamworksSDK.init() returned false');
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

if (steam) {
  try {
    // explicitCallRunFrame=true means we drive runFrame() each tick.
    const inputOk = steam.input.init(true);
    if (!inputOk) throw new Error('Steam Input init returned false');
    steamInputReady = true;
    console.log('Steam Input initialized');

    if (fs.existsSync(DEV_IGA_PATH)) {
      const setOk = steam.input.setInputActionManifestFilePath(DEV_IGA_PATH);
      console.log(`setInputActionManifestFilePath(${DEV_IGA_PATH}) -> ${setOk}`);
    } else {
      console.warn('Dev IGA not found at', DEV_IGA_PATH, '- Steam will fall back to the Steamworks-registered path');
    }
  } catch (e) {
    console.warn('Steam Input init failed:', e.message);
  }
}

// Per-name "have we logged this error yet" flags so we don't spam the terminal
// when a method throws every tick before Steam loads the manifest.
const _logged = new Set();
function logOnce(key, msg) {
  if (_logged.has(key)) return;
  _logged.add(key);
  console.warn(msg);
}

function resolveHandles() {
  if (!steamInputReady) return;
  if (setHandle === 0n) {
    try { setHandle = steam.input.getActionSetHandle('InGameControls'); }
    catch (e) { logOnce('set:InGameControls', 'getActionSetHandle(InGameControls) threw: ' + e.message); }
  }
  if (steerHandle === 0n) {
    try { steerHandle = steam.input.getAnalogActionHandle('Steer'); }
    catch (e) { logOnce('analog:Steer', 'getAnalogActionHandle(Steer) threw: ' + e.message); }
  }
  if (confirmHandle === 0n) {
    try { confirmHandle = steam.input.getDigitalActionHandle('Confirm'); }
    catch (e) { logOnce('digital:Confirm', 'getDigitalActionHandle(Confirm) threw: ' + e.message); }
  }
  // Probe a wider name list - whichever resolves non-zero is what Steam
  // actually parsed. Runs continuously since Steam may load lazily.
  for (const name of PROBE_SETS) {
    if (!probeResults.sets[name] || probeResults.sets[name] === '0') {
      try { probeResults.sets[name] = steam.input.getActionSetHandle(name).toString(); }
      catch (e) { probeResults.sets[name] = 'error: ' + e.message; }
    }
  }
  for (const name of PROBE_ANALOG) {
    if (!probeResults.analog[name] || probeResults.analog[name] === '0') {
      try { probeResults.analog[name] = steam.input.getAnalogActionHandle(name).toString(); }
      catch (e) { probeResults.analog[name] = 'error: ' + e.message; }
    }
  }
  for (const name of PROBE_DIGITAL) {
    if (!probeResults.digital[name] || probeResults.digital[name] === '0') {
      try { probeResults.digital[name] = steam.input.getDigitalActionHandle(name).toString(); }
      catch (e) { probeResults.digital[name] = 'error: ' + e.message; }
    }
  }
}

function tickSteamInput() {
  if (steamInputReady) {
    try { steam.input.runFrame(); }
    catch (e) { logOnce('runFrame', 'steam.input.runFrame() threw: ' + e.message); }
  }
  resolveHandles();
  const handles = {
    set: setHandle.toString(),
    steer: steerHandle.toString(),
    confirm: confirmHandle.toString(),
  };
  if (!steamInputReady) return { ready: false, controllers: [], handles, probe: probeResults };

  const controllers = [];
  try {
    for (const handle of steam.input.getConnectedControllers()) {
      if (setHandle !== 0n) {
        try { steam.input.activateActionSet(handle, setHandle); }
        catch (e) { logOnce('activateActionSet:' + handle, 'activateActionSet threw: ' + e.message); }
      }
      let type = 'Unknown';
      try { type = String(steam.input.getInputTypeForHandle(handle)); }
      catch (e) { logOnce('inputType:' + handle, 'getInputTypeForHandle threw: ' + e.message); }
      const row = {
        handle: handle.toString(),
        type,
        steerX: 0,
        steerY: 0,
        confirm: false,
      };
      if (steerHandle !== 0n) {
        try {
          const v = steam.input.getAnalogActionData(handle, steerHandle);
          row.steerX = v.x;
          row.steerY = v.y;
        } catch (e) { logOnce('analogData:' + handle, 'getAnalogActionData threw: ' + e.message); }
      }
      if (confirmHandle !== 0n) {
        try {
          const d = steam.input.getDigitalActionData(handle, confirmHandle);
          row.confirm = !!d.state;
        } catch (e) { logOnce('digitalData:' + handle, 'getDigitalActionData threw: ' + e.message); }
      }
      controllers.push(row);
    }
  } catch (e) { logOnce('getConnectedControllers', 'getConnectedControllers threw: ' + e.message); }

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
  const candidates = [
    // Steam-managed install (this is where Steam Input reads from when launched via Steam)
    path.join('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Tandemonium Playtest',
              'controller_config', `game_actions_${STEAM_APP_ID}.vdf`),
    // Repo packaged output (what our forge hook produces locally)
    path.join(__dirname, '..', '..', 'out', 'Tandemonium-win32-x64',
              'controller_config', `game_actions_${STEAM_APP_ID}.vdf`),
    // Repo source VDF (what we point setInputActionManifestFilePath at in dev)
    DEV_IGA_PATH,
  ];
  return candidates.map(p => {
    if (fs.existsSync(p)) {
      return { path: p, exists: true, size: fs.statSync(p).size };
    }
    return { path: p, exists: false };
  });
});

ipcMain.handle('steam:controller-log-tail', () => {
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
