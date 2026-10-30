// Bike-only review set: 8 azimuths around the whole bike + top, plus the rear-end close-ups.
//   node scripts/fit-review-set.mjs <prefix> [--geese] [--outfit victorian]   (#505; writes renders/fit/<prefix>-*.png)
//   --geese keeps both geese on the bike (crank 60°); the default is the bike alone.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT = process.cwd(), PORT = 8966, PREFIX = process.argv[2] || 'turn';
const GEESE = process.argv.includes('--geese');
const OUTFIT = process.argv.includes('--outfit') ? process.argv[process.argv.indexOf('--outfit') + 1] : 'victorian';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => { let u = decodeURIComponent(req.url.split('?')[0]); if (u === '/favicon.ico') return res.writeHead(204).end(); if (u.endsWith('/')) u += 'index.html'; const f = path.join(ROOT, u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end(); res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 600000, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
await page.setRequestInterception(true);
page.on('request', (req) => { const u = req.url(); if (u.startsWith(`http://127.0.0.1:${PORT}`)) return req.continue(); let m = u.match(/three@[^/]+\/build\/three\.module\.js/); if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')) }); m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f = m && path.join(ROOT, 'node_modules/three/examples/jsm/' + m[1]); if (f && fs.existsSync(f)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) }); return req.abort(); });
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${PORT}/tools/fit-viewer/index.html?capture&outfit=${OUTFIT}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__fit && window.__fit.ready, { timeout: 180000 });
const snap = async (f) => { for (let i = 0; i < 20; i++) { const d = await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => { window.__fit.render(); r(window.__fit.debug()); })))); if (d.triangles > 1000) break; await new Promise(r => setTimeout(r, 300)); } await page.screenshot({ path: f }); };
await page.evaluate((g) => { window.__fit.setCrank(60); window.__fit.showGeese(g); }, GEESE);
const out = (n) => `renders/fit/${PREFIX}-${n}.png`;
// whole bike, 8 azimuths at a slight elevation
const T = GEESE ? [0, 0.85, -0.1] : [0, 0.55, -0.1];
for (let i = 0; i < 8; i++) {
  const a = i * Math.PI / 4, d = GEESE ? 5.0 : 4.2;
  await page.evaluate((p, t) => window.__fit.lookFrom(p, t, 1.3), [d * Math.sin(a), GEESE ? 1.4 : 1.1, -0.1 + d * Math.cos(a)], T);
  await snap(out(`az${i * 45}`));
}
await page.evaluate((t) => window.__fit.lookFrom([0.01, 5.5, -0.1], t, 1.4), T); await snap(out('top'));
// rear end close-ups
const views = { 'rear-side': [[2.2, 0.6, -0.85], [0, 0.45, -0.85], 0.6], 'rear-34-high': [[1.6, 1.3, -2.2], [0, 0.45, -0.85], 0.6], 'rear-34-low': [[1.7, 0.25, -1.9], [0, 0.45, -0.85], 0.6], 'rear': [[0, 0.7, -3.0], [0, 0.45, -0.85], 0.6], 'rear-other-34': [[-1.6, 0.9, -2.0], [0, 0.45, -0.85], 0.6], 'rear-top': [[0.4, 2.6, -1.0], [0, 0.45, -0.85], 0.6], 'rack-side': [[1.2, 0.8, -0.8], [0, 0.7, -0.8], 0.3], 'rack-above': [[0.5, 1.7, -0.9], [0, 0.7, -0.9], 0.35], 'seat-cluster-side': [[1.2, 0.75, -0.62], [0, 0.7, -0.62], 0.3], 'mudguard-tail': [[0.9, 0.45, -1.9], [0, 0.4, -1.25], 0.25] };
for (const [n, [p, t, s]] of Object.entries(views)) { await page.evaluate((p, t, s) => window.__fit.lookFrom(p, t, s), p, t, s); await snap(out(n)); }
await browser.close(); server.close();
console.log('done', PREFIX);
