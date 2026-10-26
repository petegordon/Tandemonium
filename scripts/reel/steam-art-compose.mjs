#!/usr/bin/env node
// steam-art-compose.mjs — turn the in-engine plates (steam-art.mjs) into Steam-sized candidates (#357):
// the title lettering (images/logo.png, transparent) composited onto each capsule, the half-size
// variants Steam also asks for, the hero left without text, and the icons from the existing pedal.
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

// slot -> plate, output sizes, and where the lettering goes (fraction of width, anchor corner, gravity)
const SLOTS = {
  header:   { plate: 'header_920x430.png',   sizes: [[920, 430], [460, 215]], logo: { w: 0.34, at: 'top-left' } },
  small:    { plate: 'small_462x174.png',    sizes: [[462, 174], [231, 87]],  logo: { w: 0.38, at: 'top-left' } },
  main:     { plate: 'main_1232x706.png',    sizes: [[1232, 706], [616, 353]], logo: { w: 0.34, at: 'top-left' } },
  vertical: { plate: 'vertical_748x896.png', sizes: [[748, 896], [374, 448]], logo: { w: 0.80, at: 'top-centre' } },
  library:  { plate: 'library_600x900.png',  sizes: [[600, 900]],             logo: { w: 0.86, at: 'top-centre' } },
  libheader:{ plate: 'header_920x430.png',   sizes: [[920, 430]],             logo: null },   // library header: no text
  hero:     { plate: 'hero_3840x1240.png',   sizes: [[3840, 1240]],           logo: null },   // the library logo goes over it
  pagebg:   { plate: 'pagebg_1438x810.png',  sizes: [[1438, 810]],            logo: null },
};

async function compose(name, sl) {
  const src = path.join(PLATES, sl.plate);
  if (!fs.existsSync(src)) { console.log('  (no plate for', name + ')'); return; }
  const [W, H] = sl.sizes[0];
  let img = sharp(src).resize(W, H, { fit: 'cover' });
  if (sl.logo) {
    const lw = Math.round(W * sl.logo.w);
    const logo = await sharp(LOGO).resize({ width: lw }).toBuffer();
    const lh = (await sharp(logo).metadata()).height;
    const pad = Math.round(W * 0.03);
    const left = sl.logo.at === 'top-centre' ? Math.round((W - lw) / 2) : pad;
    const top = sl.logo.at.startsWith('top') ? pad : H - lh - pad;
    img = img.composite([{ input: logo, left, top }]);
  }
  const full = await img.png({ compressionLevel: 9 }).toBuffer();
  for (const [w, h] of sl.sizes) {
    const f = path.join(OUT, `${name}_${w}x${h}.png`);
    const buf = (w === W) ? full : await sharp(full).resize(w, h).png({ compressionLevel: 9 }).toBuffer();
    fs.writeFileSync(f, buf);
    console.log('  ->', path.relative(ROOT, f), (buf.length / 1e6).toFixed(2), 'MB');
  }
}
// (the plates/ renders are the same frames with no lettering, for whoever places the final logo)

for (const [name, sl] of Object.entries(SLOTS)) await compose(name, sl);

// library logo (transparent PNG): the existing title art, already 1280x720 with alpha
fs.copyFileSync(path.join(ROOT, 'assets', 'steam', 'tandemonium_title_1280x720.png'), path.join(OUT, 'library_logo_1280x720.png'));
// icons from the existing pedal icon (no riders in it, so nothing to regenerate)
const icon = path.join(ROOT, 'assets', 'steam', 'tandemonium_icon_512x512.png');
fs.writeFileSync(path.join(OUT, 'community_icon_184x184.png'), await sharp(icon).resize(184, 184).png().toBuffer());
fs.writeFileSync(path.join(OUT, 'client_icon_32x32.png'), await sharp(icon).resize(32, 32).png().toBuffer());
// screenshots: straight copies of the 1920x1080 gameplay stills
for (const f of fs.readdirSync(PLATES).filter(f => /^screenshot\d_1920x1080\.png$/.test(f))) {
  fs.writeFileSync(path.join(OUT, f), await sharp(path.join(PLATES, f)).png({ compressionLevel: 9 }).toBuffer());
}
// Steam's 5 MB limit
for (const f of fs.readdirSync(OUT).filter(f => f.endsWith('.png'))) {
  const mb = fs.statSync(path.join(OUT, f)).size / 1e6;
  if (mb > 5) console.log('  OVER 5 MB:', f, mb.toFixed(2));
}
console.log('done');
