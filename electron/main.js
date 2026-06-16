const { app, BrowserWindow, globalShortcut, ipcMain, session, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');

// Diagnostic file logger for Steam Input troubleshooting.
// Writes to %USERPROFILE%\tandemonium-diag.log so we can see main-
// process diagnostics from Steam-launched runs (which swallow stdout).
// Reset on each launch. Remove this whole block once Steam Input is
// confirmed working end-to-end.
const _diagLogPath = path.join(process.env.USERPROFILE || process.env.HOME || __dirname, 'tandemonium-diag.log');
try { fs.writeFileSync(_diagLogPath, `--- launch ${new Date().toISOString()} ---\n`); } catch (e) {}
function _diagLog(msg) {
  console.log(msg);
  try { fs.appendFileSync(_diagLogPath, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) {}
}

// Group all Electron processes under one taskbar/alt-tab entry on Windows.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.jimandi.tandemonium');
}

// Prevent Chromium from opening listening sockets that trigger Windows Firewall prompt.
// The game only uses outbound connections (WebRTC, HTTPS) — no inbound listening needed.
app.commandLine.appendSwitch('remote-debugging-port', '-1');
app.commandLine.appendSwitch('disable-background-networking');

// --- Single instance lock ---
// Prevent multiple app instances (common with Steam launching or double-clicks).
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus existing window when a second instance tries to launch
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// --- Steamworks initialization (before app.ready) ---
// Migrated 2026-05-16 from steamworks.js@0.4.0 to steamworks-ffi-node@0.10.3.
// The new SDK exposes Steam Input methods (runFrame, getActionSetHandle, etc.)
// that 0.4.0 was missing - that gap was the root cause of every IGA failure
// we hit earlier on this branch.
let steam = null;
let appId = 4482940; // hoisted so Steam Input diagnostic can reference it below
try {
  // Read app ID from steam_appid.txt (playtest: 4510250, release: 4482940)
  try {
    const idPath = app.isPackaged
      ? path.join(process.resourcesPath, 'steam_appid.txt')
      : path.join(__dirname, '..', 'steam_appid.txt');
    const raw = fs.readFileSync(idPath, 'utf-8').trim();
    if (raw) appId = parseInt(raw, 10);
  } catch (e) {
    console.warn('Could not read steam_appid.txt, using default app ID:', e.message);
  }

  // Steam Overlay support: the Chromium switches below are what upstream
  // steamworks.js's electronEnableSteamOverlay() used. We deliberately do
  // NOT install the per-frame webContents.invalidate() shim that ships with
  // that helper - it caused visible flicker and made the overlay's close
  // button unresponsive. The two command-line switches are enough for the
  // overlay to render in most cases; if specific frames glitch we'll add a
  // narrower fix.
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-direct-composition');

  const { SteamworksSDK } = require('steamworks-ffi-node');
  steam = SteamworksSDK.getInstance();

  // Tell the SDK where to find steam_api64.dll. In dev it's checked into
  // the repo at <repo>/steamworks_sdk/redistributable_bin/win64/. Packaged
  // builds get the same folder shipped via forge.config.js extraResource
  // into the install's resources/ dir.
  const sdkDir = app.isPackaged
    ? path.join(process.resourcesPath, 'steamworks_sdk')
    : path.join(__dirname, '..', 'steamworks_sdk');
  steam.setSdkPath(sdkDir);

  const ok = steam.init({ appId });
  if (!ok) throw new Error('SteamworksSDK.init() returned false');
  console.log('Steamworks initialized via steamworks-ffi-node, appId=' + appId);
} catch (err) {
  console.warn('Steamworks unavailable, running without Steam:', err.message);
  steam = null;
}

// --- Steam Input (action-based gyro→Steer) ---
// We declare ONE analog action "Steer" in steam/game_actions_<appid>.vdf and
// let Steam Input map the controller's gyro to it (input_mode joystick_move).
// At runtime we ask Steam Input which controllers it has captured, read the
// Steer vector for each, and push the snapshot to the renderer at ~60Hz. The
// renderer overrides motionLean for slots that Steam Input owns; everything
// else (sticks, buttons, triggers, keyboard) flows through the existing
// Gamepad API / WebHID / keyboard pipelines unchanged.
let steamInputReady = false;
let steamInputSetHandle = 0n;
let steamInputSteerHandle = 0n;
const steamInputActivated = new Set(); // controller handles we've already activated the action set on
let steamInputSnapshot = [];
let steamInputTimer = null;

if (steam) {
  try {
    // Mirror the depot-shipped IGA to Steam's root controller_config dir.
    // Steam Input caches action-set definitions from THIS path at runtime —
    // a stale IGA there overrides our depot copy and causes new actions to
    // resolve as zero handles. Best-effort: if Electron lacks write access
    // to the Steam dir (typical without admin), we log and continue.
    // <Steam>/steamapps/common/<game>/Tandemonium.exe → three dirnames up.
    if (app.isPackaged) {
      try {
        const exeDir = path.dirname(app.getPath('exe'));
        const srcIga = path.join(exeDir, 'controller_config', `game_actions_${appId}.vdf`);
        const steamRoot = path.dirname(path.dirname(path.dirname(exeDir)));
        const destDir = path.join(steamRoot, 'controller_config');
        const destIga = path.join(destDir, `game_actions_${appId}.vdf`);
        if (fs.existsSync(srcIga)) {
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          const srcStat = fs.statSync(srcIga);
          let needCopy = true;
          if (fs.existsSync(destIga)) {
            const destStat = fs.statSync(destIga);
            if (destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) needCopy = false;
          }
          if (needCopy) {
            fs.copyFileSync(srcIga, destIga);
            _diagLog(`[SteamInput diag] Mirrored IGA to Steam-root: ${destIga} (${srcStat.size} bytes)`);
          } else {
            _diagLog(`[SteamInput diag] Steam-root IGA already in sync: ${destIga}`);
          }
        }
      } catch (e) {
        _diagLog(`[SteamInput diag] IGA mirror to Steam-root failed: ${e.message}. If digital action handles resolve to 0, manually copy controller_config/game_actions_${appId}.vdf from the game install dir to <Steam>/controller_config/`);
      }
    }

    // ORDER MATTERS: SetInputActionManifestFilePath MUST be called BEFORE
    // input.init() per Valve's ISteamInput docs and steamworks-ffi-node JSDoc.
    // Calling it after init is a silent no-op — Steam Input has already
    // loaded its (empty) manifest by then and won't reload from a new path.
    // This was the root cause of the "Steam parses our IGA but action set
    // never registers" symptom we'd been treating as a Valve-side blocker.
    try {
      const igaForSet = app.isPackaged
        ? path.join(path.dirname(app.getPath('exe')), 'controller_config', `game_actions_${appId}.vdf`)
        : path.join(__dirname, '..', 'steam', `game_actions_${appId}.vdf`);
      if (fs.existsSync(igaForSet)) {
        const setOk = steam.input.setInputActionManifestFilePath(igaForSet);
        _diagLog(`[SteamInput diag] setInputActionManifestFilePath(${igaForSet}) -> ${setOk}`);
      } else {
        _diagLog(`[SteamInput diag] IGA not at ${igaForSet} (skipping explicit set)`);
      }
    } catch (e) {
      _diagLog('[SteamInput diag] setInputActionManifestFilePath threw: ' + e.message);
    }

    // explicitCallRunFrame=true means we drive ISteamInput::RunFrame() from
    // our tick loop. The upstream steamworks.js package didn't expose
    // RunFrame and that's why action handles never populated for us.
    const inputOk = steam.input.init(true);
    if (!inputOk) throw new Error('Steam Input init returned false');
    steamInputReady = true;
    _diagLog('Steam Input initialized');
  } catch (err) {
    _diagLog('Steam Input init failed: ' + err.message);
  }

  // Sanity-check the action manifest is actually present in the install
  // dir at the path Steam Input expects. When packaged, the exe sits at
  // <install>/Tandemonium.exe, so the manifest should be at
  // <install>/controller_config/game_actions_<appid>.vdf.
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    const igaPath = path.join(exeDir, 'controller_config', `game_actions_${appId}.vdf`);
    _diagLog(`[SteamInput diag] expected IGA path: ${igaPath}`);
    if (fs.existsSync(igaPath)) {
      const stat = fs.statSync(igaPath);
      _diagLog(`[SteamInput diag] IGA file exists: ${stat.size} bytes`);
      // Sniff for non-ASCII bytes that could trip Steam's VDF parser.
      const buf = fs.readFileSync(igaPath);
      let nonAscii = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7F) nonAscii++;
      _diagLog(`[SteamInput diag] IGA non-ASCII byte count: ${nonAscii}`);
    } else {
      _diagLog('[SteamInput diag] IGA file MISSING at expected path');
    }
  } catch (e) {
    _diagLog('[SteamInput diag] IGA path check threw: ' + e.message);
  }
}

