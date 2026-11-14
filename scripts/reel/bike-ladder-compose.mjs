#!/usr/bin/env node
// bike-ladder-compose.mjs — the Road to Gold Standard ladder image from the plates bike-ladder.mjs shoots.
// Eight rungs, Demo at the bottom, Gold Standard at the top; each rung = its unlock + the bikes it brings.
//   node scripts/reel/bike-ladder-compose.mjs              -> assets/ladder/final/ladder_store.png (1232 wide = Steam 616 @2x)
//                                                            + ladder_vertical.png (1080x1920)
//   REVEAL=solo_flight,time_warp node …                    those special bikes in colour, the rest as silhouettes
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = process.cwd();
const PLATES = process.env.PLATES || path.join(ROOT, 'assets', 'ladder', 'plates');
const OUTDIR = process.env.OUTDIR || path.join(ROOT, 'assets', 'ladder', 'final');
const REVEAL = new Set((process.env.REVEAL || '').split(',').filter(Boolean));
const SUFFIX = process.env.SUFFIX || (REVEAL.size ? '_reveal-' + [...REVEAL].join('-') : '');
fs.mkdirSync(OUTDIR, { recursive: true });
const meta = JSON.parse(fs.readFileSync(path.join(PLATES, 'meta.json'), 'utf8'));
const url = (f) => pathToFileURL(path.join(PLATES, f)).href;
const font = pathToFileURL(path.join(ROOT, 'assets', 'ladder', 'fonts', 'LilitaOne-Regular.ttf')).href;
/** the bike's own name, as the chooser prints it (no lock / trophy icon) */
const nameOf = (k) => (meta[k]?.name || k).replace(/^[^\p{L}]+/u, '').trim();

const special = (k, need) => REVEAL.has(k)
  ? { key: k, img: url(`${k}.png`), name: nameOf(k), dark: false }
  : { key: k, img: url(`${k}_locked.png`), name: '???', dark: true, need };

// top -> bottom
const RUNGS = [
  { badge: '100', label: 'every achievement', cards: [{ ...special('gold_standard'), big: true }], gold: true },
  { badge: '90', label: 'any 90 of 95', cards: [{ ...special('time_warp'), big: true }] },
  { badge: '80', label: 'any 80 of 81 solo', cards: [{ ...special('solo_flight'), big: true, stand: true, size: 'auto 178%', pos: '50% 44%',
    extra: REVEAL.has('solo_flight') ? '+ 🤖 Robot outfit' : '+ a mystery outfit', note: REVEAL.has('solo_flight') ? 'a robot goose rides with you' : '' }] },
  { badge: '65', label: 'achievements', cards: [{ img: url('bike_blue.png'), name: nameOf('bike_blue') },
    { img: url('bike_birthday.png'), name: nameOf('bike_birthday'), stand: true, extra: '+ 👑 Georgian outfit' }], arrow: true },
  { badge: '50', label: 'achievements', cards: [{ img: url('bike_yellow.png'), name: nameOf('bike_yellow') },
    { img: url('bike_newyears.png'), name: nameOf('bike_newyears'), stand: true, extra: '+ 💎 Fancy outfit' }], arrow: true },
  { badge: '35', label: 'achievements', cards: [{ img: url('bike_green.png'), name: nameOf('bike_green') },
    { img: url('bike_christmas.png'), name: nameOf('bike_christmas'), stand: true, extra: '+ 🚴 Cyclists outfit' }], arrow: true },
  { badge: 'FULL', label: 'game', cards: [{ img: url('bike_magenta.png'), name: nameOf('bike_magenta') },
    { img: url('bike_red.png'), name: nameOf('bike_red') }] },
  { badge: 'DEMO', label: 'free', cards: [{ img: url('default.png'), name: nameOf('default'), extra: '+ 🎩 Victorian outfit' },
    { img: url('bike_orange.png'), name: nameOf('bike_orange') }] },
];

/** emoji in the colour emoji font, a size up (they render small inside the text font) */
const emo = (s) => s.replace(/(\p{Extended_Pictographic}️?)/gu, '<span class="emo">$1</span>');
const card = (c) => `
    <div class="card${c.big ? ' big' : ''}${c.dark ? ' dark' : ''}">
      <div class="bg" style="background-image:url('${c.img}')"></div>
      <div class="pic"${c.fx ? ` data-fx="${c.fx}" data-aspect="${c.aspect || 2000 / 900}"` : ''} style="background-image:url('${c.img}');background-size:${c.size || (c.stand ? 'auto 128%' : 'auto 170%')};background-position:${c.pos || (c.stand ? '50% 48%' : '52% 52%')}"></div>
      <div class="cap">${c.extra ? `<i>${emo(c.extra)}</i>` : ''}<div class="row"><b>${c.name}</b>${c.note ? `<em>${c.note}</em>` : ''}</div></div>
    </div>`;
