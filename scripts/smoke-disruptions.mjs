#!/usr/bin/env node
// smoke-disruptions.mjs — E-2: the road warns before it acts, tightens the beat
// window while it acts, releases it after, and leaves Chill alone.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8931;
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

const out = await page.evaluate(async () => {
  const g = window._game;
  const { SharedPedalController } = await import('./js/shared-pedal-controller.js');
  const { KIND } = await import('./js/disruptions.js');
  const { BEAT_WINDOW_S } = await import('./js/pedal-scoring.js');

  g.state = 'playing';
  g.mode = 'captain';
  g.sharedPedal = new SharedPedalController();
  g.raceManager = { checkpoints: [125, 250, 375], timerHeld: false, getElapsedMs: () => 0 };
  const level = { id: 'daily', distance: 500, seed: 4242 };

  g._startDisruptions(level, 'adventurous');
  const plan = g._disruptions.map(e => ({ kind: e.kind, atM: e.atM }));

  g._startDisruptions(level, 'chill');
  const chill = g._disruptions.length;

  // Back to adventurous, and force a cobbles event so the window can be checked.
  g._startDisruptions(level, 'adventurous');
  g._disruptions = [{ kind: KIND.COBBLES, atM: 200, telegraphM: 176, duration: 4 }];

  const read = (d) => {
    g.bike.distanceTraveled = d;
    g._updateDisruptions(1 / 60);
    const el = document.getElementById('disruption-banner');
    return {
      text: el.textContent,
      shown: el.classList.contains('show'),
      window: g.sharedPedal.beatWindow
    };
  };

  const before = read(100);
  const warned = read(185);
  const during = read(210);
  const after  = read(400);

  return { plan, chill, before, warned, during, after, defaultWindow: BEAT_WINDOW_S };
});
console.log(JSON.stringify(out, null, 1));

const ok = out.plan.length === 2 && out.chill === 0
  && !out.before.shown && out.before.window === out.defaultWindow
  && out.warned.shown && /COBBLES/.test(out.warned.text) && out.warned.window === out.defaultWindow
  && out.during.shown && out.during.window === 0.15
  && !out.after.shown && out.after.window === out.defaultWindow;
console.log(ok ? '✔ warned before it acted, tightened the window while it acted, released it after; Chill untouched'
               : '✖ disruption behaviour wrong');
await browser.close(); server.close(); process.exit(ok?0:1);
