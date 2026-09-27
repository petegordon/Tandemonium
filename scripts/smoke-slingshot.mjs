#!/usr/bin/env node
// smoke-slingshot.mjs — Slingshot mode end to end: lobby button → garage →
// buy an upgrade → the bike sits in the slingshot (no countdown, no
// checkpoints) → pedaling and a mouse drag pull it back → letting go launches
// → reset returns it to the slingshot → both pedals launch → stall pays out →
// launch again → crash pays out → reaching the stage goal clears the stage.
// Headless software rendering runs at ~1-2 fps, so pedal strokes are fed to
// the pedal controller and the stall/crash/distance are set directly.
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

// 3. Launch → instructions → the aim phase at the slingshot
await page.evaluate(() => Array.from(document.querySelectorAll('#sling-garage button')).find(b => /launch/i.test(b.textContent)).click());
await page.waitForFunction(() => ['instructions', 'countdown'].includes(window._game.state), { timeout: 60000 });
if (await page.evaluate(() => window._game.state === 'instructions')) {
  await page.evaluate(() => window._game._startCountdown());
}
await waitState('countdown', 60000);
// Headless renders at ~1-2 fps, far too slow to pedal: feed the pedal
// controller's output directly (a queue of frames), falling back to the real one.
await page.evaluate(() => {
  const g = window._game; const orig = g.pedalCtrl.update.bind(g.pedalCtrl);
  window.__feed = [];
  g.pedalCtrl.update = (dt) => (window.__feed.length ? window.__feed.shift() : orig(dt));
});
const pedal = (acceleration, braking = false) => page.evaluate((a, b) => window.__feed.push({ acceleration: a, braking: b, wobble: 0, crankAngle: 0 }), acceleration, braking);
const aim = await page.evaluate(() => {
  const g = window._game;
  return {
    pullVisible: document.getElementById('sling-pull').classList.contains('visible'),
    rig: !!g._slingRig, coins: g.collectibleManager.getTotalItems(), coast: !!g.bike.coast,
    checkpoints: g.raceManager.checkpoints.length, d: g.bike.distanceTraveled, flavor: document.getElementById('countdown-flavor-num').textContent,
  };
});
check(aim.pullVisible && aim.rig && aim.coast && aim.coins > 0, `aim phase: slingshot built, pull meter up, ${aim.coins} Chaos Coins placed`);
check(aim.checkpoints === 0, `no checkpoints (${aim.checkpoints})`);
check(Math.abs(aim.d - 5.2) < 0.01 && aim.flavor === '', `bike rests in the slingshot at ${aim.d.toFixed(2)} m, no countdown numbers`);
await new Promise(r => setTimeout(r, 4000));
check(await page.evaluate(() => window._game.state === 'countdown'), 'the slingshot waits for the riders — no countdown launches it');

// 4. Pedal pulls the bike back; a mouse drag pulls it the rest of the way; letting go launches
await pedal(3);
await page.waitForFunction(() => window._game._slingRun.pull >= 0.5, { timeout: 30000, polling: 100 });
const half = await page.evaluate(() => ({ pull: window._game._slingRun.pull, d: window._game.bike.distanceTraveled }));
check(half.d < 5.2 - 1, `pedaling draws the bike back (pull ${half.pull.toFixed(2)}, bike at ${half.d.toFixed(2)} m)`);
await page.mouse.move(640, 300);
await page.mouse.down();
await page.mouse.move(640, 330, { steps: 2 });
await page.mouse.move(640, 700, { steps: 4 });
await page.waitForFunction(() => window._game._slingRun.pull >= 1, { timeout: 30000, polling: 100 });
const full = await page.evaluate(() => {
  const g = window._game; const rig = g._slingRig;
  // Pouch behind the fork: its road-forward offset from the fork centre is negative.
  const fwd = rig._fwd; const rel = rig.pouch.position.clone().sub(rig._center);
  return { pull: g._slingRun.pull, d: g.bike.distanceTraveled, pouchAhead: rel.dot(fwd), state: g.state };
});
check(full.pull === 1 && Math.abs(full.d - 1.7) < 0.05 && full.pouchAhead < -2, `dragging down pulls it all the way (bike at ${full.d.toFixed(2)} m, pouch ${full.pouchAhead.toFixed(1)} m behind the fork)`);
await new Promise(r => setTimeout(r, 2500));
check(await page.evaluate(() => window._game.state === 'countdown'), 'a held drag does not auto-release');
await shot('2-aim');
await page.mouse.up();
await waitState('playing', 60000);
const launch = await page.evaluate(() => ({ speed: window._game.bike.speed, max: window._game._slingStats.launchMax, hud: document.getElementById('sling-hud').classList.contains('visible') }));
check(Math.abs(launch.speed - launch.max) < 1.5 && launch.hud, `letting go launches at ${launch.speed.toFixed(1)} m/s (launchMax ${launch.max.toFixed(1)})`);
await new Promise(r => setTimeout(r, 3000));
const coasting = await page.evaluate(() => ({ d: window._game.bike.distanceTraveled, v: window._game.bike.speed }));
check(coasting.d > 1.7 && coasting.v > 0, `the bike flies on its own (${coasting.d.toFixed(1)} m, ${coasting.v.toFixed(1)} m/s)`);
await shot('3-riding');

