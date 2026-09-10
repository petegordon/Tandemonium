#!/usr/bin/env node
// audit-first-30s.mjs — #263 bounce audit: cold-load numbers per device profile.
// Writes out/bounce-audit.json. See docs/playtests/2026-09-bounce-audit.md.
// #263 · first-30-seconds bounce audit, measured rather than guessed.
// Loads the game cold in a set of device profiles and records what a first-time
// player would experience: when the page paints, when the lobby is usable,
// what the first screen says, and how many taps stand between load and riding.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = process.cwd();
const PORT = 8909;
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.glb':'model/gltf-binary',
  '.mp3':'audio/mpeg', '.json':'application/json', '.ico':'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const three = 'node_modules/three/build/three.module.js';
const addons = (m) => `node_modules/three/examples/jsm/${m}`;

const PROFILES = [
  { name: 'Desktop Chrome (keyboard)', viewport: { width: 1440, height: 900 }, mobile: false },
  { name: 'iPhone 13 Safari-ish',      viewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', mobile: true },
  { name: 'Pixel 7 Chrome',            viewport: { width: 412, height: 915, isMobile: true, hasTouch: true },
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', mobile: true },
  { name: 'Steam Deck (1280x800)',     viewport: { width: 1280, height: 800 }, mobile: false }
];

const browser = await puppeteer.launch({ headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });

const rows = [];
for (const prof of PROFILES) {
  const page = await browser.newPage();
  await page.setViewport(prof.viewport);
  if (prof.ua) await page.setUserAgent(prof.ua);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith(`http://127.0.0.1:${PORT}`)) return req.continue();
    let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
    if (m) return req.respond({ status: 200, contentType: 'text/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, three)) });
    m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/);
    if (m && fs.existsSync(path.join(ROOT, addons(m[1])))) return req.respond({ status: 200, contentType: 'text/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, addons(m[1]))) });
    return req.abort();
  });

  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  const firstPaintMs = Date.now() - t0;
  const veilText = await page.evaluate(() => document.getElementById('tap-to-start-text')?.textContent?.trim());

  let bootMs = null;
  try {
    await page.waitForFunction(() => !!window._game, { timeout: 45000 });
    bootMs = Date.now() - t0;
  } catch {}

  // When is the lobby actually usable — i.e. the veil gone and a ride button live?
  let usableMs = null;
  try {
    await page.waitForFunction(() => {
      const veil = document.getElementById('tap-to-start');
      const gone = !veil || veil.classList.contains('fade-out') || veil.offsetParent === null;
      const solo = document.getElementById('btn-solo') || document.querySelector('[id*="solo" i], [id*="ride" i]');
      return gone && !!solo;
    }, { timeout: 45000 });
    usableMs = Date.now() - t0;
  } catch {}

  const screen = await page.evaluate(() => {
    const visible = (el) => el && el.offsetParent !== null;
    const buttons = Array.from(document.querySelectorAll('button, .lobby-btn, [role="button"]'))
      .filter(visible)
      .map(b => (b.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 0 && t.length < 40);
    return {
      veilVisible: visible(document.getElementById('tap-to-start')),
      veilText: document.getElementById('tap-to-start-text')?.textContent?.trim(),
      buttons: buttons.slice(0, 14),
      hasBootFail: document.getElementById('boot-fail')?.classList.contains('show') || false
    };
  });

  rows.push({ profile: prof.name, firstPaintMs, bootMs, usableMs, veilText, ...screen });
  console.log(`\n== ${prof.name}`);
  console.log(`   first paint ${firstPaintMs} ms · modules ${bootMs ?? 'NEVER'} ms · lobby usable ${usableMs ?? 'NEVER'} ms`);
  console.log(`   veil said: ${JSON.stringify(veilText)} (still visible: ${screen.veilVisible})`);
  console.log(`   visible buttons: ${screen.buttons.join(' | ')}`);
  await page.close();
}

await browser.close();
server.close();
fs.writeFileSync('out/bounce-audit.json', JSON.stringify(rows, null, 2));
console.log('\nwrote out/bounce-audit.json');
