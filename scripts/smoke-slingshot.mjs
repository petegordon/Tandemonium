#!/usr/bin/env node
// smoke-slingshot.mjs — Slingshot mode end to end with real mouse drags:
// lobby button → garage → buy an upgrade → the bike waits in the slingshot (no
// countdown, no checkpoints, no pedals; pedaling does nothing) → drag back and
// left: bands stretch, bike shifts left and aims right → let go: it flies that
// way → reset returns it to the slingshot → a flick cancels → stall, crash and
// stage-goal endings pay out. Headless renders at ~1-2 fps, so the stall, the
// crash and the distance are set directly.
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

// 3. Launch → instructions → the bike waits in the slingshot
await page.evaluate(() => Array.from(document.querySelectorAll('#sling-garage button')).find(b => /launch/i.test(b.textContent)).click());
await page.waitForFunction(() => ['instructions', 'countdown'].includes(window._game.state), { timeout: 60000 });
if (await page.evaluate(() => window._game.state === 'instructions')) {
  await page.evaluate(() => window._game._startCountdown());
}
await waitState('countdown', 60000);
// Pedal strokes, fed straight to the pedal controller (headless is ~1-2 fps).
await page.evaluate(() => {
  const g = window._game; const orig = g.pedalCtrl.update.bind(g.pedalCtrl);
  window.__feed = [];
  g.pedalCtrl.update = (dt) => (window.__feed.length ? window.__feed.shift() : orig(dt));
});
const pedal = (acceleration, braking = false) => page.evaluate((a, b) => window.__feed.push({ acceleration: a, braking: b, wobble: 0, crankAngle: 0 }), acceleration, braking);
// The bike's offset from the road's centre line and its heading relative to the road.
const pose = () => page.evaluate(() => {
  const g = window._game, b = g.bike, rp = g.world.roadPath;
  const pt = rp.getPointAtDistance(b.roadD);
  const lateral = (b.position.x - pt.x) * Math.cos(pt.heading) - (b.position.z - pt.z) * Math.sin(pt.heading);
  return { d: b.distanceTraveled, lateral, angle: b.heading - pt.heading, pull: g._slingRun.pull, state: g.state, speed: b.speed };
});
// Drag from the middle of the screen by (dx, dy); optionally let go.
async function drag(dx, dy, letGo) {
  await page.mouse.move(640, 300);
  await page.mouse.down();
  await page.mouse.move(640 + dx * 0.1, 300 + dy * 0.1, { steps: 2 });
  await page.mouse.move(640 + dx, 300 + dy, { steps: 4 });
  await page.waitForFunction(() => window._game._slingRun.pull > 0.05, { timeout: 30000, polling: 100 });
  if (letGo) await page.mouse.up();
}
const aim = await page.evaluate(() => {
  const g = window._game;
  return {
    pullVisible: document.getElementById('sling-pull').classList.contains('visible'),
    pedalsHidden: getComputedStyle(document.getElementById('pedal-bar')).display === 'none',
    rig: !!g._slingRig, coins: g.collectibleManager.getTotalItems(), coast: !!g.bike.coast,
    checkpoints: g.raceManager.checkpoints.length, flavor: document.getElementById('countdown-flavor-num').textContent,
  };
});
check(aim.pullVisible && aim.rig && aim.coast && aim.coins > 0, `the slingshot is built, hint up, ${aim.coins} Chaos Coins placed`);
check(aim.pedalsHidden, 'no pedal pads in this mode');
check(aim.checkpoints === 0 && aim.flavor === '', 'no checkpoints and no countdown');
const rest = await pose();
check(Math.abs(rest.d - 5.2) < 0.01 && Math.abs(rest.lateral) < 0.05, `the bike rests in the slingshot (${rest.d.toFixed(2)} m, centred)`);
await pedal(3); await pedal(3); await pedal(0, true);
await new Promise(r => setTimeout(r, 4000));
const still = await pose();
check(still.state === 'countdown' && still.pull === 0, 'pedaling does nothing, and nothing launches it but a drag');

// 4. Drag back and to the left: the bands stretch, the bike moves left and aims right
await drag(-250, 240, false);
await new Promise(r => setTimeout(r, 1500));
const held = await pose();
const rig = await page.evaluate(() => {
  const r = window._game._slingRig; const rel = r.pouch.position.clone().sub(r._center);
  return { pouchBack: rel.dot(r._fwd), guide: r.guide.visible };
});
check(held.pull > 0.75 && held.d < 3, `dragging back pulls the bike back (pull ${held.pull.toFixed(2)}, bike at ${held.d.toFixed(2)} m, pouch ${rig.pouchBack.toFixed(1)} m behind the fork)`);
check(held.lateral < -0.8 && held.angle > 0.2 && rig.guide, `dragging left shifts it left (${held.lateral.toFixed(2)} m) and aims it right (${(held.angle * 57.3).toFixed(0)}°), guide shown`);
check(held.state === 'countdown', 'holding the drag holds the shot');
await shot('2-aim');
await page.mouse.up();
await waitState('playing', 60000);
const launch = await page.evaluate(() => ({ speed: window._game.bike.speed, max: window._game._slingStats.launchMax, guide: window._game._slingRig.guide.visible }));
check(launch.speed > launch.max * 0.75 && !launch.guide, `letting go launches (${launch.speed.toFixed(1)} m/s of ${launch.max.toFixed(1)})`);
await pedal(3); await pedal(3);
await new Promise(r => setTimeout(r, 3000));
const flying = await pose();
check(flying.d > held.d + 1 && flying.lateral > held.lateral + 0.3, `it flies the way it was aimed (now ${flying.lateral.toFixed(2)} m across, ${flying.d.toFixed(1)} m along)`);
check(flying.speed <= launch.speed, `pedaling adds nothing in the air (${flying.speed.toFixed(1)} m/s)`);
await shot('3-riding');