/** the CSS every layout shares (cards, tags, captions, badges), scaled by u = one unit in px */
const sharedCss = (u) => `
  @font-face { font-family: 'Lilita'; src: url('${font}'); }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #fff4dc; overflow: hidden;
    background: radial-gradient(ellipse at 50% 30%, #a08463 0%, #7d6448 45%, #3e2f20 100%); }
  .emo { font-family: 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif; font-size: 1.35em; line-height: 1; vertical-align: -0.12em; }
  .card { position: relative; border-radius: ${u * 1.4}px; overflow: hidden; border: ${u * 0.3}px solid rgba(255,220,150,.55);
    box-shadow: 0 ${u * 0.5}px ${u * 1.4}px rgba(0,0,0,.45); background: linear-gradient(#8a7456 0%, #8c7556 50%, #9c7b55 62%, #a07e58 100%); }
  .bg { position: absolute; inset: -12%; background-size: 100% 100%; filter: blur(${u * 3}px); }
  .pic { position: absolute; inset: 0; background-repeat: no-repeat; -webkit-mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent); }
  .tag { position: absolute; top: ${u * 0.8}px; left: ${u * 0.8}px; padding: ${u * 0.3}px ${u * 0.9}px; border-radius: 99px;
    font-size: ${u * 1.65}px; color: #ffe9b8; background: rgba(30,18,8,.72); border: 1px solid rgba(255,210,120,.5); }
  .cap { position: absolute; left: 0; right: 0; bottom: 0; padding: ${u * 0.6}px ${u * 1.2}px; background: linear-gradient(transparent, rgba(30,18,8,.85) 55%); }
  .cap b { font-family: 'Lilita'; font-weight: 400; font-size: ${u * 2.6}px; color: #fff; letter-spacing: .02em; }
  .card.dark .cap b { color: #ffd34d; }
  .gold .card { border-color: #ffd34d; box-shadow: 0 0 ${u * 3}px rgba(255,210,80,.55), 0 ${u * 0.5}px ${u * 1.4}px rgba(0,0,0,.45); }
  .title .pre { font-family: 'Lilita'; letter-spacing: .12em; color: #ffe9b0; text-shadow: 0 3px 0 #4a2c17; }
  .title h1 { font-family: 'Lilita'; font-weight: 400; line-height: .95; letter-spacing: .02em;
    background: linear-gradient(#fff6a8 10%, #ffd34d 45%, #f0a020 75%, #c8780c); -webkit-background-clip: text; color: transparent;
    -webkit-text-stroke: ${u * 0.4}px #4a2c17; filter: drop-shadow(0 ${u * 0.5}px 0 #4a2c17) drop-shadow(0 0 ${u * 2}px rgba(255,200,80,.45)); }
  .title p, .foot { color: #fff0d0; text-shadow: 0 2px 4px rgba(0,0,0,.5); }
  .foot b { font-family: 'Lilita'; font-weight: 400; color: #ffd34d; letter-spacing: .02em; }
  .badge { position: relative; z-index: 1; flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center;
    aspect-ratio: 1; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #5b3a1e, #2e1c0d); border: ${u * 0.5}px solid #e7b549;
    box-shadow: 0 ${u * 0.4}px ${u}px rgba(0,0,0,.5); }
  .badge span { font-family: 'Lilita'; line-height: 1; color: #ffd34d; }
  .badge small { line-height: 1.1; text-align: center; color: #f3e2bd; max-width: 85%; margin-top: ${u * 0.3}px; }
  .gold .badge { background: radial-gradient(circle at 35% 30%, #fff1a0, #e2a321 55%, #8a5a10); }
  .gold .badge span, .gold .badge small { color: #3a2410; font-weight: 700; }`;

