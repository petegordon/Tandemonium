#!/usr/bin/env node
// smoke:disconnect · the disconnect pause (#468). A dropped controller or online
// partner pauses the ride (clock + physics stop); after DROP_TAKEOVER_MS the
// player still here can ride on alone / take over the bike.
//
// Pads are fake Gamepad API pads (scripts/lib/fake-gamepads.mjs) that go through
// the real ControllerManager: unplugging empties the pad's getGamepads() slot,
// the manager orphans the seat, and the game sees the drop the same way it
// would a real cable pull. Local co-op is seated through the real lobby join
// (Player 2 presses a button on the host step).
//
//   solo     pad drop → pause → replug resumes; Resume rides on without it
//   local    P2 drop → "Ride on alone"; P1 drop → "Player 2: take over";
//            replug inside 20 s resumes with the same seats
//   online   captain + stoker partner loss (fake net) → ride on alone / take over
import { startHarness, sleep, clickId, waitState } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const h = await startHarness({ port: 8957, outDir: 'tandemonium-disconnect' });
const { check } = h;
const STORAGE = { tandemonium_tutorial_done: 'smoke' };

const overlay = (page) => page.evaluate(() => {
  const g = window._game;
  const shown = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.offsetParent !== null; };
  return {
    visible: document.getElementById('disconnect-overlay').style.display !== 'none',
    msg: document.getElementById('disconnect-msg').textContent,
    sub: document.getElementById('disconnect-sub').textContent,
    resume: shown('btn-drop-resume'), alone: shown('btn-ride-alone'), retry: shown('btn-try-reconnect'),
    aloneText: document.getElementById('btn-ride-alone').textContent,
    who: g._drop ? g._drop.who : null, mode: g.mode, state: g.state,
  };
});
const skipWait = (page) => page.evaluate(() => { window._game._drop.since -= 20000; });
const p1Slot = (page) => page.evaluate(() => { const s = window.__controllerManager.getSlot('P1'); return { state: s.state, index: s.gamepadIndex }; });

/** Count race-manager steps, to prove the clock + progress stop while paused. */
const countRaceSteps = (page) => page.evaluate(() => {
  const rm = window._game.raceManager;
  if (!rm.__counted) { const up = rm.update.bind(rm); rm.update = (...a) => { window.__rmCalls++; return up(...a); }; rm.__counted = true; }
  window.__rmCalls = 0;
});

/** Solo ride with one fake Xbox pad, plugged in before the page loads. */
async function rideSolo() {
  const page = await h.gamePage({ storage: STORAGE, before: (p) => installFakeGamepads(p, { atBoot: ['xbox'] }) });
  await sleep(1200);
  await clickId(page, 'btn-solo');
  await sleep(600);
  await clickId(page, 'btn-start-ride');
  await waitState(page, 'playing');
  await sleep(800);
  return page;
}

// ── Solo: pad drop pauses; reconnect resumes; Resume rides on ──
console.log('solo');
{
  const page = await rideSolo();
  const pads = fakePads(page);
  check((await p1Slot(page)).state === 'claimed', 'solo: the manager claimed the fake pad as P1', await p1Slot(page));
  check(await page.evaluate(() => window._game._p1PadSeen), 'solo: P1 pad seen while riding');
  await pads.unplug(0);
  await sleep(1200);
  let o = await overlay(page);
  check((await p1Slot(page)).state === 'orphan', 'solo: unplugging orphans the P1 seat');
  check(o.visible && o.who === 'p1' && /Your controller/.test(o.msg), 'solo: unplugging pauses with "Your controller disconnected"', o.msg);
  check(o.resume && !o.alone, 'solo: Resume shown, no ride-on-alone', o);
  await countRaceSteps(page);
  await sleep(1500);
  const pausedCalls = await page.evaluate(() => window.__rmCalls);
  check(pausedCalls === 0, 'solo: race clock + physics not stepped while paused', pausedCalls);
  await pads.replug(0);
  await sleep(800);
  o = await overlay(page);
  check((await p1Slot(page)).state === 'claimed', 'solo: replugging reclaims the same seat', await p1Slot(page));
  check(!o.visible && !o.who && o.state === 'playing', 'solo: reconnecting resumes the ride', o);
  await sleep(800);
  check(await page.evaluate(() => window.__rmCalls) > 0, 'solo: race steps again after resume');
  await pads.unplug(0);
  await sleep(1200);
  await clickId(page, 'btn-drop-resume');
  await sleep(800);
  o = await overlay(page);
  check(!o.visible && o.state === 'playing', 'solo: Resume rides on without the pad', o);
  await page.close();
}

// ── Local co-op through the lobby: two pads, P2 joins by pressing a button ──
async function rideLocal() {
  const page = await h.gamePage({ storage: STORAGE, before: (p) => installFakeGamepads(p, { atBoot: ['xbox'] }) });
  const pads = fakePads(page);
  await sleep(1200);
  await page.evaluate(() => {
    const l = window._game.lobby;
    document.getElementById('room-code-display').textContent = 'TNDM-LOCL';
    l._pendingMode = 'multiplayer'; l._roomRole = 'captain';
    l._showStep(l.hostStep); l._refreshHostNext();
  });
  await sleep(500);
  const p2 = await pads.plug('dualsense');
  await sleep(600);
  await pads.tap(p2, 'A');
  await sleep(800);
  const seated = await page.evaluate(() => ({ p2: !!window._game.lobby._localP2InputManager, type: window._game.lobby._localP2Type }));
  check(seated.p2 && seated.type === 'gamepad', 'local: Player 2 seated by pressing a button on the second pad', seated);
  await clickId(page, 'btn-host-local-next');
  await sleep(700);
  await clickId(page, 'btn-start-ride');
  await waitState(page, 'playing');
  await sleep(1000);
  const ride = await page.evaluate(() => ({ mode: window._game.mode, p2: !!window._game.inputP2, p2pad: window._game.inputP2?.gamepadConnected }));
  check(ride.mode === 'local' && ride.p2 && ride.p2pad, 'local: ride started in local co-op with P2 on its pad', ride);
  await page.evaluate(() => { window.__p1Input = window._game.input; window.__p2Input = window._game.inputP2; });
  return { page, pads, p2 };
}

