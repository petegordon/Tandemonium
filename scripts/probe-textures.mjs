// probe-textures.mjs — list every texture in the ride scene with its size and
// estimated GPU memory (RGBA8 + mips), to see what fills a low-memory device.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT = process.cwd(); const PORT = 8934;
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.json':'application/json' };
const server = http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
  fs.stat(f,(e,st)=>{if(e||st.isDirectory())return res.writeHead(404).end();res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser = await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const page = await browser.newPage(); await page.setViewport({width:1280,height:720});
await page.setRequestInterception(true);
page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
  let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
  if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
  m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
  if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
  return req.abort();});
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('tandemonium_tutorial_done', 'probe'); } catch {} });
await page.goto(`http://127.0.0.1:${PORT}/index.html?quality=low`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>!!window._game,{timeout:60000});
await page.click('#tap-to-start').catch(()=>{});
await page.evaluate(() => document.getElementById('btn-solo')?.click()); await new Promise(r=>setTimeout(r,1500));
await page.evaluate(() => Array.from(document.querySelectorAll('button, uf-button')).find(x => /start ride/i.test(x.textContent||''))?.click());
await page.waitForFunction(() => window._game?.state === 'playing', { timeout: 120000 });
await new Promise(r=>setTimeout(r,5000));
const out = await page.evaluate(() => {
  const seen = new Map(); const tris = new Map();
  window._game.scene.traverse((o) => {
    // owner = top-level child under the scene, for grouping
    let top = o; while (top.parent && top.parent !== window._game.scene) top = top.parent;
    const owner = (top.name || top.type) + '';
    if (o.isMesh && o.geometry) { const g = o.geometry; const n = g.index ? g.index.count/3 : (g.attributes.position?.count||0)/3; tris.set(owner, (tris.get(owner)||0) + n); }
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) for (const k of Object.keys(m)) { const t = m[k]; if (t && t.isTexture && !seen.has(t.uuid)) {
      const img = t.image || t.source?.data; const w = img?.width||img?.videoWidth||0, h = img?.height||img?.videoHeight||0;
      seen.set(t.uuid, { owner, slot: k, w, h, mb: +(w*h*4*1.33/1048576).toFixed(1) }); } }
  });
  return { tex: [...seen.values()], tris: Object.fromEntries([...tris].map(([k,v])=>[k,Math.round(v)])) };
});
const det = await page.evaluate(() => { const S = window._game.scene, res = []; for (const top of S.children) { let n = 0; const sub = {}; top.traverse((o) => { if (o.isMesh) { const g = o.geometry; const t = Math.round(g.index ? g.index.count/3 : g.attributes.position.count/3); n += t; let p = o; while (p.parent && p.parent !== top && p.parent.parent !== top) p = p.parent; const key = (p.name||p.type) + (o.visible ? "" : " [hidden]"); sub[key] = (sub[key]||0) + t; } }); if (n > 5000) res.push({ name: top.name || top.type, visible: top.visible, pos: top.position.toArray().map(v=>+v.toFixed(1)), tris: n, sub }); } return res; }); console.log(JSON.stringify(det, null, 1));
const byOwner = {};
for (const t of out.tex) { byOwner[t.owner] ??= { n: 0, mb: 0, sizes: new Set() }; byOwner[t.owner].n++; byOwner[t.owner].mb += t.mb; byOwner[t.owner].sizes.add(`${t.w}x${t.h}`); }
console.log('Textures by owner (est. GPU MB):');
for (const [k, v] of Object.entries(byOwner).sort((a,b)=>b[1].mb-a[1].mb)) console.log(`  ${k.padEnd(28)} ${String(v.n).padStart(3)} tex  ${v.mb.toFixed(0).padStart(5)} MB  ${[...v.sizes].join(' ')}`);
console.log('total est.', out.tex.reduce((s,t)=>s+t.mb,0).toFixed(0), 'MB');
console.log('Triangles by owner (geometry, not per-frame):');
for (const [k, v] of Object.entries(out.tris).sort((a,b)=>b[1]-a[1]).slice(0,12)) console.log(`  ${k.padEnd(28)} ${v}`);
await browser.close(); server.close();
