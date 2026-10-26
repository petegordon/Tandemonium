// lib.mjs — shared plumbing for the trailer capture (docs/demo-reel-plan.md).
// Serves the game, opens Chrome on the real GPU, and installs:
//   - a virtual clock (performance.now / Date.now / rAF / setTimeout) stepped 1/60 s per captured frame,
//     so the footage is a perfect 60 fps however slow a frame takes to render and save;
//   - window.__reel: the input bot + camera override, driven from the page each frame.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

export const ROOT = process.cwd();
export const OUT = path.join(ROOT, 'renders', 'reel');
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.mp4':'video/mp4','.json':'application/json','.wasm':'application/wasm' };

export async function launch({ width = 1920, height = 1080, port = 8931, query = '', storage = {}, scale = 1, before = null } = {}) {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(ROOT, u === '/' ? 'index.html' : u);
    fs.stat(f, (e, st) => {
      if (e || st.isDirectory()) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [`--window-size=${width},${height + 140}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const page = (await browser.pages())[0] || await browser.newPage();
  // scale: device pixels per CSS pixel (2 = a phone-sized layout captured at twice the resolution)
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  page.__reelClip = scale !== 1 ? { x: 0, y: 0, width, height, scale } : null;   // CDP captures CSS px unless clipped + scaled
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith(`http://127.0.0.1:${port}`)) return req.continue();
    let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
    if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')) });
    m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/);
    const f = m && path.join(ROOT, 'node_modules/three/examples/jsm/' + m[1]);
    if (f && fs.existsSync(f)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
    return req.abort();   // no analytics / CDN / peer servers in the capture
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
  page.on('console', m => { if (/\[reel\]/.test(m.text())) console.log(m.text()); });
  await page.evaluateOnNewDocument((storage) => {
    try {
      localStorage.setItem('tandemonium_tutorial_done', 'reel');
      // null removes a key (e.g. tandemonium_tutorial_done: null = a brand-new player, for the tutorial)
      for (const [k, v] of Object.entries(storage)) { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
    } catch {}
    installVirtualClock();
    function installVirtualClock() {
      const realNow = performance.now.bind(performance), realDateNow = Date.now;
      const realRAF = window.requestAnimationFrame.bind(window), realST = window.setTimeout.bind(window),
        realSI = window.setInterval.bind(window), realCT = window.clearTimeout.bind(window), realCI = window.clearInterval.bind(window);
      const vc = { on: false, t: 0, dateBase: 0, raf: [], timers: new Map(), nextId: 1e7 };
      window.__vclock = vc;
      performance.now = () => (vc.on ? vc.t : realNow());
      Date.now = () => (vc.on ? vc.dateBase + vc.t : realDateNow());
      window.requestAnimationFrame = (cb) => { if (!vc.on) return realRAF(cb); const id = vc.nextId++; vc.raf.push([id, cb]); return id; };
      const realCAF = window.cancelAnimationFrame.bind(window);
      window.cancelAnimationFrame = (id) => { vc.raf = vc.raf.filter(([i]) => i !== id); realCAF(id); };
      window.setTimeout = (cb, ms = 0, ...a) => { if (!vc.on || typeof cb !== 'function') return realST(cb, ms, ...a);
        const id = vc.nextId++; vc.timers.set(id, { due: vc.t + (+ms || 0), cb, a }); return id; };
      window.setInterval = (cb, ms = 0, ...a) => { if (!vc.on || typeof cb !== 'function') return realSI(cb, ms, ...a);
        const id = vc.nextId++; vc.timers.set(id, { due: vc.t + Math.max(1, +ms || 0), cb, a, every: Math.max(1, +ms || 0) }); return id; };
      window.clearTimeout = (id) => { vc.timers.delete(id); realCT(id); };
      window.clearInterval = (id) => { vc.timers.delete(id); realCI(id); };
      vc.enable = () => { if (vc.on) return; vc.t = realNow(); vc.dateBase = realDateNow() - vc.t; vc.on = true;
        // the game's loop is parked on a real rAF: let it land once, it re-registers on the virtual queue
      };
      // advance one frame: timers due in (t, t+ms], then the rAF callbacks (the game loop)
      vc.step = (ms) => {
        const end = vc.t + ms;
        for (;;) {
          let best = null;
          for (const [id, tm] of vc.timers) if (tm.due <= end && (!best || tm.due < best[1].due)) best = [id, tm];
          if (!best) break;
          const [id, tm] = best; vc.t = Math.max(vc.t, tm.due);
          if (tm.every) tm.due += tm.every; else vc.timers.delete(id);
          try { tm.cb(...tm.a); } catch (e) { console.error(e); }
        }
        vc.t = end;
        const q = vc.raf; vc.raf = [];
        for (const [, cb] of q) { try { cb(vc.t); } catch (e) { console.error(e); } }
      };
    }
  }, storage);
  if (before) await before(page);   // e.g. scripts/lib/fake-webhid.mjs: simulated controllers, installed before boot
  await page.goto(`http://127.0.0.1:${port}/index.html${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window._game, { timeout: 60000 });
  await page.addScriptTag({ type: 'module', url: `http://127.0.0.1:${port}/scripts/reel/page-bot.js` });
  await page.waitForFunction(() => !!window.__reel, { timeout: 10000 });
  return { browser, page, server, errors, close: async () => { await browser.close(); server.close(); } };
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Record `seconds` of footage into renders/reel/<name>/%05d.jpg, 60 fps virtual time.
 * `perFrame(i, t)` (optional, node side) can steer the shot between frames.
 */
export async function record(page, name, seconds, { fps = 60, perFrame = null, quality = 92 } = {}) {
  const dir = path.join(OUT, 'frames', name);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  await page.evaluate(() => window.__vclock.enable());
  await sleep(100);   // the loop's pending real rAF fires and moves onto the virtual queue
  const client = await page.createCDPSession();
  const n = Math.round(seconds * fps), t0 = Date.now();
  for (let i = 0; i < n; i++) {
    if (perFrame) await perFrame(i, i / fps);
    await page.evaluate((ms) => { window.__reel.tick(ms / 1000); window.__vclock.step(ms); }, 1000 / fps);
    const { data } = await client.send('Page.captureScreenshot', { format: 'jpeg', quality, optimizeForSpeed: true,
      ...(page.__reelClip ? { clip: page.__reelClip } : {}) });
    fs.writeFileSync(path.join(dir, String(i).padStart(5, '0') + '.jpg'), Buffer.from(data, 'base64'));
    if (i % 120 === 0) process.stdout.write(`  ${name} ${i}/${n} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
  }
  await client.detach();
  return dir;
}

/** Advance virtual time without capturing (skip boring bits fast). */
export async function advance(page, seconds, fps = 60) {
  await page.evaluate(() => window.__vclock.enable());
  await sleep(100);
  await page.evaluate((n, ms) => { for (let i = 0; i < n; i++) { window.__reel.tick(ms / 1000); window.__vclock.step(ms); } },
    Math.round(seconds * fps), 1000 / fps);
}

/** frames dir -> mp4 (H.264 yuv420p, 60 fps) */
export async function encode(name, fps = 60) {
  const { execFileSync } = await import('node:child_process');
  const dir = path.join(OUT, 'frames', name), out = path.join(OUT, 'clips', name + '.mp4');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(fps), '-i', path.join(dir, '%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', out]);
  return out;
}
