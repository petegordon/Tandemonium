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

// Steam's SetInputActionManifestFilePath validates the path against
// its trusted-directory list. Paths outside (Steam install dir,
// running-process dir, etc.) get silently rejected. So we try several
// candidates in priority order and use whichever Steam accepts.
const IGA_PATH_CANDIDATES = [
  // The install path Steam already trusts (confirmed via "Found App Manifest"
  // log lines for real app-launches). Most likely to be accepted.
  path.join('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Tandemonium Playtest',
            'controller_config', `game_actions_${STEAM_APP_ID}.vdf`),
  // Repo's packaged output - sits next to a Tandemonium.exe in its own
  // controller_config dir, matching the "process-relative" convention.
  path.join(__dirname, '..', '..', 'out', 'Tandemonium-win32-x64',
            'controller_config', `game_actions_${STEAM_APP_ID}.vdf`),
  // Repo source. Convenient for editing but historically rejected by Steam.
  path.join(__dirname, '..', '..', 'steam', `game_actions_${STEAM_APP_ID}.vdf`),
];

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
// Capture the manifest-path-set results for ALL candidates so the UI can
// show which Steam accepted/rejected. The first accepted path is the one
// in effect; later candidates are skipped.
let manifestPathAttempts = [];
let manifestPathAccepted = null;

// Probe a list of plausible action set + action names so we can tell
// whether Steam parsed our IGA but renamed something (vs. didn't parse
// it at all). Whichever names resolve to non-zero handles are the ones
// Steam actually knows about.
const PROBE_SETS    = ['InGameControls', 'Default', 'default', 'Gameplay', 'gameplay', 'Game', 'Menu', 'MenuControls'];
const PROBE_ANALOG  = ['Steer', 'steer', 'Move', 'move', 'Camera', 'camera'];
const PROBE_DIGITAL = ['Confirm', 'confirm', 'Cancel', 'Action', 'Fire', 'jump'];
const probeResults = { sets: {}, analog: {}, digital: {} };
// Tracks first tick after init succeeded - used to compute "no controllers for X seconds" hints.
let readyAtMs = 0;
let snapshot = {
  ready: false,
  controllers: [],
  handles: {},
  probe: probeResults,
  sessionConfig: null,
  gamepadIndexProbe: {},
  secondsSinceReady: 0,
};

