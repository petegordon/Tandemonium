// UI audit harness: serves the repo, opens the game in headless Chrome at a TV
// resolution with fake controllers, and saves screenshots + a manifest.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE = fs.readFileSync(path.join(ROOT, 'scripts/ui-audit/fake-input.js'), 'utf8');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.webp': 'image/webp', '.hdr': 'application/octet-stream', '.ogg': 'audio/ogg',
};

export async function start({ port = 8931, out, width = 1920, height = 1080 } = {}) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.stat(file, (err, st) => {
      if (err || st.isDirectory()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', ...(process.env.UI_AUDIT_SWIFTSHADER ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']), '--mute-audio',
      '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--window-size=${width},${height}`],
  });
  fs.mkdirSync(out, { recursive: true });
  const manifest = [];

  async function open({ url = '/index.html', storage = {}, setup, pads = [], pucks = 0 } = {}) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const _close = page.close.bind(page); page.close = async () => { await _close(); await ctx.close(); };
    await page.setViewport({ width, height });
    await page.evaluateOnNewDocument(FAKE);
    await page.evaluateOnNewDocument((s) => {
      try { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } catch {}
    }, storage);
    // Controllers plugged in before launch.
    await page.evaluateOnNewDocument((pl, pk) => { pl.forEach((t) => window.__fake.addPad(t)); if (pk) window.__fake.addPuck(pk); }, pads, pucks);
    // three from node_modules (no CDN dependency); block sign-in widget + peer relay.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      const m = u.match(/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/(build\/three\.module\.js|examples\/jsm\/.+)$/);
      if (m) {
        const f = path.join(ROOT, 'node_modules/three', m[1]);
        if (fs.existsSync(f)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
      }
      if (/accounts\.google\.com|gsi\/client/.test(u)) return req.abort();
      return req.continue();
    });
    page.logs = [];
    page.on('console', (m) => page.logs.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => page.logs.push(`pageerror: ${e.message}`));
    if (setup) await setup(page);
    await page.goto(`http://127.0.0.1:${port}${url}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => !!window._game && !!window._game.lobby, { timeout: 90000 });
    await wait(2500);
    return page;
  }

  async function shot(page, id, meta = {}) {
    const file = `${id}.png`;
    const info = await page.evaluate(() => {
      const fx = [...document.querySelectorAll('.gamepad-focus')].filter((e) => e.offsetParent !== null); const a = fx[fx.length - 1] || document.activeElement;
      const lobby = window._game?.lobby;
      const step = document.querySelector('#lobby-flow')?.getAttribute('current');
      const visibleOverlays = [...document.querySelectorAll('[id$="-overlay"],[id$="-modal"],[id$="-popup"]')]
        .filter((el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetParent !== null || cs.position === 'fixed' && cs.display !== 'none' && cs.opacity !== '0'; })
        .map((el) => el.id);
      return {
        state: window._game?.state, mode: window._game?.mode,
        lobbyVisible: getComputedStyle(document.getElementById('lobby')).display !== 'none',
        step: step || lobby?._currentStep,
        focus: a && a !== document.body ? `${a.tagName.toLowerCase()}#${a.id || ''}.${(a.className || '').toString().split(' ').slice(0, 2).join('.')} "${(a.innerText || a.value || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"` : null,
        overlays: visibleOverlays,
        slots: window._game?.lobby?.controllerManager?.slots?.map((s) => `${s.id}:${s.state}${s.controllerLabel ? ' ' + s.controllerLabel.slice(0, 30) : ''}`),
      };
    });
    await page.screenshot({ path: path.join(out, file) });
    const rec = { id, file, ...meta, ...info };
    manifest.push(rec);
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`📸 ${id}  step=${rec.step} state=${rec.state} focus=${rec.focus}`);
    return rec;
  }

  async function close() { await browser.close(); server.close(); }
  return { browser, open, shot, close, manifest };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const click = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error('no ' + s); el.click(); }, sel);
export const fake = (page, fn, ...args) => page.evaluate((f, a) => window.__fake[f](...a), fn, args);
