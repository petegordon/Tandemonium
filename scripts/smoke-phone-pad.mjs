#!/usr/bin/env node
// smoke-phone-pad.mjs — phone remote (#421) end to end, locally.
//
// Starts the pad relay (worker/pad-relay.js) under `wrangler dev`, serves the
// game, opens the game in one headless browser and the phone page in another
// (two browsers, so neither is a throttled background tab). The "phone" gets a
// stand-in deviceorientation stream and mouse presses on its pedal halves.
// Checks: pairing, tilt → the game's lean, pedals → the game's input, a wrong
// secret is refused, the phone leaving releases the input, and a SOLO ride
// pedalled only from the phone moves the bike.
//
//   npm run smoke:phone-pad
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import puppeteer from 'puppeteer';

const ROOT = process.cwd();
const PORT = 8931;
const RELAY_PORT = 8791;
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.json': 'application/json' };

let failures = 0;
const check = (ok, label, extra = '') => { console.log(`${ok ? '  ok ' : '  FAIL'} ${label}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── pad relay under wrangler dev ──
const wrangler = spawn('npx', ['wrangler', 'dev', '--config', 'worker/wrangler-pad.toml', '--port', String(RELAY_PORT), '--ip', '127.0.0.1', '--show-interactive-dev-session=false'],
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
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${RELAY_PORT}/`); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}

// ── static game server ──
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u.endsWith('/')) u += 'index.html';
  const f = path.join(ROOT, u);
  fs.stat(f, (e, st) => {
    if (e || st.isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// three.js from node_modules (as the other smokes do); everything else off-site aborted.
async function wire(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith('data:')) return req.continue();
    let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
    if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')) });
    m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/);
    const f = m && path.join(ROOT, 'node_modules/three/examples/jsm/' + m[1]);
    if (f && fs.existsSync(f)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
    return req.abort();
  });
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) console.log('     console.error:', msg.text().slice(0, 160)); });
  page.on('response', (r) => { if (r.status() === 404) console.log('     404:', new URL(r.url()).pathname); });
  page.on('pageerror', (err) => console.log('     pageerror:', String(err).slice(0, 200)));
}

