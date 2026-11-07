const { app, BrowserWindow, globalShortcut, ipcMain, session, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { localizeThree, installedThreeVersion } = require('./local-vendors');

// Local diagnostic log: %USERPROFILE%\tandemonium-diag.log. Steam-launched
// runs swallow stdout, so the main process, the renderer (errors, warnings,
// window.electronApp.diag()) and the window's own lifecycle (page crashed,
// hung, reloaded) all land here.
//
// Each launch starts a fresh file but keeps the last one as
// tandemonium-diag.previous.log: after a crash the player relaunches, and the
// session that crashed is the one we need (TV playtest 2026-11-06). A file
// that passes _DIAG_MAX_BYTES is rolled the same way mid-session.
const _diagDir = process.env.USERPROFILE || process.env.HOME || __dirname;
const _diagLogPath = path.join(_diagDir, 'tandemonium-diag.log');
const _diagPrevPath = path.join(_diagDir, 'tandemonium-diag.previous.log');
const _DIAG_MAX_BYTES = 8 * 1024 * 1024;
let _diagBytes = 0;
function _diagRoll() {
  try { if (fs.existsSync(_diagLogPath)) fs.renameSync(_diagLogPath, _diagPrevPath); } catch (e) {}
  _diagBytes = 0;
}
function _diagLog(msg) {
  console.log(msg);
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (_diagBytes + line.length > _DIAG_MAX_BYTES) {
      _diagRoll();
      fs.appendFileSync(_diagLogPath, '--- continued (earlier part in tandemonium-diag.previous.log) ---\n');
    }
    fs.appendFileSync(_diagLogPath, line);
    _diagBytes += line.length;
  } catch (e) {}
}
process.on('uncaughtException', (err) => { _diagLog('[main] uncaught exception: ' + ((err && err.stack) || err)); });
process.on('unhandledRejection', (err) => { _diagLog('[main] unhandled rejection: ' + ((err && err.stack) || err)); });

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
// Roll the diag log only in the instance that runs: a second launch quits
// straight away and must not move the running game's log aside.
if (gotTheLock) { _diagRoll(); _diagLog(`--- launch ${app.getVersion()} pid=${process.pid} electron=${process.versions.electron} ${process.platform} ---`); }
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

// #400 / PR #397 B4c: the Steam demo is its own Steam app id. Main decides
// "is this the demo" once and both appends ?demo=1 to the page URL and
// exposes it to the renderer via preload (tandemoniumSteam.isDemo), so the
// demo does not depend on the --demo launch option alone.
// TODO(#400): set this to the demo's Steam app id once Steamworks creates it
// (none exists yet in steam/, steam_appid.txt or the docs). null = no demo app.
const DEMO_STEAM_APP_ID = null;
function _resolveIsDemo() {
  if (process.argv.includes('--demo') || process.env.TANDEMONIUM_DEMO === '1') return true;
  if (DEMO_STEAM_APP_ID == null) return false;
  // Steam sets SteamAppId for Steam-launched processes; steam_appid.txt (appId) covers dev runs.
  const running = parseInt(process.env.SteamAppId || '', 10);
  return running === DEMO_STEAM_APP_ID || appId === DEMO_STEAM_APP_ID;
}
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

  // Steam Overlay support: the Chromium switches below are what upstream
  // steamworks.js's electronEnableSteamOverlay() used. We deliberately do
  // NOT install the per-frame webContents.invalidate() shim that ships with
  // that helper - it caused visible flicker and made the overlay's close
  // button unresponsive.
  //
  // Applied ONLY after Steam init SUCCEEDS. in-process-gpu makes a D3D
  // device-lost (driver TDR, DXGI 0x887A00xx) unrecoverable: Chromium
  // normally relaunches the crashed GPU process, but in-process there is
  // nothing to relaunch, so the app spins forever on "eglCreateContext:
  // Context lost" (seen after a versus race with Steam exited). Non-Steam
  // sessions don't need the overlay and keep the recoverable GPU process.
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-direct-composition');
} catch (err) {
  console.warn('Steamworks unavailable, running without Steam:', err.message);
  steam = null;
}