/** 1920x1080: a staircase rising left to right, Demo bottom-left, Gold Standard top-right, the title in the empty corner */
function wideHtml(W, H) {
  const u = W / 192;                     // 10 px at 1920
  const pad = u * 4.8, gap = u * 2.2, step = u * 7.6;
  const cols = [...RUNGS].reverse();      // DEMO first
  // one slot per step, edge to edge between the page margins; the gold step is 1.5 slots wide.
  // Each card sits centred in its slot (gap/2 inset each side); each badge is centred on its slot with
  // its centre on the step line, so cards, treads, risers and badges share one grid.
  const unit = (W - 2 * pad) / cols.reduce((n, r) => n + (r.gold ? 1.5 : 1), 0);
  const slots = cols.map(r => r.gold ? unit * 1.5 : unit);
  let sx = pad;
  const badgeD = u * 8.4;
  const parts = cols.map((r, i) => {
    const slot = slots[i], x = sx + gap / 2, w = slot - gap, base = H - pad * 0.6 - badgeD / 2 - i * step;   // base = the tread's top
    const cards = r.cards.length > 1 ? [...r.cards].reverse() : r.cards;   // holiday above its colour bike
    const ch = r.cards.length > 1 ? u * 13.6 : (r.gold ? u * 25 : u * 19);
    const stackH = cards.length * ch + (cards.length - 1) * u;
    const top = base - badgeD / 2 - u - stackH;
    const extras = r.cards.flatMap(c => [c.extra, c.note]).filter(Boolean);
    const html = `
      ${extras.length ? `<div class="olabel" style="left:${x}px;bottom:${H - top + u * 0.8}px;width:${w}px">${emo(extras.join(' · '))}</div>` : ''}
      <div class="col${r.gold ? ' gold' : ''}" style="left:${x}px;top:${top}px;width:${w}px">
        ${cards.map(c => ({ ...c, extra: '', note: '' })).map(c => card(r.cards.length > 1 ? c : { ...c, size: r.gold ? 'auto 126%' : (c.stand ? 'auto 112%' : 'auto 128%'), pos: '50% 50%', fx: { gold_standard: 0.539, time_warp: 0.54 }[c.key] }).replace('class="card', `style="height:${ch}px" class="card`)).join('')}
      </div>
      <div class="tread${r.gold ? ' gold' : ''}" style="left:${sx}px;top:${base}px;width:${slot}px;height:${H - base}px"></div>
      <div class="${r.gold ? 'gold ' : ''}bw" style="left:${sx + slot / 2 - badgeD / 2}px;top:${base - badgeD / 2}px">
        <div class="badge" style="width:${badgeD}px"><span${/[^0-9]/.test(r.badge) ? ' class="word"' : ''}>${r.badge}</span><small>${r.label}</small></div></div>`;
    sx += slot;
    return html;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${sharedCss(u)}
  html, body { width: ${W}px; height: ${H}px; }
  .col { position: absolute; display: flex; flex-direction: column; gap: ${u}px; z-index: 2; }
  .col .cap b { font-size: ${u * 1.85}px; white-space: nowrap; }
  .col .tag { font-size: ${u * 1.35}px; }
  .tread { position: absolute; z-index: 0; background: linear-gradient(#f2c55c, #b07a2a ${u * 1.2}px, rgba(70,45,22,.55) ${u * 1.3}px, rgba(40,26,14,.35));
    border-left: ${u * 0.25}px solid #8a5a1c; }
  .bw { position: absolute; z-index: 3; }
  .olabel { position: absolute; z-index: 3; text-align: center; font-size: ${u * 1.5}px; line-height: 1.25; color: #ffe9b8; text-shadow: 0 2px 3px rgba(0,0,0,.6); }
  .bw .badge span { font-size: ${u * 3}px; }
  .bw .badge small { font-size: ${u * 1.05}px; }
  .bw.gold .badge span { font-size: ${u * 3.2}px; }
  .bw .badge span.word { font-size: ${u * 2.2}px; }
  .title { position: absolute; left: ${pad}px; top: ${pad * 0.8}px; width: ${u * 84}px; }
  .title .pre { font-size: ${u * 4}px; }
  .title h1 { font-size: ${u * 10.6}px; white-space: nowrap; }
  .title p { margin-top: ${u * 0.8}px; font-size: ${u * 2.5}px; }
  .title .foot { margin-top: ${u * 1.2}px; font-size: ${u * 2.2}px; }
  </style></head><body>
    <div class="title"><div class="pre">THE ROAD TO</div><h1>GOLD STANDARD</h1>
      <p>Ride for achievements, bikes, outfits and gifts for Grandma.</p>
      <p class="foot"><b>Start free with the demo.</b> Your progress comes with you.</p></div>
    ${parts}
  </body></html>`;
}

function html(W, H) {
  const rungs = RUNGS.map(r => `
    <div class="rung${r.gold ? ' gold' : ''}">
      <div class="bcol"><div class="badge"><span>${r.badge}</span><small>${r.label}</small></div></div>
      <div class="cards">${r.cards.map(card).join(r.arrow ? '<div class="arrow">→</div>' : '')}</div>
    </div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: 'Lilita'; src: url('${font}'); }
  * { box-sizing: border-box; margin: 0; }
  .emo { font-family: 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif; font-size: 1.35em; line-height: 1; vertical-align: -0.12em; }
  html, body { width: ${W}px; height: ${H}px; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #fff4dc; overflow: hidden;
    background: radial-gradient(ellipse at 50% 30%, #a08463 0%, #7d6448 45%, #3e2f20 100%); }
  .wrap { height: 100%; display: flex; flex-direction: column; padding: ${W * 0.035}px ${W * 0.04}px; gap: ${W * 0.018}px; }
  header { text-align: center; }
  header .pre { font-family: 'Lilita'; font-size: ${W * 0.04}px; letter-spacing: .12em; color: #ffe9b0; text-shadow: 0 3px 0 #4a2c17; }
  header h1 { font-family: 'Lilita'; font-weight: 400; font-size: ${W * 0.105}px; line-height: .95; letter-spacing: .02em;
    background: linear-gradient(#fff6a8 10%, #ffd34d 45%, #f0a020 75%, #c8780c); -webkit-background-clip: text; color: transparent;
    -webkit-text-stroke: ${W * 0.004}px #4a2c17; filter: drop-shadow(0 ${W * 0.005}px 0 #4a2c17) drop-shadow(0 0 ${W * 0.02}px rgba(255,200,80,.45)); }
  header p { margin-top: ${W * 0.008}px; font-size: ${W * 0.026}px; color: #fff0d0; text-shadow: 0 2px 4px rgba(0,0,0,.5); }
  .ladder { flex: 1; position: relative; display: flex; flex-direction: column; gap: ${W * 0.012}px; padding-left: ${W * 0.005}px; }
  .ladder::before { content: ''; position: absolute; left: ${W * 0.005 + W * 0.08 - W * 0.006}px; top: 2%; bottom: 2%; width: ${W * 0.012}px; border-radius: 99px;
    background: linear-gradient(90deg, #8a5a1c, #f2c55c 45%, #8a5a1c); box-shadow: 0 0 0 ${W * 0.002}px #3a2410; }
  .bcol { width: ${W * 0.16}px; flex: none; display: flex; justify-content: center; }
  .rung { flex: 1; display: flex; align-items: center; gap: ${W * 0.02}px; min-height: 0; }
  .rung.gold { flex: 1.6; }
  .badge { position: relative; z-index: 1; width: ${W * 0.135}px; flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center;
    aspect-ratio: 1; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #5b3a1e, #2e1c0d); border: ${W * 0.005}px solid #e7b549;
    box-shadow: 0 ${W * 0.004}px ${W * 0.01}px rgba(0,0,0,.5); }
  .badge span { font-family: 'Lilita'; font-size: ${W * 0.04}px; line-height: 1; color: #ffd34d; }
  .badge small { font-size: ${W * 0.0135}px; line-height: 1.1; text-align: center; color: #f3e2bd; max-width: 85%; margin-top: ${W * 0.003}px; }
  .gold .badge { width: ${W * 0.16}px; background: radial-gradient(circle at 35% 30%, #fff1a0, #e2a321 55%, #8a5a10); }
  .gold .badge span { color: #3a2410; font-size: ${W * 0.05}px; }
  .gold .badge small { color: #3a2410; font-weight: 700; }
  .cards { flex: 1; height: 100%; display: flex; align-items: stretch; gap: ${W * 0.012}px; min-width: 0; }
  .card { flex: 1; position: relative; border-radius: ${W * 0.014}px; overflow: hidden; border: ${W * 0.003}px solid rgba(255,220,150,.55);
    box-shadow: 0 ${W * 0.005}px ${W * 0.014}px rgba(0,0,0,.45); background: linear-gradient(#8a7456 0%, #8c7556 50%, #9c7b55 62%, #a07e58 100%); }
  .bg { position: absolute; inset: -12%; background-size: 100% 100%; filter: blur(${W * 0.03}px); }
  .tag { position: absolute; top: ${W * 0.008}px; left: ${W * 0.008}px; padding: ${W * 0.003}px ${W * 0.009}px; border-radius: 99px;
    font-size: ${W * 0.0165}px; color: #ffe9b8; background: rgba(30,18,8,.72); border: 1px solid rgba(255,210,120,.5); }
  .pic { position: absolute; inset: 0; background-repeat: no-repeat; -webkit-mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent); }
  .cap { position: absolute; left: 0; right: 0; bottom: 0; padding: ${W * 0.006}px ${W * 0.012}px; display: flex; flex-direction: column; align-items: flex-start; gap: ${W * 0.002}px;
    padding-top: ${W * 0.02}px; background: linear-gradient(transparent, rgba(30,18,8,.6) 30%, rgba(30,18,8,.9) 75%); }
  .cap b { font-family: 'Lilita'; font-weight: 400; font-size: ${W * 0.026}px; color: #fff; letter-spacing: .02em; }
  .cap i { font-style: normal; font-size: ${W * 0.018}px; line-height: 1.2; color: #ffe2a0; text-shadow: 0 1px 3px rgba(0,0,0,.7); }
  .cap b { line-height: 1.05; }
  .cap .row { align-self: stretch; display: flex; align-items: baseline; justify-content: space-between; gap: ${W * 0.015}px; }
  .cap em { font-style: normal; font-size: ${W * 0.018}px; color: #ffe2a0; text-shadow: 0 1px 3px rgba(0,0,0,.7); }
  .card.dark .cap b { color: #ffd34d; }
  .arrow { align-self: center; font-family: 'Lilita'; font-size: ${W * 0.04}px; color: #ffd34d; text-shadow: 0 2px 0 #4a2c17; }
  .gold .card { border-color: #ffd34d; box-shadow: 0 0 ${W * 0.03}px rgba(255,210,80,.55), 0 ${W * 0.005}px ${W * 0.014}px rgba(0,0,0,.45); }
  footer { text-align: center; font-size: ${W * 0.024}px; color: #fff0d0; text-shadow: 0 2px 4px rgba(0,0,0,.5); }
  footer b { font-family: 'Lilita'; font-weight: 400; color: #ffd34d; letter-spacing: .02em; }
  </style></head><body><div class="wrap">
    <header><div class="pre">THE ROAD TO</div><h1>GOLD STANDARD</h1>
      <p>Ride for achievements, bikes, outfits and gifts for Grandma.</p></header>
    <div class="ladder">${rungs}</div>
    <footer><b>Start free with the demo.</b> Your progress comes with you.</footer>
  </div></body></html>`;
}

/**
 * In the page: centre a card's subject horizontally where the card names it (data-fx = the subject's middle as a
 * fraction of the plate's width; the special bikes stand a little right of the plate's centre).
 */
function centreSubjects() {
  const out = [];
  for (const el of document.querySelectorAll('.pic[data-fx]')) {
    const fx = parseFloat(el.dataset.fx), aspect = parseFloat(el.dataset.aspect);
    const cw = el.clientWidth, chh = el.clientHeight;
    const bs = getComputedStyle(el).backgroundSize.split(' ');           // 'auto 126%'
    const bw = (bs[1] && bs[1].endsWith('%') ? chh * parseFloat(bs[1]) / 100 : chh) * aspect;
    el.style.backgroundPositionX = (cw / 2 - fx * bw) + 'px';
    out.push({ fx, cw, bw: Math.round(bw), x: el.style.backgroundPositionX });
  }
  return out;
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--allow-file-access-from-files'] });
for (const [name, W, H, wide] of [['ladder_store', 1232, 2600], ['ladder_vertical', 1080, 1920], ['ladder_wide', 1920, 1080, true]]) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  const file = path.join(OUTDIR, `_${name}.html`);
  fs.writeFileSync(file, wide ? wideHtml(W, H) : html(W, H));
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const moved = await page.evaluate(centreSubjects);
  if (moved.length) console.log("  centred", JSON.stringify(moved));
  const out = path.join(OUTDIR, `${name}${SUFFIX}.png`);
  await page.screenshot({ path: out });
  console.log('wrote', out);
  await page.close();
}
await browser.close();
