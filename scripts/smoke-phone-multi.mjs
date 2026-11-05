#!/usr/bin/env node
// smoke:phone-multi · several phones on ONE QR (#562), and the phone choosing
// how to join (#563).
//
//   MC-16  co-op host step: one "Scan to join" QR (no online room QR, no room
//          opened yet). Two phones scan the SAME QR, pick "Control the TV" and
//          get seats 2 and 3 of the one pad room; the QR stays put. Phone 2
//          presses OK and is seated as Player 2. In the ride it pedals and
//          steers Player 2 only; it dropping mid-ride pauses the ride and shows
//          its code again.
//   MC-17  versus: the panel's QR asks no question (controller only). Two
//          phones scan the same QR, take seats with OK, D-pad → switches team,
//          BACK leaves the seat and OK rejoins; in the race each phone pedals
//          its own seat.
//   MC-18  #563 "Play on this phone": the TV opens the RIDE TOGETHER room only
//          now and the phone lands on the game's join link with its code. A
//          room that fails: the phone says so and offers Control the TV.
//
// Real pad relay (port 8794) and RIDE TOGETHER relay (port 8795) under
// `wrangler dev`, the game on the shared harness (port 8996) with no pads
// (keyboard Player 1), each phone page in its own browser (a background tab
// would be throttled).
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { startHarness, sleep, clickId } from './lib/smoke-harness.mjs';

const ROOT = process.cwd();
const require = createRequire(ROOT + '/package.json');
const puppeteer = require('puppeteer');
const RELAY_PORT = 8794;
const ROOM_RELAY_PORT = 8795;
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
// The game's RIDE TOGETHER relay, pointed at the local one (see openGame).
const PROD_ROOM_RELAY = /export const RELAY_URL = '([^']*)'/.exec(fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8'))?.[1];
if (!PROD_ROOM_RELAY) throw new Error('smoke-phone-multi: RELAY_URL not found in js/config.js');

// ── both relays under wrangler dev ──
const procs = [];
const wlogs = [];
function startWrangler(config, port, persist) {
  const p = spawn(`npx wrangler dev --config ${config} --port ${port} --ip 127.0.0.1${persist ? ` --persist-to "${path.join(os.tmpdir(), persist)}"` : ''} --show-interactive-dev-session=false`,
    { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = { text: '' };
  p.stdout.on('data', (d) => { log.text += d; });
  p.stderr.on('data', (d) => { log.text += d; });
  procs.push(p); wlogs.push(log);
  return p;
}
const killWranglers = () => {
  for (const p of procs) {
    try {
      if (process.platform === 'win32') execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore' });
      else p.kill('SIGTERM');
    } catch { /* gone */ }
  }
};
process.on('exit', killWranglers);
startWrangler('worker/wrangler-pad.toml', RELAY_PORT, 'tandemonium-smoke-phone-multi');
startWrangler('worker/wrangler.toml', ROOM_RELAY_PORT, null);
for (const port of [RELAY_PORT, ROOM_RELAY_PORT]) {
  let up = false;
  for (let i = 0; i < 180 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { /* not yet */ }
    if (!up) await sleep(500);
  }
  if (!up) { for (const l of wlogs) console.log(l.text.slice(-2000)); killWranglers(); throw new Error(`relay on ${port} did not start`); }
}

const h = await startHarness({ port: 8996, outDir: 'tandemonium-phone-multi' });
const { check } = h;
const browsers = [];

/** Poll `fn` in `page` until truthy (or the timeout), returning its last value. */
const until = async (page, fn, arg, ms = 30000) => {
  let v;
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    v = await page.evaluate(fn, arg);
    if (v) return v;
    await sleep(150);
  }
  return v;
};

/**
 * Open `link` on a new phone (its own browser) with stand-in tilt. `choice`:
 * 'connect' (a controller-only link), 'control' or 'play' (#563's choice), or
 * null (just open it). The game's join link (Play) is answered with a stub
 * page: the smoke only checks where the phone lands.
 */
async function phoneOpens(link, choice) {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--mute-audio'] });
  browsers.push(b);
  const phone = await b.newPage();
  await phone.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: false });
  await phone.setRequestInterception(true);
  phone.on('request', (req) => {
    const u = new URL(req.url());
    if (req.isNavigationRequest() && u.searchParams.has('room')) return req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>joined</title><p id="joined">joined</p>' });
    return req.continue();
  });
  // The harness serves index.html only for "/", so name the phone page's file.
  await phone.goto(link.replace('/remote/?', '/remote/index.html?'), { waitUntil: 'domcontentloaded' });
  await phone.evaluate(() => {
    window.__tilt = 0;
    setInterval(() => { const e = new Event('deviceorientation'); Object.assign(e, { alpha: 0, beta: 5, gamma: window.__tilt }); window.dispatchEvent(e); }, 16);
  });
  const btn = { connect: '#btn-connect', control: '#btn-control', play: '#btn-play' }[choice];
  if (btn) await phone.click(btn);
  return phone;
}