// 5. Reset mid-run → back into the slingshot, unpaid
const runsBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('tandemonium_slingshot')).runs);
await page.evaluate(() => window._game._resetGame());
await waitState('countdown', 60000);
const back = await pose();
const runsAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('tandemonium_slingshot')).runs);
check(Math.abs(back.d - 5.2) < 0.01 && Math.abs(back.lateral) < 0.05 && back.pull === 0 && runsAfter === runsBefore, `reset puts the bike back in the slingshot (at ${back.d.toFixed(2)} m, run not paid)`);

// 6. A flick is a cancel, not a shot
await page.mouse.move(640, 300); await page.mouse.down();
await page.mouse.move(640, 330, { steps: 3 }); await page.mouse.up();
await new Promise(r => setTimeout(r, 1500));
const flick = await pose();
check(flick.state === 'countdown' && flick.pull === 0 && Math.abs(flick.d - 5.2) < 0.01, 'a tiny drag cancels and the bands go slack');

// 7. Straight shot, then a stall → results with a payout
await drag(0, 300, true);
await waitState('playing', 60000);
await page.evaluate(() => { const g = window._game; g._slingRun.coins = 3; g.bike.speed = 0; g.bike.coast.decel = () => 50; });
await waitState('slingResults', 60000);
const r1 = await page.evaluate(() => ({ title: document.querySelector('#sling-results h2').textContent, save: JSON.parse(localStorage.getItem('tandemonium_slingshot')) }));
check(/stop/i.test(r1.title) && r1.save.runs === 1 && r1.save.coins > 60, `stalling ends the run and pays out ("${r1.title}", wallet ${r1.save.coins})`);
await shot('4-results');

// 8. Launch again → straight back into the slingshot → crash ends the run
await page.evaluate(() => Array.from(document.querySelectorAll('#sling-results button')).find(b => /again/i.test(b.textContent)).click());
await waitState('countdown', 60000);
check(Math.abs((await pose()).d - 5.2) < 0.01, 'launch again goes straight back to the slingshot');
await drag(0, 300, true);
await waitState('playing', 120000);
await page.evaluate(() => window._game.bike._fall());
await waitState('slingResults', 60000);
const r2 = await page.evaluate(() => ({ title: document.querySelector('#sling-results h2').textContent, runs: JSON.parse(localStorage.getItem('tandemonium_slingshot')).runs }));
check(/crash/i.test(r2.title) && r2.runs === 2, `a crash ends the run ("${r2.title}")`);

// 9. Reach the stage goal → stage cleared
await page.evaluate(() => Array.from(document.querySelectorAll('#sling-results button')).find(b => /again/i.test(b.textContent)).click());
await waitState('countdown', 60000);
await drag(0, 300, true);
await waitState('playing', 120000);
await page.evaluate(() => { const g = window._game; g.bike.distanceTraveled = g.lobby.selectedLevel.distance - 0.5; g.bike.speed = 15; });
await waitState('slingResults', 180000);
const r3 = await page.evaluate(() => ({ title: document.querySelector('#sling-results h2').textContent, stage: JSON.parse(localStorage.getItem('tandemonium_slingshot')).stage }));
check(/goal/i.test(r3.title) && r3.stage === 2, `reaching the goal clears the stage ("${r3.title}", now stage ${r3.stage})`);
await shot('5-goal');

// 10. Lobby cleans up
await page.evaluate(() => Array.from(document.querySelectorAll('#sling-results button')).find(b => /lobby/i.test(b.textContent)).click());
await new Promise(r => setTimeout(r, 1000));
const clean = await page.evaluate(() => ({
  sling: window._game.isSlingshot, coast: window._game.bike.coast, rig: window._game._slingRig,
  bodyClass: document.body.classList.contains('sling-mode'),
  overlays: ['sling-garage', 'sling-results', 'sling-hud', 'sling-pull'].some(id => document.getElementById(id).classList.contains('visible')),
}));
check(!clean.sling && !clean.coast && !clean.rig && !clean.bodyClass && !clean.overlays, 'returning to the lobby leaves slingshot mode, removes the slingshot, brings the pedals back');
check(errors.length === 0, `no page errors (${errors.length})`);

await browser.close(); server.close();
const ok = checks.every(Boolean);
console.log(ok ? '✔ slingshot mode smoke passed' : '✖ slingshot mode smoke FAILED');
process.exit(ok ? 0 : 1);
