#!/usr/bin/env node
// smoke-records.mjs — B-3: a stored best reaches the level card, and the card
// follows the difficulty the player picks (bests and medals are per difficulty).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8915;
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

// Seed a best directly through the module the game uses, then check the card.
const seeded = await page.evaluate(async () => {
  const r = await import('./js/records.js');
  const store = r.load();
  const k = r.key('grandma', 'chill', 'solo');
  r.recordRun(store, k, { timeMs: 161000, splits: [40000, 80000, 120000] });
  r.save(store);
  return { k, best: r.getBest(r.load(), k) };
});
console.log('seeded:', JSON.stringify(seeded.best));

await page.click('#tap-to-start').catch(()=>{});
await page.evaluate(()=>{const b=document.getElementById('btn-solo')||Array.from(document.querySelectorAll('button')).find(x=>/solo/i.test(x.textContent)); b&&b.click();});
await new Promise(r=>setTimeout(r,800));
const cards = await page.evaluate(()=>Array.from(document.querySelectorAll('.level-card')).map(c=>({
  level: c.dataset.levelId, record: c.querySelector('.level-card-record')?.textContent })));
console.log('cards:', JSON.stringify(cards));

// Switch difficulty: the line must follow.
await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('.difficulty-btn')).find(x=>x.dataset.difficulty==='adventurous'); b&&b.click();});
await new Promise(r=>setTimeout(r,300));
const afterSwitch = await page.evaluate(()=>Array.from(document.querySelectorAll('.level-card')).map(c=>c.querySelector('.level-card-record')?.textContent));
console.log('after switching to adventurous:', JSON.stringify(afterSwitch));

const grandma = cards.find(c=>c.level==='grandma');
const ok = grandma && /Best 2:41/.test(grandma.record) && /at [0-9]/.test(grandma.record)
  && afterSwitch.some(t => /No ride yet/.test(t || ''));
console.log(ok ? '✔ the card shows the best, and follows the difficulty' : '✖ record line wrong');
await browser.close(); server.close(); process.exit(ok?0:1);
