#!/usr/bin/env node
// smoke-tutorial-board.mjs — #503: the tutorial rides between two 3D boards in the end-card style.
// Checks: both boards are built (start + end, 3 meshes each, baked face texture loaded), the old
// "Your Home" video and the placeholder box house are gone from the tutorial, Grandma's keeps its
// own markers, and nothing logs a page error. Writes renders/smoke-tutorial-board.png.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT = process.cwd(); const PORT = 8917;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.json': 'application/json', '.webp': 'image/webp', '.mp4': 'video/mp4' };
const server = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  fs.stat(f, (e, st) => { if (e || st.isDirectory()) return r.writeHead(404).end(); r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }); });
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
await page.setRequestInterception(true);
page.on('request', (req) => { const u = req.url(); if (u.startsWith(`http://127.0.0.1:${PORT}`)) return req.continue();
  let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
  if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')) });
  m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f = m && path.join(ROOT, 'node_modules/three/examples/jsm/' + m[1]);
  if (f && fs.existsSync(f)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
  return req.abort(); });
const errors = [];
page.on('pageerror', e => { errors.push(e.message); console.log('  PAGEERROR:', e.message); });
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window._game, { timeout: 30000 });
await page.click('#tap-to-start').catch(() => {});
await new Promise(r => setTimeout(r, 600));

let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const markers = () => page.evaluate(() => window._game.world._raceMarkers.map(m => ({
  type: m.type, board: !!m.board, name: m.mesh.name || '', video: !!m.billboard, house: !!m.house,
  meshes: (() => { let n = 0; m.mesh.traverse(o => { if (o.isMesh) n++; }); return n; })(),
  tex: (() => { let ok = null; m.mesh.traverse(o => { if (o.isMesh && o.material.map) ok = !!(o.material.map.image && o.material.map.image.width >= 2048); }); return ok; })(),
})));

// the tutorial
const level = await page.evaluate(async () => {
  const { LEVELS } = await import('/js/race-config.js');
  const tut = LEVELS.find(l => l.isTutorial);
  window._game.world.setRaceMarkers(tut, window._game.camera);
  return tut.id;
});
await page.waitForFunction(() => window._game.world._raceMarkers.filter(m => m.board).every(m => {
  let ok = false; m.mesh.traverse(o => { if (o.isMesh && o.material.map && o.material.map.image && o.material.map.image.width) ok = true; }); return ok; }), { timeout: 30000 }).catch(() => {});
let ms = await markers();
const boards = ms.filter(m => m.board);
check(boards.length === 2, `${level}: two boards (${boards.map(b => b.name).join(', ')})`);
check(boards.every(b => b.meshes === 3), 'each board is three meshes (draw calls)');
check(boards.every(b => b.tex === true), 'baked faces loaded (2048 px atlases)');
check(!ms.some(m => m.video), 'no "Your Home" video billboard on the tutorial');
check(!ms.some(m => m.type === 'destination' && !m.board), 'no placeholder destination house on the tutorial');

// #543 · one checkered strip at the finish: no road stripe at or past the finish line except the finish itself
const stripes = await page.evaluate(() => { const w = window._game.world, L = w.roadPath.loopLength;
  return { L, ds: w._raceMarkers.filter(m => m.type === 'stripe').map(m => Math.round(m.roadD * 10) / 10) }; });
const tutDist = await page.evaluate(async () => (await import('/js/race-config.js')).LEVELS.find(l => l.isTutorial).distance);
const atEnd = stripes.ds.filter(d => d >= tutDist - 20);
check(atEnd.length === 1 && atEnd[0] === tutDist % stripes.L, `${level}: exactly one stripe at the finish (${tutDist} m) — stripes at ${stripes.ds.join(', ')} m`);
check(stripes.ds.every(d => d <= tutDist), `${level}: no stripe past the finish line`);

// a picture: in front of the end board
await page.evaluate(() => {
  const g = window._game, m = g.world._raceMarkers.find(q => q.mesh.name === 'tutorial-board-end');
  m.mesh.visible = true; const p = m.mesh.position, a = m.mesh.rotation.y;
  g.camera.position.set(p.x + Math.sin(a) * 9, p.y + 2.6, p.z + Math.cos(a) * 9); g.camera.lookAt(p.x, p.y + 2.8, p.z);
  g.renderer.render(g.scene, g.camera);
});
fs.mkdirSync(path.join(ROOT, 'renders'), { recursive: true });
await page.screenshot({ path: path.join(ROOT, 'renders', 'smoke-tutorial-board.png') });

// Grandma's keeps its own markers, and the boards are disposed
await page.evaluate(async () => { const { getLevelById } = await import('/js/race-config.js'); window._game.world.setRaceMarkers(getLevelById('grandma'), window._game.camera); });
ms = await markers();
check(!ms.some(m => m.board), "grandma: no tutorial boards");
check(ms.some(m => m.video) && ms.some(m => m.house), 'grandma: keeps the "Your Home" sign and the 3D house');
const gStripes = await page.evaluate(() => window._game.world._raceMarkers.filter(m => m.type === 'stripe').length);
check(gStripes === 1, `grandma: one finish stripe (${gStripes})`);
check(errors.length === 0, `no page errors (${errors.length})`);

await browser.close(); server.close();
console.log(fails ? `${fails} check(s) failed` : 'tutorial boards: all checks passed');
process.exit(fails ? 1 : 0);
