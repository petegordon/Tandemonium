#!/usr/bin/env node
// smoke-daily-best.mjs — #641: the Daily Ride has no practice/ranked split.
//   START RIDE starts a ride that counts (a checkpoint retry is the same ride);
//   every finish is recorded, the best stays; any help (SAFETY here) keeps a
//   ride off the board; the share strip shows the best and the first try;
//   the demo opens the road after the Tutorial and Grandma's, then stops at 3.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8923;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json'};
const server=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
 fs.stat(f,(e,st)=>{if(e||st.isDirectory())return r.writeHead(404).end();r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const errors=[];
const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});

async function open(query='') {
  const page=await browser.newPage(); await page.setViewport({width:1280,height:800});
  await page.setRequestInterception(true);
  page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
   let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
   if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
   m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
   if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
   return req.abort();});
  page.on('pageerror', e => { errors.push(e.message); console.log('  PAGEERROR:', e.message); });
  // D6 (#400): a returning player; the first-launch tutorial has its own smoke (smoke:tutorial).
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tandemonium_tutorial_done', 'smoke'); } catch {} });
  await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window._game,{timeout:30000});
  return page;
}


const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(page, fn, arg, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await page.evaluate(fn, arg); if (v) return v; await sleep(100); }
  return page.evaluate(fn, arg);
}
async function pickDaily(page) {
  await page.evaluate(() => {
    document.getElementById('tap-to-start')?.click();
    (document.getElementById('btn-solo') || Array.from(document.querySelectorAll('button, uf-button')).find(x=>/solo/i.test(x.textContent)))?.click();
  });
  await until(page, () => !!document.querySelector('#level-cards .level-card[data-level-id="daily"]'));
  await page.evaluate(() => document.querySelector('#level-cards .level-card[data-level-id="daily"]')?.click());
}
const SUMMARY = (timeMs) => ({ timeMs, distance: 500, raceDistance: 500, collectibles: 9, collectiblesTotal: 12, crashes: 1 });

// ── 1. Full game: no chooser; START RIDE starts a counted ride ──────────────
const web = await open();
await pickDaily(web);
const gone = await web.evaluate(() => ({
  overlay: !!document.getElementById('daily-mode-overlay'),
  badge: !!document.getElementById('ranked-badge'),
  practiceHelp: !!document.getElementById('btn-practice-help'),
}));
await web.evaluate(() => document.getElementById('btn-start-ride').click());
await until(web, () => window._game.state === 'countdown' || window._game.state === 'playing', null, 8000);
const start = await web.evaluate(async () => {
  const g = window._game;
  const d = await import('./js/daily-ride.js');
  return { state: g.state, level: g.lobby.selectedLevel.id, rideNo: g._dailyRideNo,
           started: d.ridesStarted(d.browserStore(), g.lobby.selectedLevel.key),
           safetyLocked: !!g.safetyBtn.disabled, speedLocked: !!g.speedBtn.disabled };
});
console.log('start:', JSON.stringify(start), 'removed:', JSON.stringify(gone));

// ── 2. A finish counts; help keeps it off the board; the strip has the first try ──
const rides = await web.evaluate(async (S) => {
  const g = window._game, l = g.lobby;
  const d = await import('./js/daily-ride.js');
  const key = l.selectedLevel.key;
  const S1 = JSON.parse(S.replace('T', '120000'));
  g.safetyMode = false; g.autoSpeed = false; g._noteRideAided();
  const clean1 = g._dailyRideClean();
  g._buildRecordHtml(S1, false);
  const after1 = d.dailyStatus(d.browserStore(), key);
  g._buildDailyStripHtml(S1, l.selectedLevel);
  const strip1 = g._dailyStripText;
  // A checkpoint-1 retry is the same ride.
  g._resetGame(false, false);
  const afterRetry = d.ridesStarted(d.browserStore(), key);
  // Back to the lobby and ride again: a new ride. SAFETY on → not clean.
  g._returnToLobby();
  document.getElementById('tap-to-start')?.click();
  document.getElementById('btn-solo')?.click();
  document.querySelector('#level-cards .level-card[data-level-id="daily"]').click();
  document.getElementById('btn-start-ride').click();
  const ride2No = g._dailyRideNo;
  g.safetyMode = true; g._noteRideAided();
  const clean2 = g._dailyRideClean();
  const line2 = g._dailyVictoryLine();
  g.safetyMode = false;
  const S2 = JSON.parse(S.replace('T', '110000'));
  g._buildRecordHtml(S2, false);
  const after2 = d.dailyStatus(d.browserStore(), key);
  g._buildDailyStripHtml(S2, l.selectedLevel);
  const strip2 = g._dailyStripText;
  const card = (l._refreshRecordLines(), document.querySelector('#level-cards .level-card[data-level-id="daily"] .level-card-desc').textContent);
  g._returnToLobby();
  return { clean1, after1, strip1, afterRetry, ride2No, clean2, line2, after2, strip2, card };
}, JSON.stringify(SUMMARY('T')).replace('"T"', 'T'));
console.log('rides:', JSON.stringify(rides, null, 1));