// 5. Reset mid-run → back into the slingshot, unpaid
const runsBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('tandemonium_slingshot')).runs);
await page.evaluate(() => window._game._resetGame());
await waitState('countdown', 60000);
const back = await page.evaluate(() => ({ d: window._game.bike.distanceTraveled, pull: window._game._slingRun.pull, launched: window._game._slingRun.launched, runs: JSON.parse(localStorage.getItem('tandemonium_slingshot')).runs }));
check(Math.abs(back.d - 5.2) < 0.01 && back.pull === 0 && !back.launched && back.runs === runsBefore, `reset puts the bike back in the slingshot (at ${back.d.toFixed(2)} m, run not paid)`);

// 6. Both pedals let go (a lazy pull), then a stall → results with a payout
await pedal(1.2);
await pedal(0, true);
await waitState('playing', 60000);
await page.evaluate(() => { const g = window._game; g._slingRun.coins = 3; g.bike.speed = 0; g.bike.coast.decel = () => 50; });
await waitState('slingResults', 60000);
const r1 = await page.evaluate(() => ({ title: document.querySelector('#sling-results h2').textContent, save: JSON.parse(localStorage.getItem('tandemonium_slingshot')) }));
check(/stop/i.test(r1.title) && r1.save.runs === 1 && r1.save.coins > 60, `both pedals launch; stalling pays out ("${r1.title}", wallet ${r1.save.coins})`);
await shot('4-results');

// 7. Launch again → straight back into the slingshot → crash ends the run
await page.evaluate(() => Array.from(document.querySelectorAll('#sling-results button')).find(b => /again/i.test(b.textContent)).click());
await waitState('countdown', 60000);
check(await page.evaluate(() => Math.abs(window._game.bike.distanceTraveled - 5.2) < 0.01), 'launch again goes straight back to the slingshot');
await pedal(0, true);
await waitState('playing', 120000);
await page.evaluate(() => window._game.bike._fall());
await waitState('slingResults', 60000);
const r2 = await page.evaluate(() => ({ title: document.querySelector('#sling-results h2').textContent, runs: JSON.parse(localStorage.getItem('tandemonium_slingshot')).runs }));
check(/crash/i.test(r2.title) && r2.runs === 2, `a crash ends the run ("${r2.title}")`);

// 8. Reach the stage goal → stage cleared
await page.evaluate(() => Array.from(document.querySelectorAll('#sling-results button')).find(b => /again/i.test(b.textContent)).click());
await waitState('countdown', 60000);
await pedal(0, true);
await waitState('playing', 120000);
await page.evaluate(() => { const g = window._game; g.bike.distanceTraveled = g.lobby.selectedLevel.distance - 0.5; g.bike.speed = 15; });
await waitState('slingResults', 180000);
const r3 = await page.evaluate(() => ({ title: document.querySelector('#sling-results h2').textContent, stage: JSON.parse(localStorage.getItem('tandemonium_slingshot')).stage }));
check(/goal/i.test(r3.title) && r3.stage === 2, `reaching the goal clears the stage ("${r3.title}", now stage ${r3.stage})`);
await shot('5-goal');

// 9. Lobby cleans up
await page.evaluate(() => Array.from(document.querySelectorAll('#sling-results button')).find(b => /lobby/i.test(b.textContent)).click());
await new Promise(r => setTimeout(r, 1000));
const clean = await page.evaluate(() => ({ sling: window._game.isSlingshot, coast: window._game.bike.coast, rig: window._game._slingRig, overlays: ['sling-garage', 'sling-results', 'sling-hud', 'sling-pull'].some(id => document.getElementById(id).classList.contains('visible')) }));
check(!clean.sling && !clean.coast && !clean.rig && !clean.overlays, 'returning to the lobby leaves slingshot mode and removes the slingshot');
check(errors.length === 0, `no page errors (${errors.length})`);

await browser.close(); server.close();
const ok = checks.every(Boolean);
console.log(ok ? '✔ slingshot mode smoke passed' : '✖ slingshot mode smoke FAILED');
process.exit(ok ? 0 : 1);
