#!/usr/bin/env node
// smoke-economy.mjs — #400 D4/D5/D11: one Chaos Coin wallet across every mode.
// A regular Grandma's ride pays on the game-over screen (distance only), then
// RESTART → finish pays the rest + the finish bonuses on the victory screen;
// GARAGE → opens the one garage, a purchase debits the shared wallet; the
// lobby's GARAGE button and wallet balance; a stage gate sends you to the
// level it needs; Today's Launch runs and pays; prestige; the demo's stage cap.
// Headless renders at ~1-2 fps, so distances are set directly.
//   node scripts/smoke-economy.mjs [--shots <dir>]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT = process.cwd(); const PORT = 8931;
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
const wallet = () => page.evaluate(() => JSON.parse(localStorage.getItem('tandemonium_wallet') || '{"coins":0}'));
const slingSave = () => page.evaluate(() => JSON.parse(localStorage.getItem('tandemonium_slingshot') || '{}'));
const setLS = (k, v) => page.evaluate((k, v) => localStorage.setItem(k, JSON.stringify(v)), k, v);
const clickText = (sel, re) => page.evaluate((sel, src) => {
  const b = Array.from(document.querySelectorAll(sel)).find(x => new RegExp(src, 'i').test(x.textContent));
  if (b) b.click();
  return !!b;
}, sel, re.source);
const boot = async (query = '') => {
  await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window._game, { timeout: 30000 });
  await page.click('#tap-to-start').catch(() => {});
  await new Promise(r => setTimeout(r, 500));
};

// D6 (#400): a returning player; the first-launch tutorial has its own smoke (smoke:tutorial).
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tandemonium_tutorial_done', 'smoke'); } catch {} });
// A fresh player: no wallet, no records, no Slingshot save. (Once per session.)
await page.evaluateOnNewDocument(() => {
  try {
    if (!sessionStorage.getItem('__seeded')) {
      sessionStorage.setItem('__seeded', '1');
      for (const k of ['tandemonium_wallet', 'tandemonium_slingshot', 'tandemonium_records', 'tandemonium_daily']) localStorage.removeItem(k);
    }
  } catch (e) {}
});
await boot();

// 1. The lobby shows the wallet on a GARAGE button.
const lobby0 = await page.evaluate(() => ({ btn: !!document.getElementById('btn-garage'), chip: document.getElementById('lobby-wallet')?.textContent }));
check(lobby0.btn && /🪙 0/.test(lobby0.chip || ''), `the lobby has GARAGE with the wallet ("${lobby0.chip}")`);

// 2. A regular solo ride on Grandma's.
await page.evaluate(() => document.getElementById('btn-solo').click());
await page.waitForFunction(() => !!document.querySelector('#level-cards .level-card[data-level-id="grandma"]'), { timeout: 20000 });
await page.evaluate(() => {
  document.querySelector('#level-cards .level-card[data-level-id="grandma"]').click();
  const d = Array.from(document.querySelectorAll('.difficulty-btn')).find(x => x.dataset.difficulty === 'chill'); d && d.click();
});
await new Promise(r => setTimeout(r, 300));
await clickText('button', /start ride/);
await page.waitForFunction(() => window._game?.state === 'playing', { timeout: 120000 });

// 3. Crash out at 140 m: the game-over screen pays the distance.
// Past the second checkpoint, so RESTART resumes this same ride from it.
await page.evaluate(() => { const g = window._game, rm = g.raceManager; rm.passedCheckpoints.add(rm.checkpoints[1]); g.bike.distanceTraveled = 140; g._showGameOver(); });
await new Promise(r => setTimeout(r, 1500));
const go = await page.evaluate(() => ({
  shown: document.getElementById('gameover-coins').style.display !== 'none',
  text: document.getElementById('gameover-coins').textContent,
  garage: document.getElementById('btn-gameover-garage').style.display !== 'none',
  pickups: window._game.collectibleManager ? window._game.collectibleManager.collected : 0,
}));
const w1 = await wallet();
check(go.shown && /Distance \(140 m\)/.test(go.text) && w1.coins === 28 + 5 * go.pickups && go.garage,
  `game over pays the distance: ${w1.coins} coins ("${go.text.replace(/\s+/g, ' ').slice(0, 70)}…"), GARAGE → shown`);
await shot('1-gameover-coins');

