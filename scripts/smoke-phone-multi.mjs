#!/usr/bin/env node
// smoke:phone-multi · several phones as controllers on one screen (#562).
//
//   MC-16  co-op: "Join with phone" on the host step; a phone scans and joins
//          as Phone 2 (the QR moves on to Phone 3), presses OK and is seated as
//          Player 2. In the ride it pedals and steers Player 2's seat only. It
//          dropping mid-ride pauses the ride and shows its code again.
//   MC-17  versus: two phones join from the versus screen, take seats with OK,
//          D-pad → switches team, BACK leaves the seat and OK rejoins; in the
//          race each phone pedals its own seat.
//
// Real pad relay under `wrangler dev` (port 8794), the game on the shared
// harness (port 8996) with no pads (keyboard Player 1), each phone page in
// its own browser (a background tab would be throttled).
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { startHarness, sleep, clickId } from './lib/smoke-harness.mjs';

const ROOT = process.cwd();
const require = createRequire(ROOT + '/package.json');
const puppeteer = require('puppeteer');
const RELAY_PORT = 8794;
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;

// ── pad relay under wrangler dev ──
const wrangler = spawn(`npx wrangler dev --config worker/wrangler-pad.toml --port ${RELAY_PORT} --ip 127.0.0.1 --persist-to "${path.join(os.tmpdir(), 'tandemonium-smoke-phone-multi')}" --show-interactive-dev-session=false`,
  { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
let wlog = '';
wrangler.stdout.on('data', (d) => { wlog += d; });
wrangler.stderr.on('data', (d) => { wlog += d; });
const killWrangler = () => {
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${wrangler.pid} /T /F`, { stdio: 'ignore' });
    else wrangler.kill('SIGTERM');
  } catch { /* gone */ }
};
process.on('exit', killWrangler);
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try { up = (await fetch(`http://127.0.0.1:${RELAY_PORT}/`)).ok; } catch { /* not yet */ }
  if (!up) await sleep(500);
}
if (!up) { console.log(wlog.slice(-2000)); killWrangler(); throw new Error('pad relay did not start'); }

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

/** Open `link` on a new phone (its own browser) and connect, with stand-in tilt. */
async function phoneJoins(link) {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--mute-audio'] });
  browsers.push(b);
  const phone = await b.newPage();
  await phone.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: false });
  // The harness serves index.html only for "/", so name the phone page's file.
  await phone.goto(link.replace('/remote/?', '/remote/index.html?'), { waitUntil: 'domcontentloaded' });
  await phone.click('#btn-connect');
  await phone.evaluate(() => {
    window.__tilt = 0;
    setInterval(() => { const e = new Event('deviceorientation'); Object.assign(e, { alpha: 0, beta: 5, gamma: window.__tilt }); window.dispatchEvent(e); }, 16);
  });
  return phone;
}

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
});

/** The pool's offered QR: wait until its room is open, return its phone number and link. */
const offered = (game) => until(game, () => {
  const p = window.__phonePool.pool.pending;
  return p && p.status === 'waiting' && p.link ? { n: p.n, link: p.link } : null;
}, null, 60000);

