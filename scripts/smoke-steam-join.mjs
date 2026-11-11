#!/usr/bin/env node
// smoke:steam-join · #694 E5 Steam Join Game / invites (js/steam-join.js) against the fake
// preload bridge (scripts/lib/fake-steam.mjs). The room transport is stubbed (enterRoom
// recorded, the relay's "you're in" fired by hand), as smoke:room-wait does. The real Steam
// side (rich presence, the invite picker, callback 337) needs two Steam accounts: manual.
//
//   SJ-01  web build: no "Invite a Steam friend"; desktop app outside Steam: none either
//   SJ-02  Steam build, host step: Invite shows; pressing it opens the room and Steam's picker
//          with "+tandemonium_room TNDM-XXXX"; the presence offers Join Game while the seat is
//          free and drops it once the partner is in
//   SJ-03  a friend's join heard in the menus: the join step joins their room ("Joining Pete's ride")
//   SJ-04  a cold start from Join Game: the game boots straight into the friend's room
//   SJ-05  already in a room with a partner: asks first (STAY HERE keeps it; JOIN joins)
//   SJ-06  mid-ride: the pause menu opens with JOIN PETE'S RIDE on top; pressing it ends the ride
//          and joins; RESUME instead drops the offer
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeSteam, fakeSteam, ELECTRON_UA } from './lib/fake-steam.mjs';

const h = await startHarness({ port: 8947, outDir: 'tandemonium-steam-join' });
const { check } = h;
const FRIEND = '76561190000000001';   // the fake's friendName() says 'Pete'

const until = async (page, fn, arg, timeout = 15000) => {
  try { const hnd = await page.waitForFunction(fn, { timeout, polling: 50 }, arg); return await hnd.jsonValue(); } catch { return null; }
};
const stepIs = (page, id) => until(page, (want) => document.getElementById('lobby-flow').current === want, id);

/** The room transport stubbed: enterRoom recorded; a captain's room "opens" 50 ms later. */
const stubRooms = (page) => page.evaluate(() => {
  const l = window._game.lobby;
  window.__entered = [];
  l.auth.getRelayToken = async () => null;
  const orig = l._replaceNet.bind(l);
  l._replaceNet = () => {
    const n = orig();
    const net = l.net;
    net.enterRoom = (code, role) => {
      net.roomCode = code; net.role = role; window.__entered.push([code, role]);
      if (role === 'captain') setTimeout(() => net.onRoomJoined && net.onRoomJoined(), 50);
    };
    net.acquireLocalMedia = async () => {};
    net.retryWithToken = () => {};
    return n;
  };
});

const desktop = (init = {}, storage = {}) => h.gamePage({
  viewport: { width: 1920, height: 1080 },
  userAgent: ELECTRON_UA,
  storage: { tandemonium_tutorial_done: 'smoke', ...storage },
  before: (p) => installFakeSteam(p, init),
});

const toHost = async (page) => {
  await page.evaluate(() => { const l = window._game.lobby; l._showStep(l.modeStep); });
  await page.evaluate(() => document.getElementById('btn-together').click());
  await stepIs(page, 'lobby-role');
  await page.evaluate(() => document.getElementById('btn-captain').click());
  await stepIs(page, 'lobby-host');
  await sleep(300);
};
const inviteShown = (page) => page.evaluate(() => {
  const b = document.getElementById('btn-host-steam-invite');
  return !!b && !b.hidden && b.getBoundingClientRect().height > 0;
});

// ── SJ-01 ──
console.log('SJ-01 no Steam: no invite');
{
  const web = await h.gamePage({ viewport: { width: 1920, height: 1080 }, storage: { tandemonium_tutorial_done: 'smoke' } });
  await toHost(web);
  check(!(await inviteShown(web)), 'SJ-01: the web build has no "Invite a Steam friend"');
  await web.close();
  const off = await desktop({ available: false });
  await toHost(off);
  check(!(await inviteShown(off)), 'SJ-01: the desktop app launched outside Steam has none either');
  check((await fakeSteam(off).presence()).length === 0, 'SJ-01: … and never touches rich presence');
  await off.close();
}

