// #503 · bake the tutorial billboards' faces (end-card style) into WebP atlases the game loads.
//   node scripts/bake-tutorial-board.mjs [kind ...]   -> assets/tutorial-board-<kind>.webp (every kind when none is named)
//   kinds: end, start (the tutorial), pot (#546 · Slingshot's POT OF GOLD sign)
// Face 2048x1024 on top, crest disc 256x256 below it (js/tutorial-board.js maps the UVs). Needs ffmpeg on PATH.
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const BOARDS = {
  end:   { title: 'TUTORIAL END',   sub: "Well ridden! Grandma's is next →", crest: '\u{1F3C1}' },
  start: { title: 'TUTORIAL START', sub: 'Lean together. Pedal together.',      crest: '\u{1F6B2}' },
  pot:   { title: 'POT OF GOLD',    sub: 'Ride through it!',                    crest: '\u{1FA99}' },
};
const only = process.argv.slice(2);
for (const k of only) if (!BOARDS[k]) throw new Error(`unknown board ${k} (${Object.keys(BOARDS).join(', ')})`);
const browser = await puppeteer.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.setViewport({ width: 2048, height: 1280, deviceScaleFactor: 1 });
for (const [kind, b] of Object.entries(BOARDS).filter(([k]) => !only.length || only.includes(k))) {
  const url = pathToFileURL(path.join(HERE, 'tutorial-board', 'face.html')) + '?' + new URLSearchParams(b);
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  // the title must fit inside the inner border (with margin)
  const w = await page.evaluate(() => document.getElementById('title').getBoundingClientRect().width);
  if (w > 1800) await page.evaluate((s) => { document.getElementById('title').style.fontSize = (268 * s) + 'px'; }, 1800 / w);
  const png = path.join(ROOT, 'renders', `tutorial-board-${kind}.png`);
  fs.mkdirSync(path.dirname(png), { recursive: true });
  await page.screenshot({ path: png });
  const out = path.join(ROOT, 'assets', `tutorial-board-${kind}.webp`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-c:v', 'libwebp', '-quality', '92', out]);
  console.log('baked', out, Math.round(fs.statSync(out).size / 1024) + ' KB', 'title px', Math.round(w));
}
await browser.close();
