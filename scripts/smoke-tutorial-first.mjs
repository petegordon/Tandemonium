#!/usr/bin/env node
// smoke-tutorial-first.mjs — D6 (#400) / #399: a first-time player who picks
// SOLO lands in the tutorial with SKIP on screen; SKIP marks it done and goes to
// the level list; a returning player (saved motion tuning) is not forced in;
// and tutorial-complete's NEXT: GRANDMA'S starts Grandma's in one tap.
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
async function open(seed = {}) {
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
  await page.evaluate(() => {
    document.getElementById('tap-to-start')?.click();
    document.getElementById('btn-solo').click();
  });
  await sleep(1200);
  return page;
}

const where = (page) => page.evaluate(() => {
  const g = window._game, skip = document.getElementById('btn-tutorial-skip');
  return {
    state: g.state,
    tutorial: !!g._tutorialActive,
    level: g.lobby.selectedLevel && g.lobby.selectedLevel.id,
    skipVisible: !!(skip && getComputedStyle(skip).display !== 'none'),  // position:fixed → no offsetParent
    onLevelList: g.lobby._currentStep === g.lobby.levelStep && g.lobby.lobbyEl.style.display !== 'none',
    done: localStorage.getItem('tandemonium_tutorial_done')
  };
});

// 1. Fresh profile: SOLO → tutorial, SKIP visible.
const fresh = await open();
const first = await where(fresh);
console.log('fresh SOLO:', JSON.stringify(first));

// 2. SKIP → marked done, back on the level list with Grandma's selected.
await fresh.evaluate(() => document.getElementById('btn-tutorial-skip').click());
await sleep(600);
const skipped = await where(fresh);
skipped.selectedCard = await fresh.evaluate(() => document.querySelector('#level-cards .level-card.selected')?.dataset.levelId);
console.log('after SKIP:', JSON.stringify(skipped));
await fresh.browserContext().close();

// 3. Returning player with saved motion tuning from an older build: not forced.
const returning = await open({ tandemonium_motion_tuning: JSON.stringify({ version: 1, inputType: 'phone' }) });
const ret = await where(returning);
console.log('returning player SOLO:', JSON.stringify(ret));
await returning.browserContext().close();

// 4. Tutorial complete → NEXT: GRANDMA'S starts Grandma's in one tap.
const finisher = await open();
const screen = await finisher.evaluate(() => {
  window._game._tutorialComplete();
  const next = document.getElementById('btn-tutorial-next');
  const cont = document.getElementById('btn-tutorial-continue');
  return {
    overlay: document.getElementById('tutorial-complete').classList.contains('visible'),
    nextVisible: !!(next && next.offsetParent !== null), nextText: next && next.textContent.trim(),
    continueText: cont.textContent.trim(),
    done: localStorage.getItem('tandemonium_tutorial_done'),
    skipVisible: getComputedStyle(document.getElementById('btn-tutorial-skip')).display !== 'none'
  };
});
console.log('tutorial complete:', JSON.stringify(screen));
await finisher.evaluate(() => document.getElementById('btn-tutorial-next').click());
await sleep(800);
const next = await where(finisher);
next.instructionsHidden = await finisher.evaluate(() => document.getElementById('instructions')?.classList.contains('hidden') ?? true);
console.log('after NEXT:', JSON.stringify(next));

const ok =
  first.tutorial && first.level === 'tutorial' && first.skipVisible && first.done === null &&
  !skipped.tutorial && skipped.done === 'skip' && skipped.onLevelList && !skipped.skipVisible &&
    skipped.selectedCard === 'grandma' &&
  !ret.tutorial && ret.onLevelList &&
  screen.overlay && screen.nextVisible && /GRANDMA/i.test(screen.nextText) && screen.continueText === 'LOBBY' &&
    screen.done === 'complete' && !screen.skipVisible &&
  next.level === 'grandma' && !next.tutorial && ['countdown', 'playing'].includes(next.state) && next.instructionsHidden;
console.log(ok ? '✔ first SOLO → tutorial with SKIP; SKIP → level list; returning players not forced; NEXT → Grandma\'s'
               : '✖ something is wrong');
await browser.close(); server.close(); process.exit(ok?0:1);