for (const who of ['p2', 'p1']) {
  console.log('local ' + who);
  const { page, pads, p2 } = await rideLocal();
  const idx = who === 'p2' ? p2 : 0;
  await pads.unplug(idx);
  await sleep(1200);
  let o = await overlay(page);
  const want = who === 'p2' ? /Player 2's controller/ : /Player 1's controller/;
  check(o.visible && o.who === who && want.test(o.msg), `local ${who}: drop pauses`, o.msg);
  check(o.resume === (who === 'p1') && !o.alone && !o.retry, `local ${who}: buttons before 20 s`, o);
  if (who === 'p2') {
    // Replug inside the 20 s: the ride resumes with the same seats.
    await pads.replug(idx);
    await pads.tap(idx, 'A');
    await sleep(900);
    o = await overlay(page);
    const seats = await page.evaluate(() => ({ p1: window._game.input === window.__p1Input, p2: window._game.inputP2 === window.__p2Input, p2pad: window._game.inputP2?.gamepadConnected }));
    check(!o.visible && o.mode === 'local' && seats.p1 && seats.p2 && seats.p2pad, 'local p2: replug inside 20 s resumes with the same seats', { ...o, ...seats });
    await pads.unplug(idx);
    await sleep(1200);
  }
  await skipWait(page);
  await sleep(800);
  o = await overlay(page);
  const label = who === 'p2' ? /Ride on alone/ : /Player 2: take over/;
  await h.shot(page, `local-${who}-after-20s`);
  check(o.alone && label.test(o.aloneText), `local ${who}: after 20 s "${who === 'p2' ? 'Ride on alone' : 'Player 2: take over'}"`, o.aloneText);
  await clickId(page, 'btn-ride-alone');
  await sleep(1500);
  o = await overlay(page);
  const seat = await page.evaluate(() => ({ p2: !!window._game.inputP2, isP2: window._game.input === window.__p2Input, isP1: window._game.input === window.__p1Input }));
  check(!o.visible && o.mode === 'solo' && o.state === 'playing' && !seat.p2 && (who === 'p1' ? seat.isP2 : seat.isP1),
    `local ${who}: ${who === 'p1' ? 'Player 2 rides the bike solo' : 'Player 1 rides on solo'}`, { ...o, ...seat });
  if (who === 'p1') {
    await page.evaluate(() => window._game._returnToLobby());
    await sleep(500);
    check(await page.evaluate(() => window._game.input === window.__p1Input), 'local p1: P1 input back in the seat at the lobby');
  }
  await page.close();
}

// ── Online (fake net): partner loss → pause → after 20 s ride on / take over ──
for (const role of ['captain', 'stoker']) {
  console.log('online ' + role);
  const page = await rideSolo();
  await page.evaluate((role) => {
    const g = window._game;
    window.__destroyed = 0;
    g.net = { connected: false, transport: 'relay', roomCode: 'TNDM-TEST', sendState() {}, sendLean() {}, sendPedal() {}, sendEvent() {}, retryConnection() { window.__retried = 1; }, destroy() { window.__destroyed++; } };
    g.mode = role;
    g._reconnecting = true;   // what _showReconnecting sets after the 2 s grace
  }, role);
  await sleep(1000);
  let o = await overlay(page);
  const want = role === 'stoker' ? /captain lost connection/ : /partner lost connection/;
  check(o.visible && o.who === 'partner' && want.test(o.msg), `${role}: partner loss pauses`, o.msg);
  check(!o.alone && /in \d+s/.test(o.sub), `${role}: take-over waits with a countdown`, o.sub);
  await h.shot(page, `online-${role}-waiting`);
  // The transport gives up → Try Again appears too.
  await page.evaluate(() => { const g = window._game; g._netLost = true; g._renderDropOverlay(); });
  o = await overlay(page);
  check(o.retry, `${role}: Try Again offered once the connection gave up`);
  await skipWait(page);
  await sleep(800);
  o = await overlay(page);
  const label = role === 'stoker' ? /Take over the bike/ : /Ride on alone/;
  check(o.alone && label.test(o.aloneText), `${role}: after 20 s "${role === 'stoker' ? 'Take over the bike' : 'Ride on alone'}"`, o.aloneText);
  await clickId(page, 'btn-ride-alone');
  await sleep(1500);
  o = await overlay(page);
  const after = await page.evaluate(() => ({ net: window._game.net, destroyed: window.__destroyed }));
  check(!o.visible && o.mode === 'solo' && o.state === 'playing' && after.net === null && after.destroyed === 1, `${role}: rides on as a solo ride`, { ...o, ...after });
  await page.close();
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
