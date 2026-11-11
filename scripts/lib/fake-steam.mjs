// fake-steam.mjs — the Electron preload's Steam bridge, scripted, for headless smokes.
//
// electron/preload.js exposes three globals the game reads:
//   window.steam              isAvailable / isSubscribed / getPlayerName / getSteamId /
//                             getAuthTicket / activateAchievement / storeStats /
//                             saveScreenshot (#657, recorded; init.screenshot = 'fail' refuses), and
//                             steam.input { isAvailable, getXInputMap, getFullDiag }
//                             setPresence / inviteFriends / takePendingJoin / friendName /
//                             onJoinRequest (#694 E5 Steam Join Game, recorded; joinRequest() fires one)
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
    screenshots: [],                 // #657: what saveScreenshot received
    screenshotMode: init.screenshot || 'ok',
    // #694 E5 · Join Game / invites: what the game put in rich presence, the invite pickers it
    // opened, a join waiting from a cold start, and the join listeners (fired by joinRequest).
    presence: [],
    invites: [],
    inviteMode: init.invite || 'ok',
    pendingJoin: init.pendingJoin || null,
    joinListeners: [],
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
    // #657 · main.js's steam:saveScreenshot, recorded: the PNG's size and its
    // IHDR dimensions, the RGB buffer's length, the caption.
    saveScreenshot: (req) => {
      const png = req && req.png ? new Uint8Array(req.png) : new Uint8Array(0);
      const be32 = (o) => ((png[o] << 24) >>> 0) + (png[o + 1] << 16) + (png[o + 2] << 8) + png[o + 3];
      const isPng = png.length > 24 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
      state.screenshots.push({
        pngBytes: png.length, isPng,
        pngWidth: isPng ? be32(16) : 0, pngHeight: isPng ? be32(20) : 0,
        rgbBytes: req && req.rgb ? req.rgb.length : 0,
        width: req && req.width, height: req && req.height, caption: req && req.caption,
      });
      if (state.screenshotMode === 'fail') return ok({ ok: false, error: 'fake-fail' });
      return ok({ ok: true, handle: state.screenshots.length, method: 'write', captioned: true });
    },
    setPresence: (p) => { state.presence.push(p); return ok(state.available); },
    inviteFriends: (c) => { state.invites.push(c); return ok(state.available && state.inviteMode !== 'fail'); },
    takePendingJoin: () => { const r = state.pendingJoin; state.pendingJoin = null; return ok(r); },
    friendName: (id) => ok(id === '76561190000000001' ? 'Pete' : null),
    onJoinRequest: (cb) => { state.joinListeners.push(cb); },
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
    setScreenshotMode(mode) { state.screenshotMode = mode; },
    joinRequest(req) { for (const cb of state.joinListeners) cb(req); return state.joinListeners.length; },
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
    /** #657 · every saveScreenshot call: { pngBytes, isPng, pngWidth, pngHeight, rgbBytes, width, height, caption }. */
    screenshots: () => page.evaluate(() => window.__fakeSteam.state.screenshots.slice()),
    /** 'ok' | 'fail' — a failing save makes SHARE RESULT fall back to the clipboard. */
    setScreenshotMode: (mode) => call('setScreenshotMode', mode),
    /** How many times the page asked electronApp.quit() (#172). */
    quitCalls: () => page.evaluate(() => window.__fakeSteam.state.quitCalls || 0),
    /** #694 E5 · every setPresence({ connect, status }) the game made. */
    presence: () => page.evaluate(() => window.__fakeSteam.state.presence.slice()),
    /** #694 E5 · every Steam invite picker the game opened (its connect string). */
    invites: () => page.evaluate(() => window.__fakeSteam.state.invites.slice()),
    /** #694 E5 · Steam hands the running game a friend's join ({ connect, friend, via }); returns the listener count. */
    joinRequest: (req) => call('joinRequest', req),
  };
}
