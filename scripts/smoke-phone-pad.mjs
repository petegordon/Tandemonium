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
// #454: the QR is single-use (an old QR is refused, the paired phone still
// reconnects with its own key), menus send less, a takeover is reported, and
// the version mixes: this game with an older phone (a script that never says
// hello) and an older game (a script host) with this phone page.
//
//   npm run smoke:phone-pad
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { encodeFrame, makePadCode, makePadSecret, sha256hex, buildPadLink, PAD_INPUT } from '../js/remote/pad-protocol.js';

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
  // A smaller window: on a CI runner software WebGL draws ~1-2 fps at 1280x800,
  // and the phone's timing checks need the game to keep up.
  await game.setViewport({ width: 960, height: 600 });
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

  // ── #454: single-use QR ──
  {
    await game.waitForFunction((l) => window.__phonePad.link !== l, { timeout: 8000 }, link).catch(() => {});
    const g = await game.evaluate(() => ({ link: window.__phonePad.link, phoneV: window.__phonePad.phoneVersion, relayV: window.__phonePad.relayVersion }));
    const keys = await phone.evaluate(() => window.__pad.keys.slice());
    const qrSecret = link.split('#k=')[1];
    check(g.link !== link && g.phoneV >= 2 && g.relayV >= 2, 'after pairing, the QR moves to a new secret', JSON.stringify({ ...g, link: g.link.replace(/#k=.*/, '#k=…') }));
    // The QR secret stays as a fallback until the phone's own key has worked once.
    check(keys[0] !== qrSecret && keys[1] === qrSecret, 'the phone holds its own key first, the QR secret as fallback', String(keys.length));
    const reuse = await phoneBrowser.newPage();
    await wire(reuse);
    await reuse.goto(link, { waitUntil: 'domcontentloaded' });
    await reuse.click('#btn-connect');
    await sleep(2500);
    const r = await reuse.evaluate(() => window.__pad.hostHere);
    const still = await game.evaluate(() => ({ status: window.__phonePad.status, takeovers: window.__phonePad.takeovers }));
    check(!r && still.status === 'connected' && still.takeovers === 0, 'the old QR no longer opens the seat; the phone keeps it', JSON.stringify({ reused: r, ...still }));
    await reuse.close();
  }

  // Stand-in sensors: a steady deviceorientation stream the test can tilt.
  await phone.evaluate(() => {
    window.__tilt = 0;
    setInterval(() => {
      const e = new Event('deviceorientation');
      Object.assign(e, { alpha: 0, beta: 5, gamma: window.__tilt });
      window.dispatchEvent(e);
    }, 16);
  });
  // Level until the game's tilt pipeline has calibrated its centre (5 warm-up +
  // 10 samples). In menus a still phone sends only a ~2/s heartbeat, so this
  // takes seconds; the old fixed 800 ms often tilted mid-calibration, the centre
  // averaged in some of the 35° and landed at 15–19°, and "tilt right" then
  // read 0.36–0.39 (flaky on main too; #522 investigation). Poll, don't sleep.
  const centred = await game.waitForFunction(() => {
    const i = window._game.input;
    return i.motionOffset !== null && !i._calibrating;
  }, { timeout: 20000, polling: 200 }).then(() => true).catch(() => false);
  check(centred, 'the game calibrates the phone\'s centre while it is held level');
  // The lean eases in over the game's frames; at headless frame rates that can
  // take a few seconds, so poll (up to 8 s) instead of one fixed wait.
  const leanWait = async (ok) => {
    const t0 = Date.now(); let v;
    do { await sleep(300); v = await game.evaluate(() => window._game.input.getMotionLeanVisual()); } while (!ok(v) && Date.now() - t0 < 8000);
    return v;
  };
  await phone.evaluate(() => { window.__tilt = 35; });
  const leanR = await leanWait((v) => v > 0.4);
  const lean = await game.evaluate((v) => ({ visual: v, motion: window._game.input.motionEnabled, frames: window.__phonePad.framesReceived }), leanR);
  check(lean.motion && lean.visual > 0.4, 'tilting the phone right leans the game right', JSON.stringify(lean));
  await phone.evaluate(() => { window.__tilt = -35; });
  const leanL = await leanWait((v) => v < -0.4);
  check(leanL < -0.4, 'tilting left leans left', leanL.toFixed(2));
  await phone.evaluate(() => { window.__tilt = 0; });

  // ── #454: in menus a still phone sends only the heartbeat ──
  {
    await sleep(1000);
    const n0 = await phone.evaluate(() => window.__pad.framesSent);
    const f0 = await game.evaluate(() => window.__phonePad.framesReceived);
    await sleep(2000);
    const n = (await phone.evaluate(() => window.__pad.framesSent)) - n0;
    const f = (await game.evaluate(() => window.__phonePad.framesReceived)) - f0;
    const st = await game.evaluate(() => window.__phonePad.status);
    check(n >= 2 && n <= 8 && f >= 2 && st === 'connected', 'menus, phone still: a heartbeat (~2/s) instead of 30/s, and the game keeps the phone', JSON.stringify({ sent: n, received: f, st }));
  }

  // ── Phase 2: drive the menus from the phone's menu pad ──
  // The phone's layout never changes; the game reads presses by its own mode.
  const phoneLayoutFixed = () => phone.evaluate(() => {
    const seen = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0; };
    return seen('#controls [data-nav="ok"]') && seen('#btn-pause') && seen('#pedal-l') && seen('#pedal-r');
  });
  const hostMode = () => game.evaluate(() => window._game.phonePad?.mode);
  check(await phoneLayoutFixed(), 'in the lobby the phone shows its one layout (menu strip + pedals)');
  check(await hostMode() === 'menu', 'in the lobby the game reads the phone as a menu pad');
  check(await game.evaluate(() => window._game.input.gamepadConnected), 'the game sees the phone as a pad for the menus');
  // Headless software rendering runs the game at a few fps: hold each press
  // across several of its frames (a real phone press spans many).
  const press = async (nav, holdMs = 700) => {
    const el = await phone.$(`#controls [data-nav="${nav}"]`);
    const b = await el.boundingBox();
    await phone.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await phone.mouse.down(); await sleep(holdMs);
    // Hold until the game has seen the press for two of its frames: on a slow
    // runner (~1 fps) a whole tap can otherwise fall between two frames.
    const bit = { up: 1, down: 2, left: 4, right: 8, ok: 16, back: 32 }[nav] || 0;
    if (bit) {
      await game.waitForFunction((b) => (window._game.input._remoteNav & b) !== 0, { timeout: 5000 }, bit).catch(() => {});
      await game.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    await phone.mouse.up(); await sleep(700);
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
  // #454: a held button in menus streams at the full rate, so the game's
  // 400 ms "let go" rule doesn't cut it.
  {
    const el = await phone.$('#controls [data-nav="down"]');
    const b = await el.boundingBox();
    await phone.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await phone.mouse.down();
    await sleep(1200);
    const held = await game.evaluate(() => (window._game.input._remoteNav & 2) !== 0);
    await phone.mouse.up();
    await sleep(700);
    check(held, 'menus: a d-pad press held for over a second is still held in the game');
  }
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
    check(await phoneLayoutFixed() && await hostMode() === 'ride', 'riding: same phone layout; the game reads it as pedals');
    check(await game.evaluate(() => !window._game.input.gamepadConnected), 'riding: the phone is not a pad (ride hints unchanged)');
    check(await phone.evaluate(() => window.__pad.lastCue) === 'go', 'the phone got the GO cue', await phone.evaluate(() => window.__pad.lastCue));
    {
      const n0 = await phone.evaluate(() => window.__pad.framesSent);
      await sleep(1000);
      const n = (await phone.evaluate(() => window.__pad.framesSent)) - n0;
      check(n >= 20, 'riding: the phone streams at the full rate', `${n} frames/s`);
    }
    // Pedals: press and hold the left half, then the right half.
    // While held, poll (up to 3 s): on a slow runner the first frame can lag.
    const heldUntil = async (read, ok) => {
      const t0 = Date.now(); let v;
      do { await sleep(150); v = await game.evaluate(read); } while (!ok(v) && Date.now() - t0 < 3000);
      return v;
    };
    await phone.mouse.move(150, 250); await phone.mouse.down();
    const pl = await heldUntil(() => [window._game.input.isPressed('ArrowLeft'), window._game.input.isPressed('ArrowRight')], (v) => v[0] && !v[1]);
    await phone.mouse.up();
    await sleep(300);
    await phone.mouse.move(700, 250); await phone.mouse.down();
    const pr = await heldUntil(() => [window._game.input.isPressed('ArrowLeft'), window._game.input._remoteRight], (v) => v[1]);
    await phone.mouse.up();
    check(pl[0] && !pl[1], 'holding LEFT on the phone holds the left pedal', JSON.stringify(pl));
    check(pr[1], 'holding RIGHT on the phone holds the right pedal', JSON.stringify(pr));

    await sleep(1100);
    const before = await game.evaluate(() => window._game.bike?.speed);
    // Alternate strokes until the bike picks up (up to ~60): on a slow runner
    // the game sees only a few of them per second.
    for (let i = 0; i < 60; i++) {
      const x = i % 2 ? 700 : 150;
      await phone.mouse.move(x, 250); await phone.mouse.down();
      await sleep(140);
      await phone.mouse.up();
      await sleep(140);
      if (i >= 15 && i % 4 === 3 && (await game.evaluate(() => window._game.bike?.speed)) > before + 0.5) break;
    }
    const ride = await game.evaluate(() => ({ speed: window._game.bike?.speed, dist: window._game.bike?.distanceTraveled }));
    check(ride.speed > before + 0.5, 'pedalling on the phone speeds the bike up', JSON.stringify({ before, ...ride }));

    // Pause from the phone, resume with BACK. #529: paused = the pause menu (_pause); the phone shows its menu pad.
    await phone.click('#btn-pause');
    // Poll (up to 4 s): on a slow runner the tap can take a few game frames to land.
    await game.waitForFunction(() => window._game._pause, { timeout: 4000 }).catch(() => {});
    check(await game.evaluate(() => !!window._game._pause), 'Pause on the phone opens the pause menu (#459)');
    check(await phoneLayoutFixed() && await hostMode() === 'menu', 'paused: same phone layout; the game reads it as a menu pad');
    await press('back');
    await game.waitForFunction(() => !window._game._pause, { timeout: 4000 }).catch(() => {});
    check(await game.evaluate(() => !window._game._pause), 'BACK on the phone resumes');
    check(await phoneLayoutFixed() && await hostMode() === 'ride', 'resumed: same phone layout; pedals again');

    // The phone drops mid-ride (asleep / closed), then comes back.
    await phone.evaluate(() => { window.__pad.ws.onclose = null; window.__pad.ws.close(); window.__pad.ws = null; });
    await game.waitForFunction(() => window._game._pause && document.getElementById('phone-pad-panel').classList.contains('open'), { timeout: 8000 }).catch(() => {});
    const drop = await game.evaluate(() => ({ paused: !!window._game._pause, panel: document.getElementById('phone-pad-panel').classList.contains('open'), title: document.getElementById('ppp-title').textContent }));
    check(!!drop.paused && drop.panel && /DISCONNECTED/.test(drop.title), 'a dropped phone pauses the ride and shows the QR again', JSON.stringify(drop));
    // The phone page comes back to the foreground: it reconnects by itself.
    await phone.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await game.waitForFunction(() => window.__phonePad.status === 'connected', { timeout: 15000 }).catch(() => {});
    await game.waitForFunction(() => !document.getElementById('phone-pad-panel').classList.contains('open'), { timeout: 5000 }).catch(() => {});
    const back = await game.evaluate(() => ({ status: window.__phonePad.status, panel: document.getElementById('phone-pad-panel').classList.contains('open'), paused: !!window._game._pause }));
    check(back.status === 'connected' && !back.panel && !!back.paused, 'the phone reconnects; the QR closes and the game stays paused for the player', JSON.stringify(back));
    const k = await phone.evaluate(() => ({ n: window.__pad.keys.length }));
    const t = await game.evaluate(() => window.__phonePad.takeovers);
    check(k.n === 1 && t === 0, '#454: it came back with its own key (the old QR secret is dropped), not as a takeover', JSON.stringify({ keys: k.n, takeovers: t }));
    check(await phoneLayoutFixed() && await hostMode() === 'menu', 'reconnected while paused: same phone layout; read as a menu pad');
    await press('back');
    await game.waitForFunction(() => !window._game._pause && window._game.state === 'playing', { timeout: 8000 }).catch(() => {});
    check(await game.evaluate(() => !window._game._pause && window._game.state === 'playing'), 'BACK resumes the ride');
    // PR-05: after the reconnect the phone drives the ride again (pedal + lean).
    await phone.evaluate(() => { window.__tilt = 30; });
    await phone.mouse.move(150, 250); await phone.mouse.down();
    await game.waitForFunction(() => window._game.input.isPressed('ArrowLeft') && window._game.input.getMotionLean() > 0.1, { timeout: 8000 }).catch(() => {});
    const again = await game.evaluate(() => ({ left: window._game.input.isPressed('ArrowLeft'), lean: +window._game.input.getMotionLean().toFixed(2) }));
    await phone.mouse.up();
    await phone.evaluate(() => { window.__tilt = 0; });
    check(again.left && again.lean > 0.1, 'PR-05: after the reconnect the phone pedals and steers the ride again', JSON.stringify(again));
  }

  // ── someone with only the room code can't take the game's place ──
  {
    const code = await game.evaluate(() => window.__phonePad.code);
    const tryHost = (k) => new Promise((res) => {
      const ws = new WebSocket(RELAY + '/pad?code=' + code + '&role=host' + (k ? '&k=' + k : ''));
      ws.onopen = () => { ws.close(); res('open'); };
      ws.onerror = () => res('refused');
      setTimeout(() => res('timeout'), 5000);
    });
    const a = await tryHost(null), b = await tryHost('0'.repeat(32));
    await sleep(1500);
    const st = await game.evaluate(() => window.__phonePad.status);
    check(a === 'refused' && b === 'refused' && st === 'connected', 'a host without the room key is refused; the game keeps its phone', JSON.stringify({ a, b, st }));
  }

  // ── the game's own relay link blips: the phone stays paired ──
  {
    await game.evaluate(() => window.__phonePad._ws.close());
    await sleep(4000);
    const g = await game.evaluate(() => ({ status: window.__phonePad.status, drops: window.__phonePad.drops.length }));
    const p = await phone.evaluate(() => ({ host: window.__pad.hostHere, gone: window.__pad.closedForGood }));
    check(g.status === 'connected' && p.host && !p.gone, 'the game reconnects to the relay and the phone stays paired', JSON.stringify({ ...g, ...p }));
  }

  // ── the phone leaves: input is released ──
  await phone.evaluate(() => { window.__tilt = 35; });
  await phone.mouse.move(150, 250); await phone.mouse.down();
  await game.waitForFunction(() => window._game.input.getMotionLean() > 0.1, { timeout: 8000 }).catch(() => {});
  // PR-05 / #424: when the phone goes, the lean eases to 0 over
  // REMOTE_LEAN_EASE_MS (300) instead of snapping. The ease is read from the
  // clock, so sample it inside the drop itself, at fixed times after it, and
  // the result doesn't depend on the game's frame rate.
  await game.evaluate(() => {
    const im = window._game.input, orig = im.detachRemote.bind(im);
    im.detachRemote = (...a) => {
      const r = orig(...a);
      if (!window.__leanEase) {
        const t0 = performance.now(), spin = (ms) => { while (performance.now() - t0 < ms) { /* wait */ } };
        const s = [];
        for (const ms of [0, 100, 200, 360]) { spin(ms); s.push(+im.getMotionLean().toFixed(3)); }
        window.__leanEase = s;
      }
      return r;
    };
  });
  await phone.close();
  await game.waitForFunction(() => window.__phonePad.status === 'waiting', { timeout: 10000 }).catch(() => {});
  await sleep(400);   // #424: the lean eases to 0 over 300 ms rather than snapping
  const after = await game.evaluate(() => ({ status: window.__phonePad.status, left: window._game.input.isPressed('ArrowLeft'), lean: window._game.input.getMotionLean() }));
  check(after.status === 'waiting' && !after.left && after.lean === 0, 'closing the phone page releases the pedal and the lean', JSON.stringify(after));
  const ease = await game.evaluate(() => window.__leanEase || null);
  // [at the drop, +100 ms, +200 ms, +360 ms]: from the held lean, falling, same side, then 0.
  check(!!ease && ease[0] > 0.1 && ease[1] < ease[0] && ease[1] > 0 && ease[2] < ease[1] && ease[2] > 0 && ease[3] === 0,
    'PR-05: the lean eases back to centre over ~300 ms (no snap)', JSON.stringify(ease));

  /** A script WebSocket that records what it gets. */
  const scriptSocket = (url) => new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.got = [];
    ws.onmessage = (ev) => ws.got.push(typeof ev.data === 'string' ? JSON.parse(ev.data) : new Uint8Array(ev.data));
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('script socket refused: ' + url.replace(/k=[^&]+/, 'k=…')));
  });

  // ── #454 mix: this game + an OLDER phone (never says hello) — also a takeover ──
  {
    const cur = await game.evaluate(() => ({ link: window.__phonePad.link, code: window.__phonePad.code }));
    const secret = cur.link.split('#k=')[1];
    const old = await scriptSocket(`${RELAY}/pad?code=${cur.code}&role=pad-1&k=${secret}`);
    let seq = 0;
    const pump = setInterval(() => old.send(encodeFrame({ seq: ++seq & 0xff, tilt: 0, left: false, right: false, tapsL: 0, tapsR: 0, nav: 0 })), 33);
    await game.waitForFunction(() => window.__phonePad.status === 'connected', { timeout: 10000 }).catch(() => {});
    await sleep(1500);
    const g = await game.evaluate(() => ({
      status: window.__phonePad.status, phoneV: window.__phonePad.phoneVersion, link: window.__phonePad.link,
      takeovers: window.__phonePad.takeovers, note: document.getElementById('phone-pad-note')?.classList.contains('on'),
    }));
    const types = old.got.filter((m) => !(m instanceof Uint8Array)).map((m) => m.type);
    check(g.status === 'connected' && g.phoneV === 1, 'an older phone (no hello) still pairs and drives the game', JSON.stringify({ status: g.status, phoneV: g.phoneV }));
    check(!types.some((t) => t === 'rekey' || t === 'mode' || t === 'hello') && g.link === cur.link, 'an older phone is sent nothing new, and its QR keeps working', JSON.stringify(types));
    check(g.takeovers === 1 && g.note, 'it took the seat from the phone that had a key: the game says so', JSON.stringify({ takeovers: g.takeovers, note: g.note }));
    clearInterval(pump);
    old.close();
  }

  // ── #454 mix: an OLDER game (a script host: no hello, 'allow' only) + this phone page ──
  {
    const code = makePadCode(), hostKey = makePadSecret(), secret = makePadSecret();
    const oldHost = await scriptSocket(`${RELAY}/pad?code=${code}&role=host&k=${hostKey}`);
    oldHost.send(JSON.stringify({ type: 'allow', seat: 1, hash: await sha256hex(secret) }));
    // A much older game also told the phone its mode; without hello it must change nothing.
    const p = await phoneBrowser.newPage();
    await p.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: false });
    await wire(p);
    await p.goto(buildPadLink(`http://127.0.0.1:${PORT}/`, code, 1, secret, { relay: RELAY }), { waitUntil: 'domcontentloaded' });
    await p.click('#btn-connect');
    for (let i = 0; i < 40 && !oldHost.got.some((m) => m.type === 'pad-joined'); i++) await sleep(250);
    oldHost.send(JSON.stringify({ type: 'to-pad', seat: 1, msg: { type: 'seat', seat: 1, label: 'Player 1' } }));
    oldHost.send(JSON.stringify({ type: 'to-pad', seat: 1, msg: { type: 'mode', mode: 'menu' } }));
    await sleep(500);
    const from = oldHost.got.length;
    await sleep(1500);
    const frames = oldHost.got.slice(from).filter((m) => m instanceof Uint8Array);
    const ph = await p.evaluate(() => ({ host: window.__pad.hostHere, v: window.__pad.hostVersion, keys: window.__pad.keys.length }));
    check(ph.host && ph.v === 1 && ph.keys === 1, 'this phone page pairs with an older game', JSON.stringify(ph));
    check(frames.length >= 30 && frames.every((f) => f[0] === 1 && f[1] === PAD_INPUT), 'an older game gets 30 Hz frames in the layout it reads (0x50), even after an old "mode"', `${frames.length} frames in 1.5 s`);
    await p.close();
    oldHost.close();
  }
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