// --- Steam Input (emulation mode) ---
// The game ships NO action manifest (IGA), on purpose. Without one, Steam
// treats Tandemonium as a plain gamepad game and re-emits every controller it
// captures as a virtual XInput pad that navigator.getGamepads() can see; the
// player's Steam layout decides what that pad's inputs do (the official layout
// routes the Steam Controller's gyro onto the left stick). Steam Input is
// initialised only so getControllerForGamepadIndex / getInputTypeForHandle can
// name the physical controller behind each virtual pad (#362): the renderer
// uses that to hide the XInput twin of a Steam Controller it already reads
// over WebHID. docs/steam-input.md has the whole model.
let steamInputReady = false;
let steamInputTimer = null;

if (steam) {
  try {
    // explicitCallRunFrame=true: we drive ISteamInput::RunFrame() from the tick.
    const inputOk = steam.input.init(true);
    if (!inputOk) throw new Error('Steam Input init returned false');
    steamInputReady = true;
    _diagLog('Steam Input initialized (emulation mode: no action manifest)');
  } catch (err) {
    _diagLog('Steam Input init failed: ' + err.message);
  }
}

// Diag heartbeat: how many controllers Steam reports as captured. In emulation
// mode that is normally 0 even while virtual XInput pads exist. A non-zero count
// means Steam is treating the game as a Steam Input API game — a stray
// game_actions_<appid>.vdf left in <Steam>/controller_config/, for one.
let _diagHeartbeatAt = 0;
function tickSteamInput() {
  try { steam.input.runFrame(); } catch (e) { /* skip transient errors */ }
  if (Date.now() - _diagHeartbeatAt > 10000) {
    _diagHeartbeatAt = Date.now();
    let n = 0;
    try { n = steam.input.getConnectedControllers().length; } catch (e) {}
    _diagLog(`[SteamInput diag] heartbeat: ${n} captured pad(s) (emulation mode expects 0)`);
  }
}

// XInput-slot identity link (#362). In Steam's emulation mode
// getConnectedControllers() can return NOTHING while Steam still re-emits each
// captured pad as a virtual XInput device — the renderer then sees generic
// "Xbox 360 Controller" pads with no way to tell a DualSense from the Steam
// Controller's own twin. getControllerForGamepadIndex(i) DOES resolve those
// slots to live handles (observed on hardware), and getInputTypeForHandle
// names the pad behind each. Probed every tick and pushed to the renderer.
let steamXInputMap = [];
let _diagXInputKey = '';
function probeSteamXInputSlots() {
  const out = [];
  for (let i = 0; i < 4; i++) {
    let handle = null;
    try { handle = steam.input.getControllerForGamepadIndex(i); } catch (e) { continue; }
    if (handle == null || handle === 0n || handle === 0) continue;
    let type = 'Unknown';
    try { type = String(steam.input.getInputTypeForHandle(handle)); } catch (e) {}
    out.push({ index: i, handle: handle.toString(), type });
  }
  const key = out.map((e) => `${e.index}:${e.type}:${e.handle}`).join('|');
  if (key !== _diagXInputKey) {
    _diagXInputKey = key;
    _diagLog(`[SteamInput diag] XInput slots: ${key || '(none)'}`);
  }
  return out;
}

function startSteamInputTickLoop() {
  if (steamInputTimer || !steamInputReady) return;
  steamInputTimer = setInterval(() => {
    tickSteamInput();
    steamXInputMap = probeSteamXInputSlots();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('steam:input:xinput', steamXInputMap);
    }
  }, 16);
}

