#!/usr/bin/env node
// smoke-first-ride.mjs — drive a real first ride end to end in headless Chrome.
// Proves the A-6 grace (clock held, HUD dash, released by the first taps), the
// coach card, and that the bike actually moves. Headless software rendering runs
// the loop at ~1.4 fps, so wall-clock timings here are NOT player timings.
// #263 · how many actions, and how long, from cold load to actually riding?
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = process.cwd(); const PORT = 8910;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json' };
const server = http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
  fs.stat(f,(e,st)=>{if(e||st.isDirectory())return res.writeHead(404).end();res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser = await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const page = await browser.newPage();
await page.setViewport({width:1440,height:900});
await page.setRequestInterception(true);
page.on('request',(req)=>{const u=req.url();
  if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
  let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
  if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
  m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/);
  const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
  if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
  return req.abort();});
page.on('console', m => { if (m.type()==='error') console.log('   console.error:', m.text().slice(0,140)); });

await page.bringToFront();
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>!!window._game,{timeout:45000});
const steps = [];
const stamp = (label, extra) => steps.push({ label, ms: Date.now()-t0, ...extra });
stamp('modules booted');

// 1. dismiss the desktop tap gate
await page.click('#tap-to-start').catch(()=>{});
stamp('clicked the veil');

// 2. solo ride
await page.waitForSelector('#btn-solo, [id*="solo" i]', { timeout: 10000 });
const soloSel = await page.evaluate(() => {
  const b = document.getElementById('btn-solo') || Array.from(document.querySelectorAll('button')).find(x=>/solo/i.test(x.textContent));
  return b ? (b.id ? '#'+b.id : null) : null;
});
await page.evaluate(() => {
  const b = document.getElementById('btn-solo') || Array.from(document.querySelectorAll('button')).find(x=>/solo/i.test(x.textContent));
  b && b.click();
});
stamp('clicked SOLO RIDE', { selector: soloSel });

await new Promise(r=>setTimeout(r,900));
const afterSolo = await page.evaluate(() => ({
  state: window._game?.state,
  visibleButtons: Array.from(document.querySelectorAll('button')).filter(b=>b.offsetParent!==null).map(b=>(b.textContent||'').replace(/\s+/g,' ').trim()).filter(t=>t&&t.length<40).slice(0,12)
}));
stamp('after SOLO RIDE', afterSolo);

// 3. pick a level, then press START RIDE
await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll('button, .level-card, [class*="level"]'))
    .filter(el => el.offsetParent !== null && /grandma/i.test(el.textContent || ''));
  (cards[0] || document.querySelector('.level-card'))?.click();
});
await new Promise(r=>setTimeout(r,500));
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x => /start ride/i.test(x.textContent||''));
  b && b.click();
});
await new Promise(r=>setTimeout(r,800));
stamp('picked Grandma + START RIDE', { state: await page.evaluate(()=>window._game?.state) });

// 4. dismiss instructions ("tap anywhere to start")
await page.evaluate(() => { document.body.click(); document.getElementById('instructions')?.click(); });
await new Promise(r=>setTimeout(r,500));
stamp('dismissed instructions', { state: await page.evaluate(()=>window._game?.state) });

// 5. wait for the countdown to end and the ride to begin
try {
  await page.waitForFunction(()=>window._game?.state==='playing',{timeout:90000});
  stamp('RIDING');
} catch { stamp('never reached playing'); }

// 6. pedal once and see the clock behaviour (A-6 grace)
const dashCheck = await page.evaluate(()=>{ window._game.hud.updateTimer(20,30,true); return document.getElementById('segment-timer')?.textContent; });
console.log('held-timer renders:', JSON.stringify(dashCheck));
const before = await page.evaluate(()=>({
  held: window._game?.raceManager?.timerHeld,
  remaining: window._game?.raceManager?.segmentTimeRemaining,
  timerText: document.getElementById('segment-timer')?.textContent
}));
await page.keyboard.press('ArrowLeft');
await new Promise(r=>setTimeout(r,120));
await page.keyboard.press('ArrowRight');
await new Promise(r=>setTimeout(r,900));
const after = await page.evaluate(()=>({
  held: window._game?.raceManager?.timerHeld,
  remaining: window._game?.raceManager?.segmentTimeRemaining,
  speed: window._game?.bike?.speed,
  timerText: document.getElementById('segment-timer')?.textContent,
  coach: document.getElementById('coach-card')?.classList.contains('show')
}));
console.log('\nSTEPS');
for (const s of steps) console.log(`  ${String(s.ms).padStart(6)} ms  ${s.label}${s.state?`  [state=${s.state}]`:''}${s.visibleButtons?`\n            buttons: ${s.visibleButtons.join(' | ')}`:''}`);
console.log('\nA-6 grace before pedalling:', JSON.stringify(before));
console.log('A-6 after two taps      :', JSON.stringify(after));
await browser.close(); server.close();
