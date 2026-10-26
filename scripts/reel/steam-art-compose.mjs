#!/usr/bin/env node
// steam-art-compose.mjs — turn the in-engine plates (steam-art.mjs) into Steam-sized candidates (#357),
// following Steam's store/library asset rules (partner.steamgames.com/doc/store/assets/standard, /libraryassets):
//   capsules      the title lettering (images/logo.png, the Tandemonium-with-pedals sticker) is the dominant,
//                 legible element: 58-62% of the width on header/main, ~85% on vertical/library capsule,
//                 over open sky, off the riders' faces and Grandma, with a soft drop shadow; no other text
//   small capsule logo-first: the sticker nearly fills it (readable at 120x45) over a blurred, darkened crop
//   library hero  no text, no logo; subjects inside the centred 1720x760 safe box (checks/hero_safe_area.png)
//   library logo  the existing transparent 1280x720 title (logotype + pedals logomark)
//   page bg       ambient: blurred and darkened, no text
//   screenshots   1920x1080 gameplay as played (Steam wants at least five)
//   icons         community 184x184, client 32x32 PNG + .ico
//   SHARP_DIR=<dir with node_modules/sharp> node scripts/reel/steam-art-compose.mjs
// (sharp is not a project dependency: npm i --no-save sharp somewhere and point SHARP_DIR at it.)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const sharp = createRequire(path.join(process.env.SHARP_DIR || ROOT, 'package.json'))('sharp');
const PLATES = path.join(ROOT, 'assets', 'steam-candidates', 'plates');
const OUT = path.join(ROOT, 'assets', 'steam-candidates');
const LOGO = path.join(ROOT, 'images', 'logo.png');   // 940x400, transparent: lettering + dirt + pedals
const png = (s) => s.png({ compressionLevel: 9 }).toBuffer();
const cover = (file, w, h) => sharp(file).resize(w, h, { fit: 'cover' });

// slot -> plate, output sizes, lettering: width (fraction of the slot), position (fraction of w/h, or 'centre')
const SLOTS = {
  header:    { plate: 'header_920x430.png',    sizes: [[920, 430], [460, 215]], logo: { w: 0.58, x: 0.02,     y: 0.03 } },
  main:      { plate: 'main_1232x706.png',     sizes: [[1232, 706], [616, 353]], logo: { w: 0.60, x: 0.02,     y: 0.03 } },
  vertical:  { plate: 'vertical_748x896.png',  sizes: [[748, 896], [374, 448]], logo: { w: 0.86, x: 'centre', y: 0.05 } },
  library:   { plate: 'library_600x900.png',   sizes: [[600, 900]],             logo: { w: 0.88, x: 'centre', y: 0.06 } },
  libheader: { plate: 'libheader_920x430.png', sizes: [[920, 430]],             logo: null },   // no text: Steam puts the logo over it
  hero:      { plate: 'hero_3840x1240.png',    sizes: [[3840, 1240]],           logo: null },   // no text, no logo
};

/** The sticker at `width` px plus a soft dark drop shadow under it (so it reads against sky). */
async function sticker(width, { shadow = 0.55, offset = 0.012, blur = 0.02, padding = 0.06 } = {}) {
  const logo = await sharp(LOGO).resize({ width }).png().toBuffer();
  const { width: w, height: h } = await sharp(logo).metadata();
  const pad = Math.round(width * padding);
  const raw = await sharp(logo).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < raw.length; i += 4) { raw[i] = raw[i + 1] = raw[i + 2] = 0; raw[i + 3] = Math.round(raw[i + 3] * shadow); }
  const shade = await sharp(raw, { raw: { width: w, height: h, channels: 4 } })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .blur(Math.max(1, width * blur)).png().toBuffer();
  const d = Math.round(width * offset);
  const out = await sharp({ create: { width: w + 2 * pad, height: h + 2 * pad, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: shade, left: d, top: d }, { input: logo, left: pad, top: pad }]).png().toBuffer();
  return { buf: out, w: w + 2 * pad, h: h + 2 * pad, pad };
}

async function compose(name, sl) {
  const src = path.join(PLATES, sl.plate);
  if (!fs.existsSync(src)) { console.log('  (no plate for', name + ')'); return; }
  const [W, H] = sl.sizes[0];
  let img = cover(src, W, H);
  if (sl.logo) {
    const st = await sticker(Math.round(W * sl.logo.w));
    const left = sl.logo.x === 'centre' ? Math.round((W - st.w) / 2) : Math.round(W * sl.logo.x) - st.pad;
    const top = Math.round(H * sl.logo.y) - st.pad;
    img = img.composite([{ input: st.buf, left, top }]);
  }
  const full = await png(img);
  for (const [w, h] of sl.sizes) write(`${name}_${w}x${h}.png`, w === W ? full : await png(sharp(full).resize(w, h)));
}

function write(name, buf) {
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log('  ->', path.posix.join('assets/steam-candidates', name), (buf.length / 1e6).toFixed(2), 'MB');
}

