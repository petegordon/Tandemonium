// fake-steam.mjs — the Electron preload's Steam bridge, scripted, for headless smokes.
//
// electron/preload.js exposes three globals the game reads:
//   window.steam              isAvailable / isSubscribed / getPlayerName / getSteamId /
//                             getAuthTicket / activateAchievement / storeStats, and
//                             steam.input { isAvailable, getLatest, getXInputMap, getFullDiag }
//   window.electronApp        toggleDevTools / setHeldHidDevices / diag
//   window.tandemoniumSteam   { isDemo }
// main.js pushes the Steam Input snapshot at ~60 Hz; the renderer reads
// steam.input.getLatest() synchronously every frame. Here the snapshot is
// whatever the test last set, so it is "pushed" instantly.
//
// A snapshot entry has main.js's shape (tickSteamInput):
//   { handle: '123', type: '13', steerX, steerY, active, digital: { Confirm, Cancel,
//     PedalLeft, PedalRight, Pause, MenuUp, MenuDown, MenuLeft, MenuRight }, motion }
// `type` is the ESteamInputType enum as a numeric string: '13' PS5, '5' PS4,
// '1' Steam Controller, '14' Steam Deck / 2026 Steam Controller, '3' Xbox One.
// `motion` is getMotionData: { rotQuat: [x,y,z,w], accel: [x,y,z] (raw, ~16384/g),
// rotVel: [x,y,z] (rad/s) } or null.
//
//   await installFakeSteam(page, { controllers: [steamPad({ handle: '1', type: '13' })] });
//   const steam = fakeSteam(page);
//   await steam.tilt('1', 20);              // gravity rolled 20° about the forward axis
//   await steam.press('1', 'PedalLeft');    // held until release(...)
//   await steam.set([]);                    // Steam Input lets go of every pad

/** A Steam Input entry with neutral sticks, no buttons, and level motion. */
export function steamPad({ handle = '1', type = '13', motion = true } = {}) {
  return {
    handle: String(handle), type: String(type), steerX: 0, steerY: 0, active: true,
    digital: { Confirm: false, Cancel: false, PedalLeft: false, PedalRight: false, Pause: false, MenuUp: false, MenuDown: false, MenuLeft: false, MenuRight: false },
    // Level: accel reads +1 g on Y (SensorFusion's gravity is -accel, (0,-1,0) at rest).
    motion: motion ? { rotQuat: [0, 0, 0, 1], accel: [0, 16384, 0], rotVel: [0, 0, 0] } : null,
  };
}

function browserFake(init) {
  const state = {
    controllers: init.controllers || [],
    xinput: init.xinput || [],
    available: init.available !== false,
    subscribed: init.subscribed !== false,
    achievements: [],
  };
  const ok = (v) => Promise.resolve(v);
  window.steam = {
    isAvailable: () => ok(state.available),
    isSubscribed: () => ok(state.subscribed),
    getPlayerName: () => ok('Smoke Rider'),
    getSteamId: () => ok('76561190000000000'),
    getAuthTicket: () => ok(null),   // no ticket: auth.loginWithSteam stops before any fetch
    activateAchievement: (id) => { state.achievements.push(id); return ok(true); },
    isAchievementActivated: (id) => ok(state.achievements.includes(id)),
    storeStats: () => ok(true),
    input: {
      isAvailable: () => ok(state.available),
      getLatest: () => state.controllers,
      getXInputMap: () => state.xinput,
      getFullDiag: () => ok({ ready: state.available, controllers: state.controllers }),
    },
  };
  window.electronApp = {
    toggleDevTools: () => ok(false),
    setHeldHidDevices: () => {},
    diag: () => {},
    // #172: the lobby's QUIT confirm. Counted, never acted on (the page stays up).
    quit: () => { state.quitCalls = (state.quitCalls || 0) + 1; },
  };
  window.tandemoniumSteam = { isDemo: !!init.isDemo };
  const find = (h) => state.controllers.find((c) => c.handle === String(h));
  window.__fakeSteam = {
    state,
    set(list) { state.controllers = list; },
    setXInput(map) { state.xinput = map; },
    patch(handle, fields) { const c = find(handle); if (c) Object.assign(c, fields); return !!c; },
    digital(handle, name, down) { const c = find(handle); if (!c) return false; c.digital = { ...c.digital, [name]: !!down }; return true; },
    motion(handle, m) { const c = find(handle); if (!c) return false; c.motion = m; return true; },
  };
}

/**
 * Install before navigation. Pass the desktop-app user agent to gamePage too —
 * the lobby and game read `Electron` from navigator.userAgent for some choices.
 */
export async function installFakeSteam(page, init = {}) {
  await page.evaluateOnNewDocument(browserFake, init);
}

/** User agent of the packaged desktop app (as smoke-host-room uses). */
export const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) tandemonium/1.0 Chrome/130 Electron/33 Safari/537.36';

/** Node-side handle for the fake on `page`. */
export function fakeSteam(page) {
  const call = (fn, ...args) => page.evaluate((f, a) => window.__fakeSteam[f](...a), fn, args);
  return {
    set: (list) => call('set', list),
    setXInput: (map) => call('setXInput', map),
    patch: (h, fields) => call('patch', h, fields),
    press: (h, name) => call('digital', h, name, true),
    release: (h, name) => call('digital', h, name, false),
    motion: (h, m) => call('motion', h, m),
    /** Motion with the pad rolled `deg` degrees about its forward axis (accel only). Fusion roll = -deg. */
    tilt: (h, deg) => {
      const r = (deg * Math.PI) / 180;
      return call('motion', h, { rotQuat: [0, 0, 0, 1], accel: [16384 * Math.sin(r), 16384 * Math.cos(r), 0], rotVel: [0, 0, 0] });
    },
    achievements: () => page.evaluate(() => window.__fakeSteam.state.achievements.slice()),
    /** How many times the page asked electronApp.quit() (#172). */
    quitCalls: () => page.evaluate(() => window.__fakeSteam.state.quitCalls || 0),
  };
}
