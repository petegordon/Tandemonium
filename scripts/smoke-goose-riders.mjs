#!/usr/bin/env node
// smoke-goose-riders.mjs — the goose tandem in a real solo ride (headless Chrome).
// Checks: the rigged bike loads with both geese seated on its sockets and their riding clips
// bound; the bike's cranks and both geese's legs follow the crank; each goose leans by ITS OWN
// rider's lean (captain right / stoker left at the same time); writes screenshots to
// renders/smoke-goose-*.png. Headless software rendering is slow (~1-2 fps): state checks only.
//   node scripts/smoke-goose-riders.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = process.cwd(); const PORT = 8911;
const OUT = path.join(ROOT, 'renders'); fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json' };
const server = http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
  fs.stat(f,(e,st)=>{if(e||st.isDirectory())return res.writeHead(404).end();res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser = await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const page = await browser.newPage();
await page.setViewport({width:1280,height:800});
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
page.on('console', m => { if (m.type()==='error') errors.push(m.text().slice(0,160)); });
page.on('pageerror', e => errors.push(String(e).slice(0,160)));
const missing = [];
page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(`http://127.0.0.1:${PORT}`)) missing.push(r.url().replace(`http://127.0.0.1:${PORT}`, '')); });
await page.evaluateOnNewDocument(() => { try {
  localStorage.setItem('tandemonium_tutorial_done', 'smoke');
  localStorage.setItem('tandemonium_show_riders', 'on');
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
await page.waitForFunction(()=>window._game?.state==='playing',{timeout:120000}).catch(()=>{});
await page.waitForFunction(()=>window._game?.bike?.goose && window._game.bike.modelLoaded,{timeout:120000}).catch(()=>{});

const results = {};
const fail = [];
const check = (name, ok, info) => { results[name] = { ok: !!ok, ...(info !== undefined ? { info } : {}) }; if (!ok) fail.push(name); };

const load = await page.evaluate(() => {
  const b = window._game.bike, g = b.goose;
  if (!g) return null;
  const seats = {};
  for (const [s, r] of Object.entries(g.riders)) {
    seats[s] = { socket: r.root.parent?.name, clips: ['pedal', 'ride', 'leanL', 'leanR'].filter(k => r[k]),
                 pedalTracks: r.pedal?.getClip().tracks.length, rideTracks: r.ride?.getClip().tracks.length };
  }
  return { path: b._modelPath, pedalNodes: b.pedalNodes.length, bikePedal: !!g.pedal, wheels: !!g.wheels,
           wheelCirc: +g.wheelCircumference.toFixed(3), viewScale: +b.riderViewScale.toFixed(3), seats };
});
check('goose bike + both geese loaded', load && load.seats.Captain && load.seats.Stoker, load);
check('no node spun as a pedal (cranks come from the Pedal clip)', load && load.pedalNodes === 0 && load.bikePedal);
for (const s of ['Captain', 'Stoker']) {
  const r = load?.seats?.[s];
  check(`${s} on Seat_${s} with Pedal/Ride/Lean_L/Lean_R`, r && r.socket === `Seat_${s}` && r.clips.length === 4, r);
}

// cranks: set the crank, step the model, the bike's crank bone + each goose's thigh move
const crank = await page.evaluate(async () => {
  const b = window._game.bike, g = b.goose;
  const read = () => {
    const out = {};
    const c = b.group.getObjectByName('Crank_F');
    out.crank = c ? c.quaternion.toArray().map(x => +x.toFixed(4)) : null;
    for (const [s, r] of Object.entries(g.riders)) out[s] = r.root.getObjectByName('LeftUpLeg').quaternion.toArray().map(x => +x.toFixed(4));
    return out;
  };
  g.setCrank(0); g.update(); const a = read();
  g.setCrank(Math.PI / 2); g.update(); const q = read();
  return { a, q };
});
const moved = (u, v) => u && v && u.some((x, i) => Math.abs(x - v[i]) > 1e-3);
check('bike crank turns with the crank angle', moved(crank.a.crank, crank.q.crank));
check('captain legs follow the crank', moved(crank.a.Captain, crank.q.Captain));
check('stoker legs follow the crank', moved(crank.a.Stoker, crank.q.Stoker));

// feet on the pedals through a whole crank turn, in the game's own playback (bike + geese mixers):
// the ball of each foot vs its pedal pin raised by the ball height, in bike metres
const feet = await page.evaluate(() => {
  const b = window._game.bike, g = b.goose;
  const model = b.group.children[0];
  const k = model.scale.x;
  const BALL = { Captain: 0.0244, Stoker: 0.028 };
  const PIN = { Captain: { L: 'PedalPin_FL', R: 'PedalPin_FR' }, Stoker: { L: 'PedalPin_RL', R: 'PedalPin_RR' } };
  const up = new b.group.position.constructor(0, 1, 0).applyQuaternion(b.group.quaternion);
  const toe = {}, pin = {};
  let worst = 0, at = null;
  for (let deg = 0; deg < 360; deg += 5) {
    g.setCrank(deg * Math.PI / 180); g.update(); b.group.updateMatrixWorld(true);
    for (const seat of ['Captain', 'Stoker']) for (const side of ['L', 'R']) {
      const t = g.riders[seat].root.getObjectByName(side === 'L' ? 'LeftToeBase' : 'RightToeBase').getWorldPosition(up.clone());
      const q = model.getObjectByName(PIN[seat][side]).getWorldPosition(up.clone()).addScaledVector(up, BALL[seat] * k);
      const d = t.distanceTo(q) / k;
      if (d > worst) { worst = d; at = `${seat} ${side} @${deg}`; }
    }
  }
  return { worstMm: +(worst * 1000).toFixed(1), at };
});
check('feet stay on the pedals through the crank turn (< 6 mm)', feet.worstMm < 6, feet);

// independent lean: captain right, stoker left, at the same time
const lean = await page.evaluate(async () => {
  const b = window._game.bike, g = b.goose;
  const keep = b.setRiderLeans;
  b.setRiderLeans = () => {};                    // hold our inputs against the live controller
  b._captainLeanTarget = 1; b._stokerLeanTarget = -1;
  await new Promise(r => setTimeout(r, 4000));   // ~5+ frames of smoothing at headless speed
  const w = {};
  for (const [s, r] of Object.entries(g.riders)) {
    w[s] = { ride: +r.ride.getEffectiveWeight().toFixed(2), left: +r.leanL.getEffectiveWeight().toFixed(2),
             right: +r.leanR.getEffectiveWeight().toFixed(2) };
  }
  window.__restoreLean = () => { b.setRiderLeans = keep; };
  return w;
});
check('captain leans right by his own input', lean.Captain.right > 0.8 && lean.Captain.left === 0, lean.Captain);
check('stoker leans left by her own input at the same time', lean.Stoker.left > 0.8 && lean.Stoker.right === 0, lean.Stoker);
await page.screenshot({ path: path.join(OUT, 'smoke-goose-lean-split.png') });

// versus: a clone of this bike (SkeletonUtils) gets its own geese and its own mixers
const clone = await page.evaluate(() => {
  const b = window._game.bike;
  const c = new b.constructor(window._game.scene, b._modelPath, b);
  const g = c.goose;
  if (!g) return null;
  g.setLeans(-1, 1); g.update();        // the opposite of the original's
  const own = (s) => g.riders[s].root !== b.goose.riders[s].root &&
    g.riders[s].root.getObjectByName('Spine') !== b.goose.riders[s].root.getObjectByName('Spine');
  const res = { seats: Object.keys(g.riders), ownGeese: own('Captain') && own('Stoker'),
    cloneCaptainLeft: +g.riders.Captain.leanL.getEffectiveWeight().toFixed(2),
    origCaptainRight: +b.goose.riders.Captain.leanR.getEffectiveWeight().toFixed(2) };
  window._game.scene.remove(c.group);
  return res;
});
check('versus clone: own geese, leans independently of the original',
  clone && clone.seats.length === 2 && clone.ownGeese && clone.cloneCaptainLeft === 1 && clone.origCaptainRight === 1, clone);
await page.evaluate(() => { const b = window._game.bike; b._captainLeanTarget = 0; b._stokerLeanTarget = 0; window.__restoreLean(); });
for (let i = 0; i < 6; i++) { await page.keyboard.press(i % 2 ? 'ArrowRight' : 'ArrowLeft'); await new Promise(r => setTimeout(r, 250)); }
await new Promise(r => setTimeout(r, 2500));
await page.screenshot({ path: path.join(OUT, 'smoke-goose-ride.png') });
// (aborted off-site requests and missing local extras show up as 'Failed to load resource'; the
//  goose assets themselves must all load)
const real = errors.filter(e => !/Failed to load resource/.test(e));
// Show Solo: in a solo ride only the captain goose shows; off brings the stoker back
const solo = await page.evaluate(async () => {
  const gm = window._game, b = gm.bike;
  const wait = () => new Promise(r => setTimeout(r, 1500));
  gm._setShowSolo(true); await wait();
  const on = { mode: gm.mode, stoker: b.goose.riders.Stoker.root.visible, captain: b.goose.riders.Captain.root.visible,
               btn: document.getElementById('opt-solo-on')?.classList.contains('active') };
  gm._setShowSolo(false); await wait();
  const off = { stoker: b.goose.riders.Stoker.root.visible };
  return { on, off };
});
check('Show Solo: solo ride shows only the captain; off shows both',
  solo.on.mode === 'solo' && solo.on.stoker === false && solo.on.captain === true && solo.on.btn && solo.off.stoker === true, solo);
check('no script errors', real.length === 0, real.slice(0, 5));
check('every goose asset served', !missing.some(u => /goose/.test(u)), missing);

console.log(JSON.stringify(results, null, 1));
console.log(fail.length ? `FAIL: ${fail.join(', ')}` : 'PASS: goose riders');
await browser.close(); server.close();
process.exit(fail.length ? 1 : 0);
