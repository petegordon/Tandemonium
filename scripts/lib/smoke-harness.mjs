// smoke-harness.mjs — shared setup for the headless smokes.
//
//   const h = await startHarness({ port: 8961 });
//   const page = await h.gamePage({ storage: { tandemonium_tutorial_done: 'smoke' } });
//   h.check(ok, 'name', detail);
//   await h.finish();            // closes Chrome + server, exits 1 on any FAIL / page error
//
// SMOKE_CPU_THROTTLE=6 node scripts/smoke-x.mjs   runs the game pages ~CI-slow.
//
// Serves the repo over http on 127.0.0.1, answers three.js CDN requests from
// node_modules and aborts every other off-host request, so a smoke never needs
// the network. Chrome runs headless with software WebGL (swiftshader).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const require = createRequire(ROOT + '/package.json');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg', '.json': 'application/json', '.webp': 'image/webp', '.wasm': 'application/wasm',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startHarness({ port, outDir = null, headless = 'new' } = {}) {
  const puppeteer = require('puppeteer');
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/favicon.ico') return r.writeHead(204).end();   // no console 404 noise
    const f = path.join(ROOT, u === '/' ? 'index.html' : u);
    fs.stat(f, (e, st) => {
      if (e || st.isDirectory()) return r.writeHead(404).end();
      r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(r);
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const browser = await puppeteer.launch({
    headless,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });
  const out = outDir ? path.join(os.tmpdir(), outDir) : null;
  if (out) fs.mkdirSync(out, { recursive: true });

  const results = [];
  const errors = [];
  const origin = `http://127.0.0.1:${port}`;

  const check = (ok, name, detail) => {
    results.push(!!ok);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
    return !!ok;
  };

  /**
   * Open the game. `before(page)` runs before navigation (install fakes there).
   * `storage` is written to localStorage before any game script runs.
   */
  async function gamePage({ viewport = { width: 1280, height: 800 }, storage = {}, query = '', userAgent = null, before = null, waitGame = true } = {}) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    if (userAgent) await page.setUserAgent(userAgent);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (u.startsWith(origin) || u.startsWith('data:') || u.startsWith('blob:')) return req.continue();
      let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
      if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')) });
      m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/);
      const f = m && path.join(ROOT, 'node_modules/three/examples/jsm/' + m[1]);
      if (f && fs.existsSync(f)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
      return req.abort();
    });
    page.on('pageerror', (e) => { errors.push(e.message); console.log('  PAGEERROR:', e.message); });
    const seed = { tandemonium_started: '1', ...storage };
    await page.evaluateOnNewDocument((s) => { try { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } catch {} }, seed);
    if (before) await before(page);
    // SMOKE_CPU_THROTTLE=<n> slows the page n× (CDP), to reproduce a CI runner's
    // ~1-3 fps locally before trusting a timing-sensitive check.
    const throttle = Number(process.env.SMOKE_CPU_THROTTLE || 0);
    if (throttle > 1) { const cdp = await page.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
    await page.goto(`${origin}/index.html${query}`, { waitUntil: 'domcontentloaded' });
    if (waitGame) await page.waitForFunction(() => !!window._game && !!window._game.lobby, { timeout: 90000 });
    await page.click('#tap-to-start').catch(() => {});
    return page;
  }

  async function shot(page, name) {
    if (!out) return null;
    const f = path.join(out, name + '.png');
    await page.screenshot({ path: f });
    return f;
  }

  async function finish() {
    await browser.close().catch(() => {});
    server.close();
    const failed = results.filter((x) => !x).length;
    if (errors.length) console.log(`  page errors: ${errors.length}`);
    console.log(`\n${results.length - failed}/${results.length} checks passed${out ? ` · screenshots: ${out}` : ''}`);
    process.exit(failed || errors.length ? 1 : 0);
  }

  return { browser, server, origin, check, gamePage, shot, finish, results, errors, out };
}

// ── Page helpers shared by the lobby-driving smokes ──

/** Current lobby step id ('lobby-mode', 'lobby-host', …) and game state. */
export const where = (page) => page.evaluate(() => {
  const flow = document.getElementById('lobby-flow');
  const g = window._game;
  return { step: flow ? (flow.current || flow.getAttribute('current') || null) : null, state: g ? g.state : null, mode: g ? g.mode : null };
});

/** Click a button by id; returns false if it isn't on the page. */
export const clickId = (page, id) => page.evaluate((i) => { const b = document.getElementById(i); if (!b) return false; b.click(); return true; }, id);

/** Click the first visible button whose text matches `re` (a RegExp source string). */
export const clickText = (page, re) => page.evaluate((src) => {
  const rx = new RegExp(src, 'i');
  const b = Array.from(document.querySelectorAll('button, uf-button')).find((x) => x.offsetParent !== null && rx.test(x.textContent || ''));
  if (!b) return false; b.click(); return true;
}, re);

/** Wait until the game is in `state` ('playing', 'lobby', …). */
export const waitState = (page, state, timeout = 120000) =>
  page.waitForFunction((s) => window._game && window._game.state === s, { timeout }, state);