if (steam) {
  try {
    // ORDER MATTERS: SetInputActionManifestFilePath MUST be called BEFORE
    // input.init() per Valve's ISteamInput docs and steamworks-ffi-node JSDoc.
    // We try each candidate path in priority order and stop at the first
    // one Steam accepts.
    for (const candidate of IGA_PATH_CANDIDATES) {
      const attempt = { path: candidate, fileExists: fs.existsSync(candidate), attempted: false, returned: null, error: null };
      if (attempt.fileExists) {
        attempt.attempted = true;
        try {
          attempt.returned = steam.input.setInputActionManifestFilePath(candidate);
          console.log(`setInputActionManifestFilePath(${candidate}) -> ${attempt.returned}`);
        } catch (e) {
          attempt.error = e.message;
          console.warn(`setInputActionManifestFilePath threw on ${candidate}:`, e.message);
        }
      } else {
        console.warn('Candidate not present, skipping:', candidate);
      }
      manifestPathAttempts.push(attempt);
      if (attempt.returned === true) {
        manifestPathAccepted = candidate;
        break;
      }
    }

    // explicitCallRunFrame=true means we drive runFrame() each tick.
    const inputOk = steam.input.init(true);
    if (!inputOk) throw new Error('Steam Input init returned false');
    steamInputReady = true;
    console.log('Steam Input initialized');
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
    if (readyAtMs === 0) readyAtMs = Date.now();
  }
  resolveHandles();
  const handles = {
    set: setHandle.toString(),
    steer: steerHandle.toString(),
    confirm: confirmHandle.toString(),
  };
  const secondsSinceReady = readyAtMs === 0 ? 0 : (Date.now() - readyAtMs) / 1000;

  // Session config bitmask - tells us whether Steam Input has any
  // controller-type configurations enabled for this app. Non-zero is good.
  let sessionConfig = null;
  if (steamInputReady) {
    try { sessionConfig = steam.input.getSessionInputConfigurationSettings(); }
    catch (e) { logOnce('sessionConfig', 'getSessionInputConfigurationSettings threw: ' + e.message); }
  }

  // Secondary enumeration path: XInput gamepad slots 0..3. Sometimes catches
  // pads that getConnectedControllers() misses, or returns 0n for all slots
  // when Steam knows about them but hasn't bound them to this app.
  const gamepadIndexProbe = {};
  if (steamInputReady) {
    for (let i = 0; i < 4; i++) {
      try { gamepadIndexProbe[i] = steam.input.getControllerForGamepadIndex(i).toString(); }
      catch (e) { gamepadIndexProbe[i] = 'error: ' + e.message; }
    }
  }

  if (!steamInputReady) {
    return {
      ready: false,
      controllers: [],
      handles,
      probe: probeResults,
      sessionConfig,
      gamepadIndexProbe,
      secondsSinceReady,
    };
  }

  // Union of handles seen by both enumeration paths. Deduped by bigint value.
  const seenHandles = new Map(); // bigint -> source string
  try {
    for (const h of steam.input.getConnectedControllers()) seenHandles.set(h, 'getConnectedControllers');
  } catch (e) { logOnce('getConnectedControllers', 'getConnectedControllers threw: ' + e.message); }
  for (const [idx, str] of Object.entries(gamepadIndexProbe)) {
    if (str === '0' || str.startsWith('error')) continue;
    try {
      const h = BigInt(str);
      if (!seenHandles.has(h)) seenHandles.set(h, 'gamepadIndex:' + idx);
    } catch {}
  }

  const controllers = [];
  for (const [handle, source] of seenHandles) {
    if (setHandle !== 0n) {
      try { steam.input.activateActionSet(handle, setHandle); }
      catch (e) { logOnce('activateActionSet:' + handle, 'activateActionSet threw: ' + e.message); }
    }
    let type = 'Unknown';
    try { type = String(steam.input.getInputTypeForHandle(handle)); }
    catch (e) { logOnce('inputType:' + handle, 'getInputTypeForHandle threw: ' + e.message); }
    let gpIndex = -1;
    try { gpIndex = steam.input.getGamepadIndexForController(handle); }
    catch (e) { logOnce('gpIndex:' + handle, 'getGamepadIndexForController threw: ' + e.message); }
    const row = {
      handle: handle.toString(),
      type,
      source,
      gamepadIndex: gpIndex,
      steerX: 0,
      steerY: 0,
      confirm: false,
      motion: null,
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
    try {
      const m = steam.input.getMotionData(handle);
      if (m) {
        row.motion = {
          rotVelX: m.rotVelX, rotVelY: m.rotVelY, rotVelZ: m.rotVelZ,
          posAccelX: m.posAccelX, posAccelY: m.posAccelY, posAccelZ: m.posAccelZ,
        };
      }
    } catch (e) { logOnce('motion:' + handle, 'getMotionData threw: ' + e.message); }
    controllers.push(row);
  }

  return {
    ready: true,
    controllers,
    handles,
    probe: probeResults,
    sessionConfig,
    gamepadIndexProbe,
    secondsSinceReady,
    manifestPathAttempts,
    manifestPathAccepted,
  };
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

ipcMain.handle('steam:show-binding-panel', (_e, handleStr) => {
  if (!steamInputReady) return { ok: false, reason: 'Steam Input not initialized' };
  try {
    const h = BigInt(handleStr);
    const ok = steam.input.showBindingPanel(h);
    return { ok };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
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
