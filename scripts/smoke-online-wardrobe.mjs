#!/usr/bin/env node
// smoke:online-wardrobe · #672 both online players dress their own goose in the room, over the
// REAL room transport (the relay under `wrangler dev`, as smoke:online runs it).
//
// Pete, Steam playtest 2026-11-07: "I tested Steam-to-Steam and it's a miss. Need to have both
// able to select wardrobe, colors, and controller lights."
//
//   OW-01  host + join; the captain's host step shows the partner's goose on their seat
//   OW-02  on the room's level screen both sides have a WARDROBE; each seat shows its goose
//          (outfit · colours · light swatch)
//   OW-03  the joiner (on a controller) opens the Wardrobe with △ / Y: the captain's screen tags
//          the stoker's seat "dressing…" and says "Partner is still dressing" under START RIDE
//   OW-04  the joiner picks Georgian + a gold light: the captain sees it (seat + _partnerLook)
//          within a second or so; closing (B, B) clears the tag
//   OW-05  the reverse: the captain (mouse) opens WARDROBE, picks Fancy / Royal / green; the
//          stoker sees the tag, then the look; DONE + BACK TO SEATS clears it
//   OW-06  START RIDE never waits for a dressing partner: the joiner is dressing, the captain
//          starts, the joiner's Wardrobe closes and both ride, each partner goose in the look
//          the other picked
//
// Screenshots (1920×1080) go to $TMP/tandemonium-online-wardrobe, or SMOKE_SHOTS_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const ROOT = process.cwd();
const require = createRequire(ROOT + '/package.json');
const puppeteer = require('puppeteer');
const PORT = 8985;
const RELAY_PORT = 8794;
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

const h = await startHarness({ port: PORT, outDir: 'tandemonium-online-wardrobe' });
const { check } = h;
const shotsDir = process.env.SMOKE_SHOTS_DIR || h.out;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
const shot = async (page, name) => { if (!shotsDir) return; await page.bringToFront(); const f = path.join(shotsDir, name + '.png'); await page.screenshot({ path: f }); console.log(`  shot ${f}`); };
const browsers = [h.browser, await puppeteer.launch({ headless: 'new', args: ARGS })];

const configJs = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8')
  .replace(/export const RELAY_URL = '[^']*';/, `export const RELAY_URL = '${RELAY}';`)
  .replace(/export const TURN_CREDENTIALS_URL = '[^']*';/, `export const TURN_CREDENTIALS_URL = 'http://127.0.0.1:${RELAY_PORT}/turn-credentials';`);
if (!configJs.includes(RELAY)) throw new Error('smoke-online-wardrobe: RELAY_URL line not found in js/config.js');

