#!/usr/bin/env node
// smoke-achievements.mjs — #401: the 100 achievements, wired end to end.
// A Grandma's ride earns Kick Off (a real pedal stroke through the game's tap
// path) and Made It (the finish); its payout earns Pocket Change through the
// economy event; a Slingshot launch earns Fire!; the lobby's badge screen
// shows sections, counter progress, and a hidden one as ???.
// Headless renders at ~1-2 fps, so distances are set directly.
//   node scripts/smoke-achievements.mjs [--shots <dir>]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT = process.cwd(); const PORT = 8941;
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
const earned = () => page.evaluate(() => JSON.parse(localStorage.getItem('tandemonium_achievements') || '[]').map(a => a.id));
const stats = () => page.evaluate(() => JSON.parse(localStorage.getItem('tandemonium_achievement_stats') || '{}'));
const clickText = (sel, re) => page.evaluate((sel, src) => {
  const b = Array.from(document.querySelectorAll(sel)).find(x => new RegExp(src, 'i').test(x.textContent));
  if (b) b.click();
  return !!b;
}, sel, re.source);

// A returning player (D6: first launch auto-enters the tutorial) with nothing
// earned yet. Once per session, so a reload keeps what was earned.
await page.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem('tandemonium_tutorial_done', 'smoke');
    if (!sessionStorage.getItem('__seeded')) {
      sessionStorage.setItem('__seeded', '1');
      for (const k of ['tandemonium_achievements', 'tandemonium_achievement_stats', 'tandemonium_wallet',
        'tandemonium_slingshot', 'tandemonium_records', 'tandemonium_daily']) localStorage.removeItem(k);
    }
  } catch (e) {}
});
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window._game, { timeout: 30000 });
await page.click('#tap-to-start').catch(() => {});
await new Promise(r => setTimeout(r, 500));

// 1. A Grandma's ride.
await page.evaluate(() => document.getElementById('btn-solo').click());
await page.waitForFunction(() => !!document.querySelector('#level-cards .level-card[data-level-id="grandma"]'), { timeout: 20000 });
await page.evaluate(() => {
  document.querySelector('#level-cards .level-card[data-level-id="grandma"]').click();
  const d = Array.from(document.querySelectorAll('.difficulty-btn')).find(x => x.dataset.difficulty === 'chill'); d && d.click();
});
await new Promise(r => setTimeout(r, 300));
await clickText('button', /start ride/);
await waitState('playing');
check((await earned()).length === 0, 'nothing is earned before the ride does anything');

// 2. A real pedal stroke, through the game's tap path → Kick Off.
await page.evaluate(() => window._game._playPedalTaps({ tapEvents: [{ kind: 'good', gap: 0.5 }] }));
await page.waitForFunction(() => !!document.querySelector('.achievement-toast'), { timeout: 10000 }).catch(() => {});
const afterPedal = await earned();
const toast = await page.evaluate(() => document.querySelector('.achievement-toast')?.textContent || '');
check(afterPedal.includes('first_pedal') && /Kick Off/.test(toast), `the first stroke earns Kick Off, with a toast ("${toast.trim()}")`);

// 3. Finish → Made It + Home Sweet Home; the victory payout → Pocket Change.
await page.evaluate(() => { const g = window._game; g.bike.distanceTraveled = g.lobby.selectedLevel.distance - 0.5; g.bike.speed = 10; });
await waitState('victory', 240000);
await new Promise(r => setTimeout(r, 1200));
const afterRide = await earned();
const st1 = await stats();
for (const id of ['first_finish', 'home_sweet', 'coin_first']) {
  check(afterRide.includes(id), `the ride earns ${id}`);
}
check(st1.v === 2 && st1.rides === 1 && st1.finishes === 1 && st1.coinsEarned > 0 && st1.cumulativeDistance >= 240,
  `the stats count it: v${st1.v}, ${st1.rides} ride, ${st1.finishes} finish, ${st1.coinsEarned} coins, ${Math.round(st1.cumulativeDistance)} m`);
