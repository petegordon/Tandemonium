#!/usr/bin/env node
// smoke-lookahead.mjs — E-1: the stoker sees the road past the captain view,
// the captain never does, and Chill turns the whole job off.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8927;
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
  const { CAPTAIN_VIEW_M } = await import('./js/lookahead.js');

  // A road with one of each thing, 10/20/30 m past where the captain can see.
  const at = (d, lat) => ({ absoluteD: d, lateralOffset: lat });
  g.bike.distanceTraveled = 100;
  const base = 100 + CAPTAIN_VIEW_M;
  g.obstacleManager = { _items: [at(base + 10, -2)] };
  g.collectibleManager = { _items: [at(base + 20, 0)] };
  g.geeseManager = { _items: [at(base + 30, 2)] };
  g.lobby.selectedLevel = { id: 'grandma' };
  g.lobby.selectedDifficulty = 'adventurous';

  const read = () => {
    const el = document.getElementById('lookahead');
    const lanes = [...el.querySelectorAll('.lookahead-lane')]
      .map(l => [...l.querySelectorAll('.lookahead-item')].map(i => i.textContent));
    return { visible: el.classList.contains('visible'), lanes };
  };

  g.mode = 'stoker'; g._lookaheadTimer = 0; g._updateLookahead(0.2);
  const stoker = read();

  g.mode = 'captain'; g._lookaheadTimer = 0; g._updateLookahead(0.2);
  const captain = read();

  g.mode = 'stoker'; g.lobby.selectedDifficulty = 'chill';
  g._lookaheadTimer = 0; g._updateLookahead(0.2);
  const chill = read();

  return { stoker, captain, chill };
});
console.log(JSON.stringify(out, null, 1));

const ok = out.stoker.visible
  && out.stoker.lanes[0].length === 1 && out.stoker.lanes[1].length === 1 && out.stoker.lanes[2].length === 1
  && !out.captain.visible && !out.chill.visible;
console.log(ok ? '✔ the stoker sees three lanes of road the captain cannot; Chill shows nothing'
               : '✖ look-ahead visibility wrong');
await browser.close(); server.close(); process.exit(ok?0:1);
