#!/usr/bin/env node
// smoke:disconnect · the disconnect pause (2026-10-23). A dropped controller or
// online partner pauses the ride (clock + physics stop); after DROP_TAKEOVER_MS
// the player still here can ride on alone / take over the bike.
// Solo pad drop → Resume; local co-op P2 drop + P1 drop (P2 takes over); online
// captain + stoker partner loss (fake net) → ride on alone / take over.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
import os from 'node:os';
const ROOT = process.cwd();
const require = createRequire(ROOT + '/package.json');
const puppeteer = require('puppeteer');
const PORT = 8957;
const OUT = path.join(os.tmpdir(), 'tandemonium-disconnect'); fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.json': 'application/json', '.webp': 'image/webp' };
const server = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  fs.stat(f, (e, st) => { if (e || st.isDirectory()) return r.writeHead(404).end(); r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }); });
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const errors = [];
const results = [];
const check = (ok, name, detail) => { results.push(!!ok); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function rideSolo() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setRequestInterception(true);
  page.on('request', (req) => { const u = req.url(); if (u.startsWith(`http://127.0.0.1:${PORT}`)) return req.continue();
    let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
    if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')) });
    m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f = m && path.join(ROOT, 'node_modules/three/examples/jsm/' + m[1]);
    if (f && fs.existsSync(f)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
    return req.abort(); });
  page.on('pageerror', e => { errors.push(e.message); console.log('  PAGEERROR:', e.message); });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tandemonium_tutorial_done', 'smoke'); localStorage.setItem('tandemonium_started', '1'); } catch {} });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window._game, { timeout: 60000 });
  await page.click('#tap-to-start').catch(() => {});
  await page.evaluate(() => { const b = document.getElementById('btn-solo') || Array.from(document.querySelectorAll('button, uf-button')).find(x => /solo/i.test(x.textContent)); b && b.click(); });
  await sleep(600);
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button, uf-button')).find(x => /start ride/i.test(x.textContent || '')); b && b.click(); });
  await page.waitForFunction(() => window._game?.state === 'playing', { timeout: 120000 });
  // A fake pad for P1 that the test can unplug.
  await page.evaluate(() => {
    window.__p1pad = true;
    Object.defineProperty(window._game.input, 'gamepadConnected', { configurable: true, get: () => window.__p1pad });
  });
  await sleep(800);
  return page;
}

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
    timer: g.raceManager ? g.raceManager.segmentTimeRemaining : null,
  };
});
const skipWait = (page) => page.evaluate(() => { window._game._drop.since -= 20000; });

// ── Solo: pad drop pauses; reconnect resumes; Resume rides on ──
console.log('solo');
{
  const page = await rideSolo();
  check(await page.evaluate(() => window._game._p1PadSeen), 'solo: P1 pad seen while riding');
  await page.evaluate(() => { window.__p1pad = false; });
  await sleep(1200);
  let o = await overlay(page);
  check(o.visible && o.who === 'p1' && /Your controller/.test(o.msg), 'solo: unplugging pauses with "Your controller disconnected"', o.msg);
  check(o.resume && !o.alone, 'solo: Resume shown, no ride-on-alone', o);
  // The race manager (clock + progress) isn't stepped while paused.
  await page.evaluate(() => { const rm = window._game.raceManager; const up = rm.update.bind(rm); window.__rmCalls = 0; rm.update = (...a) => { window.__rmCalls++; return up(...a); }; });
  await sleep(1500);
  const pausedCalls = await page.evaluate(() => window.__rmCalls);
  check(pausedCalls === 0, 'solo: race clock + physics not stepped while paused', pausedCalls);
  await page.evaluate(() => { window.__p1pad = true; });
  await sleep(600); o = await overlay(page);
  check(!o.visible && !o.who && o.state === 'playing', 'solo: reconnecting resumes the ride');
  await sleep(800);
  const runCalls = await page.evaluate(() => window.__rmCalls);
  check(runCalls > 0, 'solo: race steps again after resume', runCalls);
  await page.evaluate(() => { window.__p1pad = false; });
  await sleep(1200);
  await page.evaluate(() => document.getElementById('btn-drop-resume').click());
  await sleep(800); o = await overlay(page);
  check(!o.visible && o.state === 'playing', 'solo: Resume rides on without the pad', o);
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
  await page.screenshot({ path: path.join(OUT, `online-${role}-waiting.png`) });
  // The transport gives up → Try Again appears too.
  await page.evaluate(() => { const g = window._game; g._netLost = true; g._renderDropOverlay(); });
  o = await overlay(page);
  check(o.retry, `${role}: Try Again offered once the connection gave up`);
  await skipWait(page); await sleep(800); o = await overlay(page);
  const label = role === 'stoker' ? /Take over the bike/ : /Ride on alone/;
  check(o.alone && label.test(o.aloneText), `${role}: after 20 s "${role === 'stoker' ? 'Take over the bike' : 'Ride on alone'}"`, o.aloneText);
  await page.evaluate(() => document.getElementById('btn-ride-alone').click());
  await sleep(1500); o = await overlay(page);
  const after = await page.evaluate(() => ({ net: window._game.net, destroyed: window.__destroyed }));
  check(!o.visible && o.mode === 'solo' && o.state === 'playing' && after.net === null && after.destroyed === 1, `${role}: rides on as a solo ride`, { ...o, ...after });
  await page.close();
}

