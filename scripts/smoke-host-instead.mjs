#!/usr/bin/env node
// smoke:host-instead · #667 a full-game owner in a demo player's room can HOST INSTEAD, over the
// REAL room transport (the relay under `wrangler dev`, as smoke:online runs it).
//
//   HI-01  a demo host + a full guest: both see a "Demo room"; the full guest's room screen shows
//          the line + HOST INSTEAD (in its controller focus, focused on a pad); the demo host
//          sees neither
//   HI-02  A on HOST INSTEAD (no accept step): a new room code, the full owner is the captain,
//          the demo player rejoined automatically as the stoker, both connected on level select
//   HI-03  both now call it a "Full game room"; the button is gone; the demo's Daily Ride gate is
//          gone and the new captain's pick of it reaches the demo player; recent rooms: old code gone
//   HI-04  seats carry over: each screen keeps its own controller, its phone pad room (same
//          object, same code) and its partner's name on the room seats
//   HI-05  an older demo build (no 'rehost' cap) never gets the button, even in a Demo room
//   HI-06  the follow fails (the demo host never arrives): the full guest stays in the old room,
//          still connected, with a toast, never stranded
//
// Screenshots (1920×1080): hi-*.png in $TMP/tandemonium-host-instead, or SMOKE_SHOTS_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const ROOT = process.cwd();
const require = createRequire(ROOT + '/package.json');
const puppeteer = require('puppeteer');
const PORT = 8987;
const RELAY_PORT = 8796;
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
const ARGS = ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'];
const VIEW = { width: 1920, height: 1080 };