// --- IPC handlers for Steam API calls from renderer ---
// Renderer-facing IPC channel names stay identical to the old steamworks.js
// implementation; only the handler bodies changed. preload.js and every JS
// file under js/ that calls window.steam.* keep working without edits.
// Perf readout: the display the game window is on (Windows names it, e.g. the TV's model).
ipcMain.handle('app:display', (e) => {
  const { screen } = require('electron');
  const win = BrowserWindow.fromWebContents(e.sender);
  const d = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  return { label: d.label || '', width: d.size.width, height: d.size.height, scale: d.scaleFactor,
    hz: d.displayFrequency || 0, internal: !!d.internal, count: screen.getAllDisplays().length };
});
ipcMain.handle('steam:isAvailable', () => !!steam);
ipcMain.handle('steam:input:isAvailable', () => steamInputReady);
ipcMain.handle('steam:input:xinputMap', () => steamXInputMap);
// #617 · Steam Controller haptics. A Steam Controller read over WebHID has no rumble
// command of the game's own, so the renderer also asks Steam: TriggerVibration on a handle
// from the XInput-slot map (Steam renders it as the controller's haptics), stopped after
// ms. Only handles listed in that map are accepted. (SetLEDColor did nothing on a Steam
// Controller and was removed, #623.)
const _vibrateStops = new Map();
let _diagVibrateOnce = false;
function _knownSteamHandle(h) {
  if (!steamInputReady || typeof h !== 'string' || !/^\d+$/.test(h)) return null;
  return steamXInputMap.some((e) => e.handle === h) ? BigInt(h) : null;
}
ipcMain.on('steam:input:vibrate', (_e, m) => {
  const handle = _knownSteamHandle(m && m.handle);
  if (handle == null) return;
  const speed = (v) => Math.max(0, Math.min(65535, Math.round((Number(v) || 0) * 65535)));
  try {
    steam.input.triggerVibration(handle, speed(m.strong), speed(m.weak));
    if (!_diagVibrateOnce) { _diagVibrateOnce = true; _diagLog('[SteamInput] TriggerVibration on ' + m.handle); }
  } catch (err) { _diagLog('[SteamInput] TriggerVibration failed: ' + err.message); return; }
  clearTimeout(_vibrateStops.get(m.handle));
  _vibrateStops.set(m.handle, setTimeout(() => {
    _vibrateStops.delete(m.handle);
    try { steam.input.triggerVibration(handle, 0, 0); } catch (e) { /* controller gone */ }
  }, Math.max(20, Math.min(2000, Number(m.ms) || 100))));
});

// B4c: preload reads this synchronously at load so js/edition.js sees
// window.tandemoniumSteam.isDemo before the first getEditionRules() call.
ipcMain.on('app:isDemo', (e) => { e.returnValue = _resolveIsDemo(); });
// #172: the lobby's QUIT pill (js/app-quit.js via preload's electronApp.quit).
// app.quit() closes the window and runs will-quit like the window's close box.
ipcMain.on('app:quit', () => { _diagLog('[app] quit requested from the lobby'); app.quit(); });