/** Which first screen the phone page shows. */
const phoneScreen = (phone) => phone.evaluate(() => document.querySelector('.screen.on')?.id || null);

/** Tap a phone's menu button (ok / back / left / right …). */
const tap = async (phone, nav) => {
  await phone.evaluate((n) => {
    const el = document.querySelector(`#controls [data-nav="${n}"]`);
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7 }));
    setTimeout(() => el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 })), 250);
  }, nav);
  await sleep(450);
};

/** Hold a phone's left pedal while `read` (in the game) is polled for `ok`. */
const whileHolding = async (game, phone, read, ok) => {
  await phone.mouse.move(150, 300); await phone.mouse.down();
  let v;
  for (const t0 = Date.now(); Date.now() - t0 < 5000;) { v = await game.evaluate(read); if (ok(v)) break; await sleep(150); }
  await phone.mouse.up();
  return v;
};

const openGame = () => h.gamePage({
  viewport: { width: 1600, height: 900 },
  storage: { tandemonium_tutorial_done: 'smoke' },
  query: `?padRelay=${encodeURIComponent(RELAY)}`,
  // RIDE TOGETHER's relay → the local one (WebSockets bypass request interception).
  before: (page) => page.evaluateOnNewDocument((prod, local) => {
    const W = window.WebSocket;
    const Patched = function (url, protocols) {
      const u = String(url);
      return new W(u.startsWith(prod) ? local + u.slice(prod.length) : u, protocols);
    };
    Patched.prototype = W.prototype;
    Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = /** @type {any} */ (Patched);
  }, PROD_ROOM_RELAY, `ws://127.0.0.1:${ROOM_RELAY_PORT}`),
});

/** Captain's host step the real way: RIDE TOGETHER → START A RIDE. */
async function toHostStep(game) {
  await game.waitForFunction(() => !!window.__phonePool && !!window._game?.lobby, { timeout: 60000 });
  await clickId(game, 'btn-together');
  await game.waitForFunction(() => document.getElementById('lobby-flow').current === 'lobby-role', { timeout: 15000 }).catch(() => {});
  await clickId(game, 'btn-captain');
  await game.waitForFunction(() => document.getElementById('lobby-flow').current === 'lobby-host', { timeout: 15000 });
}

/** The host step's "Scan to join" link, once its room is up. */
const hostQr = (game) => until(game, () => {
  const v = document.getElementById('host-join-qr')?.value || '';
  return /seats=/.test(v) ? v : null;
}, null, 60000);

