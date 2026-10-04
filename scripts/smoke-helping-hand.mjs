#!/usr/bin/env node
// smoke-helping-hand.mjs — #403: retries get easier, visibly.
//
// On a practice Today's Road, fail checkpoint 2 again and again:
//   attempts 1-3 ride as designed; attempt 4 gets 💨 Lady Victoria (half gusts,
//   1.25× time); attempt 5 gets 🎩 Sir Winston (no gusts, 1.5× time, safety on);
//   after the 5th failure the Royal Shortcut is offered — including when that
//   failure is a timeout. Passing the checkpoint resets it. An assisted finish
//   gets bronze at most, with 🛟, and does not overwrite an unassisted best.
//   A failed ranked run offers "Ride it as practice — with a helping hand".
//
// The ride is frozen in its countdown between steps (headless rendering runs at
// ~1.4 fps, and an unattended bike would fall over or time out on its own), so
// every failure here is one the script caused.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8931;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json'};
const server=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
 fs.stat(f,(e,st)=>{if(e||st.isDirectory())return r.writeHead(404).end();r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function open() {
  const page=await browser.newPage(); await page.setViewport({width:1280,height:800});
  await page.setRequestInterception(true);
  page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
   let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
   if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
   m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
   if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
   return req.abort();});
  page.on('pageerror', e => console.log('  PAGEERROR:', e.message));
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tandemonium_tutorial_done', 'smoke'); } catch {} });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window._game,{timeout:30000});
  return page;
}

/** Today's Road, solo, as `mode` ('practice' | 'ranked'); returns once riding, frozen. */
async function rideDaily(page, mode) {
  await page.evaluate(() => {
    document.getElementById('tap-to-start')?.click();
    (document.getElementById('btn-solo') || Array.from(document.querySelectorAll('button')).find(x=>/solo/i.test(x.textContent)))?.click();
  });
  await sleep(600);
  await page.evaluate(() => document.querySelector('.level-card[data-level-id="daily"]')?.click());
  await sleep(300);
  await page.evaluate((mode) => {
    document.getElementById('btn-start-ride').click();
    document.getElementById(mode === 'ranked' ? 'btn-daily-ranked' : 'btn-daily-practice').click();
  }, mode);
  await page.waitForFunction(() => window._game?.state === 'playing', { timeout: 180000, polling: 200 });
  await page.evaluate(() => {
    const g = window._game;
    // Freeze: every reset lands in a countdown that never ends.
    const orig = g._resetGame.bind(g);
    g._resetGame = (...a) => { const r = orig(...a); g.countdownTimer = 1e9; return r; };
    g.state = 'countdown'; g.countdownTimer = 1e9;
  });
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok });
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
}

// What the next attempt looks like right now: tier, badge, gust push, clock.
const probe = (page) => page.evaluate(async () => {
  const g = window._game;
  const { KIND, DURATION } = await import('./js/disruptions.js');
  // One synchronous gust frame at the bike's position, as the captain/solo
  // would apply it. Same position, speed and dt every time → comparable.
  const saved = { state: g.state, dis: g._disruptions, lv: g.bike.leanVelocity };
  const d = g.bike.distanceTraveled;
  g._disruptions = [{ kind: KIND.GUST, atM: Math.floor(d) - 1, telegraphM: Math.floor(d) - 30, duration: DURATION[KIND.GUST] }];
  g._activeDisruption = null; g._disruptionStartSpeed = 6;
  g.state = 'playing'; g.bike.leanVelocity = 0;
  g._updateDisruptions(0.1);
  const push = Math.abs(g.bike.leanVelocity);
  const banner = document.getElementById('disruption-banner')?.textContent || '';
  g._clearDisruptionEffects(); g._activeDisruption = null;
  g.state = saved.state; g._disruptions = saved.dis; g.bike.leanVelocity = saved.lv;
  const badge = document.getElementById('help-badge');
  const cp = g.raceManager.passedCheckpoints.size ? Math.max(...g.raceManager.passedCheckpoints) : 0;
  return {
    tier: g._help ? g._help.tier : 0,
    failures: g.ddaManager ? g.ddaManager.getFailureCount(cp) : null,
    badge: badge && badge.classList.contains('show') ? badge.textContent : '',
    push: +push.toFixed(5), banner,
    timeTotal: g.raceManager.segmentTimeTotal,
    timeScale: g.raceManager.helpTimeScale,
    safety: g.safetyMode,
    gameoverHelp: document.getElementById('gameover-help')?.textContent || '',
  };
});

