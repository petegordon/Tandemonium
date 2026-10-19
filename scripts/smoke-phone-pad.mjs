#!/usr/bin/env node
// smoke-phone-pad.mjs — phone remote (#421) end to end, locally.
//
// Starts the pad relay (worker/pad-relay.js) under `wrangler dev`, serves the
// game, opens the game in one headless browser and the phone page in another
// (two browsers, so neither is a throttled background tab). The "phone" gets a
// stand-in deviceorientation stream and mouse presses on its pedal halves.
// Checks: pairing, tilt → the game's lean, pedals → the game's input, a wrong
// secret is refused; then (Phase 2) the whole SOLO ride driven from the phone:
// d-pad + OK through the lobby, pedals while riding, Pause / BACK, a dropped
// phone pausing the ride and reconnecting, and the phone leaving releasing it.
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

  // ── Phase 2: drive the menus from the phone's menu pad ──
  const phoneMode = () => phone.evaluate(() => (document.getElementById('screen-ride').classList.contains('menu') ? 'menu' : 'ride'));
  check(await phoneMode() === 'menu', 'in the lobby the phone shows its menu pad');
  check(await game.evaluate(() => window._game.input.gamepadConnected), 'the game sees the phone as a pad for the menus');
  // Headless software rendering runs the game at a few fps: hold each press
  // across several of its frames (a real phone press spans many).
  const press = async (nav, holdMs = 700) => {
    const el = await phone.$(`#menu-pad [data-nav="${nav}"]`);
    const b = await el.boundingBox();
    await phone.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await phone.mouse.down(); await sleep(holdMs); await phone.mouse.up(); await sleep(700);
  };
  const focused = () => game.evaluate(() => {
    const el = document.querySelector('.gamepad-focus');
    return el ? ((el.id ? '#' + el.id + ' ' : '') + (el.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 60) : '';
  });
  /** Move the game's focus with the phone d-pad until it matches `re`, then OK. */
  const focusAndPick = async (re, label) => {
    const dirs = ['down', 'right', 'up', 'left', 'down', 'right'];
    let f = await focused();
    const trail = [f];
    for (const dir of dirs) {
      for (let i = 0; i < 6 && !re.test(f); i++) { await press(dir); f = await focused(); trail.push(dir + '>' + f.slice(0, 24)); }
      if (re.test(f)) break;
    }
    check(re.test(f), `phone d-pad reaches ${label}`, re.test(f) ? JSON.stringify(f) : JSON.stringify(trail));
    await press('ok');
    await sleep(700);
  };
  await focusAndPick(/btn-solo/i, 'SOLO RIDE');
  // The level step opens on START RIDE with the default level (Grandma's) selected.
  check(await game.evaluate(() => window._game.lobby.selectedLevel?.id) === 'grandma', "Grandma's is the selected level");
  await focusAndPick(/start ride/i, 'START RIDE');
  await game.waitForFunction(() => window._game?.state !== 'lobby', { timeout: 15000 }).catch(() => {});
  const st = await game.evaluate(() => window._game.state);
  check(st !== 'lobby', 'OK on the phone leaves the lobby for the ride', st);
  if (st === 'instructions') { await press('ok'); }

  let playing = true;
  try { await game.waitForFunction(() => window._game?.state === 'playing', { timeout: 120000 }); }
  catch { playing = false; }
  check(playing, "SOLO Grandma's ride starts, driven from the phone", await game.evaluate(() => window._game?.state));
  if (playing) {
    await sleep(400);
    check(await phoneMode() === 'ride', 'riding: the phone switches to its pedals');
    check(await game.evaluate(() => !window._game.input.gamepadConnected), 'riding: the phone is not a pad (ride hints unchanged)');
    check(await phone.evaluate(() => window.__pad.lastCue) === 'go', 'the phone got the GO cue', await phone.evaluate(() => window.__pad.lastCue));
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

    await sleep(1100);
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

    // Pause from the phone, resume with BACK.
    await phone.click('#btn-pause');
    await sleep(500);
    check(await game.evaluate(() => window._game._optionsOpen), 'Pause on the phone pauses the game');
    check(await phoneMode() === 'menu', 'paused: the phone shows its menu pad');
    await press('back');
    await sleep(500);
    check(await game.evaluate(() => !window._game._optionsOpen), 'BACK on the phone resumes');
    check(await phoneMode() === 'ride', 'resumed: pedals again');

    // The phone drops mid-ride (asleep / closed), then comes back.
    await phone.evaluate(() => { window.__pad.ws.onclose = null; window.__pad.ws.close(); window.__pad.ws = null; });
    await game.waitForFunction(() => window._game._optionsOpen && document.getElementById('phone-pad-panel').classList.contains('open'), { timeout: 8000 }).catch(() => {});
    const drop = await game.evaluate(() => ({ paused: window._game._optionsOpen, panel: document.getElementById('phone-pad-panel').classList.contains('open'), title: document.getElementById('ppp-title').textContent }));
    check(drop.paused && drop.panel && /DISCONNECTED/.test(drop.title), 'a dropped phone pauses the ride and shows the QR again', JSON.stringify(drop));
    // The phone page comes back to the foreground: it reconnects by itself.
    await phone.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await game.waitForFunction(() => window.__phonePad.status === 'connected', { timeout: 15000 }).catch(() => {});
    await game.waitForFunction(() => !document.getElementById('phone-pad-panel').classList.contains('open'), { timeout: 5000 }).catch(() => {});
    const back = await game.evaluate(() => ({ status: window.__phonePad.status, panel: document.getElementById('phone-pad-panel').classList.contains('open'), paused: window._game._optionsOpen }));
    check(back.status === 'connected' && !back.panel && back.paused, 'the phone reconnects; the QR closes and the game stays paused for the player', JSON.stringify(back));
    check(await phoneMode() === 'menu', 'reconnected while paused: the phone shows its menu pad');
    await press('back');
    await sleep(500);
    check(await game.evaluate(() => !window._game._optionsOpen && window._game.state === 'playing'), 'BACK resumes the ride');
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
