// Render a Goose Stage reel to MP4, frame-exact (goose-stage/reels.js).
//   node scripts/goose-reel.mjs <reel> [9x16|16x9] [--pair victorian|cyclists|fancy] [--goose <name>] [--fps 60]
//        [--headful] [--frames-only]
// -> renders/goose-reels/<reel>_<pair|goose>_<aspect>.mp4 (H.264 + AAC: the game music + every honk, mixed offline)
//
// The page runs no clock of its own in capture mode: each frame is window.__stage.step(1/fps) then a CDP
// screenshot, so the footage is smooth however slow a frame renders. Honks are logged by the page (time, window
// into assets/goose-honk.mp3, rate, gain) and rebuilt here with ffmpeg, in sync to the frame.
// (Same idea as the gameplay trailer's scripts/reel/lib.mjs virtual clock; this page needs no clock shim.)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const reel = args[0] || 'intro';
const aspect = /^\d+x\d+$/.test(args[1] || '') ? args[1] : '9x16';
const [W, H] = aspect === '16x9' ? [1920, 1080] : [1080, 1920];
const fps = +opt('--fps', 60);
const pair = opt('--pair', 'victorian'), goose = opt('--goose', '');
const tag = `${reel}_${goose || pair}_${aspect}`;
const OUT = path.join(ROOT, 'renders', 'goose-reels');
const FR = path.join(OUT, 'frames', tag);
fs.rmSync(FR, { recursive: true, force: true });
fs.mkdirSync(FR, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary',
  '.json': 'application/json', '.mp3': 'audio/mpeg', '.png': 'image/png' };
const port = 8934;
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(port, '127.0.0.1', r));
const headful = args.includes('--headful');
const browser = await puppeteer.launch({
  headless: headful ? false : 'new', defaultViewport: null,
  args: [`--window-size=${W},${H}`, '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const page = (await browser.pages())[0] || await browser.newPage();
await page.setViewport({ width: W, height: H });
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  if (u.startsWith(`http://127.0.0.1:${port}`)) return req.continue();
  let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
  if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')) });
  m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/);
  if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/examples/jsm/' + m[1])) });
  return req.abort();
});
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
const q = new URLSearchParams({ reel, aspect, pair, capture: '1', ...(goose ? { goose } : {}) });
await page.goto(`http://127.0.0.1:${port}/goose-stage/index.html?${q}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__stage && window.__stage.ready, { timeout: 180000 });
const duration = await page.evaluate(() => window.__stage.duration);
const n = Math.round(duration * fps);
const client = await page.createCDPSession();
const t0 = Date.now();
console.log(`${tag}: ${duration.toFixed(2)} s, ${n} frames @ ${fps}`);
for (let i = 0; i < n; i++) {
  await page.evaluate((dt) => window.__stage.step(dt), 1 / fps);
  const { data } = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 93, optimizeForSpeed: true });
  fs.writeFileSync(path.join(FR, String(i).padStart(5, '0') + '.jpg'), Buffer.from(data, 'base64'));
  if (i % 120 === 0) console.log(`  ${i}/${n} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
const audio = await page.evaluate(() => window.__stage.audio());
fs.writeFileSync(path.join(FR, 'audio.json'), JSON.stringify(audio, null, 1));
await browser.close();
server.close();
if (errors.length) console.log('PAGE ERRORS:', errors.join(' | '));
if (args.includes('--frames-only')) process.exit(0);

// ---- encode: video + offline audio mix (music bed + one input per honk)
const out = path.join(OUT, tag + '.mp4');
const inputs = ['-framerate', String(fps), '-i', path.join(FR, '%05d.jpg')];
const filters = [], mixes = [];
let k = 1;
if (audio.music) {
  const m = audio.music, fo = m.fadeOut || 1;
  inputs.push('-t', String(duration), '-i', path.join(ROOT, m.file));
  filters.push(`[${k}:a]volume=${m.gain},afade=t=in:d=0.3,afade=t=out:st=${Math.max(0, duration - fo).toFixed(3)}:d=${fo}[a${k}]`);
  mixes.push(`[a${k}]`); k++;
}
const honkFile = path.join(ROOT, 'assets', 'goose-honk.mp3');
const sr = 44100;
for (const h of audio.honks) {
  inputs.push('-ss', String(h.offset), '-t', String(h.dur + 0.02), '-i', honkFile);
  const ms = Math.round(h.t * 1000);
  filters.push(`[${k}:a]aresample=${sr},asetrate=${Math.round(sr * h.rate)},aresample=${sr},` +
    `afade=t=in:d=0.008,afade=t=out:st=${(h.dur / h.rate - 0.05).toFixed(3)}:d=0.05,volume=${h.gain * 1.6},adelay=${ms}|${ms}[a${k}]`);
  mixes.push(`[a${k}]`); k++;
}
const ff = ['-y', '-v', 'error', ...inputs];
if (mixes.length) {
  filters.push(`${mixes.join('')}amix=inputs=${mixes.length}:normalize=0:duration=longest,atrim=0:${duration.toFixed(3)}[aout]`);
  ff.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
}
ff.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', duration.toFixed(3), out);
execFileSync('ffmpeg', ff, { stdio: 'inherit' });
console.log('wrote', out, `(${audio.honks.length} honks${audio.music ? ', music ' + path.basename(audio.music.file) : ''}, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
