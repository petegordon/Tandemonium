/**
 * Achievement icons for Steam — one 256x256 JPG per state, made from each
 * achievement's emoji in js/achievement-defs.js.
 *
 *   earned:  the emoji on the game's dark surface inside a green ring
 *   locked:  the emoji greyed out inside a dashed grey ring (the in-game locked badge)
 *
 * The emoji font is Noto Color Emoji (Google Fonts), so the icons look the same
 * on every machine that runs the sync. Files land in steam/achievement-icons/
 * as <id>.jpg and <id>_gray.jpg.
 *
 * Standalone preview: node scripts/achievement-icons.js [--sheet]
 *   renders every icon (and with --sheet a contact sheet, icons-sheet.jpg).
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'steam', 'achievement-icons');
const SIZE = 256;

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&display=block" rel="stylesheet">
<style>
  html, body { margin: 0; background: #0a0a0f; }
  .tile { width: ${SIZE}px; height: ${SIZE}px; position: relative; overflow: hidden;
    background: radial-gradient(circle at 50% 38%, #2c2c3e 0%, #16161f 62%, #0e0e14 100%); }
  .ring { position: absolute; inset: 14px; border-radius: 50%; border: 10px solid #2ef33c;
    box-shadow: 0 0 22px rgba(46, 243, 60, .35), inset 0 0 18px rgba(46, 243, 60, .18); }
  .emoji { position: absolute; inset: 0; display: grid; place-items: center;
    font: 124px/1 'Noto Color Emoji'; }
  .tile.gray { background: #141419; }
  .tile.gray .ring { border: 8px dashed #4a4a58; box-shadow: none; inset: 16px; }
  .tile.gray .emoji { filter: grayscale(1) brightness(.85); opacity: .42; }
</style></head><body><div id="tile" class="tile"><div class="ring"></div><div class="emoji" id="emoji"></div></div></body></html>`;

/**
 * Render both icons for every achievement. Reuses files already on disk unless
 * force is set. Returns [{ id, earned, gray }] with absolute paths.
 * achievements: [{ id, icon }] (icon = the emoji).
 */
async function renderIcons(browser, achievements, { force = false, outDir = OUT_DIR } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const todo = achievements.filter(a => force
    || !fs.existsSync(path.join(outDir, `${a.id}.jpg`))
    || !fs.existsSync(path.join(outDir, `${a.id}_gray.jpg`)));

  if (todo.length) {
    const page = await browser.newPage();
    await page.setViewport({ width: SIZE, height: SIZE, deviceScaleFactor: 1 });
    await page.setContent(PAGE, { waitUntil: 'networkidle0', timeout: 60000 });
    // Make the browser fetch every glyph we need before the first screenshot.
    const glyphs = [...new Set(todo.map(a => a.icon))].join('');
    const fontOk = await page.evaluate(async (g) => {
      await document.fonts.load("124px 'Noto Color Emoji'", g);
      return document.fonts.check("124px 'Noto Color Emoji'", g);
    }, glyphs);
    if (!fontOk) throw new Error('Noto Color Emoji did not load (no network?) — icons not rendered');

    const tile = await page.$('#tile');
    for (const a of todo) {
      for (const gray of [false, true]) {
        await page.evaluate((icon, isGray) => {
          document.getElementById('emoji').textContent = icon;
          document.getElementById('tile').className = isGray ? 'tile gray' : 'tile';
        }, a.icon, gray);
        await tile.screenshot({
          path: path.join(outDir, `${a.id}${gray ? '_gray' : ''}.jpg`),
          type: 'jpeg', quality: 92,
        });
      }
    }
    await page.close();
  }

  return achievements.map(a => ({
    id: a.id,
    earned: path.join(outDir, `${a.id}.jpg`),
    gray: path.join(outDir, `${a.id}_gray.jpg`),
  }));
}

module.exports = { renderIcons, OUT_DIR, SIZE };

// ── Standalone: render all icons (+ optional contact sheet) ──────
if (require.main === module) {
  (async () => {
    const puppeteer = require('puppeteer');
    const { pathToFileURL } = require('url');
    const defs = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'achievement-defs.js')).href);
    const list = defs.ACHIEVEMENTS.map(a => ({ id: a.id, icon: a.icon, name: a.name }));
    const browser = await puppeteer.launch({ headless: true });
    try {
      const files = await renderIcons(browser, list, { force: true });
      console.log(`Rendered ${files.length * 2} icons into ${OUT_DIR}`);
      if (process.argv.includes('--sheet')) {
        const cells = list.map((a, i) => {
          const f = files[i];
          const b64 = p => fs.readFileSync(p).toString('base64');
          return `<figure><img src="data:image/jpeg;base64,${b64(f.earned)}"><img src="data:image/jpeg;base64,${b64(f.gray)}"><figcaption>${a.name}</figcaption></figure>`;
        }).join('');
        const page = await browser.newPage();
        await page.setViewport({ width: 1600, height: 900 });
        await page.setContent(`<style>body{margin:12px;background:#0a0a0f;color:#ccd;font:12px system-ui;display:flex;flex-wrap:wrap;gap:8px}
          figure{margin:0;width:140px;text-align:center}img{width:64px;height:64px;margin:1px}figcaption{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style>${cells}`);
        const sheet = path.join(OUT_DIR, '..', 'icons-sheet.jpg');
        await page.screenshot({ path: sheet, type: 'jpeg', quality: 85, fullPage: true });
        console.log(`Contact sheet: ${sheet}`);
      }
    } finally {
      await browser.close();
    }
  })().catch(e => { console.error(e); process.exit(1); });
}
