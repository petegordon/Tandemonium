#!/usr/bin/env node
// smoke-edition.mjs — #400 / #641: what each edition offers in the menus.
//   demo (?demo=1): SOLO shows exactly Tutorial, Grandma's, Daily Ride
//     (+ the Slingshot card) — no Tourist even with a Maps key. #641: the
//     Daily Ride is today's real road on Adventurous, shut until the Tutorial
//     and Grandma's are done, then three rides a day (a 4th is refused);
//     NEXT LEVEL from Grandma's goes to it once open, and from there to the
//     demo's end screen, never elsewhere. VERSUS and five bike colours are shut.
//   full game (?key=dummy): the Tourist card is under SOLO and RIDE TOGETHER
//     (captain), not VERSUS; the road is the Daily Ride.
//   PR #397 B4: the demo survives an invite (?demo=1&room=X keeps demo after
//     the URL tidy; invite/QR links carry demo=1), Options hides "Ride real
//     terrain" and ?demo=1&mode=tourist boots the ordinary game.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8937;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json'};
const server=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
 fs.stat(f,(e,st)=>{if(e||st.isDirectory())return r.writeHead(404).end();r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const errors=[];

async function open(query) {
  const page=await browser.newPage(); await page.setViewport({width:1280,height:800});
  // SOLO must open the level list, not the first-run tutorial auto-start.
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tandemonium_tutorial_done', 'smoke'); } catch {} });
  await page.setRequestInterception(true);
  page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
   let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
   if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
   m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
   if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
   return req.abort();});   // Google + the tiles CDN are never contacted
  page.on('pageerror', e => { errors.push(e.message); console.log('  PAGEERROR:', e.message); });
  await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window._game,{timeout:30000});
  return page;
}

// What the SOLO list, the RIDE TOGETHER list and the VERSUS list offer.
async function lists(page) {
  return page.evaluate(() => {
    const l = window._game.lobby;
    document.getElementById('tap-to-start')?.click();
    document.getElementById('btn-solo')?.click();
    const ids = (root) => Array.from(root.querySelectorAll('.level-card')).map(c => c.dataset.levelId);
    const solo = ids(document.getElementById('level-cards'));
    const road = document.querySelector('#level-cards .level-card[data-level-id="daily"]');
    const roadName = road ? road.querySelector('.level-card-name').textContent : null;
    const roadDesc = road ? road.querySelector('.level-card-desc').textContent : null;
    const other = (mode) => {
      const box = document.createElement('div');
      l._buildLevelCardsShared({ container: box, isClickable: true, mode, showTutorial: mode !== 'versus',
        startBtn: null, backBtn: document.getElementById('btn-back-level'), step: document.createElement('div') });
      return ids(box);
    };
    const coop = other('multiplayer');
    const versus = other('versus');
    l._buildLevelCards();   // put the real SOLO list back
    return { solo, coop, versus, roadName, roadDesc, modeTouristBtn: !!document.getElementById('btn-tourist') };
  });
}

// #641 · the road card's state: shut (greyed) or open, and what it says.
const cardState = () => {
  const card = document.querySelector('#level-cards .level-card[data-level-id="daily"]');
  return { locked: card.classList.contains('level-locked'), desc: card.querySelector('.level-card-desc').textContent };
};

