#!/usr/bin/env node
// smoke-tutorial-first.mjs — D6 (#400) / #399: a first-time player who picks
// SOLO lands in the tutorial with SKIP on screen; SKIP marks it done and goes to
// the level list; a returning player (saved motion tuning) is not forced in;
// and tutorial-complete's NEXT: GRANDMA'S starts Grandma's in one tap; and a
// phone player passes the tilt calibration by actually tilting (B1).
// The tutorial ride itself is not ridden here — headless renders at ~1.4 fps —
// so completion is triggered through the game's own _tutorialComplete().
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8931;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json'};
const server=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
 fs.stat(f,(e,st)=>{if(e||st.isDirectory())return r.writeHead(404).end();r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

// Each scenario gets its own incognito context, so localStorage starts empty.
// `beforeSolo` (optional) runs in the page after boot, before SOLO is clicked.
async function open(seed = {}, beforeSolo = null) {
  const ctx = await browser.createBrowserContext();
  const page=await ctx.newPage(); await page.setViewport({width:1280,height:800});
  await page.setRequestInterception(true);
  page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
   let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
   if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
   m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
   if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
   return req.abort();});
  page.on('pageerror', e => console.log('  PAGEERROR:', e.message));
  await page.evaluateOnNewDocument((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, seed);
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>!!window._game,{timeout:90000});
  if (beforeSolo) await page.evaluate(beforeSolo);
  await page.evaluate(() => {
    document.getElementById('tap-to-start')?.click();
    document.getElementById('btn-solo').click();
  });
  await sleep(1200);
  return page;
}

const where = (page) => page.evaluate(() => {
  const g = window._game, skip = document.getElementById('btn-tutorial-skip');
  const intro = document.getElementById('tutorial-intro');
  return {
    state: g.state,
    tutorial: !!g._tutorialActive,
    level: g.lobby.selectedLevel && g.lobby.selectedLevel.id,
    // #459 item 6: the intro sheet before the first countdown, START / SKIP TUTORIAL.
    intro: !!(intro && intro.open && g._intro),
    skipVisible: !!(skip && getComputedStyle(skip).display !== 'none'),  // position:fixed → no offsetParent
    onLevelList: g.lobby._currentStep === g.lobby.levelStep && g.lobby.lobbyEl.style.display !== 'none',
    done: localStorage.getItem('tandemonium_tutorial_done')
  };
});
/** Wait for the intro, then START; resolves once the ride is being set up (countdown / calibration). */
async function startFromIntro(page) {
  await page.waitForFunction(() => document.getElementById('tutorial-intro')?.open, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => document.getElementById('btn-tutorial-intro-start').click());
  await page.waitForFunction(() => window._game.state !== 'lobby' && !window._game._intro, { timeout: 20000 }).catch(() => {});
  await sleep(600);
}

// 1. Fresh profile: SOLO → the tutorial intro (no countdown yet), nothing on record.
const fresh = await open();
const first = await where(fresh);
console.log('fresh SOLO:', JSON.stringify(first));

// 2. SKIP TUTORIAL on the intro → marked done, back on the level list with Grandma's selected.
await fresh.evaluate(() => document.getElementById('btn-tutorial-intro-skip').click());
await fresh.waitForFunction(() => !window._game._intro, { timeout: 10000 }).catch(() => {});
await sleep(600);
const skipped = await where(fresh);
skipped.selectedCard = await fresh.evaluate(() => document.querySelector('#level-cards .level-card.selected')?.dataset.levelId);
console.log('after SKIP:', JSON.stringify(skipped));
await fresh.browserContext().close();

// 2b. Esc on the intro is SKIP too (B on a pad).
const escaper = await open();
await escaper.keyboard.press('Escape');
await escaper.waitForFunction(() => !window._game._intro, { timeout: 10000 }).catch(() => {});
await sleep(600);
const escSkipped = await where(escaper);
console.log('after Esc on the intro:', JSON.stringify(escSkipped));
await escaper.browserContext().close();

// 3. Returning player with saved motion tuning from an older build: not forced.
const returning = await open({ tandemonium_motion_tuning: JSON.stringify({ version: 1, inputType: 'phone' }) });
const ret = await where(returning);
console.log('returning player SOLO:', JSON.stringify(ret));
await returning.browserContext().close();

// 4. START on the intro → the tutorial ride with SKIP on screen; tutorial
//    complete → NEXT: GRANDMA'S starts Grandma's in one tap.
const finisher = await open();
await startFromIntro(finisher);
const started = await where(finisher);
console.log('after START:', JSON.stringify(started));
const screen = await finisher.evaluate(() => {
  window._game._tutorialComplete();
  const next = document.getElementById('btn-tutorial-next');
  const cont = document.getElementById('btn-tutorial-continue');
  const sheet = document.getElementById('tutorial-complete-sheet');
  const row = sheet && sheet.querySelector('[slot="actions"]');
  return {
    overlay: document.getElementById('tutorial-complete').classList.contains('visible'),
    // #459 item 15: the result-screen shell, NEXT first in its action row and focused.
    shell: !!sheet && sheet.hasAttribute('headline') && !!row && row.querySelector('uf-button') === next,
    nextVisible: !!(next && next.getBoundingClientRect().width > 0), nextText: next && next.textContent.trim(),
    continueText: cont.textContent.trim(),
    done: localStorage.getItem('tandemonium_tutorial_done'),
    skipVisible: getComputedStyle(document.getElementById('btn-tutorial-skip')).display !== 'none',
    natural: window._game.achievements.getEarnedIds().includes('tutorial_clean')
  };
});
console.log('tutorial complete:', JSON.stringify(screen));
await finisher.evaluate(() => document.getElementById('btn-tutorial-next').click());
await sleep(800);
const next = await where(finisher);
next.instructionsHidden = await finisher.evaluate(() => document.getElementById('instructions')?.classList.contains('hidden') ?? true);
console.log('after NEXT:', JSON.stringify(next));

