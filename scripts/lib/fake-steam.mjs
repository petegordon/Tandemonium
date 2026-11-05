// fake-steam.mjs — the Electron preload's Steam bridge, scripted, for headless smokes.
//
// electron/preload.js exposes three globals the game reads:
//   window.steam              isAvailable / isSubscribed / getPlayerName / getSteamId /
//                             getAuthTicket / activateAchievement / storeStats, and
//                             steam.input { isAvailable, getXInputMap, getFullDiag }
//   window.electronApp        toggleDevTools / setHeldHidDevices / diag
//   window.tandemoniumSteam   { isDemo }
//
// The game runs under Steam in emulation mode (docs/steam-input.md): a pad
// Steam captures reaches the game as a virtual XInput pad through the Gamepad
// API (fake-gamepads.mjs), and main.js pushes the XInput-slot map — which
// physical controller sits behind each virtual pad — at ~60 Hz. Here the map
// is whatever the test last set, so it is "pushed" instantly.
//
//   await installFakeSteam(page, { xinput: [{ index: 0, handle: '100', type: '14' }] });
//   const steam = fakeSteam(page);
//   await steam.setXInput([]);              // Steam lets go of every pad
//
// `type` is the ESteamInputType enum as a numeric string: '13' PS5, '5' PS4,
// '1' Steam Controller, '14' Steam Deck / 2026 Steam Controller, '3' Xbox One.

function browserFake(init) {
  const state = {
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
      getXInputMap: () => state.xinput,
      getFullDiag: () => ok({ ready: state.available, controllers: [], xinput: state.xinput }),
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
  window.__fakeSteam = {
    state,
    setXInput(map) { state.xinput = map; },
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
    setXInput: (map) => call('setXInput', map),
    achievements: () => page.evaluate(() => window.__fakeSteam.state.achievements.slice()),
    /** How many times the page asked electronApp.quit() (#172). */
    quitCalls: () => page.evaluate(() => window.__fakeSteam.state.quitCalls || 0),
  };
}
