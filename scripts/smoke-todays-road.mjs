#!/usr/bin/env node
// smoke-todays-road.mjs — C-2: two players on the same day ride the same road,
// the difficulty is locked, and an expired ?daily= link lands on today.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8921;
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

// Two independent "players": same day, so the same road.
async function roadFingerprint(page) {
  return page.evaluate(async () => {
    const { resolveDailyLevel } = await import('./js/daily-ride.js');
    const { dailyKey, dailySeed } = await import('./js/daily-seed.js');
    const { LEVELS } = await import('./js/race-config.js');
    const level = resolveDailyLevel(LEVELS.find(l => l.isDaily), { key: dailyKey(), seed: dailySeed() });
    const g = window._game;
    g.world.reseed(level.seed);
    const road = [0, 125, 250, 375].map(d => {
      const p = g.world.roadPath.getPointAtDistance(d);
      return [+p.x.toFixed(2), +p.z.toFixed(2)];
    });
    // Item placement, with no salt (everyone must meet the same pylons).
    const { itemSeed, SALT } = await import('./js/daily-seed.js');
    return { key: level.key, seed: level.seed, road,
             obstacleSeed: itemSeed(level, SALT.obstacles, 0, 999),
             saltedSeed: itemSeed(level, SALT.obstacles, 4321, 999) };
  });
}

const p1 = await open();
const p2 = await open();
const a = await roadFingerprint(p1);
const b = await roadFingerprint(p2);
console.log('player 1:', a.key, a.seed, JSON.stringify(a.road[1]));
console.log('player 2:', b.key, b.seed, JSON.stringify(b.road[1]));

// The card: visible in solo, difficulty locked to adventurous when picked.
const card = await p1.evaluate(() => {
  const l = window._game.lobby;
  document.getElementById('tap-to-start')?.click();
  (document.getElementById('btn-solo') || Array.from(document.querySelectorAll('button')).find(x=>/solo/i.test(x.textContent)))?.click();
  const c = document.querySelector('.level-card[data-level-id="daily"]');
  if (!c) return { present: false };
  const text = c.textContent.replace(/\s+/g,' ').trim();
  c.click();
  const diffBtns = Array.from(document.querySelectorAll('#difficulty-selector .difficulty-btn'));
  return {
    present: true, text,
    difficulty: l.selectedDifficulty,
    allDisabled: diffBtns.every(b => b.disabled),
    selectedKey: l.selectedLevel?.key,
    versusHasDaily: null
  };
});
console.log('card:', JSON.stringify(card));

// An expired link lands on today's road.
const expired = await open('?daily=2020-01-01');
const linked = await expired.evaluate(() => ({
  level: window._game.lobby.selectedLevel?.id,
  key: window._game.lobby.selectedLevel?.key
}));
console.log('expired link:', JSON.stringify(linked));

const ok = a.key === b.key && a.seed === b.seed && JSON.stringify(a.road) === JSON.stringify(b.road)
  && a.obstacleSeed === b.obstacleSeed && a.saltedSeed !== a.obstacleSeed
  && card.present && card.difficulty === 'adventurous' && card.allDisabled
  && linked.level === 'daily' && linked.key === a.key;
console.log(ok ? "✔ same road for both players, difficulty locked, expired link recovered"
               : '✖ Today\'s Road did not hold');
await browser.close(); server.close(); process.exit(ok?0:1);
