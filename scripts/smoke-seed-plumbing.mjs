#!/usr/bin/env node
// smoke-seed-plumbing.mjs — B-4, in the real engine: the legacy world is untouched, a seeded
// world is different but reproducible, reseeding with the same seed is a no-op,
// and ten reseeds do not leak geometry.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8917;
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
await page.waitForFunction(()=>!!window._game && !!window._game.world,{timeout:30000});

const out = await page.evaluate(async () => {
  const g = window._game;
  const w = g.world;
  const sample = () => [0, 250, 500, 900].map(d => {
    const p = w.roadPath.getPointAtDistance(d);
    return [+p.x.toFixed(3), +p.z.toFixed(3)];
  });
  const before = sample();
  const seedAtBoot = w.roadSeed;

  const noop = w.reseed(w.roadSeed);
  const afterNoop = sample();

  const changed = w.reseed(999001);
  const seeded = sample();
  w.reseed(999001);
  const seededAgain = sample();

  w.reseed(42);
  const backToLegacy = sample();

  const geomBefore = g.renderer.info.memory.geometries;
  for (let i = 0; i < 10; i++) w.reseed(100000 + i);
  w.reseed(42);
  const geomAfter = g.renderer.info.memory.geometries;

  return { seedAtBoot, before, afterNoop, noop, changed, seeded, seededAgain, backToLegacy, geomBefore, geomAfter };
});

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
console.log('seed at boot           :', out.seedAtBoot);
console.log('reseed(sameSeed)       :', out.noop === false ? 'no-op ✔' : 'REBUILT ✖');
console.log('legacy road unchanged  :', eq(out.before, out.afterNoop) ? '✔' : '✖');
console.log('new seed differs       :', !eq(out.before, out.seeded) ? '✔' : '✖');
console.log('same seed reproduces   :', eq(out.seeded, out.seededAgain) ? '✔' : '✖');
console.log('42 restores the legacy :', eq(out.before, out.backToLegacy) ? '✔' : '✖');
console.log(`geometries ${out.geomBefore} -> ${out.geomAfter} after 11 reseeds`);
const ok = out.noop === false && eq(out.before, out.afterNoop) && !eq(out.before, out.seeded)
  && eq(out.seeded, out.seededAgain) && eq(out.before, out.backToLegacy)
  && out.geomAfter <= out.geomBefore + 40;
console.log(ok ? '✔ seed plumbing holds' : '✖ seed plumbing failed');
await browser.close(); server.close(); process.exit(ok?0:1);