try {
  // ── MC-16 · co-op: one QR, two phones, Player 2 on a phone ──
  console.log('MC-16 co-op: two phones scan one QR');
  {
    const game = await openGame();
    await toHostStep(game);
    const link = await hostQr(game);
    const tv = await game.evaluate(() => ({
      head: document.querySelector('#host-online-head h3')?.textContent,
      oldQr: !!document.getElementById('room-qr-tv'),
      phoneBtn: !!document.getElementById('btn-host-join-phone'),
      net: !!window._game.lobby.net,
      code: document.getElementById('room-code-display').textContent,
      codeShown: getComputedStyle(document.getElementById('room-code-display')).display !== 'none',
      codeBtn: (() => { const b = document.getElementById('btn-host-room-code'); return !!b && b.offsetParent !== null; })(),
      hint: document.getElementById('host-seat-stoker').hint,
    }));
    check(/scan to join/i.test(tv.head || '') && !tv.oldQr && !tv.phoneBtn, 'MC-16: the host step shows one "Scan to join" QR (no online QR, no separate phone button)', tv);
    check(!tv.net && !tv.codeShown && tv.codeBtn, 'MC-16: no online room is opened yet; a button opens one to type its code elsewhere', tv);
    check(/play=1/.test(link) && /seats=2%2C3%2C4/.test(link), 'MC-16: the QR offers both choices and every free phone seat', link);
    check(/scan the code/.test(tv.hint || ''), 'MC-16: the stoker seat says a phone can scan the code', tv.hint);

    const phoneA = await phoneOpens(link, null);
    check(await phoneScreen(phoneA) === 'screen-choose', 'MC-16: after scanning, the phone asks: Control the TV or Play on this phone');
    const sizes = await phoneA.evaluate(() => ({ control: document.getElementById('btn-control').getBoundingClientRect().height, play: document.getElementById('btn-play').getBoundingClientRect().height }));
    check(sizes.control > sizes.play, 'MC-16: Control the TV is the bigger (default) button', sizes);
    await phoneA.click('#btn-control');
    const phoneB = await phoneOpens(link, 'control');   // the SAME QR
    const both = await until(game, () => {
      const p = window.__phonePool.pool;
      return p.entries.get(2)?.present && p.entries.get(3)?.present ? { code2: p.entries.get(2).host.room.code, code3: p.entries.get(3).host.room.code } : null;
    });
    check(!!both && both.code2 === both.code3, 'MC-16: two phones scanning the same QR get seats 2 and 3 of one pad room', both);
    const same = await game.evaluate(() => document.getElementById('host-join-qr').value);
    check(same === link, 'MC-16: the QR stays put after phones join');
    const note = await until(phoneA, () => /watch the TV/.test(document.getElementById('status').textContent) && document.getElementById('status').textContent);
    check(!!note, 'MC-16: the joined phone says it is the controller and to watch the TV', note);
    const cand = await until(game, () => {
      const c = window._game.lobby._detectLocalJoinCandidates().filter((x) => x.kind === 'phone').map((x) => x.name);
      return c.length === 2 ? c : null;
    });
    check(!!cand && cand.includes('Phone 2') && cand.includes('Phone 3'), 'MC-16: both phones are join candidates on the host step', cand);
    await tap(phoneA, 'ok');
    const seated = await until(game, () => {
      const l = window._game.lobby;
      return l._localSeatedOnHost && l._localP2InputManager?.remoteOnly ? { name: l._localP2Name, stoker: document.getElementById('host-seat-stoker').who } : null;
    });
    check(!!seated, 'MC-16: OK on the phone seats it as Player 2 (the stoker)', seated);
    const label = await until(phoneA, () => /Player 2/.test(document.getElementById('seat-label').textContent) && document.getElementById('seat-label').textContent);
    check(!!label, 'MC-16: the phone now shows it is Player 2', label);
    const after = await until(game, () => {
      const step = document.getElementById('lobby-host');
      return step.classList.contains('host-join-off') ? { entries: [...window.__phonePool.pool.entries.keys()].sort().join() } : null;
    });
    check(!!after && after.entries === '2,3', 'MC-16: with the partner seat taken the QR goes away and the unused seat closes; joined phones stay', after);
    await h.shot(game, '1-coop-seated');
    await phoneB.browser().close();

    await clickId(game, 'btn-host-local-next');
    await game.waitForFunction(() => document.getElementById('lobby-flow').current === 'lobby-level', { timeout: 15000 }).catch(() => {});
    await clickId(game, 'btn-start-ride');
    await game.waitForFunction(() => window._game.state === 'playing' && window._game.mode === 'local', { timeout: 180000 });
    const mode = await until(game, () => window.__phonePool.pool.mode === 'ride');
    check(mode, 'MC-16: the pool\'s phones switch to riding');
    const ped = await whileHolding(game, phoneA, () => ({ p2: window._game.inputP2.isPressed('ArrowLeft'), p1: window._game.input.isPressed('ArrowLeft') }), (v) => v.p2);
    check(ped.p2 && !ped.p1, 'MC-16: the phone pedals Player 2 only', ped);
    await phoneA.evaluate(() => { window.__tilt = 25; });
    const lean = await until(game, () => { const v = window._game.inputP2.getMotionLean(); return Math.abs(v) > 0.05 ? v : 0; }, null, 15000);
    const p1Lean = await game.evaluate(() => window._game.input.getMotionLean());
    check(Math.abs(lean) > 0.05 && Math.abs(p1Lean) < 0.05, 'MC-16: tilting the phone steers Player 2 only', { p2: lean, p1: p1Lean });

    // The phone drops: the ride pauses and the panel shows its code again.
    await phoneA.close();
    const drop = await until(game, () => {
      const g = window._game, panel = document.getElementById('phone-pool-panel');
      return g._dropWho && g._dropWho() === 'p2' && panel.classList.contains('open')
        ? { title: document.getElementById('ppool-title').textContent, qr: document.getElementById('ppool-qr').dataset.link } : null;
    }, null, 20000);
    check(!!drop && /PHONE 2 DISCONNECTED/.test(drop.title) && /seat=2/.test(drop.qr) && !/seats=/.test(drop.qr), 'MC-16: Phone 2 dropping pauses the ride and shows its own seat\'s code', drop && drop.title);
    await h.shot(game, '2-coop-drop');
    await game.close();
  }

  // ── MC-17 · versus: two phones join one QR, pick teams, leave and rejoin, race ──
  console.log('MC-17 versus: two phones scan one QR');
  {
    const game = await openGame();
    await game.waitForFunction(() => !!window.__phonePool && !!window._game?.lobby, { timeout: 60000 });
    await clickId(game, 'btn-together');
    await game.waitForFunction(() => document.getElementById('lobby-flow').current === 'lobby-role', { timeout: 15000 }).catch(() => {});
    await clickId(game, 'btn-versus');
    await game.waitForFunction(() => document.getElementById('lobby-flow').current === 'lobby-versus', { timeout: 15000 });
    await clickId(game, 'btn-versus-join-phone');
    const link = await until(game, () => { const l = window.__phonePool.pool.joinLink(); return l && document.getElementById('ppool-qr').dataset.link === l ? l : null; }, null, 60000);
    check(!!link && !/play=1/.test(link), 'MC-17: the versus QR is controller only (no Play on this phone)', link);
    const phoneB = await phoneOpens(link, null);
    check(await phoneScreen(phoneB) === 'screen-connect', 'MC-17: a phone scanning it skips the question');
    await phoneB.click('#btn-connect');
    const phoneC = await phoneOpens(link, 'connect');   // the SAME QR
    const both = await until(game, () => window.__phonePool.pool.entries.get(2)?.present && window.__phonePool.pool.entries.get(3)?.present);
    check(both, 'MC-17: two phones scanning the same QR join as Phone 2 and Phone 3');
    const stays = await game.evaluate(() => document.getElementById('ppool-qr').dataset.link);
    check(stays === link, 'MC-17: the panel QR stays put');
    await clickId(game, 'btn-ppool-done');
    const players = () => game.evaluate(() => window._game.lobby._versusPlayers.map((p) => ({ n: p.n, team: p.team, name: p.name, phone: !!p.input?.remoteOnly })));
    await tap(phoneB, 'ok');
    await tap(phoneC, 'ok');
    const v = await until(game, () => window._game.lobby._versusPlayers.filter((p) => p.input?.remoteOnly).length === 2 && true);
    let ps = await players();
    check(v && ps.length === 3 && new Set(ps.map((p) => p.n)).size === 3, 'MC-17: OK on each phone takes a seat as its own player (keyboard P1 + two phones)', ps);
    const roster = await game.evaluate(() => (document.getElementById('versus-roster').rows || []).map((r) => r.name || r.shortName));
    check(roster.filter((n) => /Phone [23]/.test(n)).length === 2, 'MC-17: the roster names the phones', roster);
    // D-pad → on Phone 3 moves it to team B (if it isn't there), ← to A.
    const cTeam = ps.find((p) => p.name === 'Phone 3').team;
    await tap(phoneC, cTeam === 'A' ? 'right' : 'left');
    ps = await players();
    check(ps.find((p) => p.name === 'Phone 3').team !== cTeam, 'MC-17: the phone\'s D-pad switches its team', { before: cTeam, after: ps });
    // BACK leaves the seat; OK rejoins.
    await tap(phoneB, 'back');
    const left = await until(game, () => !window._game.lobby._versusPlayers.some((p) => p.name === 'Phone 2') && window._game.lobby._versusCandidates.some((c) => c.name === 'Phone 2'));
    check(left, 'MC-17: BACK on the phone leaves its seat and it is a candidate again');
    await tap(phoneB, 'ok');
    const back = await until(game, () => window._game.lobby._versusPlayers.some((p) => p.name === 'Phone 2'));
    check(back, 'MC-17: OK on the phone takes a seat again');
    ps = await players();
    // Make the teams valid (2 v 1 or 1 v 2 is fine; all on one side is not).
    if (new Set(ps.map((p) => p.team)).size < 2) await tap(phoneC, ps.find((p) => p.name === 'Phone 3').team === 'A' ? 'right' : 'left');
    await h.shot(game, '3-versus-seated');
    await game.waitForFunction(() => !document.getElementById('btn-versus-continue').disabled, { timeout: 10000 });
    await clickId(game, 'btn-versus-continue');
    await sleep(700);
    await clickId(game, 'btn-start-ride');
    await game.waitForFunction(() => window._game.state === 'playing' && window._game.mode === 'versus', { timeout: 180000 });
    const read = () => {
      const ms = (window._game.versusRigs || []).flatMap((r) => r.members);
      const m = ms.find((x) => x.input && x.input.remoteOnly && window.__phonePool.pool.entryForInput(x.input)?.n === 2);
      const o = ms.find((x) => x.input && x.input.remoteOnly && window.__phonePool.pool.entryForInput(x.input)?.n === 3);
      return { b: !!m && m.input.isPressed('ArrowLeft'), c: !!o && o.input.isPressed('ArrowLeft'), p1: window._game.input.isPressed('ArrowLeft') };
    };
    const vp = await whileHolding(game, phoneB, read, (x) => x.b);
    check(vp.b && !vp.c && !vp.p1, 'MC-17: in the race each phone pedals its own seat', vp);
    await h.shot(game, '4-versus-race');
    await game.close();
  }

  // ── MC-18 · #563 Play on this phone ──
  console.log('MC-18 Play on this phone');
  {
    const game = await openGame();
    await toHostStep(game);
    const link = await hostQr(game);

    // A room that fails to open: the phone says so and offers Control the TV.
    await game.evaluate(() => { const l = window._game.lobby; l.__openRoom = l.openRoomForPhone; l.openRoomForPhone = async () => null; });
    const phoneF = await phoneOpens(link, 'play');
    const failed = await until(phoneF, () => {
      const b = document.getElementById('btn-play-control');
      return !b.hidden ? document.getElementById('play-status').textContent : null;
    });
    check(!!failed && /couldn.t open a room/i.test(failed), 'MC-18: a room that fails: the phone says so and offers Control the TV', failed);
    await phoneF.click('#btn-play-control');
    const ctl = await until(phoneF, () => document.getElementById('screen-ride').classList.contains('on') && /watch the TV|Connected/.test(document.getElementById('status').textContent));
    const ctlTv = await until(game, () => window._game.lobby._detectLocalJoinCandidates().some((c) => c.kind === 'phone'));
    check(ctl && ctlTv, 'MC-18: ...and Control the TV then makes it a controller on the TV');
    await phoneF.browser().close();
    await game.evaluate(() => { const l = window._game.lobby; l.openRoomForPhone = l.__openRoom; });

    // Play: the TV opens the online room only now; the phone lands on its join link.
    check(await game.evaluate(() => !window._game.lobby.net), 'MC-18: no online room before a phone asks');
    const phoneP = await phoneOpens(link, 'play');
    const code = await until(game, () => { const c = document.getElementById('room-code-display').textContent; return /^TNDM-\w{4}$/.test(c) ? c : null; }, null, 30000);
    check(!!code, 'MC-18: the TV opens the RIDE TOGETHER room and shows its code', code);
    const landed = await until(phoneP, () => (document.getElementById('joined') ? location.href : null), null, 30000);
    const url = landed ? new URL(landed) : null;
    check(!!url && url.searchParams.get('room') === code && url.origin === new URL(link).origin, 'MC-18: the phone lands on the game\'s join link with that code', landed);
    // Phone 2 is the earlier phone (now gone); the Play phone took seat 3.
    const freed = await until(game, () => {
      const p = window.__phonePool.pool;
      return p.joinedEntries().map((e) => e.n).join() === '2' && [3, 4].every((n) => p.entries.get(n) && !p.entries.get(n).everJoined);
    }, null, 15000);
    check(freed, 'MC-18: the phone that went to play is not a controller, and its seat goes back on offer');
    const roomOn = await game.evaluate(() => ({ cls: document.getElementById('lobby-host').classList.contains('host-room-open'), btn: document.getElementById('btn-host-room-code').style.display }));
    check(roomOn.cls && roomOn.btn === 'none', 'MC-18: the code shows (to type on another device) and the code button goes', roomOn);
    await h.shot(game, '5-play-room-open');
    await game.close();
  }
} catch (e) {
  check(false, 'crashed: ' + (e && e.message));
}

for (const b of browsers) await b.close().catch(() => {});
killWranglers();
check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