// Handle resolution is lazy: Steam may not have loaded the action manifest
// at init() time, so we re-try every tick until both handles are non-zero.
// Diagnostic logging stays in place until end-to-end success is confirmed
// (we'll strip it in a follow-up commit).
let _diagFirstResolveLogged = false;
let _diagSetHandleLogged = false;
let _diagSteerHandleLogged = false;
let _diagDigitalHandlesLogged = false;
let _diagControllersEverSeen = 0;
const steamInputActiveLogged = new Set(); // controller handles for which we've logged active-action diagnostic
const steamInputLastPressed = new Map(); // controller handle -> last comma-joined pressed-action names

// Digital action names declared in the IGA. Handles are resolved lazily
// alongside Steer (Steam may not have loaded the manifest at init() time).
const STEAM_INPUT_DIGITAL_ACTIONS = [
  'MenuUp', 'MenuDown', 'MenuLeft', 'MenuRight',
  'Confirm', 'Cancel',
  'PedalLeft', 'PedalRight',
  'Pause',
];
const steamInputDigitalHandles = {}; // name -> bigint handle (0n = unresolved)
for (const name of STEAM_INPUT_DIGITAL_ACTIONS) steamInputDigitalHandles[name] = 0n;

function resolveSteamInputHandles() {
  if (!steamInputReady) return false;
  if (steamInputSetHandle === 0n) {
    try { steamInputSetHandle = steam.input.getActionSetHandle('InGameControls'); }
    catch (e) { /* manifest not yet loaded */ }
  }
  if (steamInputSteerHandle === 0n) {
    try { steamInputSteerHandle = steam.input.getAnalogActionHandle('Steer'); }
    catch (e) { /* manifest not yet loaded */ }
  }
  // Type-agnostic "is this handle zero?" check. The Steamworks binding can
  // return BigInt 0n for unrecognized actions but also sometimes a plain
  // Number 0 — `=== 0n` alone misses the Number case and silently treats
  // the action as resolved.
  const isZeroHandle = (h) => h == null || h === 0n || h === 0;
  let unresolvedDigital = 0;
  for (const name of STEAM_INPUT_DIGITAL_ACTIONS) {
    if (isZeroHandle(steamInputDigitalHandles[name])) {
      try { steamInputDigitalHandles[name] = steam.input.getDigitalActionHandle(name); }
      catch (e) { /* manifest not yet loaded */ }
      if (isZeroHandle(steamInputDigitalHandles[name])) unresolvedDigital++;
    }
  }
  if (!_diagFirstResolveLogged) {
    _diagFirstResolveLogged = true;
    _diagLog(`[SteamInput diag] first resolve: set=${steamInputSetHandle.toString()} steer=${steamInputSteerHandle.toString()}`);
  }
  if (!_diagSetHandleLogged && steamInputSetHandle !== 0n) {
    _diagSetHandleLogged = true;
    _diagLog(`[SteamInput diag] InGameControls action set resolved: ${steamInputSetHandle.toString()}`);
  }
  if (!_diagSteerHandleLogged && steamInputSteerHandle !== 0n) {
    _diagSteerHandleLogged = true;
    _diagLog(`[SteamInput diag] Steer analog action resolved: ${steamInputSteerHandle.toString()}`);
  }
  if (!_diagDigitalHandlesLogged && unresolvedDigital === 0) {
    _diagDigitalHandlesLogged = true;
    const parts = STEAM_INPUT_DIGITAL_ACTIONS.map(n => `${n}=${steamInputDigitalHandles[n].toString()}`);
    _diagLog(`[SteamInput diag] digital action handles resolved: ${parts.join(', ')}`);
  }
  return steamInputSetHandle !== 0n && steamInputSteerHandle !== 0n;
}