// Diagnostic: what Steam Input reports right now — the captured controllers
// (normally none in emulation mode) and the XInput-slot map.
ipcMain.handle('steam:input:fullDiag', () => {
  const out = { ready: steamInputReady, controllers: [], xinput: steamXInputMap };
  if (!steamInputReady) return out;
  let controllers = [];
  try { controllers = steam.input.getConnectedControllers(); } catch (e) {}
  for (const handle of controllers) {
    let type = 'Unknown';
    try { type = String(steam.input.getInputTypeForHandle(handle)); } catch (e) {}
    out.controllers.push({ handle: handle.toString(), type });
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

// ── WebHID pairing (see the select-hid-device handler) ──
// Which attached device should a requestDevice() grant? One wrong answer —
// "the first one" — makes pairing a SECOND controller impossible, because
// every prompt re-grants the pad we already hold. The policy lives in
// @usersfirst/controller-core (pickNewHidDevice), vendored under shared/, so
// the game and the lab's overlay app decide identically. The core is ESM and
// this file is CommonJS, hence the dynamic import; resolved once at startup.
let pickNewHidDevice = null;
const { pathToFileURL } = require('url');
import(pathToFileURL(path.join(__dirname, '..', 'shared', 'controller-inventory.js')).href)
  .then((m) => { pickNewHidDevice = m.pickNewHidDevice; _diagLog('[hid] pick policy loaded from shared/controller-inventory.js'); })
  .catch((err) => _diagLog(`[hid] pick policy unavailable (${err.message}) — falling back to first un-granted device`));

// What the renderer already holds (ControllerManager.heldHidDescriptors()),
// pushed over 'hid:held' before it prompts. Plus the deviceIds we have handed
// out this session, which break ties so repeated prompts walk the controllers.
let heldHidDevices = [];
const hidAlreadyPicked = new Set();
ipcMain.on('hid:held', (_event, list) => {
  heldHidDevices = Array.isArray(list) ? list.filter(Boolean) : [];
});

// Renderer diagnostics → the same log file as the main-process ones. preload
// has always SENT on this channel (uncaught errors, rejections) but nothing
// listened, so every renderer error was dropped. Renderer code can also log
// deliberately via window.electronApp.diag().
ipcMain.on('renderer:diag', (_event, msg) => {
  if (typeof msg === 'string' && msg) _diagLog(msg.slice(0, 4000));
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
    // Opaque backing for the window surface. Without it the window has no
    // backing colour, so until the compositor owns a fully painted frame the
    // desktop behind bleeds through — visible for the first seconds of a race
    // while the GLBs and first WebGL frames land. Much more likely to show
    // when Steam init succeeded, since that path adds `in-process-gpu` and
    // `disable-direct-composition`, which take Windows' own compositor out of
    // the loop and remove the surface that would otherwise hide this.
    backgroundColor: '#000000',
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
  // #400: the demo is the full game restricted by js/edition.js, switched on
  // by ?demo=1. Launch with --demo (Steam demo launch option) or
  // TANDEMONIUM_DEMO=1 to get it in the desktop build.
  const _params = new URLSearchParams();
  if (process.env.TANDEM_TOURIST) _params.set('mode', 'tourist');
  if (_resolveIsDemo()) _params.set('demo', '1');
  const _query = _params.toString() ? '?' + _params.toString() : '';
  mainWindow.loadURL('tandemonium://app/index.html' + _query);
  _watchWindow(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Window lifecycle + renderer console → the diag log. The game's own recovery
// paths (WebGL context lost → reload) only ever said so in the DevTools
// console, so a reload on the TV left no trace anywhere.
const _CONSOLE_LEVELS = ['verbose', 'info', 'warning', 'error'];
function _watchWindow(win) {
  const wc = win.webContents;
  let loads = 0;
  let lastConsole = '';
  let repeats = 0;
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2) return;   // warnings and errors only
    const src = sourceId ? ` (${String(sourceId).split('/').pop()}:${line})` : '';
    const text = `[console:${_CONSOLE_LEVELS[level] || level}] ${String(message).slice(0, 2000)}${src}`;
    // A warning fired every frame would bury everything else: log it once,
    // then how many times it repeated.
    if (text === lastConsole) {
      repeats++;
      if (repeats === 10 || repeats === 100 || repeats % 1000 === 0) _diagLog(`[console] (last message repeated ${repeats}x)`);
      return;
    }
    if (repeats > 0) _diagLog(`[console] (last message repeated ${repeats}x)`);
    lastConsole = text;
    repeats = 0;
    _diagLog(text);
  });
  wc.on('did-start-navigation', (details) => {
    if (details && details.isMainFrame && !details.isSameDocument) _diagLog(`[window] navigating: ${details.url}`);
  });
  wc.on('did-finish-load', () => { loads++; _diagLog(`[window] page loaded (#${loads}${loads > 1 ? ', a RELOAD' : ''})`); });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => { if (isMainFrame) _diagLog(`[window] page failed to load: ${code} ${desc} ${url}`); });
  wc.on('render-process-gone', (_e, details) => { _diagLog(`[window] PAGE CRASHED: reason=${details.reason} exitCode=${details.exitCode}`); });
  wc.on('unresponsive', () => _diagLog('[window] page not responding'));
  wc.on('responsive', () => _diagLog('[window] page responding again'));
}
app.on('child-process-gone', (_e, details) => {
  _diagLog(`[app] child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}${details.name ? ' name=' + details.name : ''}`);
});
app.on('will-quit', () => _diagLog('[app] quitting'));

app.whenReady().then(async () => {
  // Dev: purge any previously-cached tandemonium:// responses so source
  // edits always show up on the next `npm start` (older sessions cached
  // JS modules heuristically — see the no-store note in protocol.handle).
  if (!app.isPackaged) {
    try { await session.defaultSession.clearCache(); } catch (e) {}
  }

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
  // tandemonium.housetandem.com referrer, but Electron's page origin is tandemonium://app.
  // Send a matching Referer on tile requests so the restricted key is accepted
  // in the desktop app (the web build matches naturally).
  // maps.googleapis.com is included for the Maps JavaScript API, which Tourist
  // Mode loads to reach ElevationService when anchoring a ?lat/?lon ride. Same
  // restricted key, so it needs the same Referer or the lookup is rejected and
  // the anchor silently degrades to the blind-guess fallback.
  const TILES_MATCH = /(?:tile|maps)\.googleapis\.com/;
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (API_MATCH.test(details.url)) {
      details.requestHeaders['Origin'] = 'https://tandemonium.housetandem.com';
    }
    if (TILES_MATCH.test(details.url)) {
      // Use the game's own subdomain so it matches the key's referrer restriction
      // (an apex domain does NOT satisfy a `*.` wildcard).
      details.requestHeaders['Referer'] = 'https://tandemonium.housetandem.com/';
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
  const _threeVersion = installedThreeVersion(rootDir);
  _diagLog(`[vendors] three ${_threeVersion ? _threeVersion + ' from node_modules' : 'not installed locally — CDN'}`);
  protocol.handle('tandemonium', async (request) => {
    const url = new URL(request.url);
    let filePath = decodeURIComponent(url.pathname);
    if (filePath === '/' || filePath === '') filePath = '/index.html';
    const fullPath = path.join(rootDir, filePath);
    // Security: prevent path traversal
    if (!fullPath.startsWith(rootDir)) {
      return new Response('Forbidden', { status: 403 });
    }
    // #353: the root page's importmap pulls three from jsdelivr. Point it at
    // the packaged node_modules/three instead, so three — and the Draco
    // decoder, which js/draco-path.js resolves next to three/addons/ — load
    // offline. Left on the CDN if the installed three isn't the pinned version.
    if (filePath === '/index.html') {
      try {
        const html = await fs.promises.readFile(fullPath, 'utf-8');
        const { html: localHtml } = localizeThree(html, { prefix: '/', installedVersion: _threeVersion });
        return new Response(localHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      } catch (e) {
        _diagLog(`[vendors] index.html rewrite failed, serving as-is: ${e && e.message}`);
      }
    }
    // Serve via net.fetch for proper streaming and MIME handling.
    // no-store: the scheme is registered as 'standard', so without cache
    // headers Chromium heuristically caches responses in the profile —
    // which served STALE JS after source edits (fresh `npm start` showed
    // old code). Files are local; re-reading from disk costs nothing.
    const resp = await net.fetch('file://' + fullPath);
    const headers = new Headers(resp.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(resp.body, { status: resp.status, headers });
  });

  createWindow();
  startSteamInputTickLoop();

  // Auto-select first matching HID device (skip the browser picker dialog)
  mainWindow.webContents.session.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const list = (details && details.deviceList) || [];
    const hex = (n) => (n == null ? '????' : n.toString(16).padStart(4, '0'));
    _diagLog(`[hid] picker: ${list.length} device(s): ` +
      (list.map((d) => `${hex(d.vendorId)}:${hex(d.productId)}${d.name ? ' ' + d.name : ''}`).join(', ') || '(none)'));
    if (!list.length) { try { callback(''); } catch (e) {} return; }
    // Shared policy: serials prove which units we already hold, and per-model
    // counts cover the rest — so two identical pads (two DualSenses, a second
    // Steam Controller body) still pair, which a flat vid:pid exclusion would
    // refuse. `reason` says WHY this device won; it is the difference between
    // "nothing new is attached" and "we picked the wrong one".
    const picked = pickNewHidDevice
      ? pickNewHidDevice(list, { held: heldHidDevices, grantedIds: hidAlreadyPicked })
      : { device: list.find((d) => !hidAlreadyPicked.has(d.deviceId)) || list[0], reason: 'fallback: policy unavailable' };
    const chosen = picked.device;
    hidAlreadyPicked.add(chosen.deviceId);
    _diagLog(`[hid] picker: granting ${hex(chosen.vendorId)}:${hex(chosen.productId)}` +
      `${chosen.name ? ' ' + chosen.name : ''} — ${picked.reason} (held ${heldHidDevices.length}, granted ${hidAlreadyPicked.size})`);
    try { callback(chosen.deviceId); } catch (e) { /* callback already used */ }
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