await shot('1-victory');

// 4. Back to the lobby: the badge screen.
await page.evaluate(() => { const g = window._game; g._hideVictory(); g._returnToLobby(); });
await waitState('lobby', 20000);
await page.evaluate(() => { const l = window._game.lobby; l._achievements.reload(); l._renderAchievements(); });
const screen = await page.evaluate(() => {
  const root = document.getElementById('lb-achievements');
  const item = id => root.querySelector(`[data-ach="${id}"]`);
  return {
    sections: root.querySelectorAll('.lb-ach-section').length,
    rows: root.querySelectorAll('.lb-ach-item').length,
    count: root.querySelector('.lb-ach-count')?.textContent || '',
    hidden: item('false_start')?.querySelector('.lb-ach-name')?.textContent,
    hiddenIcon: item('false_start')?.querySelector('.lb-ach-icon')?.textContent,
    earned: item('first_finish')?.classList.contains('earned'),
    retired: !!item('grandma_default'),
    progress: item('rides_10')?.querySelector('.lb-ach-progress')?.textContent || '',
  };
});
check(screen.sections === 14 && screen.rows === 93, `the badge screen has 14 sections, 93 badges ("${screen.count}")`);
check(screen.hidden === '???' && screen.hiddenIcon === '❔', `a hidden achievement shows as ??? until earned (${screen.hidden})`);
check(screen.earned && !screen.retired, 'earned ones light up; retired colours never show');
check(screen.progress === '1/10', `counters show their progress (Regular Rider "${screen.progress}")`);
await shot('2-badges');

// 5. Slingshot: a launch → Fire!
await page.evaluate(() => document.getElementById('btn-solo').click());
await page.waitForFunction(() => !!document.querySelector('#level-cards .level-card-slingshot'), { timeout: 20000 });
await page.evaluate(() => document.querySelector('#level-cards .level-card-slingshot').click());
await waitState('slingGarage', 20000);
await page.evaluate(() => Array.from(document.querySelectorAll('#sling-garage button')).find(b => /launch/i.test(b.textContent)).click());
await waitState('slingAim', 60000);
check(!(await earned()).includes('sling_first'), 'Fire! is not earned by aiming');
await page.evaluate(() => { const g = window._game; g._slingRun.pull = 0.6; g._slingGo(); });
await waitState('playing', 60000);
await page.waitForFunction(() => JSON.parse(localStorage.getItem('tandemonium_achievements') || '[]').some(a => a.id === 'sling_first'), { timeout: 10000 }).catch(() => {});
check((await earned()).includes('sling_first'), 'the launch earns Fire!');
await page.evaluate(() => { const g = window._game; g.bike.distanceTraveled = 5.2 + 120; g.bike.speed = 0; g.bike.coast.decel = () => 50; });
await waitState('slingResults', 120000);
const st2 = await stats();
check(st2.slingLaunches === 1 && st2.slingBest >= 100 && st2.rides === 2,
  `the run is counted (${st2.slingLaunches} launch, best ${st2.slingBest} m, ${st2.rides} rides)`);
// m2: a Slingshot crash feeds no ride achievement (Goose Down, So Close, False Start).
const slingCrash = await page.evaluate(() => {
  const g = window._game; const was = g._lastCrashCause;
  g._recordCrash('tree'); g._lastCrashCause = was;
  return { sling: !!g.isSlingshot, crashes: JSON.parse(localStorage.getItem('tandemonium_achievement_stats') || '{}').crashes || 0 };
});
check(slingCrash.sling && slingCrash.crashes === (st2.crashes || 0) && !(await earned()).includes('first_crash'),
  `a Slingshot crash counts for no ride achievement (crashes ${slingCrash.crashes})`);
await shot('3-sling');

check(errors.length === 0, `no page errors (${errors.length})`);
await browser.close(); server.close();
const failed = checks.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) FAILED` : `\nALL ${checks.length} CHECKS PASSED`);
process.exit(failed ? 1 : 0);