try {
  // ── MC-16 · co-op: Player 2 on a phone ──
  console.log('MC-16 co-op with a phone as Player 2');
  {
    const game = await openGame();
    await game.waitForFunction(() => !!window.__phonePool && !!window._game?.lobby, { timeout: 60000 });
    await game.evaluate(() => {
      const l = window._game.lobby;
      document.getElementById('room-code-display').textContent = 'TNDM-LOCL';
      l._pendingMode = 'multiplayer'; l._roomRole = 'captain';
      l._showStep(l.hostStep); l._refreshHostNext();
    });
    const shown = await until(game, () => { const b = document.getElementById('btn-host-join-phone'); return !!b && b.offsetParent !== null; });
    check(shown, 'MC-16: the co-op host step shows "Join with phone"');
    await clickId(game, 'btn-host-join-phone');
    const first = await offered(game);
    check(first && first.n === 2, 'MC-16: the panel offers a QR for Phone 2', first);
    const words = await game.evaluate(() => ({
      button: document.getElementById('btn-host-join-phone').textContent.trim(),
      caption: document.getElementById('ppool-caption').textContent,
      roomQr: getComputedStyle(document.getElementById('room-qr-tv')).visibility,
    }));
    check(/phone as a controller/i.test(words.button) && /game stays on this screen/.test(words.caption),
      'MC-16: the controller QR says the game stays on this screen', words);
    check(words.roomQr === 'hidden', 'MC-16: the online room QR is hidden while the controller QR is up', words);
    const phoneA = await phoneJoins(first.link);
    const note = await until(phoneA, () => /watch the TV/.test(document.getElementById('status').textContent) && document.getElementById('status').textContent);
    check(!!note, 'MC-16: the joined phone says it is the controller and to watch the TV', note);
    const moved = await until(game, () => {
      const p = window.__phonePool.pool;
      return p.entries.get(2)?.present && p.pending && p.pending.n === 3 ? { pending: p.pending.n, chips: document.getElementById('ppool-phones').textContent } : null;
    });
    check(!!moved && /Phone 2/.test(moved.chips), 'MC-16: Phone 2 joins and the QR moves on to Phone 3', moved);
    const cand = await until(game, () => window._game.lobby._detectLocalJoinCandidates().some((c) => c.kind === 'phone' && c.name === 'Phone 2'));
    check(cand, 'MC-16: Phone 2 is a join candidate on the host step');
    await tap(phoneA, 'ok');
    const seated = await until(game, () => {
      const l = window._game.lobby;
      return l._localSeatedOnHost && l._localP2InputManager?.remoteOnly ? { name: l._localP2Name, stoker: document.getElementById('host-seat-stoker').who } : null;
    });
    check(!!seated, 'MC-16: OK on the phone seats it as Player 2 (the stoker)', seated);
    const label = await until(phoneA, () => /Player 2/.test(document.getElementById('seat-label').textContent) && document.getElementById('seat-label').textContent);
    check(!!label, 'MC-16: the phone now shows it is Player 2', label);
    await clickId(game, 'btn-ppool-done');
    await game.waitForFunction(() => !window.__phonePool.panelOpen, { timeout: 10000 });
    const unjoined = await game.evaluate(() => ({ pending: window.__phonePool.pool.pending, entries: [...window.__phonePool.pool.entries.keys()] }));
    check(!unjoined.pending && unjoined.entries.join() === '2', 'MC-16: closing the panel closes Phone 3\'s unused room; Phone 2 stays', unjoined);
    await h.shot(game, '1-coop-seated');

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
      return g._dropWho && g._dropWho() === 'p2' && panel.classList.contains('open') ? { title: document.getElementById('ppool-title').textContent } : null;
    }, null, 20000);
    check(!!drop && /PHONE 2 DISCONNECTED/.test(drop.title), 'MC-16: Phone 2 dropping pauses the ride and shows its code', drop);
    await h.shot(game, '2-coop-drop');
    await game.close();
  }

  // ── MC-17 · versus: two phones join, pick teams, leave and rejoin, race ──
  console.log('MC-17 versus with two phones');
  {
    const game = await openGame();
    await game.waitForFunction(() => !!window.__phonePool && !!window._game?.lobby, { timeout: 60000 });
    await clickId(game, 'btn-together');
    await game.waitForFunction(() => document.getElementById('lobby-flow').current === 'lobby-role', { timeout: 15000 }).catch(() => {});
    await clickId(game, 'btn-versus');
    await game.waitForFunction(() => document.getElementById('lobby-flow').current === 'lobby-versus', { timeout: 15000 });
    await clickId(game, 'btn-versus-join-phone');
    const a = await offered(game);
    const phoneB = await phoneJoins(a.link);
    const b = await until(game, () => {
      const p = window.__phonePool.pool.pending;
      return window.__phonePool.pool.entries.get(2)?.present && p && p.n === 3 && p.status === 'waiting' && p.link ? { n: p.n, link: p.link } : null;
    }, null, 60000);
    check(a.n === 2 && b && b.n === 3, 'MC-17: Phone 2 joins, then the QR offers Phone 3', { a: a.n, b: b && b.n });
    const phoneC = await phoneJoins(b.link);
    await until(game, () => window.__phonePool.pool.entries.get(3)?.present);
    await clickId(game, 'btn-ppool-done');
    const players = () => game.evaluate(() => window._game.lobby._versusPlayers.map((p) => ({ n: p.n, team: p.team, name: p.name, phone: !!p.input?.remoteOnly })));
    await tap(phoneB, 'ok');
    await tap(phoneC, 'ok');
    let v = await until(game, () => window._game.lobby._versusPlayers.filter((p) => p.input?.remoteOnly).length === 2 && true);
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
} catch (e) {
  check(false, 'crashed: ' + (e && e.message));
}

for (const b of browsers) await b.close().catch(() => {});
killWrangler();
check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