// ── room relay under wrangler dev ──
const wrangler = spawn('npx', ['wrangler', 'dev', '--config', 'worker/wrangler.toml', '--port', String(RELAY_PORT), '--ip', '127.0.0.1', '--show-interactive-dev-session=false'],
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
async function waitForRelay() {
  for (let i = 0; i < 180; i++) {
    try { const r = await fetch(`http://127.0.0.1:${RELAY_PORT}/`); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}

const h = await startHarness({ port: PORT, outDir: 'tandemonium-host-instead' });
const { check } = h;
const shotsDir = process.env.SMOKE_SHOTS_DIR || h.out;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
const shot = async (page, name) => { if (!shotsDir) return; await page.bringToFront(); const f = path.join(shotsDir, name + '.png'); await page.screenshot({ path: f }); console.log(`  shot ${f}`); };
const browsers = [h.browser, await puppeteer.launch({ headless: 'new', args: ARGS })];

const configJs = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8')
  .replace(/export const RELAY_URL = '[^']*';/, `export const RELAY_URL = '${RELAY}';`)
  .replace(/export const TURN_CREDENTIALS_URL = '[^']*';/, `export const TURN_CREDENTIALS_URL = 'http://127.0.0.1:${RELAY_PORT}/turn-credentials';`);
if (!configJs.includes(RELAY)) throw new Error('smoke-host-instead: RELAY_URL line not found in js/config.js');

/** One player's page, in its own browser. */
async function openPlayer(browser, label, { query = '', pad = null } = {}) {
  const page = await browser.newPage();
  await page.setViewport(VIEW);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith(h.origin)) {
      if (new URL(u).pathname === '/js/config.js') return req.respond({ status: 200, contentType: 'text/javascript', body: configJs });
      return req.continue();
    }
    if (u.startsWith('data:') || u.startsWith('blob:')) return req.continue();
    if (u.startsWith(`http://127.0.0.1:${RELAY_PORT}`)) return req.continue();
    let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
    if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')) });
    m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/);
    const f = m && path.join(ROOT, 'node_modules/three/examples/jsm/' + m[1]);
    if (f && fs.existsSync(f)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
    return req.abort();
  });
  page.on('pageerror', (e) => { h.errors.push(`${label}: ${e.message}`); console.log(`  PAGEERROR (${label}):`, e.message); });
  const seed = { tandemonium_started: '1', tandemonium_tutorial_done: 'smoke' };
  await page.evaluateOnNewDocument((s) => { try { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } catch {} }, seed);
  if (pad) await installFakeGamepads(page, { atBoot: [pad] });
  await page.goto(`${h.origin}/index.html${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window._game && !!window._game.lobby, { timeout: 120000 });
  await page.click('#tap-to-start').catch(() => {});
  return page;
}

const waitFor = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, { timeout, polling: 100 }, arg).then(() => true, () => false);
const clickId = (page, id) => page.evaluate((i) => { const b = document.getElementById(i); if (!b) return false; b.click(); return true; }, id);
/** The room as one side sees it. */
const room = (page) => page.evaluate(() => {
  const l = window._game.lobby, n = l.net;
  const row = document.getElementById('level-room-rehost'), btn = document.getElementById('btn-host-instead');
  const team = document.getElementById('level-room-team');
  return {
    code: n ? n.roomCode : null, role: l._roomRole, netRole: n ? n.role : null, connected: !!(n && n.connected),
    step: document.getElementById('lobby-flow')?.current || null,
    badge: team ? team.dataset.roomBadge || '' : '',
    offer: !!row && !row.hidden && !!btn && !btn.hidden && btn.getBoundingClientRect().height > 0,
    line: row && !row.hidden ? document.getElementById('level-room-rehost-line').textContent : '',
    partner: l._roomPartnerName || null,
    move: l._lastRoomMove || null,
  };
});
/** Host + join, both on the room's level screen. Returns { cap, sto, code }. */
async function pair(capOpts, stoOpts, before = null) {
  const cap = await openPlayer(browsers[0], 'host', capOpts);
  const sto = await openPlayer(browsers[1], 'guest', stoOpts);
  if (before) await before(cap, sto);
  await clickId(cap, 'btn-together');
  await waitFor(cap, () => document.getElementById('lobby-flow').current === 'lobby-role');
  await clickId(cap, 'btn-captain');
  await waitFor(cap, () => document.getElementById('lobby-flow').current === 'lobby-host');
  await clickId(cap, 'btn-host-room-code');
  await waitFor(cap, () => /^TNDM-\w{4}$/.test(document.getElementById('room-code-display')?.textContent || ''));
  const code = await cap.evaluate(() => document.getElementById('room-code-display').textContent);
  await clickId(sto, 'btn-together');
  await waitFor(sto, () => document.getElementById('lobby-flow').current === 'lobby-role');
  await clickId(sto, 'btn-stoker');
  await waitFor(sto, () => document.getElementById('lobby-flow').current === 'lobby-join');
  await sto.evaluate((c) => { document.getElementById('room-code-input').value = c.slice(-4); document.getElementById('btn-join').click(); }, code);
  await waitFor(cap, () => !!window._game.lobby.net?.connected);
  await waitFor(sto, () => !!window._game.lobby.net?.connected);
  await waitFor(cap, () => !document.getElementById('btn-host-online-next')?.disabled, null, 30000);
  await clickId(cap, 'btn-host-online-next');
  await waitFor(cap, () => document.getElementById('lobby-flow').current === 'lobby-level');
  await waitFor(sto, () => document.getElementById('lobby-flow').current === 'lobby-level');
  // Both room profiles heard (the badge comes from the host's edition).
  await waitFor(cap, () => !!window._game.lobby._partnerRoom, null, 30000);
  await waitFor(sto, () => !!window._game.lobby._partnerRoom, null, 30000);
  return { cap, sto, code };
}
const seats = (page) => page.evaluate(() => {
  const g = window._game, l = g.lobby;
  const pad = g.phonePad || null;
  window.__hiInput = window.__hiInput || l.input;
  return {
    sameInput: window.__hiInput === l.input, pads: (navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean).length : 0),
    padRoom: pad ? (window.__hiPad = window.__hiPad || pad) === pad : null, padCode: pad ? pad.code : null,
    captainSeat: document.getElementById('level-room-captain')?.who || null, stokerSeat: document.getElementById('level-room-stoker')?.who || null,
  };
});

try {
  console.log('room relay (wrangler dev) …');
  if (!(await waitForRelay())) { console.log(wlog.slice(-3000)); throw new Error('room relay did not start'); }

  // ── HI-01 a demo host + a full guest ──
  console.log('HI-01 demo host + full guest');
  {
    const { cap, sto, code } = await pair({ query: '?demo=1' }, { pad: 'xbox' });
    const demoBadges = await waitFor(sto, () => document.getElementById('level-room-team')?.dataset.roomBadge === 'Demo room', null, 15000)
      && await waitFor(cap, () => document.getElementById('level-room-team')?.dataset.roomBadge === 'Demo room', null, 15000);
    await waitFor(sto, () => { const b = document.getElementById('btn-host-instead'); return !!b && !b.hidden && b.getBoundingClientRect().height > 0; }, null, 15000);
    const s0 = await room(sto), c0 = await room(cap);
    check(demoBadges && s0.badge === 'Demo room' && c0.badge === 'Demo room', 'HI-01 a demo host\'s room is a "Demo room" on both screens', { cap: c0.badge, sto: s0.badge });
    check(s0.offer && /Your friend has the demo\. Host the room yourself to unlock every level and Versus\. They can still join free\./.test(s0.line),
      'HI-01 the full guest sees the line and HOST INSTEAD', s0);
    check(!c0.offer && !c0.line, 'HI-01 the demo host sees neither', c0);
    const nav = await sto.evaluate(() => { const l = window._game.lobby; return (l._stepItems.get(l.levelStep) || []).some((e) => e && e.id === 'btn-host-instead'); });
    await waitFor(sto, () => !!window._game.lobby.input?.gamepadConnected, null, 15000);
    const focused = await waitFor(sto, () => window._game.lobby._stepFocus.focusedEl?.id === 'btn-host-instead', null, 10000);
    check(nav && focused, 'HI-01 HOST INSTEAD is in the controller focus, and focused on a pad', { nav, focused: await sto.evaluate(() => window._game.lobby._stepFocus.focusedEl?.id || null) });
    await shot(sto, 'hi-guest-room-host-instead');
    await shot(cap, 'hi-host-demo-room');
    const before = { cap: await seats(cap), sto: await seats(sto) };
    const dailyBefore = await sto.evaluate(() => document.querySelector('#level-cards .level-card[data-level-id="daily"]')?.textContent || '');

    // ── HI-02 A on HOST INSTEAD ──
    console.log('HI-02 HOST INSTEAD');
    await sto.bringToFront();
    await fakePads(sto).tap(0, 'A');
    const moved = await waitFor(sto, () => !!window._game.lobby._lastRoomMove, null, 30000);
    await waitFor(cap, () => !!window._game.lobby._lastRoomMove, null, 30000);
    await waitFor(sto, () => document.getElementById('lobby-flow').current === 'lobby-level' && !!window._game.lobby.net?.connected, null, 15000);
    await waitFor(cap, () => document.getElementById('lobby-flow').current === 'lobby-level' && !!window._game.lobby.net?.connected, null, 15000);
    const s1 = await room(sto), c1 = await room(cap);
    check(moved && s1.move?.ok && s1.code && s1.code !== code && /^TNDM-\w{4}$/.test(s1.code), 'HI-02 a new room code', { old: code, sto: s1 });
    check(s1.role === 'captain' && s1.netRole === 'captain' && s1.connected, 'HI-02 the full owner is the captain (the host)', s1);
    check(c1.move?.ok && c1.code === s1.code && c1.role === 'stoker' && c1.netRole === 'stoker' && c1.connected, 'HI-02 the demo player rejoined automatically as the stoker', c1);
    check(s1.step === 'lobby-level' && c1.step === 'lobby-level', 'HI-02 both on the room\'s level screen', { cap: c1.step, sto: s1.step });

    // ── HI-03 a Full game room ──
    console.log('HI-03 Full game room');
    const full = await waitFor(sto, () => document.getElementById('level-room-team')?.dataset.roomBadge === 'Full game room', null, 10000)
      && await waitFor(cap, () => document.getElementById('level-room-team')?.dataset.roomBadge === 'Full game room', null, 10000);
    const s2 = await room(sto), c2 = await room(cap);
    check(full && s2.badge === 'Full game room' && c2.badge === 'Full game room', 'HI-03 badge now "Full game room" on both screens', { cap: c2.badge, sto: s2.badge });
    check(!s2.offer && !c2.offer, 'HI-03 HOST INSTEAD is gone', { cap: c2, sto: s2 });
    // The demo's Daily Ride gate (finish Tutorial + Grandma's first) was on in the Demo room; in
    // the new host's Full game room it is open, and the pick reaches the demo player (no refusal).
    const dailyText = (pg) => pg.evaluate(() => document.querySelector('#level-cards .level-card[data-level-id="daily"]')?.textContent || '');
    const dailyAfter = await dailyText(sto);
    const picked = await sto.evaluate(() => { const c = document.querySelector('#level-cards .level-card[data-level-id="daily"]'); if (!c) return false; c.click(); return true; });
    const synced = picked && await waitFor(cap, () => window._game.lobby.selectedLevel?.isDaily && window._game.lobby._refusedLevelId == null, null, 10000);
    check(/Finish the Tutorial/.test(dailyBefore) && !/Finish the Tutorial/.test(dailyAfter) && synced,
      "HI-03 the demo's Daily Ride gate is gone in the Full game room; the new host picks it and the demo player takes it (no refusal)",
      { dailyBefore: dailyBefore.slice(0, 90), dailyAfter: dailyAfter.slice(0, 90), capLevel: await cap.evaluate(() => window._game.lobby.selectedLevel?.id), refused: await cap.evaluate(() => window._game.lobby._refusedLevelId) });
    const stores = { cap: await cap.evaluate(() => JSON.parse(localStorage.getItem('tandemonium-rooms') || '[]').map((r) => r.roomCode + ':' + r.role)),
      sto: await sto.evaluate(() => JSON.parse(localStorage.getItem('tandemonium-rooms') || '[]').map((r) => r.roomCode + ':' + r.role)) };
    check(!stores.cap.some((r) => r.startsWith(code)) && stores.cap.includes(s1.code + ':stoker') && !stores.sto.some((r) => r.startsWith(code)) && stores.sto.includes(s1.code + ':captain'),
      'HI-03 recent rooms: the old code gone, the new one saved in each new seat (rejoin goes to the right room)', stores);

    // ── HI-04 seats carry over ──
    const after = { cap: await seats(cap), sto: await seats(sto) };
    check(after.sto.sameInput && after.cap.sameInput && after.sto.pads === before.sto.pads && after.sto.padRoom !== false && after.cap.padRoom !== false &&
      after.sto.padCode === before.sto.padCode && after.cap.padCode === before.cap.padCode,
      'HI-04 each screen keeps its controller and its phone pad room (phones stay seated: the pad room never moves)', { before, after });
    check(!!c2.partner && !!s2.partner && c2.partner === (await room(cap)).partner && after.sto.captainSeat && after.sto.stokerSeat && after.sto.stokerSeat !== 'Waiting for partner…',
      'HI-04 both room seats filled on the new host\'s screen (the partner carried over)', { capPartner: c2.partner, stoPartner: s2.partner, seats: after.sto });
    await shot(sto, 'hi-new-host-full-room');
    await shot(cap, 'hi-demo-player-followed');
    await cap.close(); await sto.close();
  }

  // ── HI-05 an older demo build: no 'rehost' cap ──
  console.log('HI-05 older demo build');
  {
    const { cap, sto } = await pair({ query: '?demo=1' }, {}, async (c) => {
      await c.evaluate(() => {
        const l = window._game.lobby, orig = l.roomProfileFields.bind(l);
        l.roomProfileFields = () => { const f = orig(); return { ...f, caps: f.caps.filter((x) => x !== 'rehost') }; };
      });
    });
    const demo = await waitFor(sto, () => document.getElementById('level-room-team')?.dataset.roomBadge === 'Demo room', null, 15000);
    await sleep(1500);   // give the row its chance to (wrongly) appear
    const s = await room(sto);
    check(demo && s.badge === 'Demo room' && !s.offer && !s.line, 'HI-05 an older demo host (no rehost cap): a Demo room, and no HOST INSTEAD', s);
    await cap.close(); await sto.close();
  }

  // ── HI-06 the follow fails: never stranded ──
  console.log('HI-06 the demo host never follows');
  {
    const { cap, sto, code } = await pair({ query: '?demo=1' }, {});
    // This demo host drops the move message (as if lost), so it never arrives in the new room.
    await cap.evaluate(() => { const l = window._game.lobby; l._followRoomMove = () => {}; });
    await sto.evaluate(async () => {
      const m = await import('./js/lobby/room-move.js');
      window.__hiT = Date.now();
      // Short timeouts for the smoke: the real ones are seconds longer.
      const Orig = m.RoomMove;
      window._game.lobby.__moveTimeouts = { open: 8000, connect: 3000 };
      const run = Orig.prototype.run;
      Orig.prototype.run = function () { this._t = { ...this._t, ...window._game.lobby.__moveTimeouts }; return run.call(this); };
    });
    await waitFor(sto, () => { const b = document.getElementById('btn-host-instead'); return !!b && !b.hidden; }, null, 15000);
    await clickId(sto, 'btn-host-instead');
    const gaveUp = await waitFor(sto, () => window._game.lobby._lastRoomMove && window._game.lobby._lastRoomMove.ok === false, null, 30000);
    const s = await room(sto), c = await room(cap);
    const toast = await sto.evaluate(() => document.body.innerText.includes('The room didn’t move'));
    check(gaveUp && s.code === code && s.role === 'stoker' && s.connected && c.code === code && c.connected && c.role === 'captain',
      'HI-06 the follow fails: both still in the old room, connected, same seats', { cap: c, sto: s });
    check(toast, 'HI-06 the full guest is told the room didn\'t move');
    check(s.offer, 'HI-06 HOST INSTEAD is offered again', s);
    await cap.close(); await sto.close();
  }
} catch (e) {
  check(false, 'smoke crashed: ' + (e && e.stack || e));
}

check(h.errors.length === 0, 'no page errors', h.errors);
await browsers[1].close().catch(() => {});
killWrangler();
await h.finish();
