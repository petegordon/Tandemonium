#!/usr/bin/env node
// smoke-demo-ctas.mjs — B-5: the wishlist button shows on web and demo builds,
// the invite shows in solo only, and both fit a 390px screen.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8919;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json'};
const server=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
 fs.stat(f,(e,st)=>{if(e||st.isDirectory())return r.writeHead(404).end();r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});

async function check(query, viewport) {
  const page=await browser.newPage(); await page.setViewport(viewport);
  await page.setRequestInterception(true);
  page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
   let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
   if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
   m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
   if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
   return req.abort();});
  await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window._game,{timeout:30000});
  const res = await page.evaluate(() => {
    const g = window._game;
    const out = {};
    g.mode = 'solo';
    out.demo = g._isDemo;
    out.canWishlist = g._canWishlist;
    const solo = g._updateCtaButtons('victory').map(b => b.id);
    g.mode = 'captain';
    const coop = g._updateCtaButtons('gameover').map(b => b.id);
    // Does the button fit on screen without covering the stats?
    g.mode = 'solo';
    g._updateCtaButtons('victory');
    document.getElementById('victory-overlay').classList.add('visible');
    const btn = document.getElementById('btn-wishlist-victory');
    btn.style.display = '';
    const rect = btn.getBoundingClientRect();
    out.solo = solo; out.coop = coop;
    out.fits = rect.width > 0 && rect.right <= window.innerWidth + 1;
    return out;
  });
  await page.close();
  return res;
}

const web = await check('', { width: 1280, height: 800 });
console.log('web build      :', JSON.stringify(web));
const demo = await check('?demo=1', { width: 390, height: 844, isMobile: true, hasTouch: true });
console.log('demo on mobile :', JSON.stringify(demo));

const ok = web.canWishlist && web.solo.includes('btn-wishlist-victory') && web.solo.includes('btn-invite-victory')
  && !web.coop.includes('btn-invite-gameover') && web.coop.includes('btn-wishlist-gameover')
  && demo.demo === true && demo.fits;
console.log(ok ? '✔ CTAs appear in solo, the invite stays out of co-op, and it fits at 390px'
               : '✖ CTA visibility wrong');
await browser.close(); server.close(); process.exit(ok?0:1);
