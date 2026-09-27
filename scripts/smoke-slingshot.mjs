#!/usr/bin/env node
// smoke-slingshot.mjs — Slingshot mode end to end: lobby button → garage →
// buy an upgrade → wind-up → launch → stall pays out → launch again → crash
// pays out → reaching the stage goal clears the stage. Headless software
// rendering runs at ~1-2 fps, so the script drives state directly where real
// input would be too slow (the pull, the stall, the crash, the distance).
//   node scripts/smoke-slingshot.mjs [--shots <dir>]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT = process.cwd(); const PORT = 8921;
const shotsIdx = process.argv.indexOf('--shots');
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.json': 'application/json' };
const server = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  fs.stat(f, (e, st) => { if (e || st.isDirectory()) return r.writeHead(404).end(); r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url(); if (u.startsWith(`http://127.0.0.1:${PORT}`)) return req.continue();
  let m = u.match(/three@[^/]+\/build\/three\.module\.js/);
  if (m) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')) });
  m = u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f = m && path.join(ROOT, 'node_modules/three/examples/jsm/' + m[1]);
  if (f && fs.existsSync(f)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(f) });
  return req.abort();
});
const errors = [];
page.on('pageerror', e => { errors.push(e.message); console.log('  PAGEERROR:', e.message); });
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const checks = [];
const check = (ok, msg) => { checks.push(ok); console.log(`${ok ? '✔' : '✖'} ${msg}`); };
const waitState = (s, timeout = 120000) => page.waitForFunction((s) => window._game?.state === s, { timeout, polling: 100 }, s);

// A clean wallet with enough coins to buy something.
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('tandemonium_slingshot', JSON.stringify({ coins: 100, best: 0, runs: 0, stage: 1, lv: {} })); } catch (e) {}
});
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window._game, { timeout: 30000 });
await page.click('#tap-to-start').catch(() => {});
await new Promise(r => setTimeout(r, 500));

// 1. Lobby button → garage
await page.evaluate(() => document.getElementById('btn-slingshot').click());
await waitState('slingGarage', 10000);
check(await page.evaluate(() => document.getElementById('sling-garage').classList.contains('visible')), 'lobby button opens the garage');
await shot('1-garage');

// 2. Buy the slingshot upgrade (40 coins)
await page.evaluate(() => document.querySelectorAll('#sling-garage .sling-up')[0].click());
const afterBuy = await page.evaluate(() => JSON.parse(localStorage.getItem('tandemonium_slingshot')));
check(afterBuy.coins === 60 && afterBuy.lv.sling === 1, `buying spends coins and saves (coins ${afterBuy.coins}, sling L${afterBuy.lv.sling})`);

// 3. Launch → instructions → countdown (wind-up)
await page.evaluate(() => Array.from(document.querySelectorAll('#sling-garage button')).find(b => /launch/i.test(b.textContent)).click());
await page.waitForFunction(() => ['instructions', 'countdown'].includes(window._game.state), { timeout: 60000 });
if (await page.evaluate(() => window._game.state === 'instructions')) {
  await page.evaluate(() => window._game._startCountdown());
}
await waitState('countdown', 60000);
const wind = await page.evaluate(() => {
  const g = window._game;
  return { pullVisible: document.getElementById('sling-pull').classList.contains('visible'), coins: g.collectibleManager.getTotalItems(), coast: !!g.bike.coast, level: g.lobby.selectedLevel.id };
});
check(wind.pullVisible && wind.coast && wind.level === 'slingshot' && wind.coins > 0, `wind-up shows the pull meter, coast physics on, ${wind.coins} Chaos Coins placed`);
await page.evaluate(() => { window._game._slingRun.pull = 1; });   // a full pull (headless fps is too low to pedal it)
await shot('2-windup');

// 4. GO → launched at full launch speed
await waitState('playing', 120000);
const launch = await page.evaluate(() => ({ speed: window._game.bike.speed, max: window._game._slingStats.launchMax, hud: document.getElementById('sling-hud').classList.contains('visible') }));
check(Math.abs(launch.speed - launch.max) < 1.5 && launch.hud, `GO launches at ${launch.speed.toFixed(1)} m/s (launchMax ${launch.max.toFixed(1)}), HUD up`);
await new Promise(r => setTimeout(r, 3000));
const coasting = await page.evaluate(() => ({ d: window._game.bike.distanceTraveled, v: window._game.bike.speed }));
check(coasting.d > 1 && coasting.v > 0, `the bike rolls on its own (${coasting.d.toFixed(1)} m, ${coasting.v.toFixed(1)} m/s)`);
await shot('3-riding');

// 5. Stall → results with a payout
await page.evaluate(() => { const g = window._game; g._slingRun.coins = 3; g.bike.speed = 0; g.bike.coast.decel = () => 50; });
await waitState('slingResults', 60000);
const r1 = await page.evaluate(() => ({ title: document.querySelector('#sling-results h2').textContent, save: JSON.parse(localStorage.getItem('tandemonium_slingshot')) }));
check(/stop/i.test(r1.title) && r1.save.runs === 1 && r1.save.coins > 60, `stalling ends the run and pays out ("${r1.title}", wallet ${r1.save.coins})`);
await shot('4-results');

// 6. Launch again (no instructions this time) → crash ends the run
await page.evaluate(() => Array.from(document.querySelectorAll('#sling-results button')).find(b => /again/i.test(b.textContent)).click());
await waitState('countdown', 60000);
check(true, 'launch again goes straight to the wind-up');
await waitState('playing', 120000);
await page.evaluate(() => window._game.bike._fall());
await waitState('slingResults', 60000);
const r2 = await page.evaluate(() => ({ title: document.querySelector('#sling-results h2').textContent, runs: JSON.parse(localStorage.getItem('tandemonium_slingshot')).runs }));
check(/crash/i.test(r2.title) && r2.runs === 2, `a crash ends the run ("${r2.title}")`);

// 7. Reach the stage goal → stage cleared
await page.evaluate(() => Array.from(document.querySelectorAll('#sling-results button')).find(b => /again/i.test(b.textContent)).click());
await waitState('playing', 120000);
await page.evaluate(() => { const g = window._game; g.bike.distanceTraveled = g.lobby.selectedLevel.distance - 0.5; g.bike.speed = 15; });
await waitState('slingResults', 180000);
const r3 = await page.evaluate(() => ({ title: document.querySelector('#sling-results h2').textContent, stage: JSON.parse(localStorage.getItem('tandemonium_slingshot')).stage }));
check(/goal/i.test(r3.title) && r3.stage === 2, `reaching the goal clears the stage ("${r3.title}", now stage ${r3.stage})`);
await shot('5-goal');

// 8. Lobby cleans up
await page.evaluate(() => Array.from(document.querySelectorAll('#sling-results button')).find(b => /lobby/i.test(b.textContent)).click());
await new Promise(r => setTimeout(r, 1000));
const clean = await page.evaluate(() => ({ sling: window._game.isSlingshot, coast: window._game.bike.coast, overlays: ['sling-garage', 'sling-results', 'sling-hud'].some(id => document.getElementById(id).classList.contains('visible')) }));
check(!clean.sling && !clean.coast && !clean.overlays, 'returning to the lobby leaves slingshot mode');
check(errors.length === 0, `no page errors (${errors.length})`);

await browser.close(); server.close();
const ok = checks.every(Boolean);
console.log(ok ? '✔ slingshot mode smoke passed' : '✖ slingshot mode smoke FAILED');
process.exit(ok ? 0 : 1);
