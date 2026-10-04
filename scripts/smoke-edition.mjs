#!/usr/bin/env node
// smoke-edition.mjs — #400: what each edition offers in the menus.
//   demo (?demo=1): SOLO shows exactly Tutorial, Grandma's, This Week's Road
//     (+ the Slingshot card) — no Tourist even with a Maps key; the road rides
//     on Chill with the week's key; NEXT LEVEL from Grandma's goes to the
//     weekly road, and from there to the demo's end screen, never elsewhere.
//   full game (?key=dummy): the Tourist card is under SOLO (not under RIDE
//     TOGETHER: co-op Tourist is not built), the road is Today's Road.
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

// Pick the road card, then walk NEXT LEVEL.
async function walk(page) {
  return page.evaluate(async () => {
    const g = window._game, l = g.lobby;
    const { LEVELS } = await import('./js/race-config.js');
    const { weeklyKey, dailyKey } = await import('./js/daily-seed.js');
    document.querySelector('#level-cards .level-card[data-level-id="daily"]').click();
    const picked = { id: l.selectedLevel.id, name: l.selectedLevel.name, key: l.selectedLevel.key,
                     difficulty: l.selectedDifficulty, weeklyKey: weeklyKey(), dailyKey: dailyKey() };

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
    return { picked, fromGrandma: fromGrandma && fromGrandma.id, afterGrandma,
             fromRoad: fromRoad && fromRoad.id, endShown, endText, wishlistShown, endHidden };
  });
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
  document.querySelector('#level-cards .level-card[data-level-id="daily"]').click();
  const picked = { key: l.selectedLevel.key, difficulty: l.selectedDifficulty, today: dailyKey() };
  l.selectedLevel = LEVELS.find(x => x.id === 'grandma');
  const next = g._nextLevel();
  l.selectedLevel = l.resolveRoadLevel(LEVELS.find(x => x.isDaily));
  const fromRoad = g._nextLevel();
  return { picked, next: next && next.id, nextLocked: !!(next && l._lockedLevelIds.has(next.id)),
           nextName: next && next.name, fromRoad };
});
console.log('full walk:', JSON.stringify(fw));

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const checks = {
  demoSolo: same(dl.solo, ['tutorial', 'grandma', 'daily', 'slingshot']),
  demoCoop: same(dl.coop, ['tutorial', 'grandma', 'daily']),
  demoVersus: same(dl.versus, ['grandma']),
  demoRoadNamed: dl.roadName === "This Week's Road" && /A new road every week/.test(dl.roadDesc),
  noModeButton: !dl.modeTouristBtn && !fl.modeTouristBtn,
  demoRoadWeekly: dw.picked.key === dw.picked.weeklyKey && dw.picked.difficulty === 'chill',
  demoNextFromGrandma: dw.fromGrandma === 'daily' && dw.afterGrandma.id === 'daily' &&
    dw.afterGrandma.name === "This Week's Road" && dw.afterGrandma.key === dw.picked.weeklyKey &&
    dw.afterGrandma.difficulty === 'chill',
  demoEnd: dw.fromRoad === null && dw.endShown && /That's the demo/.test(dw.endText) &&
    dw.wishlistShown && dw.endHidden === true,
  fullTouristSolo: fl.solo.includes('tourist') && fl.solo.includes('slingshot'),
  fullNoTouristCoop: !fl.coop.includes('tourist') && !fl.versus.includes('tourist'),
  fullRoadDaily: fl.roadName === "Today's Road" && fw.picked.key === fw.picked.today &&
    fw.picked.difficulty === 'adventurous',
  fullNextNotLocked: !!fw.next && !fw.nextLocked && fw.fromRoad === null,
  noPageErrors: errors.length === 0
};
console.log(checks);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? '✔ each edition offers exactly its levels; NEXT LEVEL never leaves the edition'
               : '✖ edition menus wrong');
await browser.close(); server.close(); process.exit(ok?0:1);
