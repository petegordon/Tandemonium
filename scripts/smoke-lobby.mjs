#!/usr/bin/env node
// ============================================================
// smoke-lobby.mjs — does the game still load?
// ============================================================
//
// Plan rule 3: "keep the game playable at every commit". There is no build
// step, so nothing catches a typo in js/*.js until someone opens the page.
// This serves the repo, opens index.html in headless Chrome, waits for the
// lobby, optionally starts a ride, and fails on any console error or uncaught
// exception. It is not a gameplay test — it is the tripwire for a broken import
// or a syntax error in a module the lobby loads.
//
//   node scripts/smoke-lobby.mjs            # lobby only
//   node scripts/smoke-lobby.mjs --ride     # also start a solo ride
//   node scripts/smoke-lobby.mjs --insecure # serve over an insecure context
//
// Screenshots land in out/smoke/ when --shot is passed.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 8901);
const WANT_RIDE = process.argv.includes('--ride');
const WANT_SHOT = process.argv.includes('--shot');
// A page served over plain http from anything but localhost is NOT a secure
// context, and the SecureContext-only APIs — crypto.randomUUID, crypto.subtle —
// are undefined rather than merely restricted. That is how a phone reaches the
// site from an http:// link, and an unguarded call there is a hard boot failure.
// 127.0.0.1 is always treated as trustworthy, so reproducing it needs a real
// hostname mapped back to loopback.
const INSECURE = process.argv.includes('--insecure');
const HOST = INSECURE ? 'tandemonium.test' : '127.0.0.1';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
});
await new Promise(r => server.listen(PORT, INSECURE ? '0.0.0.0' : '127.0.0.1', r));

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
    ...(INSECURE ? ['--host-resolver-rules=MAP ' + HOST + ' 127.0.0.1'] : [])]
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

// Serve three (and its addons) from node_modules instead of the CDN, and drop
// every other third-party script. CI and the dev sandbox may have no route to
// the CDN at all, and the lobby does not need PeerJS or the sign-in widget to
// come up — this keeps the smoke test about OUR code.
const LOCAL = [
  [/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/build\/three\.module\.js/, 'node_modules/three/build/three.module.js'],
  [/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/examples\/jsm\/(.+)$/, 'node_modules/three/examples/jsm/$1']
];
await page.setRequestInterception(true);
page.on('request', (req) => {
  const reqUrl = req.url();
  if (reqUrl.startsWith(`http://${HOST}:${PORT}`)) return req.continue();
  for (const [re, target] of LOCAL) {
    const m = reqUrl.match(re);
    if (m) {
      const rel = target.includes('$1') ? target.replace('$1', m[1]) : target;
      const file = path.join(ROOT, rel);
      if (fs.existsSync(file)) {
        return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(file) });
      }
    }
  }
  return req.abort();
});

const errors = [];
// Network noise we do not control: the CDN scripts and the Google sign-in
// widget are blocked or slow in CI; the game runs without them.
const IGNORE = [
  /accounts\.google\.com/i, /gsi\/client/i, /peerjs/i, /qrcode/i,
  /favicon/i, /ERR_INTERNET_DISCONNECTED/i, /net::ERR_/i,
  /Failed to load resource/i, /AudioContext/i, /WebGL/i, /GroupMarkerNotSet/i
];
const ignored = (text) => IGNORE.some(re => re.test(text));

page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (!ignored(text)) errors.push(`console.error: ${text}`);
});
page.on('pageerror', (err) => {
  const text = String(err && err.message || err);
  if (!ignored(text)) errors.push(`pageerror: ${text}`);
});

const url = `http://${HOST}:${PORT}/index.html`;
console.log(`→ ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

// js/game.js sets window._game at the bottom of the module. If that global is
// missing, some module in the graph threw or failed to parse — which is exactly
// the failure this script exists to catch.
await page.waitForFunction(() => !!window._game, { timeout: 30000 })
  .catch(() => { errors.push('window._game never appeared — a module failed to load'); });

const state = await page.evaluate(() => ({
  hasGame: !!window._game,
  hasScene: !!(window._game && window._game.scene),
  hasLobby: !!document.querySelector('#lobby')
}));
if (!state.hasGame) errors.push('game modules did not initialise');
if (!state.hasScene) errors.push('the three.js scene was never built');
if (!state.hasLobby) errors.push('the lobby markup is missing');

if (WANT_SHOT) {
  fs.mkdirSync(path.join(ROOT, 'out', 'smoke'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'out', 'smoke', 'lobby.png') });
}

if (WANT_RIDE) {
  // Start whatever the lobby's primary action is, then let a few seconds of
  // the ride loop run so update paths (pedal, bike, HUD) actually execute.
  const started = await page.evaluate(() => {
    const btn = document.querySelector('#start-btn, #play-btn, .lobby-play, [data-action="play"]');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!started) console.log('  (no start button found — skipped the ride leg)');
  await new Promise(r => setTimeout(r, 6000));
  if (WANT_SHOT) await page.screenshot({ path: path.join(ROOT, 'out', 'smoke', 'ride.png') });
}

await browser.close();
server.close();

if (errors.length) {
  console.error(`\n✖ ${errors.length} error(s):`);
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
  process.exit(1);
}
console.log('✔ lobby loaded clean');