// 4. RESTART (from the checkpoint) and finish: only the new metres pay, plus the finish bonuses.
await page.evaluate(() => document.getElementById('btn-restart').click());
await page.waitForFunction(() => window._game?.state === 'playing', { timeout: 120000 });
await page.evaluate(() => { const g = window._game; g.bike.distanceTraveled = g.lobby.selectedLevel.distance - 0.5; g.bike.speed = 10; });
await waitState('victory', 240000);
await new Promise(r => setTimeout(r, 1500));
const vic = await page.evaluate(() => ({
  text: document.getElementById('victory-coins').textContent,
  garage: document.getElementById('btn-victory-garage').style.display !== 'none',
}));
const w2 = await wallet();
const gained = w2.coins - w1.coins;
check(/Finished/.test(vic.text) && /Distance \(110 m\)/.test(vic.text) && gained >= 22 + 25 && vic.garage,
  `the finish pays the rest of the road once + finishing (+${gained}: "${vic.text.replace(/\s+/g, ' ').slice(0, 90)}…")`);
await shot('2-victory-coins');

// 5. GARAGE → : the one garage, standalone; a purchase debits the shared wallet.
await page.evaluate(() => document.getElementById('btn-victory-garage').click());
await waitState('slingGarage', 20000);
const g1 = await page.evaluate(() => ({
  launch: Array.from(document.querySelectorAll('#sling-garage button')).some(b => /^LAUNCH!$/.test(b.textContent.trim())),
  back: Array.from(document.querySelectorAll('#sling-garage button')).some(b => /BACK/.test(b.textContent)),
  gain: document.querySelector('#sling-garage .sling-up[data-up="sling"] .gain')?.textContent,
  ups: Array.from(document.querySelectorAll('#sling-garage .sling-up')).map(b => b.dataset.up).join(','),
}));
check(!g1.launch && g1.back && /^\+\d+ m$/.test(g1.gain || '') && g1.ups === 'sling,wheels,magnet',
  `GARAGE → opens the garage without a launch; Aero folded in (${g1.ups}); buy buttons say "${g1.gain}"`);
const before = (await wallet()).coins;
check(before >= 40, `one Grandma's ride affords the first Slingshot level (${before} coins)`);
await page.evaluate(() => document.querySelector('#sling-garage .sling-up[data-up="sling"]').click());
const w3 = await wallet();
check(w3.coins === before - 40 && w3.lv.sling === 1, `buying debits the shared wallet (${before} → ${w3.coins}, sling L${w3.lv.sling})`);
await shot('3-garage');

// 6. BACK → the lobby shows the new balance; the lobby's GARAGE opens the same garage.
await clickText('#sling-garage button', /BACK/);
await waitState('lobby', 20000);
const chip = await page.evaluate(() => document.getElementById('lobby-wallet').textContent);
check(chip.includes(String(w3.coins)), `the lobby shows the wallet after spending ("${chip}")`);
await page.evaluate(() => document.getElementById('btn-garage').click());
await waitState('slingGarage', 20000);
check(await page.evaluate(() => document.getElementById('sling-garage').classList.contains('visible')), 'the lobby GARAGE button opens the garage');
await clickText('#sling-garage button', /BACK/);
await waitState('lobby', 20000);

