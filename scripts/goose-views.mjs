#!/usr/bin/env node
// goose-views.mjs — review renders of every Goose Outfits pair on the tandem, in the game itself (headless Chrome).
// For each outfit: seat the pair, then render the bike from 8 directions (front, rear, both sides, four 3/4s) at
// two crank angles with an extra camera on the game's own renderer + scene (lean 0, Show Solo off).
// Writes renders/goose-views/<outfit>_<crank>_<view>.png + renders/goose-views/<outfit>.png (contact sheet).
//   node scripts/goose-views.mjs [victorian,cyclists,fancy]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = process.cwd(); const PORT = 8913;
const OUT = path.join(ROOT, 'renders', 'goose-views'); fs.mkdirSync(OUT, { recursive: true });
const OUTFITS = (process.argv[2] || 'victorian,cyclists,fancy').split(',');
// optional filters: argv[3] framings (pair,cap,sto), argv[4] cranks (c0,c90), argv[5] views (front,rear,...)
const want = (i) => (process.argv[i] ? process.argv[i].split(',') : null);
const F_ONLY = want(3), C_ONLY = want(4), V_ONLY = want(5);
// argv[6]: Goose Colours indexes to capture (0 = the pair's own colours); files get a _cw<i> suffix
const CWS = want(6) ? want(6).map(Number) : [null];
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json' };
const server = http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
  fs.stat(f,(e,st)=>{if(e||st.isDirectory())return res.writeHead(404).end();res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser = await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const page = await browser.newPage();
await page.setViewport({width:900,height:900});
await page.setRequestInterception(true);
page.on('request',(req)=>{const u=req.url();
  if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
  let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
  if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
  m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/);
  const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
  if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
  return req.abort();});
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0,160)));
await page.evaluateOnNewDocument(() => { try {
  localStorage.setItem('tandemonium_tutorial_done', 'views');
  localStorage.setItem('tandemonium_show_riders', 'on');
  localStorage.setItem('tandemonium_show_solo', 'off');
} catch {} });
await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>!!window._game,{timeout:45000});
await page.click('#tap-to-start').catch(()=>{});
await page.waitForSelector('#btn-solo, [id*="solo" i]', { timeout: 10000 });
await page.evaluate(() => { const b = document.getElementById('btn-solo') || Array.from(document.querySelectorAll('button')).find(x=>/solo/i.test(x.textContent)); b && b.click(); });
await new Promise(r=>setTimeout(r,900));
await page.evaluate(() => { const c = Array.from(document.querySelectorAll('button, .level-card, [class*="level"]')).filter(el => el.offsetParent !== null && /grandma/i.test(el.textContent || '')); (c[0] || document.querySelector('.level-card'))?.click(); });
await new Promise(r=>setTimeout(r,500));
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /start ride/i.test(x.textContent||'')); b && b.click(); });
await new Promise(r=>setTimeout(r,800));
await page.evaluate(() => { document.body.click(); document.getElementById('instructions')?.click(); });
await page.waitForFunction(()=>window._game?.bike?.goose && window._game.bike.modelLoaded,{timeout:120000});
await page.evaluate(() => { const b = window._game.bike; b.setRiderLeans = () => {}; b._captainLeanTarget = 0; b._stokerLeanTarget = 0;
  window._game._setShowSolo(false); });

const VIEWS = [['front', 0], ['q34fl', 45], ['left', 90], ['q34rl', 135], ['rear', 180], ['q34rr', 225], ['right', 270], ['q34fr', 315]];
const CRANKS = [['c0', 0], ['c90', Math.PI / 2]];
// framings: the pair, then each rider close (centre on its seat, nearer camera)
const FRAMES = [['pair', null, 4.0], ['cap', 'Captain', 2.6], ['sto', 'Stoker', 2.6]];
const shots = {};
for (const outfit of OUTFITS) for (const cwi of CWS) {
  await page.evaluate(async (k, cwi) => { window._game._setGooseOutfit(k); await window._game.bike._gooseSwap;
    if (cwi !== null) window._game._setGooseColourway(cwi); }, outfit, cwi);
  await new Promise(r => setTimeout(r, 1500));
  const sfx = cwi === null ? '' : `_cw${cwi}`;
  for (const [fn, fseat, fdist] of FRAMES) for (const [cn, ca] of CRANKS) {
    if ((F_ONLY && !F_ONLY.includes(fn)) || (C_ONLY && !C_ONLY.includes(cn))) continue;
    for (const [vn, deg] of VIEWS) {
      if (V_ONLY && !V_ONLY.includes(vn)) continue;
      const url = await page.evaluate((ca, deg, fseat, fdist) => {
        const gm = window._game, b = gm.bike, g = b.goose;
        const model = b.group.children[0];
        g.setCrank(ca); g.update(); b.group.updateMatrixWorld(true);
        const V = gm.camera.position.constructor;
        const cap = model.getObjectByName('Seat_Captain').getWorldPosition(new V());
        const sto = model.getObjectByName('Seat_Stoker').getWorldPosition(new V());
        const k = model.scale.x;                                   // bike metres -> world units
        const fwd = cap.clone().sub(sto); fwd.y = 0; fwd.normalize();
        const up = new V(0, 1, 0), side = fwd.clone().cross(up).normalize();   // side = the rider's right
        const ctr = (fseat ? model.getObjectByName('Seat_' + fseat).getWorldPosition(new V()) : cap.clone().add(sto).multiplyScalar(0.5))
          .addScaledVector(up, (fseat ? 0.42 : 0.12) * k);
        const a = deg * Math.PI / 180;                             // 0 = in front, 90 = rider's left, 180 = behind
        const dir = fwd.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, -Math.sin(a));
        const cam = gm.camera.clone();
        cam.fov = 30; cam.aspect = 1; cam.near = 0.05 * k; cam.far = 200 * k;
        cam.position.copy(ctr).addScaledVector(dir, fdist * k).addScaledVector(up, (fseat ? 0.45 : 0.7) * k);
        cam.up.set(0, 1, 0); cam.lookAt(ctr); cam.updateProjectionMatrix();
        const r = gm.renderer;
        // only the bike (+ lights): the world's houses / trees otherwise drift into the shots as the bike rides on
        const hid = [];
        for (const o of gm.scene.children) if (o !== b.group && !o.isLight && o.visible) { o.visible = false; hid.push(o); }
        r.render(gm.scene, cam);
        const url_ = r.domElement.toDataURL('image/png');
        for (const o of hid) o.visible = true;
        return url_;
        return r.domElement.toDataURL('image/png');
      }, ca, deg, fseat, fdist);
      const f = path.join(OUT, `${outfit}_${fn}_${cn}_${vn}${sfx}.png`);
      fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
      (shots[outfit] = shots[outfit] || []).push(f);
    }
  }
  console.log('VIEWS', outfit, shots[outfit].length);
}
console.log(errors.length ? 'ERRORS ' + JSON.stringify(errors.slice(0, 5)) : 'no page errors');
await browser.close(); server.close();