// ── SJ-02 ──
console.log('SJ-02 the host step invites a Steam friend');
{
  const page = await desktop();
  const steam = fakeSteam(page);
  await stubRooms(page);
  await toHost(page);
  check(await inviteShown(page), 'SJ-02: the Steam build shows "Invite a Steam friend" on the host step');
  const p0 = await steam.presence();
  check(p0.length >= 1 && p0.every((p) => !p.connect), 'SJ-02: no room yet: no Join Game in the presence', p0);
  await page.evaluate(() => document.getElementById('btn-host-steam-invite').click());
  const inv = await until(page, () => window.__fakeSteam.state.invites.slice(), null, 5000).then(async () => {
    for (let i = 0; i < 60; i++) { const v = await steam.invites(); if (v.length) return v; await sleep(100); }
    return [];
  });
  const code = await page.evaluate(() => window._game.lobby._hostRoomCode);
  check(/^TNDM-[A-Z0-9]{4}$/.test(code || '') && inv.length === 1 && inv[0] === `+tandemonium_room ${code}`,
    'SJ-02: Invite opened the room and Steam\'s picker with its connect string', { code, inv });
  await sleep(1300);
  const p1 = (await steam.presence()).at(-1);
  check(p1 && p1.connect === `+tandemonium_room ${code}` && /Waiting for a partner in room/.test(p1.status || ''),
    'SJ-02: while the seat is free, the presence offers Join Game for the room', p1);
  await h.shot(page, 'sj02-host');
  await page.evaluate(() => { window._game.lobby.net.connected = true; });
  await sleep(1300);
  const p2 = (await steam.presence()).at(-1);
  check(p2 && !p2.connect, 'SJ-02: the partner is in: Join Game goes', p2);
  await page.close();
}

// ── SJ-03 ──
console.log('SJ-03 a friend\'s join heard in the menus');
{
  const page = await desktop();
  const steam = fakeSteam(page);
  await stubRooms(page);
  await until(page, () => window.__fakeSteam.state.joinListeners.length > 0);
  const n = await steam.joinRequest({ connect: '+tandemonium_room TNDM-WXYZ', friend: FRIEND, via: 'join-request' });
  await stepIs(page, 'lobby-join');
  const r = await until(page, () => window.__entered.length ? { entered: window.__entered.slice(), step: document.getElementById('lobby-flow').current,
    toast: document.body.innerText.includes("Joining Pete's ride") } : null);
  check(n === 1 && r && r.step === 'lobby-join' && r.entered[0][0] === 'TNDM-WXYZ' && r.entered[0][1] === 'stoker',
    'SJ-03: the join step joins the friend\'s room as the stoker', r);
  check(r && r.toast, 'SJ-03: "Joining Pete\'s ride" says whose', r);
  await h.shot(page, 'sj03-join');
  await page.close();
}

// ── SJ-04 ──
console.log('SJ-04 a cold start from Join Game');
{
  // The fake's takePendingJoin hands this over as soon as the lobby asks, before the transport
  // stub is in, so the check reads the join step and the code the lobby is joining.
  const page = await desktop({ pendingJoin: { connect: 'C:\\Games\\Tandemonium.exe +tandemonium_room TNDM-QR7Z', friend: null, via: 'launch' } });
  const r = await until(page, () => {
    const l = window._game.lobby;
    return document.getElementById('lobby-flow').current === 'lobby-join' && l.net && l.net.roomCode
      ? { step: 'lobby-join', code: l.net.roomCode, input: document.getElementById('room-code-input').value } : null;
  });
  check(r && r.code === 'TNDM-QR7Z' && r.input === 'QR7Z', 'SJ-04: the game boots into the friend\'s room (join step, code filled)', r);
  await page.close();
}

