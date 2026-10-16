// Screenshots of the Goose Studio tools (smoke check + review images).
//   node scripts/goose-studio-shot.mjs <page> <out.png> [--js "<expr run after load>"] [--wait ms] [--size WxH] [--headful]
// <page> e.g. "goose-wardrobe/index.html?goose=goose_stoker". Serves the repo on 127.0.0.1:8933.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const pageUrl = args[0], out = args[1];
const [W, H] = opt('--size', '1280x800').split('x').map(Number);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary',
  '.json': 'application/json', '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg' };
const port = 8933;
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(ROOT, u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(port, '127.0.0.1', r));
const browser = await puppeteer.launch({ headless: args.includes('--headful') ? false : 'new',
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
  if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')) });
  m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/);
  if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/examples/jsm/' + m[1])) });
  return req.continue();
});
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' || /\[studio\]/.test(m.text())) console.log('console:', m.text()); });
await page.goto(`http://127.0.0.1:${port}/${pageUrl}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__wardrobe ? !!window.__wardrobe.actor : (window.__stage && window.__stage.ready), { timeout: 120000 });
const js = opt('--js', '');
if (js) console.log('js ->', JSON.stringify(await page.evaluate(js)));
await new Promise(r => setTimeout(r, +opt('--wait', '1500')));
await page.screenshot({ path: out });
console.log('shot', out, errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no page errors');
await browser.close();
server.close();