/** Small capsule: the sticker nearly fills it, over the balanced plate blurred and darkened. */
async function small() {
  for (const [w, h] of [[462, 174], [231, 87]]) {
    const bg = await png(cover(path.join(PLATES, 'libheader_920x430.png'), w, h).blur(w / 120).modulate({ brightness: 0.55, saturation: 0.8 }));
    // fit the 940x400 sticker inside a 4% margin: on 462x174 that is height-bound (~91% of the width)
    const maxW = Math.round(w * 0.96), maxH = Math.round(h * 0.94);
    // the sticker box is the logo plus its shadow padding (3% a side here): fit that box in the margin
    const padding = 0.03, lw = Math.floor(Math.min(maxW / (1 + 2 * padding), maxH / (400 / 940 + 2 * padding)));
    const st = await sticker(lw, { blur: 0.015, offset: 0.008, padding });
    write(`small_${w}x${h}.png`, await png(sharp(bg).composite([{ input: st.buf, left: Math.round((w - st.w) / 2), top: Math.round((h - st.h) / 2) }])));
  }
}

/** Page background: the wide plate, blurred and darkened so the store text sits on it. */
async function pagebg() {
  write('pagebg_1438x810.png', await png(cover(path.join(PLATES, 'pagebg_1438x810.png'), 1438, 810).blur(5).modulate({ brightness: 0.6, saturation: 0.85 })));
}

/** Library hero safe-area check: the hero at 1920x620 with Steam's 860x380 centred box drawn on it. */
async function heroCheck() {
  const f = path.join(OUT, 'hero_3840x1240.png');
  if (!fs.existsSync(f)) return;
  fs.mkdirSync(path.join(OUT, 'checks'), { recursive: true });
  const box = Buffer.from(`<svg width="1920" height="620"><rect x="530" y="120" width="860" height="380" fill="none" stroke="#ff2a2a" stroke-width="4" stroke-dasharray="14 8"/>
    <rect x="0" y="300" width="560" height="320" fill="none" stroke="#2a8dff" stroke-width="3"/><text x="540" y="112" font-size="26" fill="#ff2a2a" font-family="sans-serif">safe area 860x380 (critical content)</text>
    <text x="8" y="296" font-size="22" fill="#2a8dff" font-family="sans-serif">Steam's library logo lands about here</text></svg>`);
  const buf = await png(sharp(f).resize(1920, 620).composite([{ input: box, left: 0, top: 0 }]));
  fs.writeFileSync(path.join(OUT, 'checks', 'hero_safe_area.png'), buf);
  console.log('  -> assets/steam-candidates/checks/hero_safe_area.png');
}

/** A .ico holding PNG-compressed images (Vista+ format), from PNG buffers of known square sizes. */
function ico(entries) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  const dirs = [], blobs = []; let off = 6 + 16 * entries.length;
  for (const { size, buf } of entries) {
    const d = Buffer.alloc(16);
    d.writeUInt8(size >= 256 ? 0 : size, 0); d.writeUInt8(size >= 256 ? 0 : size, 1); d.writeUInt8(0, 2); d.writeUInt8(0, 3);
    d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6); d.writeUInt32LE(buf.length, 8); d.writeUInt32LE(off, 12);
    dirs.push(d); blobs.push(buf); off += buf.length;
  }
  return Buffer.concat([head, ...dirs, ...blobs]);
}

for (const [name, sl] of Object.entries(SLOTS)) await compose(name, sl);
await small();
await pagebg();
await heroCheck();

// library logo (transparent PNG, 1280 wide / 720 tall): the existing title art
const title = path.join(ROOT, 'assets', 'steam', 'tandemonium_title_1280x720.png');
const tm = await sharp(title).metadata();
console.log('  library logo', tm.width + 'x' + tm.height, 'alpha:', tm.hasAlpha);
fs.copyFileSync(title, path.join(OUT, 'library_logo_1280x720.png'));
// icons from the existing pedal icon (no riders in it, so nothing to regenerate)
const icon = path.join(ROOT, 'assets', 'steam', 'tandemonium_icon_512x512.png');
write('community_icon_184x184.png', await png(sharp(icon).resize(184, 184)));
const i32 = await png(sharp(icon).resize(32, 32)), i16 = await png(sharp(icon).resize(16, 16)), i48 = await png(sharp(icon).resize(48, 48));
write('client_icon_32x32.png', i32);
write('client_icon.ico', ico([{ size: 16, buf: i16 }, { size: 32, buf: i32 }, { size: 48, buf: i48 }]));
// screenshots: straight copies of the 1920x1080 gameplay stills
for (const f of fs.readdirSync(PLATES).filter(f => /^screenshot\d_1920x1080\.png$/.test(f))) write(f, await png(sharp(path.join(PLATES, f))));
// Steam's 5 MB limit
for (const f of fs.readdirSync(OUT).filter(f => /\.(png|ico)$/.test(f))) {
  const mb = fs.statSync(path.join(OUT, f)).size / 1e6;
  if (mb > 5) console.log('  OVER 5 MB:', f, mb.toFixed(2));
}
console.log('done');
