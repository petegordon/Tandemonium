#!/usr/bin/env node
// smoke-hud-layout.mjs — force every in-ride overlay visible at once (the worst
// case a stoker on Grandma/Adventurous can hit on a first ride) and fail on any
// overlap, at desktop and phone sizes. Everything added in phases A-E was
// independently placed "top-centre" and ended up in a heap; this is what stops
// that happening again.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8945;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json'};
const server=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
 fs.stat(f,(e,st)=>{if(e||st.isDirectory())return r.writeHead(404).end();r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});

async function check(label, viewport) {
  const page=await browser.newPage(); await page.setViewport(viewport);
  await page.setRequestInterception(true);
  page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
   let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
   if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
   m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
   if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
   return req.abort();});
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window._game,{timeout:30000});

  const boxes = await page.evaluate(async () => {
    const g = window._game;
    // Force every in-ride overlay visible at once — the worst case a stoker on
    // Grandma's/Adventurous can actually hit on their first ride.
    document.getElementById('tap-to-start')?.remove();
    document.getElementById('hud-top').style.display = '';
    document.getElementById('bottom-hud').style.display = '';
    g.hud.setSeat('stoker', true);
    g.hud.updateLookahead([{kind:'obstacle',lane:0,distance:5,urgency:1},{kind:'goose',lane:2,distance:30,urgency:0.3}]);
    g._coachEl = document.getElementById('coach-card');
    g._coachEl.classList.add('show');
    document.getElementById('disruption-banner').textContent = '💨 GUST AHEAD';
    document.getElementById('disruption-banner').classList.add('show');
    document.getElementById('ping-call').textContent = '3';
    document.getElementById('ping-call').classList.add('show');
    document.getElementById('ping-bubbles').innerHTML = '<div class="ping-bubble">C👍</div>';
    document.getElementById('ranked-badge').classList.add('show');
    document.getElementById('split-delta').textContent = '+1.3';
    document.getElementById('split-delta').className = 'show behind';
    document.getElementById('ping-row').classList.add('visible');
    // The gradient chip is part of the worst case: every stat visible at once.
    document.getElementById('grade-row').classList.add('visible','up');
    document.getElementById('grade-value').textContent = '12%';

    const ids = ['hud-top','coach-card','lookahead','disruption-banner','ping-call','ping-bubbles',
                 'ranked-badge','split-delta','pedal-bar','sync-row','ping-row','coop-coach'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out[id] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return out;
  });
  await page.close();

  const overlaps = [];
  const keys = Object.keys(boxes);
  const hit = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const [A, B] = [keys[i], keys[j]];
    // sync-row and ping-row live inside hud-top by design.
    if (['sync-row','ping-row'].includes(A) && B === 'hud-top') continue;
    if (['sync-row','ping-row'].includes(B) && A === 'hud-top') continue;
    if (hit(boxes[A], boxes[B])) overlaps.push(`${A} × ${B}`);
  }
  console.log(`\n${label}`);
  for (const k of keys) console.log('  ', k.padEnd(20), JSON.stringify(boxes[k]));
  console.log('  OVERLAPS:', overlaps.length ? overlaps.join(', ') : 'none ✔');
  return overlaps;
}

const desktop = await check('desktop 1280x800', { width: 1280, height: 800 });
const phone = await check('phone 390x844', { width: 390, height: 844, isMobile: true, hasTouch: true });
await browser.close(); server.close();
process.exit(desktop.length + phone.length === 0 ? 0 : 1);