// 7. A stage gate (D11a): stage 6 needs a finished Today's Road; its button goes there.
await setLS('tandemonium_slingshot', { v: 3, best: 800, runs: 20, stage: 6, daily: null });
await page.evaluate(() => window._game._openSlingGarage());
await waitState('slingGarage', 20000);
const lock = await page.evaluate(() => ({
  text: document.querySelector('#sling-garage .sling-lock')?.textContent || '',
  launch: Array.from(document.querySelectorAll('#sling-garage button')).some(b => /^LAUNCH!$/.test(b.textContent.trim())),
}));
check(/Today's Road/.test(lock.text) && !lock.launch, `a locked stage says why and offers no launch ("${lock.text}")`);
await clickText('#sling-garage button', /RIDE TODAY'S ROAD/);
await new Promise(r => setTimeout(r, 800));
const went = await page.evaluate(() => ({ state: window._game.state, level: window._game.lobby.selectedLevel?.id,
  step: document.getElementById('lobby-level').style.display }));
check(went.state === 'lobby' && went.level === 'daily' && went.step !== 'none', `the lock's button picks Today's Road in the lobby (${went.level})`);

// 8. Today's Launch (D11b): the day's course, no goal; it pays the wallet and keeps the day's best.
await setLS('tandemonium_slingshot', { v: 3, best: 300, runs: 2, stage: 2, daily: null });
await page.evaluate(() => window._game._openSlingGarage());
await waitState('slingGarage', 20000);
await clickText('#sling-garage button', /TODAY'S LAUNCH/);
await waitState('slingAim', 60000);
const tl = await page.evaluate(() => ({ name: window._game.lobby.selectedLevel.name, daily: !!window._game._slingDaily,
  hud: document.querySelector('#sling-hud .sling-togo')?.textContent || '' }));
check(/Today's Launch/.test(tl.name) && tl.daily && /📅/.test(tl.hud), `Today's Launch arms the day's course ("${tl.hud}")`);
const tlBefore = (await wallet()).coins;
await page.evaluate(() => { const g = window._game; g._slingRun.pull = 0.6; g._slingGo(); });
await waitState('playing', 60000);
await page.evaluate(() => { const g = window._game; g.bike.distanceTraveled = 5.2 + 222; g.bike.speed = 0; g.bike.coast.decel = () => 50; });
await waitState('slingResults', 120000);
const tlSave = await slingSave();
const tlW = await wallet();
check(tlSave.daily && tlSave.daily.runs === 1 && tlSave.daily.best >= 200 && tlSave.stage === 2 && tlW.coins > tlBefore,
  `Today's Launch pays (+${tlW.coins - tlBefore}) and keeps the day's best (${tlSave.daily && tlSave.daily.best} m), stage untouched`);
await clickText('#sling-results button', /LOBBY/);
await waitState('lobby', 20000);

// 9. Prestige (D11c): everything maxed → REBUILD (two presses) → levels 0, +10% for good.
await setLS('tandemonium_wallet', { v: 1, coins: 5000, earned: 30000, lv: { sling: 10, wheels: 10, magnet: 8 }, rebuilds: 0 });
await page.evaluate(() => window._game._openSlingGarage(0, { standalone: true }));
await waitState('slingGarage', 20000);
await clickText('#sling-garage button', /REBUILD/);
await clickText('#sling-garage button', /PRESS AGAIN/);
const pw = await wallet();
const badge = await page.evaluate(() => document.querySelector('#sling-garage .sling-rebuilds')?.textContent || '');
check(pw.rebuilds === 1 && Object.keys(pw.lv).length === 0 && pw.coins === 5000 && /×1/.test(badge),
  `rebuilding the bike resets upgrades, keeps coins, shows the badge ("${badge}")`);
await clickText('#sling-garage button', /BACK/);
await waitState('lobby', 20000);

// 10. The demo: the stage after the edition's cap is the demo's end, with WISHLIST; no Today's Launch.
await setLS('tandemonium_slingshot', { v: 3, best: 600, runs: 9, stage: 4, daily: null });
await setLS('tandemonium_records', { 'grandma|chill|solo': { timeMs: 1000, splits: [], date: '2026-10-04' } });
await boot('?demo=1');
await page.evaluate(() => window._game._openSlingGarage());
await waitState('slingGarage', 20000);
const demo = await page.evaluate(() => ({
  lock: document.querySelector('#sling-garage .sling-lock')?.textContent || '',
  wish: Array.from(document.querySelectorAll('#sling-garage button')).some(b => /WISHLIST/.test(b.textContent)),
  today: Array.from(document.querySelectorAll('#sling-garage button')).some(b => /TODAY'S LAUNCH/.test(b.textContent)),
}));
check(/demo/i.test(demo.lock) && demo.wish && !demo.today, `the demo stops at its cap with WISHLIST, no Today's Launch ("${demo.lock}")`);
await shot('4-demo-end');

// 11. m9: the demo's end is not a dead end — LAUNCH replays the last stage
// (normal pay, the stage never moves) and the garage offers no Rebuild.
await setLS('tandemonium_wallet', { v: 1, coins: 50, earned: 900, lv: { sling: 10, wheels: 10, magnet: 8 }, rebuilds: 0 });
await page.evaluate(() => window._game._openSlingGarage());
await waitState('slingGarage', 20000);
const demoGarage = await page.evaluate(() => ({
  replay: Array.from(document.querySelectorAll('#sling-garage button')).some(b => /REPLAY STAGE 3/.test(b.textContent)),
  rebuild: !!document.querySelector('#sling-garage .sling-rebuild'),
}));
check(demoGarage.replay && !demoGarage.rebuild, `the demo's end offers REPLAY STAGE 3 and no Rebuild (${JSON.stringify(demoGarage)})`);
await clickText('#sling-garage button', /REPLAY STAGE 3/);
await waitState('slingAim', 20000);
const replayRun = await page.evaluate(() => ({ name: window._game.lobby.selectedLevel.name, stage: window._game._slingSave.stage }));
check(/Stage 3/.test(replayRun.name) && replayRun.stage === 4, `the replay launches stage 3 and the save stays on 4 (${JSON.stringify(replayRun)})`);
await page.evaluate(() => { const g = window._game; g._slingRun.pull = 1; g._slingGo(); g.bike.distanceTraveled = 5.2 + 200; g._endSlingRun('stall'); });
await waitState('slingResults', 20000);
const replayEnd = await slingSave();
check(replayEnd.stage === 4, `a demo replay never moves the stage (${replayEnd.stage})`);
await page.evaluate(() => window._game._leaveSlingMode());

check(errors.length === 0, `no page errors (${errors.length})`);
await browser.close(); server.close();
const ok = checks.every(Boolean);
console.log(ok ? '✔ economy smoke passed' : '✖ economy smoke FAILED');
process.exit(ok ? 0 : 1);
