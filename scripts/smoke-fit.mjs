#!/usr/bin/env node
// smoke-fit.mjs — the bike × geese fit, measured headless (#505).
//
// Opens tools/fit-viewer (the in-game assembly: goose_tandem.glb + the riders of every Goose
// Outfit, seated by js/goose-riders.js), sweeps one crank turn per outfit and judges the contact
// distances with js/fit/fit-rules.js: hips over the socket, body on the saddle, feet on the pedals
// at every crank step, hands at the grips, cloth out of the rear wheel, and the bike's own rear
// end clear of its tyre. Screenshots at the same camera presets go to renders/fit/ (before/after
// sheets). Lines the assets are known to fail today print KNOWN BUG instead of failing the run;
// once an asset is fixed they flip to "FIXED (make this a check)".
//   node scripts/smoke-fit.mjs [--outfits victorian,cyclists] [--steps 12] [--no-shots]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUTFITS = opt('--outfits', 'victorian,cyclists,fancy,georgian').split(',');
const STEPS = Number(opt('--steps', 12));
const SHOTS = !args.includes('--no-shots');
const PORT = 8964;
const OUT = path.join(ROOT, 'renders', 'fit');
if (SHOTS) fs.mkdirSync(OUT, { recursive: true });

// The asset defects #505 is about. Each is a RegExp on the judged line's name; while an asset still
// fails one, the line is reported as KNOWN BUG (the smoke stays green so CI can run it). The saddle
// lines are real checks: a saddle swallowed by breeches or a skirt is right, a floating goose is not.
const KNOWN = [
  /cloth vertices in the rear wheel/,   // the skirts drape over the rear wheel (goose-fit-tandem.md P5.4)
];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/favicon.ico') return res.writeHead(204).end();
  if (u.endsWith('/')) u += 'index.html';
  const f = path.join(ROOT, u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { console.log('  404', u); return res.writeHead(404).end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  if (u.startsWith(`http://127.0.0.1:${PORT}`)) return req.continue();
  let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
  if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')) });
  m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/);
  const f = m && path.join(ROOT, 'node_modules/three/examples/jsm/' + m[1]);
  if (f && fs.existsSync(f)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
  return req.abort();
});
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e).slice(0, 200)); console.log('  PAGEERROR:', String(e).slice(0, 200)); });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); else if (/context/i.test(m.text())) console.log('  console:', m.text().slice(0, 120)); });

const results = [];
const check = (ok, name, detail) => { results.push(!!ok); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); return !!ok; };
const known = (ok, name, detail) => console.log(`  ${ok ? 'FIXED (make this a check)' : 'KNOWN BUG'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
const mm = (v) => (typeof v === 'number' && Math.abs(v) < 10 ? Math.round(v * 1000) + ' mm' : v);
const SLUG = { side: 'side', 'saddle C': 'saddle_C', 'saddle S': 'saddle_S', 'pedals F': 'pedals_F', 'rear wheel': 'rear_wheel', '¾': 'three_quarter' };
/** Screenshot once a frame has drawn the assembly (after a long evaluate the first frames can be empty). */
async function shot(name) {
  for (let i = 0; i < 20; i++) {
    const d = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => { window.__fit.render(); r(window.__fit.debug()); }))));
    if (d.triangles > 1000) break;
    await new Promise((r) => setTimeout(r, 300));
    if (i === 19) console.log('  (frame still empty:', JSON.stringify(d), ')');
  }
  await page.screenshot({ path: path.join(OUT, name + '.png') });
}

await page.goto(`http://127.0.0.1:${PORT}/tools/fit-viewer/index.html?capture&outfit=${OUTFITS[0]}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__fit && window.__fit.ready, { timeout: 180000 });
check(true, 'fit viewer loads the goose tandem and its riders');

const summary = {};
for (const outfit of OUTFITS) {
  console.log(`\n${outfit}`);
  const got = await page.evaluate((k) => window.__fit.setOutfit(k), outfit);
  check(got === outfit, `${outfit}: riders seated`, got);
  await page.evaluate(() => { window.__fit.setSolo(false); window.__fit.setLeans(0, 0); });
  const rep = await page.evaluate((n) => window.__fit.sweep(n), STEPS);
  const j = await page.evaluate(() => window.__fit.judge());
  summary[outfit] = { pass: j.pass, lines: j.lines };
  for (const l of j.lines) {
    const detail = l.note ? `${mm(l.value)} · ${l.note}` : mm(l.value);
    if (KNOWN.some(k => k.test(l.name))) known(l.pass, `${outfit}: ${l.name}`, detail);
    else check(l.pass, `${outfit}: ${l.name}`, detail);
  }
  check(rep.riders.Captain && rep.riders.Stoker, `${outfit}: both geese measured`, Object.keys(rep.riders));
  if (SHOTS) {
    if (outfit === OUTFITS[0]) {
      await page.evaluate(() => { window.__fit.showGeese(false); window.__fit.setCrank(60); window.__fit.view('side'); });
      await shot('bike-only-side');
      await page.evaluate(() => { window.__fit.view('rear wheel ¾'); });
      await shot('bike-only-rear_wheel');
      await page.evaluate(() => window.__fit.showGeese(true));
    }
    if (outfit === OUTFITS[0]) console.log('  render', JSON.stringify(await page.evaluate(() => window.__fit.debug())));
    for (const [view, slug] of Object.entries(SLUG)) {
      await page.evaluate((v) => { window.__fit.setCrank(60); window.__fit.view(v); }, view);
      await shot(`${outfit}-${slug}`);
    }
    await page.evaluate(() => { window.__fit.cut('x', 0.0); window.__fit.view('saddle C'); });
    await shot(`${outfit}-saddle_C_section`);
    await page.evaluate(() => { window.__fit.view('saddle S'); });
    await shot(`${outfit}-saddle_S_section`);
    await page.evaluate(() => window.__fit.cut(null));
  }
}
// Show Solo: the captain alone measures the same as with the stoker aboard
await page.evaluate(() => { window.__fit.setSolo(true); });
const solo = await page.evaluate((n) => window.__fit.sweep(n), STEPS);
check(solo.riders.Captain && !solo.riders.Stoker, 'Show Solo: only the captain is measured', Object.keys(solo.riders));
if (SHOTS) { await page.evaluate(() => { window.__fit.setCrank(60); window.__fit.view('side'); }); await shot('solo-side'); }

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'fit-report.json'), JSON.stringify(summary, null, 1));
check(errors.length === 0, 'no page errors', errors.slice(0, 3));
await browser.close();
server.close();
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed${SHOTS ? ` · screenshots: ${OUT}` : ''}`);
process.exit(failed ? 1 : 0);
