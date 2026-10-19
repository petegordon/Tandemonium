#!/usr/bin/env node
// probe-memory.mjs — sample memory while the game idles in the lobby, rides,
// and sits paused, to look for growth (a leak) on low-memory devices like a TV.
// Usage: node scripts/probe-memory.mjs [--quality=low] [--minutes=2]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const QUALITY = arg('quality', 'low');
const MIN = +arg('minutes', '2');
const RIDERS = arg('riders', '');
const ROOT = process.cwd(); const PORT = 8933;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json','.mp4':'video/mp4' };
const server = http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
  fs.stat(f,(e,st)=>{if(e||st.isDirectory())return res.writeHead(404).end();res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser = await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio','--enable-precise-memory-info']});
const page = await browser.newPage();
await page.setViewport({width:1280,height:720});
await page.setRequestInterception(true);
page.on('request',(req)=>{const u=req.url();
  if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
  let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
  if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
  m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/);
  const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
  if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
  return req.abort();});
const cdp = await page.target().createCDPSession();
await cdp.send('Performance.enable');
await page.evaluateOnNewDocument((r) => { try { localStorage.setItem('tandemonium_tutorial_done', 'probe'); if (r) localStorage.setItem('tandemonium_show_riders', r); } catch {} }, RIDERS);
await page.goto(`http://127.0.0.1:${PORT}/index.html?quality=${QUALITY}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>!!window._game,{timeout:60000});
await page.click('#tap-to-start').catch(()=>{});

const t0 = Date.now();
const rows = [];
async function sample(phase) {
  await cdp.send('HeapProfiler.collectGarbage').catch(()=>{});
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
  const g = await page.evaluate(() => {
    const G = window._game, r = G?.renderer;
    let objs = 0; G?.scene?.traverse(() => objs++);
    return { state: G?.state, geo: r?.info.memory.geometries, tex: r?.info.memory.textures,
      progs: r?.info.programs?.length, calls: r?.info.render.calls, tris: r?.info.render.triangles,
      objs, rec: !!G?.recorder?.buffering, chunks: G?.recorder?._chunks?.length ?? 0, riders: G?._showRiders, low: G?._lowQuality };
  });
  const row = { t: Math.round((Date.now()-t0)/1000), phase, heapMB: +(m.JSHeapUsedSize/1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, ...g };
  rows.push(row); console.log(JSON.stringify(row));
}
const hold = async (phase, ms, every = 20000) => { const end = Date.now()+ms; while (Date.now() < end) { await sample(phase); await new Promise(r=>setTimeout(r, Math.min(every, Math.max(0,end-Date.now())))); } };

await hold('lobby', MIN*60000);
await page.evaluate(() => document.getElementById('btn-solo')?.click());
await new Promise(r=>setTimeout(r,1500));
await page.evaluate(() => Array.from(document.querySelectorAll('button, uf-button')).find(x => /start ride/i.test(x.textContent||''))?.click());
await page.waitForFunction(() => ['countdown','playing'].includes(window._game?.state), { timeout: 120000 }).catch(()=>{});
// pedal: alternate arrow keys in the background
const pedal = setInterval(() => { page.keyboard.press('ArrowLeft').catch(()=>{}); setTimeout(()=>page.keyboard.press('ArrowRight').catch(()=>{}), 200); }, 400);
await hold('ride', MIN*60000);
clearInterval(pedal);
await page.evaluate(() => window._game?._openOptions?.());
await hold('paused', MIN*60000);
const first = (p) => rows.find(r => r.phase === p), last = (p) => [...rows].reverse().find(r => r.phase === p);
console.log('\nGrowth within each phase (first → last):');
for (const p of ['lobby','ride','paused']) { const a = first(p), b = last(p); if (a && b) console.log(`  ${p}: heap ${a.heapMB}→${b.heapMB} MB, nodes ${a.nodes}→${b.nodes}, listeners ${a.listeners}→${b.listeners}, geo ${a.geo}→${b.geo}, tex ${a.tex}→${b.tex}, objs ${a.objs}→${b.objs}`); }
await browser.close(); server.close();
