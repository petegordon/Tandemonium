#!/usr/bin/env node
// smoke:online-replay · online co-op restarts and pauses over the REAL room transport
// (the relay under `wrangler dev`, as smoke:online runs it).
//
// Pete, 2026-11-08: "The stoker is presented with the same ending screen as the captain and
// clicking RIDE AGAIN doesn't start the ride again — it tries to start at the end (at Grandma's)."
// "If the captain pauses during the ride … it doesn't communicate to the stoker that it is
// paused." "When I (captain) clicked RESTART on a too slow checkpoint, the stoker didn't go back
// to the start until a delayed response."
//
//   ORP-01  the captain's TOO SLOW → RESTART: the stoker is back on the start line, counting
//           down, within a second
//   ORP-02  both finish; the STOKER presses PLAY AGAIN: both ride again from the start line
//           (not from the last checkpoint at Grandma's)
//   ORP-03  both finish; the CAPTAIN presses PLAY AGAIN: same
//   ORP-04  the captain pauses: the stoker's screen says the captain paused the ride and its
//           clock stops; the captain resumes: the notice goes and both ride on
//   ORP-06  the stoker pauses: the captain's ride stops and its screen says the stoker paused;
//           both pause at once: whoever resumes first waits on the other, then both ride on
//   ORP-05  back in the room after a ride: the stoker's ROAD AHEAD panel is gone; a rebuild of the
//           level list (sign-in, a controller or gyro coming on) keeps the ROOM's list on both
//           screens (no Slingshot, the stoker can't pick) and the stoker keeps the captain's pick
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startHarness, sleep } from './lib/smoke-harness.mjs';

const ROOT = process.cwd();
const require = createRequire(ROOT + '/package.json');
const puppeteer = require('puppeteer');
const PORT = 8987;
const RELAY_PORT = 8792;
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
const ARGS = ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'];

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

const h = await startHarness({ port: PORT, outDir: 'tandemonium-online-replay' });
const { check } = h;
const known = (ok, name, detail) => console.log(`  ${ok ? 'FIXED (make this a check)' : 'KNOWN BUG'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
const browsers = [h.browser, await puppeteer.launch({ headless: 'new', args: ARGS })];

// js/config.js with RELAY_URL pointed at the local relay (and TURN at it too,
// where it 502s harmlessly instead of reaching Cloudflare).
const configJs = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8')
  .replace(/export const RELAY_URL = '[^']*';/, `export const RELAY_URL = '${RELAY}';`)
  .replace(/export const TURN_CREDENTIALS_URL = '[^']*';/, `export const TURN_CREDENTIALS_URL = 'http://127.0.0.1:${RELAY_PORT}/turn-credentials';`);
if (!configJs.includes(RELAY)) throw new Error('smoke-online: RELAY_URL line not found in js/config.js');

/** One player's page, in its own browser. */
async function openPlayer(browser, label, storage = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
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
  const seed = { tandemonium_started: '1', tandemonium_tutorial_done: 'smoke', ...storage };
  await page.evaluateOnNewDocument((s) => { try { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } catch {} }, seed);
  // PeerJS loads from a CDN, which is blocked here, so window.Peer is missing:
  // the transport must stay on the relay without throwing (#472).
  // Record every game state change, so a brief one (the stoker's "waiting") is seen.
  await page.evaluateOnNewDocument(() => {
    window.__states = []; window.__stateTimes = [];
    setInterval(() => {
      const s = window._game && window._game.state;
      if (s && window.__states[window.__states.length - 1] !== s) { window.__states.push(s); window.__stateTimes.push({ s, t: Date.now() }); }
    }, 30);
  });
  const throttle = Number(process.env.SMOKE_CPU_THROTTLE || 0);
  if (throttle > 1) { const cdp = await page.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
  await page.goto(`${h.origin}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window._game && !!window._game.lobby, { timeout: 120000 });
  await page.click('#tap-to-start').catch(() => {});
  return page;
}