// ── SJ-05 ──
console.log('SJ-05 in a room with a partner: ask first');
{
  const page = await desktop();
  const steam = fakeSteam(page);
  await stubRooms(page);
  await toHost(page);
  await page.evaluate(() => document.getElementById('btn-host-room-code').click());
  await until(page, () => !!window._game.lobby._hostRoomCode);
  await page.evaluate(() => { const l = window._game.lobby; l.net.connected = true; l._roomPartnerName = 'Sam'; });
  await steam.joinRequest({ connect: '+tandemonium_room TNDM-WXYZ', friend: FRIEND, via: 'join-request' });
  const ask = await until(page, () => { const s = document.getElementById('steam-join-sheet'); return s && s.open ? document.getElementById('steam-join-text').textContent : null; });
  check(!!ask && /Pete/.test(ask) && /WXYZ/.test(ask) && /Sam/.test(ask), 'SJ-05: asks "Join Pete\'s room WXYZ? You\'ll leave Sam."', ask);
  await h.shot(page, 'sj05-ask');
  await page.evaluate(() => document.getElementById('steam-join-cancel').click());
  await sleep(300);
  const stay = await page.evaluate(() => ({ step: document.getElementById('lobby-flow').current, entered: window.__entered.map((e) => e[0]) }));
  check(stay.step === 'lobby-host' && !stay.entered.includes('TNDM-WXYZ'), 'SJ-05: STAY HERE keeps the room', stay);
  await steam.joinRequest({ connect: '+tandemonium_room TNDM-WXYZ', friend: FRIEND, via: 'join-request' });
  await until(page, () => { const s = document.getElementById('steam-join-sheet'); return s && s.open; });
  await page.evaluate(() => document.getElementById('steam-join-confirm').click());
  const go = await until(page, () => window.__entered.some((e) => e[0] === 'TNDM-WXYZ') ? document.getElementById('lobby-flow').current : null);
  check(go === 'lobby-join', 'SJ-05: JOIN leaves it and joins the friend\'s room', go);
  await page.close();
}

// ── SJ-06 ──
console.log('SJ-06 mid-ride: the pause menu offers it');
{
  const page = await desktop();
  const steam = fakeSteam(page);
  await stubRooms(page);
  const ride = async () => {
    await page.evaluate(() => { const l = window._game.lobby; l._showStep(l.modeStep); });
    await page.evaluate(() => document.getElementById('btn-solo').click());
    await page.waitForFunction(() => !!document.querySelector('#level-cards .level-card[data-level-id="grandma"]'), { timeout: 20000 });
    await page.evaluate(() => {
      document.querySelector('#level-cards .level-card[data-level-id="grandma"]').click();
      const d = Array.from(document.querySelectorAll('.difficulty-btn')).find((x) => x.dataset.difficulty === 'chill'); d && d.click();
    });
    await sleep(300);
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button, uf-button')).find((x) => x.offsetParent !== null && /start ride/i.test(x.textContent || '')); b && b.click(); });
    await page.waitForFunction(() => window._game && window._game.state === 'playing', { timeout: 120000 });
  };
  await ride();
  await steam.joinRequest({ connect: '+tandemonium_room TNDM-WXYZ', friend: FRIEND, via: 'join-request' });
  const menu = await until(page, () => {
    const g = window._game, b = document.getElementById('btn-pause-steam-join');
    return g._pause && b && !b.hidden ? { text: b.textContent, focused: b.classList.contains('gamepad-focus') || document.activeElement === b, state: g.state } : null;
  });
  check(menu && menu.text === "JOIN PETE'S RIDE", 'SJ-06: mid-ride, the pause menu opens with JOIN PETE\'S RIDE', menu);
  await h.shot(page, 'sj06-pause');
  await page.evaluate(() => document.getElementById('btn-pause-resume').click());
  await sleep(300);
  const resumed = await page.evaluate(() => ({ pause: !!window._game._pause, hidden: document.getElementById('btn-pause-steam-join').hidden, state: window._game.state }));
  check(!resumed.pause && resumed.hidden && resumed.state === 'playing', 'SJ-06: RESUME drops the offer and rides on', resumed);
  await steam.joinRequest({ connect: '+tandemonium_room TNDM-WXYZ', friend: FRIEND, via: 'join-request' });
  await until(page, () => { const b = document.getElementById('btn-pause-steam-join'); return !!window._game._pause && b && !b.hidden; });
  await page.evaluate(() => document.getElementById('btn-pause-steam-join').click());
  const joined = await until(page, () => window._game.state === 'lobby' && window.__entered.some((e) => e[0] === 'TNDM-WXYZ')
    ? { state: window._game.state, step: document.getElementById('lobby-flow').current } : null);
  check(joined && joined.step === 'lobby-join', 'SJ-06: JOIN ends the ride and joins the friend\'s room', joined);
  await page.close();
}

await h.finish();