await finisher.browserContext().close();

// 5. B1 (PR #397 review): a PHONE player passes the tilt calibration by tilting.
// Phone tilt steers at TUNE.mobileTiltGain (0.25), so the gained lean can never
// pass the ±0.25 targets; the calibration reads the ungained lean instead. A
// stand-in player feeds real deviceorientation events into the same
// InputManager path a phone uses, tilting whichever way the card asks, and
// every step must clear well before its 8 s safety timeout (tilt steps were
// all hitting it). Headless renders at ~1.4 fps, so the bounds are loose.
const TILT_LIMIT_MS = 5000, CENTER_LIMIT_MS = 7000;
const tilter = await open({}, () => {
  const g = window._game;
  g.input._startMotionListening();
  window.__tiltTarget = 0;
  window.__tiltLog = [];
  const fire = () => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 0, gamma: window.__tiltTarget }));
  for (let i = 0; i < 8; i++) fire();   // warm-up → motionEnabled before SOLO
  setInterval(fire, 16);
  let last = null;
  setInterval(() => {
    const el = document.getElementById('calib-flow-label');
    const t = el ? el.textContent : '';
    // Headless delivers only a few events per second, so the 10-sample rest
    // calibration (0.17 s on a real phone) can outlast the welcome card: hold
    // still until it has finished and the drift tracker has its first sample.
    const settled = g.input.motionOffset != null && g.input._driftEma != null;
    if (settled && window.__settledAt == null) window.__settledAt = Math.round(performance.now());
    window.__tiltTarget = !settled ? 0 : /left/i.test(t) ? -35 : /right/i.test(t) ? 35 : 0;
    if (t !== last) { window.__tiltLog.push([Math.round(performance.now()), t]); last = t; }
  }, 30);
});
await startFromIntro(tilter);
await tilter.waitForFunction(() => (window.__tiltLog || []).some(([, t]) => /recalibrate/i.test(t)), { timeout: 90000 }).catch(() => {});
const { tiltLog, settledAt } = await tilter.evaluate(() => ({ tiltLog: window.__tiltLog, settledAt: window.__settledAt || 0 }));
const tiltSteps = [];
for (let i = 0; i < tiltLog.length - 1; i++) {
  const [t0, label] = tiltLog[i];
  if (/(left|right|center)\.\.\.$/i.test(label)) tiltSteps.push({ label, ms: tiltLog[i + 1][0] - Math.max(t0, settledAt) });
}
console.log('phone tilt calibration steps:', JSON.stringify(tiltSteps));
// A centre step can clear between two label samples (already centred), so it
// may not show up; all four tilt steps must.
const isTilt = (s) => /(left|right)\.\.\.$/i.test(s.label);
const tiltOk = tiltSteps.filter(isTilt).length === 4 &&
  tiltSteps.every(s => s.ms < (isTilt(s) ? TILT_LIMIT_MS : CENTER_LIMIT_MS));
await tilter.browserContext().close();

// 6. m3 (PR #397 review): a phase retry (off-road / missed present) counts as an
// attempt, so finishing after one is not "Natural" (tutorial_clean). Scenario 4
// above finished with no retry and must have earned it.
const retrier = await open();
await startFromIntro(retrier);
const retried = await retrier.evaluate(async () => {
  const g = window._game;
  g._tutorialPhaseRetry(1, 'Stay on the road!');
  await new Promise(r => setTimeout(r, 1400));   // the retry's reset runs at 1.2 s
  g._tutorialComplete();
  return { attempts: g._tutorialAttempts, natural: g.achievements.getEarnedIds().includes('tutorial_clean') };
});
console.log('retry then finish:', JSON.stringify(retried), '| clean finish natural:', screen.natural);
await retrier.browserContext().close();

const ok =
  tiltOk &&
  screen.natural === true && retried.natural === false && retried.attempts === 2 &&
  first.intro && first.level === 'tutorial' && first.state === 'lobby' && !first.skipVisible && first.done === null &&
  !skipped.intro && !skipped.tutorial && skipped.done === 'skip' && skipped.onLevelList && !skipped.skipVisible &&
    skipped.selectedCard === 'grandma' &&
  !escSkipped.intro && !escSkipped.tutorial && escSkipped.done === 'skip' && escSkipped.onLevelList &&
  !ret.intro && !ret.tutorial && ret.onLevelList &&
  !started.intro && started.tutorial && started.level === 'tutorial' && started.skipVisible && started.state !== 'lobby' &&
  screen.overlay && screen.shell && screen.nextVisible && /GRANDMA/i.test(screen.nextText) && screen.continueText === 'LOBBY' &&
    screen.done === 'complete' && !screen.skipVisible &&
  next.level === 'grandma' && !next.tutorial && ['countdown', 'playing'].includes(next.state) && next.instructionsHidden;
console.log(ok ? '✔ first SOLO → the intro; SKIP / Esc → level list; START → tutorial with SKIP; returning players not forced; NEXT → Grandma\'s; phone tilt calibration passes'
               : '✖ something is wrong');
await browser.close(); server.close(); process.exit(ok?0:1);