const step = (page) => page.evaluate(() => document.getElementById('lobby-flow')?.current || null);
const waitFor = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const clickId = (page, id) => page.evaluate((i) => { const b = document.getElementById(i); if (!b) return false; b.click(); return true; }, id);
const net = (page) => page.evaluate(() => {
  const g = window._game, n = g.net || g.lobby.net;
  return { connected: !!(n && n.connected), transport: n ? n.transport : null, code: n ? n.roomCode : null, role: n ? n.role : null,
    state: g.state, mode: g.mode, drop: g._drop ? g._drop.who : null, reconnecting: !!g._reconnecting,
    step: document.getElementById('lobby-flow')?.current || null };
});

/** OC-01: host and join over the relay. Returns { cap, sto, code }. */
async function hostAndJoin(tag) {
  const cap = await openPlayer(browsers[0], 'captain');
  const sto = await openPlayer(browsers[1], 'stoker');
  await clickId(cap, 'btn-together');
  await waitFor(cap, () => document.getElementById('lobby-flow').current === 'lobby-role');
  await clickId(cap, 'btn-captain');
  // #563: on a desktop / TV the room opens when wanted (a phone's Play, or this button).
  await waitFor(cap, () => document.getElementById('lobby-flow').current === 'lobby-host');
  await clickId(cap, 'btn-host-room-code');
  const gotCode = await waitFor(cap, () => /^TNDM-\w{4}$/.test(document.getElementById('room-code-display')?.textContent || ''));
  const code = await cap.evaluate(() => document.getElementById('room-code-display').textContent);
  check(gotCode, `${tag}OC-01 captain hosts and gets a room code from the relay`, code);
  await clickId(sto, 'btn-together');
  await waitFor(sto, () => document.getElementById('lobby-flow').current === 'lobby-role');
  await clickId(sto, 'btn-stoker');
  await waitFor(sto, () => document.getElementById('lobby-flow').current === 'lobby-join');
  await sto.evaluate((c) => { document.getElementById('room-code-input').value = c.slice(-4); document.getElementById('btn-join').click(); }, code);
  const bothUp = await waitFor(cap, () => !!window._game.lobby.net?.connected, null, 60000) && await waitFor(sto, () => !!window._game.lobby.net?.connected, null, 60000);
  const seated = await waitFor(cap, () => document.getElementById('host-seat-stoker')?.state === 'joined' || !document.getElementById('btn-host-online-next')?.disabled, null, 30000);
  const c = await net(cap), s = await net(sto);
  check(bothUp && c.transport === 'relay' && s.transport === 'relay' && s.code === code, `${tag}OC-01 the stoker joins with the code; both connected over the relay`, { cap: c, sto: s });
  const seat = await cap.evaluate(() => ({ state: document.getElementById('host-seat-stoker')?.state, who: document.getElementById('host-seat-stoker')?.who, next: !document.getElementById('btn-host-online-next')?.disabled }));
  check(seated && seat.next, `${tag}OC-01 the captain's host step shows the partner and enables Online CHOOSE LEVEL`, seat);
  return { cap, sto, code };
}

/** Captain picks `levelId` and starts; both reach `state`. */
async function startRide(cap, sto, levelId, want = 'playing') {
  await clickId(cap, 'btn-host-online-next');
  await waitFor(cap, () => document.getElementById('lobby-flow').current === 'lobby-level');
  await waitFor(sto, () => document.getElementById('lobby-flow').current === 'lobby-level');
  await cap.waitForFunction((id) => !!document.querySelector(`#level-cards .level-card[data-level-id="${id}"]`), { timeout: 30000 }, levelId);
  await cap.evaluate((id) => document.querySelector(`#level-cards .level-card[data-level-id="${id}"]`).click(), levelId);
  await sleep(300);
  await clickId(cap, 'btn-start-ride');
  const a = await waitFor(cap, (s) => window._game.state === s, want, 180000);
  const b = await waitFor(sto, (s) => window._game.state === s, want, 180000);
  return a && b;
}


const g = (page) => page.evaluate(() => {
  const x = window._game;
  return { state: x.state, d: x.bike ? Math.round(x.bike.distanceTraveled * 10) / 10 : null, t: x.raceManager ? Math.round(x.raceManager.segmentTimeRemaining * 10) / 10 : null,
    cps: x.raceManager ? x.raceManager.passedCheckpoints.size : null, overlay: document.getElementById('disconnect-overlay').style.display, msg: document.getElementById('disconnect-msg').textContent };
});

