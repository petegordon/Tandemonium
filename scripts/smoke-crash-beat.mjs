#!/usr/bin/env node
// smoke-crash-beat.mjs — B-2: two crashes in a segment go straight back to
// riding with no modal; the third offers help. Wall-clock numbers printed here
// are NOT player timings (headless software rendering runs at ~1.4 fps).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8913;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json'};
const server=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
 fs.stat(f,(e,st)=>{if(e||st.isDirectory())return r.writeHead(404).end();r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const page=await browser.newPage(); await page.setViewport({width:1280,height:800});
await page.setRequestInterception(true);
page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
 let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
 if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
 m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
 if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
 return req.abort();});
page.on('pageerror', e => console.log('  PAGEERROR:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>!!window._game,{timeout:30000});
await page.click('#tap-to-start').catch(()=>{});
await page.evaluate(()=>{const b=document.getElementById('btn-solo')||Array.from(document.querySelectorAll('button')).find(x=>/solo/i.test(x.textContent)); b&&b.click();});
await new Promise(r=>setTimeout(r,600));
// pick Grandma's + Adventurous (so crashes are possible), then start
await page.evaluate(()=>{
  const lvl=Array.from(document.querySelectorAll('button,.level-card,[class*="level"]')).filter(e=>e.offsetParent&&/grandma/i.test(e.textContent||''));
  lvl[0]&&lvl[0].click();
  const diff=Array.from(document.querySelectorAll('button,[class*="diff"]')).filter(e=>e.offsetParent&&/adventurous/i.test(e.textContent||''));
  diff[0]&&diff[0].click();
});
await new Promise(r=>setTimeout(r,400));
await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/start ride/i.test(x.textContent||'')); b&&b.click();});
await page.waitForFunction(()=>window._game?.state==='playing',{timeout:120000});
console.log('riding; safety =', await page.evaluate(()=>window._game.safetyMode));

async function crashAndTime(n) {
  const t0 = await page.evaluate(() => {
    const g = window._game;
    g._recordCrash('balance');
    g.bike._fall();
    window.__t0 = performance.now();
    return window.__t0;
  });
  // wait until we're riding again (or a modal appears)
  const res = await page.waitForFunction(() => {
    const g = window._game;
    if (g.state === 'playing' && !g.bike.fallen) return { outcome: 'riding', ms: performance.now() - window.__t0 };
    if (g.state === 'gameover') return { outcome: 'modal', ms: performance.now() - window.__t0 };
    return false;
  }, { timeout: 60000, polling: 100 }).then(h => h.jsonValue());
  console.log(`  crash ${n}: ${res.outcome} after ${Math.round(res.ms)} ms (headless renders at ~1.4 fps; the real number is the countdown length)`);
  return res;
}
const r1 = await crashAndTime(1);
const r2 = await crashAndTime(2);
const r3 = await crashAndTime(3);
const state = await page.evaluate(()=>({ crashes: window._game._crashState, countdown: window._game.countdownTimer, gameoverVisible: document.getElementById('game-over')?.style.display }));
console.log('crash state:', JSON.stringify(state));
const ok = r1.outcome==='riding' && r2.outcome==='riding' && r3.outcome==='modal';
console.log(ok ? '✔ two crashes resume, the third offers help' : '✖ policy did not hold');
await browser.close(); server.close();
process.exit(ok?0:1);