// ── Local co-op: P2 drop → ride on alone; P1 drop → Player 2 takes over ──
for (const who of ['p2', 'p1']) {
  console.log('local ' + who);
  const page = await rideSolo();
  // Turn the solo ride into a local co-op ride with a fake-pluggable P2 pad.
  const ok = await page.evaluate(async () => {
    const g = window._game;
    const InputManager = g.input.constructor;
    const inputP2 = new InputManager({ enableKeyboard: false, enableTouch: false, enableMotion: false });
    window.__p2pad = true;
    Object.defineProperty(inputP2, 'gamepadConnected', { configurable: true, get: () => window.__p2pad });
    const { SharedPedalController } = await import('/js/shared-pedal-controller.js');
    const { BalanceController } = await import('/js/balance-controller.js');
    g.mode = 'local'; g.inputP2 = inputP2; g._localP2Type = 'gamepad';
    g.balanceCtrlP2 = new BalanceController(inputP2);
    g.sharedPedal = new SharedPedalController();
    window.__p1Input = g.input; window.__p2Input = inputP2;
    return true;
  });
  check(ok, `local ${who}: set up a local co-op ride`);
  await sleep(800);
  await page.evaluate((who) => { if (who === 'p2') window.__p2pad = false; else window.__p1pad = false; }, who);
  await sleep(1200);
  let o = await overlay(page);
  const want = who === 'p2' ? /Player 2's controller/ : /Player 1's controller/;
  check(o.visible && o.who === who && want.test(o.msg), `local ${who}: drop pauses`, o.msg);
  check(o.resume === (who === 'p1') && !o.alone && !o.retry, `local ${who}: buttons before 20 s`, o);
  await skipWait(page); await sleep(800); o = await overlay(page);
  const label = who === 'p2' ? /Ride on alone/ : /Player 2: take over/;
  await page.screenshot({ path: path.join(OUT, `local-${who}-after-20s.png`) });
  check(o.alone && label.test(o.aloneText), `local ${who}: after 20 s "${who === 'p2' ? 'Ride on alone' : 'Player 2: take over'}"`, o.aloneText);
  await page.evaluate(() => document.getElementById('btn-ride-alone').click());
  await sleep(1500); o = await overlay(page);
  const seat = await page.evaluate(() => ({ p2: window._game.inputP2, isP2: window._game.input === window.__p2Input, isP1: window._game.input === window.__p1Input }));
  check(!o.visible && o.mode === 'solo' && o.state === 'playing' && seat.p2 === null && (who === 'p1' ? seat.isP2 : seat.isP1),
    `local ${who}: ${who === 'p1' ? 'Player 2 rides the bike solo' : 'Player 1 rides on solo'}`, { ...o, ...seat, p2: !!seat.p2 });
  if (who === 'p1') {
    await page.evaluate(() => window._game._returnToLobby());
    await sleep(500);
    check(await page.evaluate(() => window._game.input === window.__p1Input), 'local p1: P1 input back in the seat at the lobby');
  }
  await page.close();
}

check(errors.length === 0, 'no page errors', errors);
await browser.close(); server.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