async function failByCrash(page) {
  const seen = await page.evaluate(() => {
    const g = window._game;
    g._showGameOver();
    const skip = document.getElementById('btn-skip-checkpoint');
    const help = document.getElementById('gameover-help');
    return {
      overlay: document.getElementById('gameover-overlay').style.display,
      title: document.getElementById('gameover-title').textContent,
      announce: help.style.display === 'none' ? '' : help.textContent,
      skip: skip.style.display === 'none' ? '' : skip.textContent,
    };
  });
  return seen;
}
async function retryFromModal(page) {
  await page.evaluate(() => document.getElementById('btn-restart').click());
}
async function failByTimeout(page) {
  const seen = await page.evaluate(() => {
    const g = window._game;
    g._onTimerExpired();
    const help = document.getElementById('timeout-help');
    return {
      flash: document.getElementById('timeout-flash').classList.contains('visible'),
      announce: help.style.display === 'none' ? '' : help.textContent,
    };
  });
  await sleep(2600);   // the TOO SLOW beat, then the automatic retry (or the modal)
  return seen;
}

// ── 1. Practice: fail checkpoint 2 again and again ─────────────────────────
console.log("practice Today's Road:");
const page = await open();
await rideDaily(page, 'practice');
const start = await page.evaluate(() => {
  const g = window._game;
  // Ride past checkpoint 1: the stretch to checkpoint 2 is the one we fail.
  const cp1 = g.raceManager.checkpoints[0];
  g.bike.resetToDistance(cp1 + 5);
  const ev = g.raceManager.update(cp1 + 5, 0);
  if (ev) g._handleRaceEvent(ev);
  g.state = 'countdown'; g.countdownTimer = 1e9;
  g.raceManager.resetSegmentTimer(cp1 + 5);
  return { level: g.lobby.selectedLevel.id, ranked: g._rankedRunActive, dda: !!g.ddaManager,
           passed: g.raceManager.passedCheckpoints.size, cp1, safety: g.safetyMode };
});
console.log('  ride:', JSON.stringify(start));
check('a practice daily ride with the DDA on, past checkpoint 1', start.level === 'daily' && !start.ranked && start.dda && start.passed === 1);

const base = await probe(page);
console.log('  attempt 1:', JSON.stringify(base));
check('attempt 1 is the road as designed', base.tier === 0 && base.badge === '' && base.push > 0 && base.timeScale === 1);

// failure 1 (crash modal) → attempt 2
let seen = await failByCrash(page);
check('failure 1: no announcement, no shortcut', seen.announce === '' && seen.skip === '', seen);
await retryFromModal(page);
const a2 = await probe(page);
check('attempt 2 unchanged', a2.tier === 0 && a2.badge === '' && Math.abs(a2.push - base.push) < 1e-6 && Math.abs(a2.timeTotal - base.timeTotal) < 1e-6, a2);

// failure 2 (timeout) → attempt 3
seen = await failByTimeout(page);
check('failure 2 (timeout): no announcement', seen.flash && seen.announce === '', seen);
const a3 = await probe(page);
check('attempt 3 unchanged', a3.tier === 0 && a3.badge === '' && Math.abs(a3.push - base.push) < 1e-6 && Math.abs(a3.timeTotal - base.timeTotal) < 1e-6, a3);

