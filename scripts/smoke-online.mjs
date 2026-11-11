#!/usr/bin/env node
// smoke:online · online co-op over the REAL room transport (#472 OC-01, OC-07,
// OC-11, OC-13).
//
// Runs the room relay (worker/relay.js, a Durable Object) under `wrangler dev`
// on 127.0.0.1:8792 and points both game pages at it by rewriting one line of
// js/config.js as it is served (RELAY_URL). No game code changes: the pages
// use js/net/room-transport.js exactly as shipped. PeerJS (P2P) loads from a
// CDN and is aborted here, so the pair stays on the relay — the primary
// transport. Each player is its own Chrome so neither page is a throttled
// background tab.
//
//   OC-01  captain hosts (TOGETHER → START A RIDE), gets a room code; the
//          stoker joins with it on the keypad; both see each other seated.
//   OC-07  a short relay drop mid-ride (< 2 s, the captain's socket closes and
//          comes back) shows no pause on either side.
//   OC-11  after a ride, BACK TO ROOM brings both back to level select on the
//          same room, still connected. (Camera/mic go over PeerJS, which is
//          unreachable offline: the media half stays a manual check.)
//   OC-13  co-op tutorial: the stoker waits for the captain's countdown, both
//          ride, the tutorial completes on both, and both return to the room.
//   OC-N   (#694) the relay names each side to the other as they meet ("Connected to Pete (your
//          Captain)!", "Sam (your Stoker) joined!", the captain's seat says Sam); once both have
//          left, the next joiner hears "Pete (your Captain) was in room … 0 s ago".
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startHarness, sleep } from './lib/smoke-harness.mjs';

const ROOT = process.cwd();
const require = createRequire(ROOT + '/package.json');
const puppeteer = require('puppeteer');
const PORT = 8983;
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

const h = await startHarness({ port: PORT, outDir: 'tandemonium-online' });
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

