#!/usr/bin/env node
// smoke-ghost.mjs — D-4: a recorded line comes back as a second, translucent
// bike riding it, in the right place at the right time.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8925;
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
await page.waitForFunction(()=>!!window._game && !!window._game.bike,{timeout:30000});
// The bike model loads asynchronously; the ghost clones it.
await page.waitForFunction(()=>window._game.bike.modelLoaded,{timeout:60000}).catch(()=>console.log('  (bike model never finished loading)'));

const out = await page.evaluate(async () => {
  const g = window._game;
  const ghostMod = await import('./js/ghost.js');
  const recs = await import('./js/records.js');

  // 1. A synthetic best: a straight ride down the middle at 5 m/s for 20 s.
  const rec = new ghostMod.GhostRecorder();
  for (let t = 0; t < 20; t += 1 / 60) rec.sample(1 / 60, { roadD: rec.elapsed * 5, lateral: 0, lean: 0 });
  const track = rec.finish();

  const store = recs.load();
  const key = recs.key('grandma', 'chill', 'solo');
  recs.recordRun(store, key, { timeMs: 20000, splits: [], track });
  recs.save(store);

  // 2. Pretend we are riding Grandma's and start the ghost.
  g.lobby.selectedLevel = { id: 'grandma', name: "Grandma's", distance: 250, checkpointInterval: 62 };
  g.lobby.selectedDifficulty = 'chill';
  g.mode = 'solo';
  g._recordStore = recs.load();
  g._startGhost(g.lobby.selectedLevel);

  const built = !!g._ghostGroup;
  const before = built ? g._ghostGroup.position.clone() : null;

  // 3. Run the ghost forward five seconds of ride time.
  g.state = 'playing';
  g.raceManager = { timerHeld: false, getElapsedMs: () => 5000 };
  for (let i = 0; i < 300; i++) g._updateGhost(1 / 60);
  const after = built ? g._ghostGroup.position.clone() : null;

  const trackFromStore = recs.getTrack(recs.load(), key);
  return {
    built,
    visible: built ? g._ghostGroup.visible : false,
    moved: built ? before.distanceTo(after) : 0,
    opacity: built ? (() => { let o = null; g._ghostGroup.traverse(c => { if (c.material && o === null) o = Array.isArray(c.material) ? c.material[0].opacity : c.material.opacity; }); return o; })() : null,
    storedSamples: trackFromStore ? trackFromStore.count : 0,
    deltaBehind: g._ghostDeltaNow(),
    sceneChildren: g.scene.children.length
  };
});
console.log(JSON.stringify(out, null, 2));

// Ghost should be built, visible, have moved ~25 m along the road in 5 s, and be translucent.
const ok = out.built && out.visible && out.moved > 15 && out.opacity !== null && out.opacity < 0.6
  && out.storedSamples > 50;
console.log(ok ? '✔ the ghost is in the scene, translucent, and riding its recorded line'
               : '✖ ghost did not behave');
await browser.close(); server.close(); process.exit(ok?0:1);