const ARGS = ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'];
let gameBrowser, phoneBrowser;
try {
  console.log('pad relay (wrangler dev) …');
  if (!(await waitForRelay())) { console.log(wlog.slice(-2000)); throw new Error('pad relay did not start'); }

  gameBrowser = await puppeteer.launch({ headless: 'new', args: ARGS });
  phoneBrowser = await puppeteer.launch({ headless: 'new', args: ARGS });

  // ── the game ──
  const game = await gameBrowser.newPage();
  await game.setViewport({ width: 1280, height: 800 });
  await wire(game);
  await game.evaluateOnNewDocument(() => { try { localStorage.setItem('tandemonium_tutorial_done', 'smoke'); } catch {} });
  await game.goto(`http://127.0.0.1:${PORT}/index.html?padRelay=${encodeURIComponent(RELAY)}`, { waitUntil: 'domcontentloaded' });
  await game.waitForFunction(() => !!window._game && !!window.__phonePad, { timeout: 60000 });
  await game.click('#tap-to-start').catch(() => {});
  await sleep(500);

  const hasQrLib = await game.evaluate(() => typeof window.qrcode === 'function');
  if (!hasQrLib) console.log('     (qrcode lib not available offline — the QR is skipped, the link still works)');
  await game.evaluate(() => document.getElementById('btn-mode-phone').click());
  await game.waitForFunction(() => window.__phonePad.status === 'waiting', { timeout: 15000 });
  const link = await game.evaluate(() => window.__phonePad.link);
  check(/\/remote\/\?pad=[A-Z2-9]{6}&seat=1&relay=.+#k=[0-9a-f]{32}$/.test(link), 'game shows a pad link with the secret in the #fragment', link.replace(/#k=.*/, '#k=…'));
  check(await game.evaluate(() => document.getElementById('phone-pad-panel').classList.contains('open')), 'the QR panel opens');

  // ── a phone with the WRONG secret is refused ──
  {
    const bad = await phoneBrowser.newPage();
    await wire(bad);
    await bad.goto(link.replace(/#k=.*/, '#k=' + '0'.repeat(32)), { waitUntil: 'domcontentloaded' });
    await bad.click('#btn-connect');
    await sleep(2500);
    const s = await bad.evaluate(() => ({ host: window.__pad.hostHere, status: document.getElementById('status').textContent }));
    check(!s.host && /Reconnecting|Connecting/.test(s.status), 'a wrong secret is not let in', JSON.stringify(s));
    check(await game.evaluate(() => window.__phonePad.status) === 'waiting', 'game still waiting after the bad phone');
    await bad.close();
  }

  // ── the real phone ──
  const phone = await phoneBrowser.newPage();
  await phone.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: false });
  await wire(phone);
  await phone.goto(link, { waitUntil: 'domcontentloaded' });
  check(await phone.evaluate(() => !location.hash), 'the phone page removes the secret from the address bar');
  await phone.click('#btn-connect');
  await game.waitForFunction(() => window.__phonePad.status === 'connected', { timeout: 15000 });
  check(true, 'phone connected to the game');
  await game.waitForFunction(() => !document.getElementById('phone-pad-panel').classList.contains('open'), { timeout: 5000 }).catch(() => {});
  check(await game.evaluate(() => !document.getElementById('phone-pad-panel').classList.contains('open')), 'the QR panel closes itself once the phone is in');

  // Stand-in sensors: a steady deviceorientation stream the test can tilt.
  await phone.evaluate(() => {
    window.__tilt = 0;
    setInterval(() => {
      const e = new Event('deviceorientation');
      Object.assign(e, { alpha: 0, beta: 5, gamma: window.__tilt });
      window.dispatchEvent(e);
    }, 16);
  });
  await sleep(800);   // level: lets the game's tilt pipeline calibrate its centre
  await phone.evaluate(() => { window.__tilt = 35; });
  await sleep(1500);
  const lean = await game.evaluate(() => ({ visual: window._game.input.getMotionLeanVisual(), motion: window._game.input.motionEnabled, frames: window.__phonePad.framesReceived }));
  check(lean.motion && lean.visual > 0.4, 'tilting the phone right leans the game right', JSON.stringify(lean));
  await phone.evaluate(() => { window.__tilt = -35; });
  await sleep(1500);
  const leanL = await game.evaluate(() => window._game.input.getMotionLeanVisual());
  check(leanL < -0.4, 'tilting left leans left', leanL.toFixed(2));
  await phone.evaluate(() => { window.__tilt = 0; });

  // Pedals: press and hold the left half, then the right half.
  await phone.mouse.move(150, 250); await phone.mouse.down();
  await sleep(300);
  const pl = await game.evaluate(() => [window._game.input.isPressed('ArrowLeft'), window._game.input.isPressed('ArrowRight')]);
  await phone.mouse.up();
  await phone.mouse.move(700, 250); await phone.mouse.down();
  await sleep(300);
  const pr = await game.evaluate(() => [window._game.input.isPressed('ArrowLeft'), window._game.input._remoteRight]);
  await phone.mouse.up();
  check(pl[0] && !pl[1], 'holding LEFT on the phone holds the left pedal', JSON.stringify(pl));
  check(pr[1], 'holding RIGHT on the phone holds the right pedal', JSON.stringify(pr));

  // ── a SOLO ride pedalled only from the phone ──
  await game.evaluate(() => document.getElementById('btn-solo').click());
  await sleep(900);
  await game.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('button, uf-button, .level-card, [class*="level"]'))
      .filter((el) => el.offsetParent !== null && /grandma/i.test(el.textContent || ''));
    (cards[0] || document.querySelector('.level-card'))?.click();
  });
  await sleep(500);
  await game.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, uf-button')).find((x) => /start ride/i.test(x.textContent || ''));
    b && b.click();
  });
  await sleep(800);
  await game.evaluate(() => { document.body.click(); document.getElementById('instructions')?.click(); });
  let playing = true;
  try { await game.waitForFunction(() => window._game?.state === 'playing', { timeout: 120000 }); }
  catch { playing = false; }
  check(playing, 'SOLO Grandma\'s ride starts', await game.evaluate(() => window._game?.state));
  if (playing) {
    await sleep(1500);
    const before = await game.evaluate(() => window._game.bike?.speed);
    for (let i = 0; i < 16; i++) {
      const x = i % 2 ? 700 : 150;
      await phone.mouse.move(x, 250); await phone.mouse.down();
      await sleep(140);
      await phone.mouse.up();
      await sleep(140);
    }
    const ride = await game.evaluate(() => ({ speed: window._game.bike?.speed, dist: window._game.bike?.distanceTraveled }));
    check(ride.speed > before + 0.5, 'pedalling on the phone speeds the bike up', JSON.stringify({ before, ...ride }));
  }

  // ── the phone leaves: input is released ──
  await phone.evaluate(() => { window.__tilt = 35; });
  await phone.mouse.move(150, 250); await phone.mouse.down();
  await sleep(600);
  await phone.close();
  await game.waitForFunction(() => window.__phonePad.status === 'waiting', { timeout: 10000 }).catch(() => {});
  const after = await game.evaluate(() => ({ status: window.__phonePad.status, left: window._game.input.isPressed('ArrowLeft'), lean: window._game.input.getMotionLean() }));
  check(after.status === 'waiting' && !after.left && after.lean === 0, 'closing the phone page releases the pedal and the lean', JSON.stringify(after));
} catch (e) {
  console.log('  FAIL', e.message);
  failures++;
} finally {
  await gameBrowser?.close().catch(() => {});
  await phoneBrowser?.close().catch(() => {});
  server.close();
  killWrangler();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nphone pad smoke: all checks passed');
process.exit(failures ? 1 : 0);