// failure 3 (crash modal) → attempt 4: Lady Victoria
seen = await failByCrash(page);
check('failure 3: 💨 announced on the crash screen', /💨 Lady Victoria sends a tailwind/.test(seen.announce) && seen.skip === '', seen);
await retryFromModal(page);
const a4 = await probe(page);
console.log('  attempt 4:', JSON.stringify(a4));
check('attempt 4: 💨 badge, half gusts, 1.25× time, safety untouched',
  a4.tier === 1 && a4.badge === '💨' && Math.abs(a4.push - base.push * 0.5) < 1e-6
  && Math.abs(a4.timeTotal - base.timeTotal * 1.25) < 1e-6 && a4.safety === base.safety);

// failure 4 (timeout) → attempt 5: Sir Winston
seen = await failByTimeout(page);
check('failure 4 (timeout): 🎩 announced on the TOO SLOW screen', seen.flash && /🎩 Sir Winston clears the road/.test(seen.announce), seen);
const a5 = await probe(page);
console.log('  attempt 5:', JSON.stringify(a5));
check('attempt 5: 🎩 badge, no gusts (no banner), 1.5× time, safety on',
  a5.tier === 2 && a5.badge === '🎩' && a5.push === 0 && !/GUST/.test(a5.banner)
  && Math.abs(a5.timeTotal - base.timeTotal * 1.5) < 1e-6 && a5.safety === true);

// failure 5 (timeout) → the modal, with the Royal Shortcut
seen = await failByTimeout(page);
const modal = await page.evaluate(() => {
  const skip = document.getElementById('btn-skip-checkpoint');
  return {
    overlay: document.getElementById('gameover-overlay').style.display,
    title: document.getElementById('gameover-title').textContent,
    skip: skip.style.display === 'none' ? '' : skip.textContent,
    announce: document.getElementById('gameover-help').textContent,
    state: window._game.state,
  };
});
check('after the 5th failure (a timeout) the game stops and offers 👑 Take the Royal Shortcut',
  modal.overlay === 'flex' && modal.title === 'TOO SLOW!' && /👑 Take the Royal Shortcut/.test(modal.skip), modal);
await retryFromModal(page);

// failure 6 (crash): still offered
seen = await failByCrash(page);
check('failure 6: the shortcut is still offered', /Royal Shortcut/.test(seen.skip), seen);
await retryFromModal(page);

// pass checkpoint 2 → everything resets
const passed = await page.evaluate(() => {
  const g = window._game;
  const cp2 = g.raceManager.checkpoints[1];
  g.bike.resetToDistance(cp2 + 5);
  const ev = g.raceManager.update(cp2 + 5, 0);
  if (ev) g._handleRaceEvent(ev);
  g.state = 'countdown'; g.countdownTimer = 1e9;
  return { event: ev && ev.event, passed: g.raceManager.passedCheckpoints.size };
});
const after = await probe(page);
console.log('  past checkpoint 2:', JSON.stringify(after));
check('passing checkpoint 2 resets the count, the tier, the badge, gusts and safety',
  passed.event === 'checkpoint' && after.tier === 0 && after.failures === 0 && after.badge === ''
  && after.push > 0 && after.timeScale === 1 && after.safety === base.safety);