/** One player's page, in its own browser. `pad`: a fake controller at boot (the TV player). */
async function openPlayer(browser, label, { pad = null } = {}) {
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
  await page.goto(`${h.origin}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window._game && !!window._game.lobby, { timeout: 120000 });
  await page.click('#tap-to-start').catch(() => {});
  return page;
}

const waitFor = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const clickId = (page, id) => page.evaluate((i) => { const b = document.getElementById(i); if (!b) return false; b.click(); return true; }, id);
const cardClick = (page, n, sel) => page.evaluate(([k, s]) => { const b = document.querySelector(`#dr-cards .dr-card[data-n="${k}"] ${s}`); if (!b) return false; b.click(); return true; }, [n, sel]);
/** A room bar seat's look line: { hint text, dressing tag shown, led swatch title }. */
const seat = (page, id) => page.evaluate((i) => {
  const e = document.getElementById(i);
  if (!e) return null;
  const tag = e.querySelector('.room-look__dressing');
  const led = e.querySelector('.room-look__led');
  return { state: e.state, who: e.who, text: (e.querySelector('.uf-seat__dev') || {}).textContent || '', look: !!e.querySelector('.room-look'), dressing: !!tag, led: led ? led.title : null };
}, id);
const partnerLook = (page) => page.evaluate(() => { const l = window._game.lobby._partnerLook; return l ? { outfit: l.outfit, colours: l.colours, body: l.body, led: l.led } : null; });

try {
  console.log('room relay (wrangler dev) …');
  if (!(await waitForRelay())) { console.log(wlog.slice(-3000)); throw new Error('room relay did not start'); }

  // ── OW-01 host + join ──
  console.log('OW-01 host + join');
  // Both on controllers (the light row is for pads); the captain still drives with the mouse.
  const cap = await openPlayer(browsers[0], 'captain', { pad: 'dualsense' });
  const sto = await openPlayer(browsers[1], 'stoker', { pad: 'xbox' });
  const pads = fakePads(sto);
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
  const up = await waitFor(cap, () => !!window._game.lobby.net?.connected) && await waitFor(sto, () => !!window._game.lobby.net?.connected);
  check(up, 'OW-01 the stoker joins the captain\'s room over the relay', code);
  // The partner's room profile carries their look: the captain's host step shows it on their seat.
  const hostSeat = await waitFor(cap, () => !!document.querySelector('#host-seat-stoker .room-look') && !!window._game.lobby._partnerLook, null, 30000);
  check(hostSeat, "OW-01 the captain's host step shows the partner's goose on the stoker seat", await seat(cap, 'host-seat-stoker'));
  check(await cap.evaluate(() => !!document.querySelector('#host-seat-captain .room-look')), "OW-01 ...and the captain's own goose on theirs", await seat(cap, 'host-seat-captain'));

  await shot(cap, 'ow-captain-host-step');

  // ── OW-02 the room's level screen ──
  console.log('OW-02 both on the room\'s level screen');
  await clickId(cap, 'btn-host-online-next');
  const bothLevel = await waitFor(cap, () => document.getElementById('lobby-flow').current === 'lobby-level') && await waitFor(sto, () => document.getElementById('lobby-flow').current === 'lobby-level');
  const wardrobeShown = (pg) => pg.evaluate(() => { const r = document.getElementById('level-room-wardrobe'); const b = document.getElementById('btn-room-wardrobe'); return !!r && !r.hidden && !!b && b.getBoundingClientRect().height > 0; });
  await waitFor(cap, () => !document.getElementById('level-room-wardrobe').hidden, null, 10000);
  await waitFor(sto, () => !document.getElementById('level-room-wardrobe').hidden, null, 10000);
  check(bothLevel && await wardrobeShown(cap) && await wardrobeShown(sto), 'OW-02 both sides show a WARDROBE in the room');
  const nav = (pg) => pg.evaluate(() => { const l = window._game.lobby; return (l._stepItems.get(l.levelStep) || []).some((e) => e && e.id === 'btn-room-wardrobe'); });
  check(await nav(cap) && await nav(sto), 'OW-02 the WARDROBE is in the level screen\'s controller focus on both sides');
  const looksOn = await waitFor(cap, () => !!document.querySelector('#level-room-stoker .room-look') && !!document.querySelector('#level-room-captain .room-look'), null, 10000)
    && await waitFor(sto, () => !!document.querySelector('#level-room-captain .room-look') && !!document.querySelector('#level-room-stoker .room-look'), null, 10000);
  check(looksOn, 'OW-02 each screen shows both geese on the room seats (outfit · colours · light)', { cap: await seat(cap, 'level-room-stoker'), sto: await seat(sto, 'level-room-captain') });

  // ── OW-03 / OW-04 the joiner dresses on a controller ──
  console.log('OW-03 / OW-04 the joiner dresses (controller)');
  await waitFor(sto, () => !!window._game.lobby.input?.gamepadConnected, null, 15000);
  await sto.bringToFront();
  await pads.tap(0, 'Y');
  const stoOpen = await waitFor(sto, () => !!window._game.lobby._room && window._game.lobby._room.states()[1] === 'editing', null, 15000);
  check(stoOpen, "OW-03 the joiner's △ / Y opens the Wardrobe on their own card (Edit)", await sto.evaluate(() => window._game.lobby._room && window._game.lobby._room.states()));
  const tagged = await waitFor(cap, () => !!document.querySelector('#level-room-stoker .room-look__dressing') && !document.getElementById('start-dressing-note').hidden, null, 10000);
  check(tagged, 'OW-03 the captain sees "dressing…" on the stoker seat and "Partner is still dressing" by START RIDE', await seat(cap, 'level-room-stoker'));
  check(await cap.evaluate(() => !document.getElementById('btn-start-ride').disabled), 'OW-03 START RIDE stays available while the partner dresses');
  await cardClick(sto, 1, 'button[data-pick="outfit"][data-val="georgian"]');
  await cardClick(sto, 1, 'button[data-pick="led"][data-val="gold"]');
  const t0 = Date.now();
  const seen = await waitFor(cap, () => { const l = window._game.lobby._partnerLook; return !!l && l.outfit === 'georgian' && l.led === 'gold' && /Georgian/.test(document.getElementById('level-room-stoker').textContent); }, null, 10000);
  const ms = Date.now() - t0;
  check(seen, `OW-04 the captain sees the joiner's Georgian + gold light on the stoker seat (${ms} ms)`, { look: await partnerLook(cap), seat: await seat(cap, 'level-room-stoker') });
  check(seen && ms < 2500, 'OW-04 ...within about a second (under 2.5 s on a headless box)', { ms });
  check(await cap.evaluate(() => window._game._partnerLook && window._game._partnerLook.outfit === 'georgian'), "OW-04 the captain's game holds it for the partner's goose", await cap.evaluate(() => window._game._partnerLook));
  await shot(cap, 'ow-captain-room-partner-dressing');
  await shot(sto, 'ow-stoker-wardrobe-open');
  await sto.bringToFront();
  await pads.tap(0, 'B');
  await waitFor(sto, () => !window._game.lobby._room || window._game.lobby._room.states()[1] === 'ready', null, 5000);
  await pads.tap(0, 'B');
  const stoClosed = await waitFor(sto, () => !window._game.lobby._room, null, 5000);
  const cleared = await waitFor(cap, () => !document.querySelector('#level-room-stoker .room-look__dressing') && document.getElementById('start-dressing-note').hidden, null, 10000);
  check(stoClosed && cleared, 'OW-04 B, B closes the joiner\'s Wardrobe; the captain\'s "dressing…" tag and START note clear', { stoClosed, seat: await seat(cap, 'level-room-stoker') });
  check(await sto.evaluate(() => document.getElementById('lobby-flow').current === 'lobby-level' && !!window._game.lobby.net?.connected), 'OW-04 the joiner is back on the room screen, still connected');
  check(await sto.evaluate(() => /Georgian/.test(document.getElementById('level-room-stoker').textContent)), "OW-04 the joiner's own seat shows their new goose", await seat(sto, 'level-room-stoker'));

  // ── OW-05 the reverse: the captain dresses with the mouse ──
  console.log('OW-05 the captain dresses (mouse)');
  await cap.bringToFront();
  await waitFor(cap, () => !!window._game.lobby.input?.gamepadConnected, null, 15000);
  await clickId(cap, 'btn-room-wardrobe');
  const capOpen = await waitFor(cap, () => !!window._game.lobby._room && window._game.lobby._room.states()[1] === 'editing', null, 15000);
  check(capOpen, "OW-05 the captain's WARDROBE click opens the Wardrobe on their card");
  const stoTag = await waitFor(sto, () => !!document.querySelector('#level-room-captain .room-look__dressing'), null, 10000);
  check(stoTag, 'OW-05 the joiner sees "dressing…" on the captain seat', await seat(sto, 'level-room-captain'));
  check(await sto.evaluate(() => document.getElementById('start-dressing-note').hidden), 'OW-05 the joiner (no START RIDE) gets no START note');
  await cardClick(cap, 1, 'button[data-pick="outfit"][data-val="fancy"]');
  await cardClick(cap, 1, 'button[data-pick="colourway"][data-val="f_royal"]');
  await cardClick(cap, 1, 'button[data-pick="led"][data-val="green"]');
  const stoSeen = await waitFor(sto, () => { const l = window._game.lobby._partnerLook; return !!l && l.outfit === 'fancy' && l.colours.fancy === 'f_royal' && l.led === 'green' && /Fancy · Royal/.test(document.getElementById('level-room-captain').textContent); }, null, 10000);
  check(stoSeen, "OW-05 the joiner sees the captain's Fancy / Royal / green light", { look: await partnerLook(sto), seat: await seat(sto, 'level-room-captain') });
  await cardClick(cap, 1, 'button[data-act="done"]');
  await waitFor(cap, () => window._game.lobby._room && window._game.lobby._room.states()[1] === 'ready', null, 5000);
  await clickId(cap, 'dr-back');
  const capClosed = await waitFor(cap, () => !window._game.lobby._room, null, 5000);
  const stoCleared = await waitFor(sto, () => !document.querySelector('#level-room-captain .room-look__dressing'), null, 10000);
  check(capClosed && stoCleared, "OW-05 DONE + BACK TO SEATS closes it; the joiner's tag clears", await seat(sto, 'level-room-captain'));
  await shot(sto, 'ow-stoker-room');
  await shot(cap, 'ow-captain-room');

  // ── OW-06 START RIDE doesn't wait for a dressing partner ──
  console.log('OW-06 the captain starts while the joiner dresses');
  await sto.bringToFront();
  await pads.tap(0, 'Y');
  await waitFor(sto, () => !!window._game.lobby._room, null, 15000);
  await waitFor(cap, () => !document.getElementById('start-dressing-note').hidden, null, 10000);
  await cap.bringToFront();
  await cap.waitForFunction(() => !!document.querySelector('#level-cards .level-card[data-level-id="grandma"]'), { timeout: 30000 });
  await cap.evaluate(() => document.querySelector('#level-cards .level-card[data-level-id="grandma"]').click());
  await waitFor(cap, () => !document.getElementById('btn-start-ride').disabled, null, 10000);
  await clickId(cap, 'btn-start-ride');
  const capRide = await waitFor(cap, () => window._game.state === 'playing', null, 180000);
  const stoRide = await waitFor(sto, () => window._game.state === 'playing', null, 180000);
  const stoRoomGone = await sto.evaluate(() => !window._game.lobby._room && !document.getElementById('dressing-room').open);
  check(capRide && stoRide && stoRoomGone, "OW-06 the captain's START RIDE doesn't wait: the joiner's Wardrobe closes and both ride", { capRide, stoRide, stoRoomGone });
  const ride = (pg) => pg.evaluate(() => ({ mode: window._game.mode, partner: window._game._partnerLook && { outfit: window._game._partnerLook.outfit, colours: window._game._partnerLook.colours }, riders: window._game._riderLooksKey }));
  const cr = await ride(cap), sr = await ride(sto);
  check(cr.mode === 'captain' && cr.partner && cr.partner.outfit === 'georgian', "OW-06 the captain's stoker goose wears the joiner's Georgian", cr);
  check(sr.mode === 'stoker' && sr.partner && sr.partner.outfit === 'fancy' && sr.partner.colours.fancy === 'f_royal', "OW-06 the joiner's captain goose wears the captain's Fancy / Royal", sr);
  await cap.close(); await sto.close();
} catch (e) {
  check(false, 'smoke crashed: ' + (e && e.stack || e));
}

check(h.errors.length === 0, 'no page errors', h.errors);
await browsers[1].close().catch(() => {});
killWrangler();
await h.finish();