// ── 3. Demo: shut, then open, then three rides and no fourth ────────────────
// Same origin, same storage: start the demo with today's rides and badges cleared.
await web.evaluate(() => { localStorage.removeItem('tandemonium_daily'); localStorage.removeItem('tandemonium_achievements'); });
const demo = await open('?demo=1');
await pickDaily(demo);
const demoRun = await demo.evaluate(async () => {
  const g = window._game, l = g.lobby;
  const d = await import('./js/daily-ride.js');
  const { dailyKey } = await import('./js/daily-seed.js');
  const { LEVELS } = await import('./js/race-config.js');
  const card = () => document.querySelector('#level-cards .level-card[data-level-id="daily"]');
  const out = { shutAtFirst: card().classList.contains('level-locked'), pickedWhenShut: l.selectedLevel && l.selectedLevel.id };
  localStorage.setItem('tandemonium_achievements', JSON.stringify([{ id: 'tutorial_done', earnedAt: 1 }, { id: 'home_sweet', earnedAt: 1 }]));
  l._refreshRecordLines();
  out.openAfter = !card().classList.contains('level-locked');
  card().click();
  document.getElementById('btn-start-ride').click();
  out.ride1 = { state: g.state, rideNo: g._dailyRideNo, line: g._dailyVictoryLine() };
  g._returnToLobby();
  while (d.ridesStarted(d.browserStore(), dailyKey()) < 3) d.recordRideStart(d.browserStore(), dailyKey());
  g._dailyRideNo = 3;
  out.line3 = g._dailyVictoryLine();
  // A 4th: START RIDE refuses in the lobby…
  document.getElementById('tap-to-start')?.click();
  document.getElementById('btn-solo')?.click();
  l._refreshRecordLines();
  out.shutAfter3 = card().classList.contains('level-locked');
  out.cardText = card().querySelector('.level-card-desc').textContent;
  l.selectedLevel = l.resolveRoadLevel(LEVELS.find(x => x.isDaily));
  document.getElementById('btn-start-ride').click();
  out.afterStart = { state: g.state, started: d.ridesStarted(d.browserStore(), dailyKey()) };
  // …and PLAY AGAIN (a reset from the beginning) goes back instead of riding.
  g.mode = 'solo';
  g._resetGame(false, true);
  out.afterPlayAgain = { state: g.state, started: d.ridesStarted(d.browserStore(), dailyKey()) };
  return out;
});
console.log('demo:', JSON.stringify(demoRun, null, 1));

const checks = {
  chooserGone: !gone.overlay && !gone.badge && !gone.practiceHelp,
  startRideStartsRide: (start.state === 'countdown' || start.state === 'playing') && start.level === 'daily' &&
    start.rideNo === 1 && start.started === 1,
  safetySpeedNeverLocked: !start.safetyLocked && !start.speedLocked,
  cleanRideIsClean: rides.clean1 === true,
  finishCounts: rides.after1.finished === 1 && rides.after1.best === 120000,
  oneRideNoFirstTry: /2:00/.test(rides.strip1) && !/1st try/.test(rides.strip1) && rides.strip1.split('\n').length === 4,
  retryIsSameRide: rides.afterRetry === 1,
  secondRideCounts: rides.ride2No === 2 && rides.after2.started === 2 && rides.after2.finished === 2,
  safetyKeepsOffBoard: rides.clean2 === false && /stays off the board/.test(rides.line2),
  bestAndFirstTry: rides.after2.best === 110000 && /1:50/.test(rides.strip2) && /1st try 2:00/.test(rides.strip2),
  cardSaysBest: /finished ×2 · best 1:50/.test(rides.card),
  demoShutThenOpen: demoRun.shutAtFirst && demoRun.pickedWhenShut !== 'daily' && demoRun.openAfter,
  demoRideCounts: demoRun.ride1.rideNo === 1 && /Daily Ride 1 of 3 today/.test(demoRun.ride1.line),
  demoThirdLine: /Daily Ride 3 of 3 today/.test(demoRun.line3),
  demoNoFourth: demoRun.shutAfter3 && /today’s 3 rides/.test(demoRun.cardText) &&
    demoRun.afterStart.state === 'lobby' && demoRun.afterStart.started === 3 &&
    demoRun.afterPlayAgain.state === 'lobby' && demoRun.afterPlayAgain.started === 3,
  noPageErrors: errors.length === 0,
};
console.log(checks);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? '✔ every Daily ride counts, help stays off the board, the strip has the first try, the demo stops at 3'
               : '✖ the Daily Ride is wrong');
await browser.close(); server.close(); process.exit(ok ? 0 : 1);