// Pick the road card (shut, then opened), then walk NEXT LEVEL.
async function walk(page) {
  return page.evaluate(async (cardStateSrc) => {
    const cardState = eval(cardStateSrc);
    const g = window._game, l = g.lobby;
    const { LEVELS } = await import('./js/race-config.js');
    const { dailyKey } = await import('./js/daily-seed.js');
    const road = () => document.querySelector('#level-cards .level-card[data-level-id="daily"]');
    // Fresh: nothing earned. The demo's road is shut and a click doesn't pick it.
    l.selectedLevel = LEVELS.find(x => x.id === 'grandma');
    const shut = cardState();
    road().click();
    shut.pickedAfterClick = l.selectedLevel.id;
    shut.nextFromGrandma = (g._nextLevel() || {}).id || null;
    // The Tutorial and Grandma's done: the road opens (read live, no reload).
    localStorage.setItem('tandemonium_achievements', JSON.stringify([
      { id: 'tutorial_done', earnedAt: 1 }, { id: 'home_sweet', earnedAt: 1 }]));
    l._refreshRecordLines();
    const open = cardState();
    road().click();
    const picked = { id: l.selectedLevel.id, name: l.selectedLevel.name, key: l.selectedLevel.key,
                     difficulty: l.selectedDifficulty, dailyKey: dailyKey() };

    // NEXT LEVEL from Grandma's (the click handler itself, as the victory screen runs it).
    l.selectedLevel = LEVELS.find(x => x.id === 'grandma');
    l.selectedDifficulty = 'adventurous';
    const fromGrandma = g._nextLevel();
    document.getElementById('btn-next-level').click();
    const afterGrandma = { id: l.selectedLevel.id, name: l.selectedLevel.name, key: l.selectedLevel.key,
                           difficulty: l.selectedDifficulty };
    // ...and NEXT LEVEL again, from the road.
    const fromRoad = g._nextLevel();
    document.getElementById('btn-next-level').click();
    const overlay = document.getElementById('demo-end-overlay');
    const endShown = overlay.style.display !== 'none';
    const endText = overlay.textContent.replace(/\s+/g, ' ').trim();
    const wishlistShown = document.getElementById('btn-wishlist-demo-end').style.display !== 'none';
    let endHidden = null;
    if (endShown) {
      document.getElementById('btn-demo-lobby').click();
      endHidden = overlay.style.display === 'none';
    }
    // #641 · three rides a day: NEXT LEVEL above started one; two more use the day up.
    const { recordRideStart, ridesStarted, browserStore } = await import('./js/daily-ride.js');
    while (ridesStarted(browserStore(), dailyKey()) < 3) recordRideStart(browserStore(), dailyKey());
    l._refreshRecordLines();
    const capped = cardState();
    l.selectedLevel = l.resolveRoadLevel(LEVELS.find(x => x.isDaily));
    g._sameRideNext = false;
    capped.blocked = g._dailyRideBlocked();
    capped.ridesStarted = ridesStarted(browserStore(), dailyKey());
    // VERSUS and the bike colours (#641).
    const vs = document.getElementById('btn-versus');
    const versus = { shown: vs && vs.style.display !== 'none', locked: !!vs && vs.classList.contains('lobby-role-locked'),
                     desc: vs ? vs.textContent.replace(/\s+/g, ' ') : '' };
    const { bikeAllowed, getEditionRules } = await import('./js/edition.js');
    const bikes = Object.fromEntries(['default', 'bike_orange', 'bike_red', 'bike_christmas']
      .map(k => [k, bikeAllowed(getEditionRules(), k)]));
    return { shut, open, picked, fromGrandma: fromGrandma && fromGrandma.id, afterGrandma,
             fromRoad: fromRoad && fromRoad.id, endShown, endText, wishlistShown, endHidden, capped, versus, bikes };
  }, cardState.toString());
}

const demo = await open('?demo=1&key=dummy');
const dl = await lists(demo);
console.log('demo lists:', JSON.stringify(dl));
const dw = await walk(demo);
console.log('demo walk:', JSON.stringify(dw, null, 1));

const full = await open('?key=dummy');
const fl = await lists(full);
console.log('full lists:', JSON.stringify(fl));
const fw = await full.evaluate(async () => {
  const g = window._game, l = g.lobby;
  const { LEVELS } = await import('./js/race-config.js');
  const { dailyKey } = await import('./js/daily-seed.js');
  // #641: the full game's road is open from the start, with no ride limit.
  const roadCard = document.querySelector('#level-cards .level-card[data-level-id="daily"]');
  const openAtStart = !roadCard.classList.contains('level-locked');
  roadCard.click();
  const picked = { key: l.selectedLevel.key, difficulty: l.selectedDifficulty, today: dailyKey(), openAtStart };
  const { recordRideStart, browserStore } = await import('./js/daily-ride.js');
  for (let i = 0; i < 5; i++) recordRideStart(browserStore(), dailyKey());
  g._sameRideNext = false;
  picked.blockedAfter5 = g._dailyRideBlocked();
  const vs = document.getElementById('btn-versus');
  picked.versusOpen = !!vs && vs.style.display !== 'none' && !vs.classList.contains('lobby-role-locked');
  l.selectedLevel = LEVELS.find(x => x.id === 'grandma');
  const next = g._nextLevel();
  l.selectedLevel = l.resolveRoadLevel(LEVELS.find(x => x.isDaily));
  const fromRoad = g._nextLevel();
  return { picked, next: next && next.id, nextLocked: !!(next && l._lockedLevelIds.has(next.id)),
           nextName: next && next.name, fromRoad };
});
console.log('full walk:', JSON.stringify(fw));