function tickSteamInput() {
  // Drive ISteamInput::RunFrame each tick - required for getConnectedControllers
  // and getAnalogActionData to return fresh values when init(true) was used.
  try { steam.input.runFrame(); } catch (e) { /* skip transient errors */ }

  if (!resolveSteamInputHandles()) return [];

  let controllers;
  try { controllers = steam.input.getConnectedControllers(); }
  catch (e) { return []; }
  if (controllers.length > _diagControllersEverSeen) {
    _diagControllersEverSeen = controllers.length;
    _diagLog(`[SteamInput diag] getConnectedControllers() now returning ${controllers.length} captured pad(s)`);
  }

  const out = [];
  const seen = new Set();
  for (const handle of controllers) {
    const handleStr = handle.toString();
    seen.add(handleStr);
    if (!steamInputActivated.has(handleStr)) {
      try {
        steam.input.activateActionSet(handle, steamInputSetHandle);
        steamInputActivated.add(handleStr);
        // Diag: confirm Steam actually accepted the activation. If
        // getCurrentActionSet returns something other than our handle,
        // Steam silently rejected (cause: missing Steamworks-side config,
        // unknown action set, etc.).
        let active = null;
        try { active = steam.input.getCurrentActionSet(handle); } catch (e) {}
        _diagLog(`[SteamInput diag] activateActionSet(handle=${handleStr}, set=${steamInputSetHandle.toString()}) -> current=${active && active.toString()}`);
      } catch (e) {
        _diagLog(`[SteamInput diag] activateActionSet threw: ${e.message}`);
      }
    }
    let data = { x: 0, y: 0, active: false };
    try { data = steam.input.getAnalogActionData(handle, steamInputSteerHandle); }
    catch (e) { /* leave at zero */ }
    let type = 'Unknown';
    try { type = steam.input.getInputTypeForHandle(handle); }
    catch (e) {}
    // Read each digital action's state for this controller. Steam returns
    // { state, active } per action; we forward state bits as a flat map.
    const digital = {};
    let _diagAnyPressed = false;
    let _diagAnyInactive = [];
    for (const name of STEAM_INPUT_DIGITAL_ACTIONS) {
      const h = steamInputDigitalHandles[name];
      if (!h || h === 0n || h === 0) { digital[name] = false; continue; }
      try {
        const d = steam.input.getDigitalActionData(handle, h);
        digital[name] = !!(d && d.state);
        if (d && !d.active) _diagAnyInactive.push(name);
        if (d && d.state) _diagAnyPressed = true;
      } catch (e) { digital[name] = false; }
    }
    // First-tick diagnostic: log which actions Steam reports as ACTIVE
    // (i.e. bound to a physical input under the current binding). If
    // an action is in the snapshot but inactive, the binding file isn't
    // wiring physical input to it for this controller type.
    if (!steamInputActiveLogged.has(handleStr)) {
      steamInputActiveLogged.add(handleStr);
      _diagLog(`[SteamInput diag] controller ${handleStr} inactive digital actions: ${_diagAnyInactive.join(', ') || '(none — all bound)'}`);
      // Stronger check: getDigitalActionOrigins returns the actual physical
      // EInputActionOrigin values bound to each action. Empty array = no
      // physical input wired (binding file isn't actually reaching the action).
      const originSummary = [];
      for (const name of STEAM_INPUT_DIGITAL_ACTIONS) {
        const h = steamInputDigitalHandles[name];
        if (!h || h === 0n || h === 0) { originSummary.push(`${name}=<no handle>`); continue; }
        try {
          const origins = steam.input.getDigitalActionOrigins(handle, steamInputSetHandle, h);
          originSummary.push(`${name}=[${(origins || []).join(',')}]`);
        } catch (e) { originSummary.push(`${name}=<err:${e.message}>`); }
      }
      _diagLog(`[SteamInput diag] digital action origins: ${originSummary.join(' | ')}`);
      // Same for Steer (analog) so we can confirm the gyro/stick wiring.
      try {
        const steerOrigins = steam.input.getAnalogActionOrigins(handle, steamInputSetHandle, steamInputSteerHandle);
        _diagLog(`[SteamInput diag] Steer analog origins: [${(steerOrigins || []).join(',')}]`);
      } catch (e) { _diagLog(`[SteamInput diag] Steer origins err: ${e.message}`); }
    }
    // Log button-press edges so we can verify physical→action firing.
    if (_diagAnyPressed) {
      const pressed = STEAM_INPUT_DIGITAL_ACTIONS.filter(n => digital[n]).join(',');
      const prev = steamInputLastPressed.get(handleStr) || '';
      if (pressed !== prev) {
        steamInputLastPressed.set(handleStr, pressed);
        _diagLog(`[SteamInput diag] digital pressed: ${pressed}`);
      }
    } else {
      const prev = steamInputLastPressed.get(handleStr);
      if (prev) {
        steamInputLastPressed.set(handleStr, '');
        _diagLog(`[SteamInput diag] digital released (was: ${prev})`);
      }
    }
    out.push({
      handle: handleStr,
      type: String(type),
      steerX: data.x,
      steerY: data.y,
      active: !!data.active,
      digital,
    });
  }
  // Drop handles that disappeared so re-attach re-activates.
  for (const h of steamInputActivated) if (!seen.has(h)) steamInputActivated.delete(h);
  return out;
}