// ── 2. The assisted finish: bronze at most, 🛟, never over a real best ─────
const fin = await page.evaluate(async () => {
  const g = window._game;
  const records = await import('./js/records.js');
  const { getMedals } = await import('./js/race-config.js');
  const k = g._recordKey();
  const store = records.load();
  const realBest = 999000;   // an unassisted best, slower than this run
  store[k] = { timeMs: realBest, splits: [], collectibles: 0, crashes: 0, date: '2026-10-01T00:00:00Z' };
  records.save(store);
  g._recordStore = store;
  const th = getMedals(g.lobby.selectedLevel.id, g.lobby.selectedDifficulty);
  const summary = { timeMs: th.gold - 1000, distance: 500, raceDistance: 500, collectibles: 0, collectiblesTotal: 0, crashes: 0 };
  const helped = g._helpFlags().helped;
  const html = g._buildRecordHtml(summary, false);
  const after = records.getBest(records.load(), k);
  return { helped, html, outcome: g._lastRecordOutcome, best: after, realBest };
});
console.log('  assisted finish outcome:', JSON.stringify(fin.outcome), 'best:', JSON.stringify(fin.best));
check('the ride is flagged helped after a tier was on', fin.helped === true);
check('a gold-pace assisted finish shows 🛟 BRONZE, not gold',
  /🛟/.test(fin.html) && /BRONZE/.test(fin.html) && !/GOLD/.test(fin.html) && fin.outcome.medal === 'bronze');
check("it does not overwrite the unassisted best", fin.best.timeMs === fin.realBest && !fin.best.helped && fin.outcome.isNewBest === false);
await page.close();

// ── 3. A failed ranked run offers practice with a helping hand ──────────────
console.log('ranked Today\'s Road:');
const rp = await open();
await rideDaily(rp, 'ranked');
const ranked = await rp.evaluate(() => {
  const g = window._game;
  const before = { ranked: g._rankedRunActive, dda: !!g.ddaManager };
  g._showGameOver();
  const btn = document.getElementById('btn-practice-help');
  return { before, shown: btn.style.display !== 'none', text: btn.textContent,
           help: document.getElementById('gameover-help').style.display };
});
console.log('  ranked game over:', JSON.stringify(ranked));
check('ranked: no helping hand on the run itself', ranked.before.ranked === true && ranked.before.dda === false && ranked.help === 'none');
check('ranked failure offers "Ride it as practice — with a helping hand"', ranked.shown && /Ride it as practice — with a helping hand/.test(ranked.text));
const practice = await rp.evaluate(async () => {
  const g = window._game;
  document.getElementById('btn-practice-help').click();
  const d = await import('./js/daily-ride.js');
  const key = g.lobby.selectedLevel.key;
  const entry = d.readAll ? d.readAll(d.browserStore())[key] : null;
  return { ranked: g._rankedRunActive, dda: !!g.ddaManager, level: g.lobby.selectedLevel.id,
           spent: d.rankedDone(d.browserStore(), key, 'solo'), entry,
           overlay: document.getElementById('gameover-overlay').style.display };
});
console.log('  after the button:', JSON.stringify(practice));
check('it spends the ranked run and starts practice on the same road, with the DDA on',
  practice.ranked === false && practice.dda === true && practice.level === 'daily' && practice.spent && practice.overlay === 'none');

// ── 4. Segment 1: a retry goes back to the start line through a fresh
// countdown, and the count must survive it ─────────────────────────────────
for (let i = 0; i < 3; i++) {
  await failByCrash(rp);
  await retryFromModal(rp);
}
const seg1 = await rp.evaluate(() => {
  const g = window._game;
  return { passed: g.raceManager.passedCheckpoints.size, failures: g.ddaManager.getFailureCount(0),
           tier: g._help.tier, scale: g.raceManager.helpTimeScale,
           badge: document.getElementById('help-badge').textContent };
});
console.log('  segment 1 after 3 failures:', JSON.stringify(seg1));
check('segment 1: the count survives the restart from the start line, attempt 4 is 💨',
  seg1.passed === 0 && seg1.failures === 3 && seg1.tier === 1 && seg1.scale === 1.25 && seg1.badge === '💨');

const ok = checks.every(c => c.ok);
console.log(ok ? `✔ helping hand: ${checks.length} checks passed` : `✖ helping hand: ${checks.filter(c => !c.ok).length} of ${checks.length} checks failed`);
await browser.close(); server.close();
process.exit(ok ? 0 : 1);
