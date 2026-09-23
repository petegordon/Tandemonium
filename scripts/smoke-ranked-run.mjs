#!/usr/bin/env node
// smoke-ranked-run.mjs — D-2/D-3/D-5: the chooser appears on the web build and
// never in the demo, a spent solo run leaves the pair run free, and the share
// strip is four lines with nothing about the road in them.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8923;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json'};
const server=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
 fs.stat(f,(e,st)=>{if(e||st.isDirectory())return r.writeHead(404).end();r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
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
  page.on('pageerror', e => console.log('  PAGEERROR:', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window._game,{timeout:30000});
  return page;
}

async function pickDaily(page) {
  await page.evaluate(() => {
    document.getElementById('tap-to-start')?.click();
    (document.getElementById('btn-solo') || Array.from(document.querySelectorAll('button')).find(x=>/solo/i.test(x.textContent)))?.click();
  });
  await new Promise(r=>setTimeout(r,600));
  await page.evaluate(() => document.querySelector('.level-card[data-level-id="daily"]')?.click());
  await new Promise(r=>setTimeout(r,300));
}

// 1. Web build: START RIDE opens the chooser.
const web = await open();
await pickDaily(web);
const chooser = await web.evaluate(() => {
  document.getElementById('btn-start-ride').click();
  const o = document.getElementById('daily-mode-overlay');
  return {
    visible: o.classList.contains('visible'),
    rankedDisabled: document.getElementById('btn-daily-ranked').disabled,
    sub: document.getElementById('daily-mode-sub').textContent
  };
});
console.log('web chooser:', JSON.stringify(chooser));

// 2. Spend the run, reopen: RANKED is disabled with the time shown.
const afterSpend = await web.evaluate(async () => {
  const d = await import('./js/daily-ride.js');
  const { dailyKey } = await import('./js/daily-seed.js');
  const key = dailyKey();
  d.recordRanked(d.browserStore(), key, 'solo', { timeMs: 161000, distance: 500 });
  document.getElementById('daily-mode-overlay').classList.remove('visible');
  window._game.lobby._showDailyModeChooser();
  return {
    rankedDisabled: document.getElementById('btn-daily-ranked').disabled,
    hint: document.getElementById('daily-ranked-hint').textContent,
    pairStillFree: !d.rankedDone(d.browserStore(), key, 'pair')
  };
});
console.log('after spending the solo run:', JSON.stringify(afterSpend));

// 3. Demo build: no chooser at all.
const demo = await open('?demo=1');
await pickDaily(demo);
const demoChooser = await demo.evaluate(() => {
  const ask = window._game.lobby._shouldAskDailyMode();
  return { asks: ask, isDemo: window._game.lobby.isDemoBuild };
});
console.log('demo build:', JSON.stringify(demoChooser));

// 4. The strip, built from a real summary through the game's own method.
const strip = await web.evaluate(async () => {
  const g = window._game;
  const { dailyKey } = await import('./js/daily-seed.js');
  const level = { ...g.lobby.selectedLevel, key: dailyKey(), isDaily: true, distance: 500 };
  g.mode = 'solo'; g._rankedRunActive = true; g.safetyMode = false;
  const html = g._buildDailyStripHtml({
    timeMs: 161000, distance: 500, raceDistance: 500, collectibles: 9,
    collectiblesTotal: 12, crashes: 1
  }, level);
  return { html, text: g._dailyStripText };
});
console.log('strip:\n' + strip.text);

const ok = chooser.visible && !chooser.rankedDisabled
  && afterSpend.rankedDisabled && /2:41/.test(afterSpend.hint) && afterSpend.pairStillFree
  && demoChooser.isDemo && demoChooser.asks === false
  && /Today's Road/.test(strip.text) && /2:41/.test(strip.text) && strip.text.split('\n').length === 4;
console.log(ok ? '✔ ranked runs, the one-per-day rule, the demo gate and the strip all hold'
               : '✖ something is wrong');
await browser.close(); server.close(); process.exit(ok?0:1);