/** The captain crosses the finish; both reach VICTORY. */
async function finish(cap, sto) {
  await cap.evaluate(() => { const x = window._game; x.bike.resetToDistance(x.raceManager.raceDistance + 0.5); });
  const a = await waitFor(cap, () => window._game.state === 'victory', null, 60000);
  const b = await waitFor(sto, () => window._game.state === 'victory', null, 60000);
  return a && b;
}

/** After PLAY AGAIN: both count down / ride from the start line. */
async function backAtStart(cap, sto, tag) {
  const t0 = Date.now();
  const capOk = await waitFor(cap, () => ['countdown', 'playing'].includes(window._game.state) && window._game.bike.distanceTraveled < 5, null, 15000);
  const stoOk = await waitFor(sto, () => ['countdown', 'playing'].includes(window._game.state) && window._game.bike.distanceTraveled < 5, null, 15000);
  const ms = Date.now() - t0;
  await sleep(1500);   // a stoker that reset to the last checkpoint would show it here
  const c = await g(cap), s = await g(sto);
  check(capOk && stoOk && c.d < 40 && s.d < 40 && s.cps === 0 && c.cps === 0, `${tag} both ride again from the start line (${ms} ms)`, { cap: c, sto: s });
}

try {
  console.log('room relay (wrangler dev) …');
  if (!(await waitForRelay())) { console.log(wlog.slice(-3000)); throw new Error('room relay did not start'); }
  const { cap, sto } = await hostAndJoin('');
  const riding = await startRide(cap, sto, 'grandma');
  check(riding, 'both ride Grandma\'s');

  // ── ORP-01 TOO SLOW → RESTART ──
  console.log('ORP-01 the captain restarts from TOO SLOW');
  await cap.evaluate(() => { const rm = window._game.raceManager; rm.timerHeld = false; rm.segmentTimeRemaining = 0.05; });
  const capOver = await waitFor(cap, () => window._game.state === 'gameover', null, 15000);
  await sleep(1800);   // the snail's beat, then the sheet (and EVT_GAMEOVER)
  const stoOver = await waitFor(sto, () => window._game.state === 'gameover' || window._game._stokerTimeoutShown, null, 10000);
  check(capOver && stoOver, 'ORP-01 the clock runs out: TOO SLOW on both', { cap: await g(cap), sto: await g(sto) });
  await sto.evaluate(() => { const n = window._game.net, h0 = n.onEventReceived; window.__ev = []; n.onEventReceived = (e) => { window.__ev.push({ e, t: Date.now(), s: window._game.state }); h0(e); }; });
  const r0 = Date.now();
  await clickId(cap, 'btn-restart');
  const stoBack = await waitFor(sto, () => window._game.state === 'countdown' && !window._game._stokerTimeoutShown && !document.getElementById('timeout-flash').classList.contains('visible'), null, 15000);
  const rMs = Date.now() - r0;
  check(stoBack && rMs < 1500, `ORP-01 the stoker is counting down again within a second of the captain's RESTART (${rMs} ms)`, { cap: await g(cap), sto: await g(sto), r0, ev: await sto.evaluate(() => window.__ev), states: await sto.evaluate(() => window.__stateTimes.slice(-6)) });
  await waitFor(cap, () => window._game.state === 'playing', null, 15000);
  await waitFor(sto, () => window._game.state === 'playing', null, 15000);
  const goAt = (pg) => pg.evaluate(() => { const st = window.__stateTimes.filter((x) => x.s === 'playing'); return st.length ? st[st.length - 1].t : 0; });
  const goGap = Math.abs((await goAt(cap)) - (await goAt(sto)));
  check(goGap < 600, `ORP-01 both hit GO together after the RESTART (${goGap} ms apart)`, { goGap });

  // ── ORP-04 the captain pauses ──
  console.log('ORP-04 the captain pauses');
  await cap.evaluate(() => window._game._openPause());
  const told = await waitFor(sto, () => document.getElementById('disconnect-overlay').style.display === 'flex' && /paused/i.test(document.getElementById('disconnect-msg').textContent), null, 3000);
  const t1 = (await g(sto)).t;
  await sleep(2000);
  const s2 = await g(sto);
  check(told, 'ORP-04 the stoker is told the captain paused the ride', s2);
  check(s2.state === 'playing' && Math.abs(s2.t - t1) < 0.3 && !(await sto.evaluate(() => window._game._stokerTimeoutShown)), "ORP-04 the stoker's clock stops while the captain is paused", { before: t1, after: s2.t });
  await cap.evaluate(() => window._game._closePause('resume'));
  const resumed = await waitFor(sto, () => document.getElementById('disconnect-overlay').style.display !== 'flex' && !window._game._partnerPaused, null, 3000);
  await sleep(1000);
  const s3 = await g(sto);
  const frozen = await sto.evaluate(() => !!window._game.raceManager._pausedAt);
  check(resumed && s3.state === 'playing' && !frozen, 'ORP-04 the captain resumes: the notice goes and the stoker rides on', { ...s3, frozen });

  // ── ORP-06 the stoker pauses (Pete 2026-11-09: a pause stops the ride for both) ──
  console.log('ORP-06 the stoker pauses');
  const capDist = () => cap.evaluate(() => window._game.bike.distanceTraveled);
  const notice = (pg) => pg.evaluate(() => ({
    shown: document.getElementById('disconnect-overlay').style.display === 'flex',
    msg: document.getElementById('disconnect-msg').textContent, paused: !!window._game._partnerPaused }));
  await sto.evaluate(() => window._game._openPause());
  const capTold = await waitFor(cap, () => document.getElementById('disconnect-overlay').style.display === 'flex' && /paused/i.test(document.getElementById('disconnect-msg').textContent), null, 3000);
  const d1 = await capDist();
  await sleep(1500);
  const d2 = await capDist();
  check(capTold && Math.abs(d2 - d1) < 0.05, "ORP-06 the stoker's pause stops the captain's ride and says so", { ...(await notice(cap)), d1, d2 });
  await sto.evaluate(() => window._game._closePause('resume'));
  const capOn = await waitFor(cap, () => document.getElementById('disconnect-overlay').style.display !== 'flex' && !window._game._partnerPaused, null, 3000);
  check(capOn, 'ORP-06 the stoker resumes: the captain rides on', await notice(cap));
  // Both press pause at once: each keeps their own menu.
  await Promise.all([cap.evaluate(() => window._game._openPause()), sto.evaluate(() => window._game._openPause())]);
  await sleep(800);
  const both = { cap: await cap.evaluate(() => ({ menu: !!window._game._pause, waits: !!window._game._partnerWantsPause })),
    sto: await sto.evaluate(() => ({ menu: !!window._game._pause, waits: !!window._game._partnerWantsPause })) };
  await cap.evaluate(() => window._game._closePause('resume'));
  const capWaits = await waitFor(cap, () => !window._game._pause && !!window._game._partnerPaused, null, 3000);
  const dw1 = await capDist(); await sleep(1000); const dw2 = await capDist();
  check(both.cap.menu && both.sto.menu && capWaits && Math.abs(dw2 - dw1) < 0.05,
    'ORP-06 both pause at once: the first to resume waits on the other (the ride stays stopped)', { both, capWaits, dw1, dw2 });
  await sto.evaluate(() => window._game._closePause('resume'));
  const allOn = await waitFor(cap, () => !window._game._partnerPaused && !window._game._pause, null, 3000)
    && await waitFor(sto, () => !window._game._partnerPaused && !window._game._pause, null, 3000);
  check(allOn, 'ORP-06 the second resumes: both ride on', { cap: await notice(cap), sto: await notice(sto) });

  // ── ORP-02 the stoker's PLAY AGAIN ──
  console.log("ORP-02 the stoker's PLAY AGAIN after the finish");
  check(await finish(cap, sto), 'ORP-02 both finish at Grandma\'s', { cap: await g(cap), sto: await g(sto) });
  await sleep(1500);
  await clickId(sto, 'btn-play-again');
  await backAtStart(cap, sto, 'ORP-02');
  await waitFor(cap, () => window._game.state === 'playing', null, 15000);
  await waitFor(sto, () => window._game.state === 'playing', null, 15000);

  // ── ORP-03 the captain's PLAY AGAIN ──
  console.log("ORP-03 the captain's PLAY AGAIN after the finish");
  check(await finish(cap, sto), 'ORP-03 both finish again', { cap: await g(cap), sto: await g(sto) });
  await sleep(1500);
  await clickId(cap, 'btn-play-again');
  await backAtStart(cap, sto, 'ORP-03');
  await h.shot(sto, 'stoker-riding-again');

  // ── ORP-05 back to the room ──
  console.log('ORP-05 back in the room');
  await waitFor(cap, () => window._game.state === 'playing', null, 15000);
  await waitFor(sto, () => window._game.state === 'playing', null, 15000);
  // Hold the stoker's ROAD AHEAD panel up (an empty stretch of road would hide it).
  await sto.evaluate(() => { const x = window._game; x._updateLookahead = () => { x.hud.updateLookahead([]); x._lookaheadWasOn = true; }; });
  await sleep(800);
  const laOn = await sto.evaluate(() => document.getElementById('lookahead').classList.contains('visible'));
  await cap.evaluate(() => window._game._returnToRoom());
  const inRoom = await waitFor(cap, () => window._game.state === 'lobby' && document.getElementById('lobby-flow').current === 'lobby-level', null, 20000)
    && await waitFor(sto, () => window._game.state === 'lobby' && document.getElementById('lobby-flow').current === 'lobby-level', null, 20000);
  const laGone = await sto.evaluate(() => !document.getElementById('lookahead').classList.contains('visible'));
  check(inRoom && laOn && laGone, "ORP-05 back in the room: the stoker's ROAD AHEAD panel is gone", { laOnDuringRide: laOn, laGone });
  const list = (pg) => pg.evaluate(() => {
    const cards = [...document.querySelectorAll('#level-cards .level-card')];
    return { ids: cards.map((c) => c.dataset.levelId), sling: cards.some((c) => c.dataset.levelId === 'slingshot'),
      picked: (cards.find((c) => c.classList.contains('selected')) || {}).dataset?.levelId || null,
      stokerLocked: cards.every((c) => c.style.pointerEvents === 'none' || c.disabled), start: document.getElementById('btn-start-ride').style.display };
  });
  // What a controller (or gyro) coming on does on each screen, and a sign-in.
  await cap.evaluate(() => { window._game.lobby._updateTutorialButton(); window._game.lobby._rebuildLevelCards(); });
  await sto.evaluate(() => { window._game.lobby._updateTutorialButton(); window._game.lobby._rebuildLevelCards(); });
  const cl = await list(cap), sl = await list(sto);
  check(!cl.sling && !sl.sling, 'ORP-05 after a rebuild neither room screen lists the Slingshot', { cap: cl.ids, sto: sl.ids });
  check(sl.stokerLocked && sl.start === 'none', "ORP-05 the stoker's rebuilt list is still read-only (no START RIDE)", sl);
  const other = cl.ids.find((id) => id !== cl.picked && id !== 'tutorial' && id !== 'tourist');
  await cap.evaluate((id) => document.querySelector('#level-cards .level-card[data-level-id="' + id + '"]').click(), other);
  const follows = await waitFor(sto, (id) => !!document.querySelector('#level-cards .level-card.selected[data-level-id="' + id + '"]'), other, 5000);
  await sto.evaluate(() => window._game.lobby._rebuildLevelCards());
  const kept = await list(sto);
  check(follows && kept.picked === other, "ORP-05 the stoker's screen shows the captain's pick, and keeps it through a rebuild", { other, follows, kept: kept.picked });
  await cap.close(); await sto.close();
} catch (e) {
  check(false, 'smoke crashed: ' + (e && e.stack || e));
}

check(h.errors.length === 0, 'no page errors', h.errors);
await browsers[1].close().catch(() => {});
killWrangler();
await h.finish();