// ── PR #397 B4 · the demo boundary ───────────────────────────────────────
const joinLink = (page) => page.evaluate(async () => (await import('./js/lobby/room-qr.js')).joinUrl('TNDM-QRQR'));
const optTourist = (page) => page.evaluate(() => document.getElementById('options-tourist-btn').style.display !== 'none');
const invite = await open('?demo=1&room=TNDM-ABCD');
await invite.evaluate(() => document.getElementById('tap-to-start')?.click());
await invite.waitForFunction(() => !/room=/.test(location.search), { timeout: 15000, polling: 100 }).catch(() => null);
const boundary = {
  inviteSearch: await invite.evaluate(() => location.search),
  inviteDemo: await invite.evaluate(async () => (await import('./js/edition.js')).isDemoEdition()),
  demoJoin: await joinLink(demo),
  fullJoin: await joinLink(full),
  demoOptTourist: await optTourist(demo),
  fullOptTourist: await optTourist(full),
};
await invite.close();
const tourDemo = await open('?demo=1&mode=tourist&key=dummy');
boundary.demoModeTourist = await tourDemo.evaluate(() => ({ isTourist: !!window._game.isTourist, world: window._game.world.constructor.name }));
await tourDemo.close();
console.log('demo boundary:', JSON.stringify(boundary));

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const checks = {
  demoSolo: same(dl.solo, ['tutorial', 'grandma', 'daily', 'slingshot']),
  demoCoop: same(dl.coop, ['tutorial', 'grandma', 'daily']),
  demoVersus: same(dl.versus, ['grandma']),
  demoRoadNamed: dl.roadName === 'Daily Ride',
  noModeButton: !dl.modeTouristBtn && !fl.modeTouristBtn,
  demoRoadShutAtFirst: dw.shut.locked && /Finish the Tutorial and Grandma/.test(dw.shut.desc) &&
    dw.shut.pickedAfterClick === 'grandma' && dw.shut.nextFromGrandma === null,
  demoRoadOpens: !dw.open.locked && /3 of 3 rides left/.test(dw.open.desc),
  demoRoadIsToday: dw.picked.id === 'daily' && dw.picked.key === dw.picked.dailyKey && dw.picked.difficulty === 'adventurous',
  demoNextFromGrandma: dw.fromGrandma === 'daily' && dw.afterGrandma.id === 'daily' &&
    dw.afterGrandma.name === 'Daily Ride' && dw.afterGrandma.key === dw.picked.dailyKey &&
    dw.afterGrandma.difficulty === 'adventurous',
  demoThreeRides: dw.capped.locked && /today’s 3 rides/.test(dw.capped.desc) && dw.capped.blocked === true &&
    dw.capped.ridesStarted === 3,
  demoVersusShut: dw.versus.shown && dw.versus.locked && /full game/i.test(dw.versus.desc),
  demoTwoBikes: dw.bikes.default && dw.bikes.bike_orange && !dw.bikes.bike_red && !dw.bikes.bike_christmas,
  demoEnd: dw.fromRoad === null && dw.endShown && /That's the demo/.test(dw.endText) &&
    dw.wishlistShown && dw.endHidden === true,
  fullTouristSolo: fl.solo.includes('tourist') && fl.solo.includes('slingshot'),
  fullTouristCoop: fl.coop.includes('tourist') && !fl.versus.includes('tourist'),
  fullRoadDaily: fl.roadName === 'Daily Ride' && fw.picked.key === fw.picked.today &&
    fw.picked.difficulty === 'adventurous' && fw.picked.openAtStart,
  fullNoRideLimit: fw.picked.blockedAfter5 === false,
  fullVersusOpen: fw.picked.versusOpen,
  fullNextNotLocked: !!fw.next && !fw.nextLocked && fw.fromRoad === null,
  // PR #397 B4a/B4b
  inviteKeepsDemo: boundary.inviteSearch === '?demo=1' && boundary.inviteDemo === true,
  inviteLinksCarryDemo: /[?&]room=TNDM-QRQR/.test(boundary.demoJoin) && /[?&]demo=1/.test(boundary.demoJoin) &&
    !/demo=/.test(boundary.fullJoin),
  demoNoTerrainOption: !boundary.demoOptTourist && boundary.fullOptTourist,
  demoIgnoresModeTourist: !boundary.demoModeTourist.isTourist && boundary.demoModeTourist.world === 'World',
  noPageErrors: errors.length === 0
};
console.log(checks);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? '✔ each edition offers exactly its levels; NEXT LEVEL never leaves the edition'
               : '✖ edition menus wrong');
await browser.close(); server.close(); process.exit(ok?0:1);