function startSteamInputTickLoop() {
  if (steamInputTimer || !steamInputReady) return;
  steamInputTimer = setInterval(() => {
    steamInputSnapshot = tickSteamInput();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('steam:input:tick', steamInputSnapshot);
    }
  }, 16);
}

// --- IPC handlers for Steam API calls from renderer ---
// Renderer-facing IPC channel names stay identical to the old steamworks.js
// implementation; only the handler bodies changed. preload.js and every JS
// file under js/ that calls window.steam.* keep working without edits.
ipcMain.handle('steam:isAvailable', () => !!steam);
ipcMain.handle('steam:input:isAvailable', () => steamInputReady);
ipcMain.handle('steam:input:poll', () => steamInputSnapshot);

// Full-diagnostic dump for the in-game Steam Input test page. Queries Steam
// on demand for every piece of state we can read (handles, controllers,
// per-action origins, motion data, current action set, gamepad-index probe).
// Returns plain JS shapes (no BigInts) so the renderer can JSON.stringify.
ipcMain.handle('steam:input:fullDiag', () => {
  const out = {
    ready: steamInputReady,
    setHandle: steamInputReady ? steamInputSetHandle.toString() : '0',
    steerHandle: steamInputReady ? steamInputSteerHandle.toString() : '0',
    digitalHandles: {},
    controllers: [],
    gamepadIndexProbe: [],
    sessionConfig: null,
  };
  if (!steamInputReady) return out;
  try {
    for (const name of STEAM_INPUT_DIGITAL_ACTIONS) {
      const h = steamInputDigitalHandles[name];
      out.digitalHandles[name] = h ? h.toString() : '0';
    }
  } catch (e) {}
  try { out.sessionConfig = steam.input.getSessionInputConfigurationSettings(); }
  catch (e) { out.sessionConfig = `err: ${e.message}`; }
  // Gamepad-index probe — secondary enumeration path.
  for (let i = 0; i < 4; i++) {
    try {
      const h = steam.input.getControllerForGamepadIndex(i);
      out.gamepadIndexProbe.push({ index: i, handle: h ? h.toString() : '0' });
    } catch (e) {
      out.gamepadIndexProbe.push({ index: i, handle: 'err' });
    }
  }
  let controllers = [];
  try { controllers = steam.input.getConnectedControllers(); } catch (e) {}
  for (const handle of controllers) {
    const c = { handle: handle.toString(), type: 'Unknown', steer: null, digital: {}, origins: { steer: [], digital: {} }, motion: null };
    try { c.type = String(steam.input.getInputTypeForHandle(handle)); } catch (e) {}
    try { c.currentSet = steam.input.getCurrentActionSet(handle).toString(); } catch (e) { c.currentSet = 'err'; }
    if (steamInputSteerHandle && steamInputSteerHandle !== 0n) {
      try {
        const d = steam.input.getAnalogActionData(handle, steamInputSteerHandle);
        c.steer = { x: d.x, y: d.y, active: !!d.active, mode: d.mode };
      } catch (e) { c.steer = { err: e.message }; }
      try {
        const origins = steam.input.getAnalogActionOrigins(handle, steamInputSetHandle, steamInputSteerHandle);
        c.origins.steer = (origins || []).map(String);
      } catch (e) { c.origins.steer = [`err: ${e.message}`]; }
    }
    for (const name of STEAM_INPUT_DIGITAL_ACTIONS) {
      const h = steamInputDigitalHandles[name];
      if (!h || h === 0n || h === 0) { c.digital[name] = { state: false, active: false, noHandle: true }; continue; }
      try {
        const d = steam.input.getDigitalActionData(handle, h);
        c.digital[name] = { state: !!(d && d.state), active: !!(d && d.active) };
      } catch (e) { c.digital[name] = { err: e.message }; }
      try {
        const origins = steam.input.getDigitalActionOrigins(handle, steamInputSetHandle, h);
        c.origins.digital[name] = (origins || []).map(String);
      } catch (e) { c.origins.digital[name] = [`err: ${e.message}`]; }
    }
    try {
      const m = steam.input.getMotionData(handle);
      c.motion = m ? { rotQuat: [m.rotQuatX, m.rotQuatY, m.rotQuatZ, m.rotQuatW], accel: [m.posAccelX, m.posAccelY, m.posAccelZ], rotVel: [m.rotVelX, m.rotVelY, m.rotVelZ] } : null;
    } catch (e) { c.motion = { err: e.message }; }
    out.controllers.push(c);
  }
  return out;
});
ipcMain.handle('steam:getPlayerName', () => {
  if (!steam) return null;
  try { return steam.friends.getPersonaName(); }
  catch (e) { return null; }
});
ipcMain.handle('steam:getSteamId', () => {
  if (!steam) return null;
  try { return steam.getStatus().steamId; }
  catch (e) { return null; }
});
ipcMain.handle('steam:isSubscribed', () => {
  if (!steam) return false;
  try { return steam.apps.isSubscribed(); }
  catch (e) { return false; }
});
ipcMain.handle('steam:activateAchievement', async (_event, apiName) => {
  if (!steam) return false;
  try {
    // unlockAchievement auto-calls StoreStats internally
    return await steam.achievements.unlockAchievement(apiName);
  } catch (e) {
    console.error('Steam achievement error:', e.message);
    return false;
  }
});
ipcMain.handle('steam:isAchievementActivated', async (_event, apiName) => {
  if (!steam) return false;
  try { return await steam.achievements.isAchievementUnlocked(apiName); }
  catch (e) { return false; }
});
ipcMain.handle('steam:getAuthTicket', async () => {
  if (!steam) return null;
  try {
    // The ffi-node binding returns ticketHex already (no Buffer→hex needed).
    const ticket = await steam.user.getAuthTicketForWebApi({ identity: 'tandemonium' });
    return ticket && ticket.success ? ticket.ticketHex : null;
  } catch (e) {
    console.error('Steam auth ticket error:', e.message);
    return null;
  }
});
ipcMain.handle('steam:storeStats', () => {
  // No-op: every stats-affecting call in the new SDK (unlockAchievement,
  // setStatInt, etc.) auto-flushes via StoreStats internally. Kept as an
  // IPC handler so renderer code that still calls window.steam.storeStats()
  // doesn't break.
  return !!steam;
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
  // Tourist Mode (#333) dev toggle: `TANDEM_TOURIST=1 npm start` streams Google
  // Photorealistic 3D Tiles instead of the procedural road.
  const _touristQuery = process.env.TANDEM_TOURIST ? '?mode=tourist' : '';
  mainWindow.loadURL('tandemonium://app/index.html' + _touristQuery);

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
  // Tourist Mode (#333): the Google Map Tiles API key is restricted to the
  // jimandi.love HTTP referrer, but Electron's page origin is tandemonium://app.
  // Send a matching Referer on tile requests so the restricted key is accepted
  // in the desktop app (the web build at jimandi.love matches naturally).
  const TILES_MATCH = /tile\.googleapis\.com/;
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (API_MATCH.test(details.url)) {
      details.requestHeaders['Origin'] = 'https://tandemonium.jimandi.love';
    }
    if (TILES_MATCH.test(details.url)) {
      // Use a subdomain referer so it matches a `*.jimandi.love` key restriction
      // (the apex `jimandi.love` does NOT satisfy the wildcard).
      details.requestHeaders['Referer'] = 'https://tandemonium.jimandi.love/';
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
  startSteamInputTickLoop();

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