try {
  console.log('room relay (wrangler dev) …');
  if (!(await waitForRelay())) { console.log(wlog.slice(-3000)); throw new Error('room relay did not start'); }

  // ── OC-01 + OC-07 + OC-11 on Grandma's ──
  console.log("OC-01 / OC-07 / OC-11 — Grandma's");
  {
    const { cap, sto, code } = await hostAndJoin('');

    // OC-F (#694 F): over the real relay each side hears the other's activity ping; an idle
    // partner shows "Your Stoker … hasn't moved for 0:35" (the idle clock is skewed, not waited
    // out); the stoker pressing a key clears it within one ping period.
    const pinged = await waitFor(cap, () => window._game.lobby._partnerIdle.pingSeen, null, 15000) && await waitFor(sto, () => window._game.lobby._partnerIdle.pingSeen, null, 15000);
    check(pinged, "OC-F both sides hear the other's activity ping over the relay (#694 F)");
    await cap.evaluate(() => { window._game.lobby._partnerIdle.lastAt -= 35000; });
    const idleText = await cap.waitForFunction(() => { const e = document.getElementById('room-idle-note'); return e && !e.hidden && /^Your Stoker.* hasn't moved for 0:3[05]$/.test(e.textContent) && e.textContent; }, { timeout: 5000, polling: 100 }).then((x) => x.jsonValue(), () => null);
    check(!!idleText, 'OC-F the captain sees the idle stoker: "Your Stoker … hasn\'t moved for 0:35"', idleText);
    await sto.keyboard.press('Shift');
    const cleared = await waitFor(cap, () => { const e = document.getElementById('room-idle-note'); return !e || e.hidden; }, null, 8000);
    check(cleared, 'OC-F the stoker presses a key: the captain\'s "hasn\'t moved" clears');

    const riding = await startRide(cap, sto, 'grandma');
    const c0 = await net(cap), s0 = await net(sto);
    check(riding && c0.mode === 'captain' && s0.mode === 'stoker', 'both ride: captain and stoker in the same ride', { cap: c0, sto: s0 });

    // OC-07: the captain's relay socket drops and comes straight back.
    // Pause watchers on both sides (the reconnect overlay or a drop pause), with
    // the wall-clock time of the first pause and of it clearing.
    const watch = (k) => {
      const w = window[k] = { pausedSeen: false, pausedAt: 0, clearedAt: 0 };
      setInterval(() => {
        const p = !!(window._game._drop || window._game._reconnecting);
        if (p && !w.pausedSeen) { w.pausedSeen = true; w.pausedAt = Date.now(); }
        if (!p && w.pausedSeen && !w.clearedAt) w.clearedAt = Date.now();
      }, 30);
    };
    await sto.evaluate(watch, '__oc07sto');
    await cap.evaluate(watch, '__oc07cap');
    await cap.evaluate(() => {
      const n = window._game.net;
      const o = window.__oc07 = { reconnecting: 0, t0: Date.now(), downAt: 0, backAt: 0 };
      const prev = n.onReconnecting;
      n.onReconnecting = (...a) => { o.reconnecting++; if (prev) prev(...a); };
      // When the transport went down and when it came back (wall clock).
      setInterval(() => {
        if (!n.connected && !o.downAt) o.downAt = Date.now();
        if (n.connected && o.downAt && !o.backAt) o.backAt = Date.now();
      }, 30);
      // A blip: the transport's own resume-recovery path (what a tab resume or
      // an "online" event triggers) closes the socket and dials again.
      n.retryConnection();
    });
    const back = await waitFor(cap, () => !!window.__oc07.backAt && window._game.net.transport === 'relay', null, 30000);
    const backSto = await waitFor(sto, () => !!window._game.net.connected, null, 30000);
    // Watch past the 2 s grace, and until any pause has cleared.
    await sleep(3500);
    await waitFor(cap, () => !window._game._drop && !window._game._reconnecting, null, 30000);
    await waitFor(sto, () => !window._game._drop && !window._game._reconnecting, null, 30000);
    const blip = await cap.evaluate(() => ({ ...window.__oc07, ...window.__oc07cap, state: window._game.state, connected: window._game.net.connected }));
    const blipSto = await sto.evaluate(() => ({ ...window.__oc07sto, state: window._game.state, connected: window._game.net.connected }));
    const reconnectMs = blip.backAt && blip.t0 ? blip.backAt - blip.t0 : null;
    check(blip.reconnecting >= 1 && back && backSto, 'OC-07 the captain\'s relay socket drops and reconnects', { reconnectMs, cap: blip, sto: blipSto });
    // The 2 s grace (RECONNECT_GRACE_MS) is wall-clock, but the redial (1 s
    // backoff + connect) is JS work that a 1-3 fps CI runner stretches past it.
    // So: back within the grace → no pause on either side (the point of the
    // grace). Back later (a slow box, not a short drop any more) → the pause
    // shows and clears once reconnected, both still riding.
    const GRACE = 2000;
    const riding2 = blip.state === 'playing' && blipSto.state === 'playing';
    if (reconnectMs !== null && reconnectMs < GRACE) {
      check(!blip.pausedSeen && !blipSto.pausedSeen && riding2,
        `OC-07 a short drop (back in ${reconnectMs} ms, under the 2 s grace) shows no pause on either side`, { cap: blip, sto: blipSto });
    } else {
      const cleared = (w) => !w.pausedSeen || (w.clearedAt > 0 && w.clearedAt >= w.pausedAt);
      const notEarly = !blip.pausedSeen || blip.pausedAt - blip.t0 >= GRACE - 100;
      console.log(`  (slow box: the redial took ${reconnectMs} ms, past the 2 s grace)`);
      check(cleared(blip) && cleared(blipSto) && notEarly && riding2 && blip.connected,
        `OC-07 a drop that outlasts the 2 s grace (${reconnectMs} ms here) pauses no sooner than the grace, then clears once reconnected; both ride on`,
        { cap: blip, sto: blipSto });
    }

    // OC-07b: a raw socket close (the server side or a NAT drops it) while the
    // transport still thinks it's connected — the common real-world blip.
    // A server-side drop fires onclose at once; a page-side close() waits for the
    // relay's close frame, which wrangler dev can hold for seconds. So deliver
    // the close event now, the way a real drop does, and detach it from the
    // socket so it isn't handled twice when the close completes.
    await cap.evaluate(() => {
      window.__oc07cap.pausedSeen = false;
      const ws = window._game.net._relayWs, onclose = ws.onclose;
      ws.onclose = null; ws.close(); onclose && onclose.call(ws, new CloseEvent('close'));
    });
    await sto.evaluate(() => { window.__oc07sto.pausedSeen = false; });
    // Wait for the redial (a slow CI box can take seconds), then judge the
    // pause the same way as above: none if it came back inside the 2 s grace,
    // otherwise it must have cleared once both are connected again.
    const t0raw = Date.now();
    await waitFor(cap, () => !!window._game.net.connected, null, 30000);
    const rawMs = Date.now() - t0raw;
    await waitFor(sto, () => !!window._game.net.connected, null, 30000);
    await sleep(1500);
    const raw = await cap.evaluate(() => ({ paused: window.__oc07cap.pausedSeen, connected: window._game.net.connected, ws: window._game.net._relayWs ? window._game.net._relayWs.readyState : null, pausedNow: !!(window._game._drop || window._game._reconnecting) }));
    const rawSto = await sto.evaluate(() => ({ paused: window.__oc07sto.pausedSeen, connected: window._game.net.connected, pausedNow: !!(window._game._drop || window._game._reconnecting) }));
    const rawFast = rawMs < 2000;
    if (!rawFast) console.log(`  (slow box: the raw-close redial took ${rawMs} ms, past the 2 s grace)`);
    check(raw.ws === 1 && raw.connected && rawSto.connected && !raw.pausedNow && !rawSto.pausedNow && (!rawFast || (!raw.paused && !rawSto.paused)),
      'OC-07 a raw relay socket close is redialled at once, with no pause on either side (#472)',
      { cap: raw, sto: rawSto });
    // Let it recover before the next part.
    await waitFor(cap, () => !!window._game.net.connected && !window._game._drop && !window._game._reconnecting, null, 60000);
    await waitFor(sto, () => !!window._game.net.connected && !window._game._drop && !window._game._reconnecting, null, 60000);
    await h.shot(cap, '1-captain-riding');

    // OC-14 (TV playtest 2026-11-06: the phone sat on TOO SLOW for good). The stoker's TOO SLOW
    // clears by itself while the captain's clock streams (a lost EVT_RESET can't strand it); a
    // silent captain gets a "Waiting for the captain…" sheet, never the drop pause, and the
    // sheet lifts the moment the captain is heard from again.
    const tooSlow = (ago) => sto.evaluate((a) => { const g = window._game; g._stokerTimeoutShown = true; g._stokerTimeoutAt = performance.now() - a; g._lastCaptainAt = performance.now() - a; document.getElementById('timeout-flash').classList.add('visible'); }, ago);
    await cap.evaluate(() => { const g = window._game; g.raceManager.segmentTimeRemaining = Math.max(g.raceManager.segmentTimeRemaining, 30); });
    await tooSlow(13000);
    const healed = await waitFor(sto, () => !window._game._stokerTimeoutShown && !document.getElementById('timeout-flash').classList.contains('visible'), null, 5000);
    const healedSheet = await sto.evaluate(() => document.getElementById('disconnect-overlay').style.display === 'flex');
    check(healed && !healedSheet, "OC-14 a stuck TOO SLOW clears itself from the captain's running clock (no sheet)", { healed, healedSheet });
    // Silence the captain: no state, no events (as if paused, or its messages lost).
    await cap.evaluate(() => { const n = window._game.net; window.__mute = { s: n.sendState, e: n.sendEvent }; n.sendState = () => {}; n.sendEvent = () => {}; });
    await sleep(1500);
    await tooSlow(13000);
    const waiting = await waitFor(sto, () => document.getElementById('disconnect-overlay').style.display === 'flex' && /Waiting for the captain/.test(document.getElementById('disconnect-msg').textContent), null, 5000);
    const quiet = await sto.evaluate(() => ({ netLost: window._game._netLost, drop: !!window._game._drop, state: window._game.state, tryAgain: !document.getElementById('btn-try-reconnect').hidden, lobbyBtn: !document.getElementById('btn-return-lobby').hidden }));
    check(waiting && !quiet.netLost && !quiet.drop && quiet.state === 'playing' && !quiet.tryAgain && quiet.lobbyBtn, 'OC-14 a silent captain: "Waiting for the captain…" sheet (Return to Lobby, no Try again on a live link), no drop pause, link not marked lost', { waiting, quiet });
    await cap.evaluate(() => { const n = window._game.net; n.sendState = window.__mute.s; n.sendEvent = window.__mute.e; });
    const lifted = await waitFor(sto, () => document.getElementById('disconnect-overlay').style.display !== 'flex' && !window._game._waitingForCaptain && !window._game._stokerTimeoutShown, null, 8000);
    check(lifted, 'OC-14 the captain heard from again: the sheet lifts and TOO SLOW clears', await sto.evaluate(() => ({ overlay: document.getElementById('disconnect-overlay').style.display, waiting: window._game._waitingForCaptain, tooSlow: window._game._stokerTimeoutShown })));

    // OC-15 · the captain skips to the next checkpoint from Game Over (its countdown, then
    // EVT_START, now sent reliably): the stoker leaves its own Game Over, and the extra START
    // copies never restart its race clock.
    await sto.evaluate(() => { const g = window._game, n = g.net; window.__starts = 0; window.__events = 0; const h = n.onEventReceived; n.onEventReceived = (ev) => { window.__events++; const before = g._lastStartAt; h(ev); if (g._lastStartAt !== before) window.__starts++; }; g._showGameOver(true); });
    await cap.bringToFront();   // a background page runs its frames throttled: the countdown would crawl
    await cap.evaluate(() => window._game._resumeCountdown());
    await waitFor(cap, () => window._game.state === 'playing', null, 20000);
    await sto.bringToFront();
    const backOn = await waitFor(sto, () => window._game.state === 'playing' && document.getElementById('gameover-overlay').style.display !== 'flex', null, 15000);
    await sleep(1500);
    const starts = await sto.evaluate(() => window.__starts);
    check(backOn && starts === 1, "OC-15 the captain's checkpoint skip takes the stoker off Game Over; its START copies start the ride once", { backOn, starts, events: await sto.evaluate(() => window.__events) });

    // OC-11: finish, then BACK TO ROOM: both on level select, same room, connected.
    await cap.evaluate(() => { const g = window._game; g.bike.resetToDistance(g.lobby.selectedLevel.distance - 0.5); g.bike.speed = 10; });
    const won = await waitFor(cap, () => window._game.state === 'victory', null, 180000);
    await waitFor(sto, () => window._game.state === 'victory', null, 60000);
    const roomBtn = await cap.evaluate(() => { const b = document.getElementById('btn-victory-room'); return !!b && b.offsetParent !== null; });
    check(won && roomBtn, 'OC-11 the captain finishes; BACK TO ROOM is offered', { won, roomBtn });
    const netBefore = await cap.evaluate(() => { window.__netObj = window._game.net; return window._game.net.roomCode; });
    // The stoker must not echo the captain's (reliable) RETURN_ROOM back: the echo could pull a
    // quickly restarted ride back to the room.
    await sto.evaluate(() => { const n = window._game.net; window.__echo = 0; const r = n.sendEventReliable.bind(n), s = n.sendEvent.bind(n); n.sendEventReliable = (...x) => { window.__echo++; return r(...x); }; n.sendEvent = (...x) => { window.__echo++; return s(...x); }; });
    await clickId(cap, 'btn-victory-room');
    const capRoom = await waitFor(cap, () => window._game.state === 'lobby' && document.getElementById('lobby-flow').current === 'lobby-level', null, 60000);
    const stoRoom = await waitFor(sto, () => window._game.state === 'lobby' && document.getElementById('lobby-flow').current === 'lobby-level', null, 60000);
    const after = await cap.evaluate(() => ({ same: window._game.lobby.net === window.__netObj || window._game.net === window.__netObj, code: (window._game.net || window._game.lobby.net)?.roomCode, connected: !!(window._game.net || window._game.lobby.net)?.connected,
      start: getComputedStyle(document.getElementById('btn-start-ride')).display !== 'none' }));
    const stoWait = await sto.evaluate(() => ({ connected: !!(window._game.net || window._game.lobby.net)?.connected, wait: getComputedStyle(document.getElementById('level-wait-text')).display !== 'none' }));
    check(capRoom && stoRoom && after.same && after.code === netBefore && after.connected && stoWait.connected,
      'OC-11 BACK TO ROOM returns both to level select on the same room, still connected', { after, stoWait, code });
    check(after.start && stoWait.wait, 'OC-11 the captain picks the next level; the stoker waits for it', { start: after.start, wait: stoWait.wait });
    await sleep(800);
    const echoes = await sto.evaluate(() => window.__echo);
    check(echoes === 0, "OC-11 the stoker follows the captain to the room without sending RETURN_ROOM back", { echoes });
    // The Level screen is part of the online room: both see both seats and the partner connected.
    const bar = (pg) => pg.evaluate(() => { const t = document.getElementById('level-room-team'); const s = (id) => { const e = document.getElementById(id); return { who: e.who, dev: e.dev, state: e.state }; };
      return { shown: !!t && !t.hidden && t.getBoundingClientRect().height > 0, heading: t && t.heading, captain: s('level-room-captain'), stoker: s('level-room-stoker') }; });
    const capBar = await bar(cap), stoBar = await bar(sto);
    check(capBar.shown && stoBar.shown && /Online room TNDM-/.test(capBar.heading || '') && capBar.stoker.state === 'joined' && /connected/i.test(capBar.stoker.dev) && stoBar.captain.state === 'joined' && /connected/i.test(stoBar.captain.dev),
      'OC-11 the Level screen shows the online room: both seats, the partner connected', { capBar, stoBar });
    await h.shot(cap, '2-captain-back-in-room');
    await cap.close(); await sto.close();
  }

  // ── OC-13: co-op tutorial ──
  console.log('OC-13 — co-op tutorial');
  {
    const { cap, sto } = await hostAndJoin('(tutorial) ');
    // Hold the captain's EVT_COUNTDOWN (0x01) for 3 s, as a captain still
    // calibrating would: the stoker must wait for it, not count down alone.
    await cap.evaluate(() => {
      const n = window._game.lobby.net;
      const send = n.sendEvent.bind(n);
      window.__held = 0; window.__released = false;
      n.sendEvent = (evt, ...a) => {
        if (evt === 0x01 && !window.__released) {
          window.__held++;
          setTimeout(() => { window.__released = true; window.__releasedAt = Date.now(); send(evt, ...a); }, 3000);
          return;
        }
        return send(evt, ...a);
      };
    });
    const ridePromise = startRide(cap, sto, 'tutorial');
    // While it's held: the stoker sits in "waiting".
    const waited = await waitFor(sto, () => window._game.state === 'waiting', null, 120000);
    const riding = await ridePromise;
    const held = await cap.evaluate(() => ({ n: window.__held, at: window.__releasedAt || 0 }));
    const times = await sto.evaluate(() => window.__stateTimes);
    const sc = await cap.evaluate(() => ({ states: window.__states, tut: !!window._game.lobby.selectedLevel?.isTutorial }));
    const ss = await sto.evaluate(() => ({ states: window.__states, tut: !!window._game.lobby.selectedLevel?.isTutorial }));
    check(riding && sc.tut && ss.tut, 'OC-13 the captain starts the tutorial; both ride it', { cap: sc, sto: ss });
    // The stoker waits for the captain's EVT_COUNTDOWN before its own countdown.
    const sw = ss.states.indexOf('waiting'), sp = ss.states.indexOf('playing');
    // Same machine, so Date.now() is one clock for both pages: the stoker went
    // into "waiting" before the captain's held countdown went out, and left it
    // only after.
    const wi = times.findIndex((x) => x.s === 'waiting');
    const enteredWait = wi >= 0 ? times[wi].t : 0;
    const leftWait = wi >= 0 && times[wi + 1] ? times[wi + 1].t : 0;
    const gated = held.n >= 1 && held.at > 0 && enteredWait > 0 && enteredWait < held.at && leftWait >= held.at - 40;
    check(waited && gated && sw >= 0 && sp > sw,
      'OC-13 the stoker waits ("Waiting for captain…") while the captain\'s countdown is held, and starts only once it arrives',
      { held, waitedMs: leftWait - enteredWait, leftAfterReleaseMs: leftWait - held.at, states: ss.states });
    // Riding all three phases takes minutes headless: complete it the way the
    // captain's own phase check does (_tutorialComplete sends EVT_FINISH).
    await cap.evaluate(() => window._game._tutorialComplete());
    const capDone = await waitFor(cap, () => getComputedStyle(document.getElementById('tutorial-complete')).display !== 'none' || document.getElementById('tutorial-complete').classList.contains('visible'), null, 60000);
    const stoDone = await waitFor(sto, () => getComputedStyle(document.getElementById('tutorial-complete')).display !== 'none' || document.getElementById('tutorial-complete').classList.contains('visible'), null, 60000);
    check(capDone && stoDone, 'OC-13 the tutorial completes on both (captain\'s EVT_FINISH reaches the stoker)', { capDone, stoDone });
    await h.shot(sto, '3-stoker-tutorial-complete');
    await clickId(cap, 'btn-tutorial-continue');
    await clickId(sto, 'btn-tutorial-continue');
    const capBack = await waitFor(cap, () => window._game.state === 'lobby' && !!window._game.lobby.net?.connected, null, 60000);
    const stoBack = await waitFor(sto, () => window._game.state === 'lobby' && !!window._game.lobby.net?.connected, null, 60000);
    const st = { cap: await net(cap), sto: await net(sto) };
    check(capBack && stoBack && st.cap.step === 'lobby-level' && st.sto.step === 'lobby-level', 'OC-13 both return to the room after the tutorial, still connected', st);

    // OC-16 · back in the room on a transport that already gave up: it tries again instead of
    // sitting on "Reconnecting…"; one whose seat was taken elsewhere says so (not "partner").
    const gaveUp = await cap.evaluate(() => { const l = window._game.lobby, n = l.net; let retried = 0; const r = n.retryConnection.bind(n); n.retryConnection = () => { retried++; }; n.connected = false; n._gaveUp = true; l.showRoom(n, 'captain'); n.retryConnection = r; n.connected = true; n._gaveUp = false; return retried; });
    const evicted = await sto.evaluate(() => { const l = window._game.lobby, n = l.net; n.connected = false; n._evicted = true; l.showRoom(n, 'stoker'); return document.getElementById('level-wait-text').textContent; });
    check(gaveUp === 1 && /opened somewhere else/.test(evicted || ''), 'OC-16 a room on a given-up transport retries; a seat taken elsewhere says so', { gaveUp, evicted });
    await cap.close(); await sto.close();
  }

  // ── OC-17 (#623) · same disruptions on both screens; the stoker's END RIDE TOGETHER ends it here ──
  console.log('OC-17 — ride difficulty + END RIDE TOGETHER');
  {
    const { cap, sto } = await hostAndJoin('');
    // The captain never touches the difficulty buttons (no difficultySync); the phone still
    // holds another difficulty from before. The start message now carries the captain's.
    await cap.evaluate(() => { window._game.lobby.selectedDifficulty = 'daredevil'; });
    await sto.evaluate(() => { window._game.lobby.selectedDifficulty = 'chill'; });
    const riding = await startRide(cap, sto, 'grandma');
    const plan = (pg) => pg.evaluate(() => ({ diff: window._game.lobby.selectedDifficulty, events: (window._game._disruptions || []).map((e) => e.kind + '@' + e.atM).join(',') }));
    const cp = await plan(cap), sp = await plan(sto);
    check(riding && sp.diff === 'daredevil' && cp.events && cp.events === sp.events, "OC-17 the stoker rides the captain's difficulty: the same cobbles and gusts on both screens", { cap: cp, sto: sp });
    // The phone ends the ride together (what END RIDE TOGETHER runs).
    await sto.evaluate(() => window._game._returnToLobby());
    const told = await waitFor(cap, () => document.getElementById('disconnect-overlay').style.display === 'flex' && /ended the ride together/.test(document.getElementById('disconnect-msg').textContent), null, 10000);
    const capAfter = await cap.evaluate(() => ({ state: window._game.state, gameNet: !!window._game.net, lobbyNet: !!window._game.lobby.net, drop: !!window._game._drop, tryAgain: !document.getElementById('btn-try-reconnect').hidden }));
    const stoAfter = await sto.evaluate(() => ({ state: window._game.state, gameNet: !!window._game.net, lobbyNet: !!window._game.lobby.net }));
    check(told && !capAfter.gameNet && !capAfter.lobbyNet && !capAfter.drop && !capAfter.tryAgain && capAfter.state !== 'playing',
      'OC-17 the phone ends the ride together: the captain is told, the session ends there (no drop pause, no reconnect)', { told, capAfter });
    check(stoAfter.state === 'lobby' && !stoAfter.gameNet && !stoAfter.lobbyNet, 'OC-17 the phone keeps no session after END RIDE TOGETHER', stoAfter);
    await clickId(cap, 'btn-return-lobby');
    const capLobby = await waitFor(cap, () => window._game.state === 'lobby', null, 10000);
    check(capLobby, 'OC-17 the captain goes back to the lobby from the notice');
    await cap.close(); await sto.close();
  }
  // ── OC-W (#694): the relay remembers rooms. A code nobody ever opened says so at once. ──
  console.log('OC-W — a never-opened room code');
  {
    const p = await openPlayer(browsers[1], 'joiner');
    const code = 'TNDM-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[Math.floor(Math.random() * 23)]).join('');
    await clickId(p, 'btn-together');
    await waitFor(p, () => document.getElementById('lobby-flow').current === 'lobby-role');
    await clickId(p, 'btn-stoker');
    await waitFor(p, () => document.getElementById('lobby-flow').current === 'lobby-join');
    await p.evaluate((c) => window._game.lobby._joinRoom(c), code);
    const said = await p.waitForFunction((c) => {
      const s = document.getElementById('join-status');
      const row = document.getElementById('join-wait-actions');
      return s && s.textContent.startsWith(`No one has opened room ${c.slice(5)} yet. Check the code`) && row && !row.hidden && s.textContent;
    }, { timeout: 30000, polling: 100 }, code).then((x) => x.jsonValue(), () => null);
    check(!!said, 'OC-W joining a code nobody opened: "No one has opened room … yet. Check the code" + Try another code at once', said);
    await p.close();
  }
  // ── OC-N (#694): the relay names the partner the moment both are in, and after they've gone ──
  console.log('OC-N — the relay names the partner');
  {
    const cap = await openPlayer(browsers[0], 'captain');
    const sto = await openPlayer(browsers[1], 'stoker');
    const nameAs = (page, n) => page.evaluate((x) => { window._game.lobby._roomSession._host.myName = () => x; }, n);
    await nameAs(cap, 'Pete');
    await nameAs(sto, 'Sam');
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
    const seenText = (page, id, want) => page.waitForFunction((i, w) => {
      const el = document.getElementById(i);
      if (el && el.textContent === w) window.__ocn = w;
      return window.__ocn === w;
    }, { timeout: 60000, polling: 20 }, id, want).then(() => true, () => false);
    const capSaw = seenText(cap, 'host-status', 'Sam (your Stoker) joined!');
    const stoSaw = seenText(sto, 'join-status', 'Connected to Pete (your Captain)!');
    await sto.evaluate((c) => { document.getElementById('room-code-input').value = c.slice(-4); document.getElementById('btn-join').click(); }, code);
    const [a, b] = await Promise.all([capSaw, stoSaw]);
    check(b, "OC-N the stoker's line names the captain: Connected to Pete (your Captain)!");
    check(a, "OC-N the captain's line names the stoker: Sam (your Stoker) joined!");
    const who = await cap.evaluate(() => window._game.lobby._roomPartnerName);
    check(who === 'Sam', "OC-N the captain's room shows Sam (from the relay, or their profile)", who);
    await cap.close(); await sto.close();
    await sleep(1500);
    const p = await openPlayer(browsers[1], 'joiner');
    await clickId(p, 'btn-together');
    await waitFor(p, () => document.getElementById('lobby-flow').current === 'lobby-role');
    await clickId(p, 'btn-stoker');
    await waitFor(p, () => document.getElementById('lobby-flow').current === 'lobby-join');
    await p.evaluate((c) => window._game.lobby._joinRoom(c), code);
    const said = await p.waitForFunction((c) => {
      const s = document.getElementById('join-status');
      return s && s.textContent.startsWith(`Pete (your Captain) was in room ${c.slice(5)}`) && s.textContent;
    }, { timeout: 30000, polling: 100 }, code).then((x) => x.jsonValue(), () => null);
    check(!!said, 'OC-N a later joiner hears who was just here: "Pete (your Captain) was in room … ago"', said);
    await p.close();
  }
} catch (e) {
  check(false, 'smoke crashed: ' + (e && e.message));
}

check(h.errors.length === 0, 'no page errors', h.errors);
await browsers[1].close().catch(() => {});
killWrangler();
await h.finish();
