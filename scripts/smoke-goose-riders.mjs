#!/usr/bin/env node
// smoke-goose-riders.mjs — the goose tandem in a real solo ride (headless Chrome).
// Checks: the rigged bike loads with both geese seated on its sockets and their riding clips
// bound; the bike's cranks and both geese's legs follow the crank; each goose leans by ITS OWN
// rider's lean (captain right / stoker left at the same time); the Goose Outfits option swaps
// both geese in place (victorian / cyclists / fancy / georgian); writes screenshots to
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
// protocolTimeout: the outfit swaps and the pixel-sampled colourway checks are single
// page.evaluate calls that take minutes under software rendering (bike + two geese).
const browser = await puppeteer.launch({headless:'new',protocolTimeout:900000,args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
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
await page.evaluate(() => { const b = document.getElementById('btn-solo') || Array.from(document.querySelectorAll('button, uf-button')).find(x=>/solo/i.test(x.textContent)); b && b.click(); });
await new Promise(r=>setTimeout(r,900));
await page.evaluate(() => { const c = Array.from(document.querySelectorAll('button, uf-button, .level-card, [class*="level"]')).filter(el => el.offsetParent !== null && /grandma/i.test(el.textContent || '')); (c[0] || document.querySelector('.level-card'))?.click(); });
await new Promise(r=>setTimeout(r,500));
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button, uf-button')).find(x => /start ride/i.test(x.textContent||'')); b && b.click(); });
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

// #456 · the rider cam draws the scene into its own picture every other frame and copies it in
const riderCam = await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => {
  const G = window._game, fv = G.frontView, R = G.renderer, gl = R.getContext();
  if (!fv || !fv._rect) return res(null);
  // draw it now (the canvas keeps its buffer at this tier), then read the corner's middle
  R.render(G.scene, G.camera); fv._stale = true; fv.render(R, G.scene);
  const r = fv._rect, pr = R.getPixelRatio(), s = Math.round(r.size * pr);
  const x = Math.round(r.cssLeft * pr), y = Math.round((innerHeight - r.cssTop - r.size) * pr);
  const px = new Uint8Array(s * s * 4); gl.readPixels(x, y, s, s, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let lit = 0; for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 60) lit++;
  res({ every: fv.renderEvery, target: !!fv._rt && fv._rt.width === s, litFrac: +(lit / (s * s)).toFixed(2), frame: fv.frame.style.display });
})));
check('rider cam: drawn every other frame into its own picture, copied into the corner', riderCam && riderCam.every === 2 && riderCam.target && riderCam.litFrac > 0.5 && riderCam.frame === 'block', riderCam);
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
  // Wait for the smoothing to settle rather than a fixed 4 s: headless software
  // rendering of the bike + two geese runs at ~1 fps here, and the per-frame
  // smoothing (k = 12·dt, capped at 1) needs a handful of frames either way.
  for (let i = 0; i < 60 && (Math.abs(b._captainLeanNorm - 1) > 0.02 || Math.abs(b._stokerLeanNorm + 1) > 0.02); i++) await new Promise(r => setTimeout(r, 500));
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
// Goose Outfits: each choice swaps both geese in place on the same bike; the new geese are
// seated with all four clips, pedal with the crank, keep their feet on the pedals, and the old
// geese leave the sockets. Show Solo carries over a swap.
const EXPECT = { cyclists: ['goose_captain_cyclist.glb', 'goose_stoker_cyclist.glb'],
                 fancy: ['goose_captain_fancy.glb', 'goose_stoker.glb'],
                 georgian: ['goose_captain_georgian.glb', 'goose_stoker_georgian.glb'],
                 victorian: ['goose_captain.glb', 'goose_stoker_victorian.glb'] };
for (const [key, files] of Object.entries(EXPECT)) {
  const solo = key === 'fancy';
  const r = await page.evaluate(async (key, solo) => {
    const gm = window._game, b = gm.bike;
    gm._setShowSolo(solo);
    const before = { Captain: b.goose.riders.Captain.root, Stoker: b.goose.riders.Stoker.root };
    gm._setGooseOutfit(key);
    await b._gooseSwap;
    const g = b.goose, model = b.group.children[0];
    const seats = {};
    for (const s of ['Captain', 'Stoker']) {
      const rr = g.riders[s];
      const socket = model.getObjectByName('Seat_' + s);
      seats[s] = { socket: rr.root.parent?.name, clips: ['pedal', 'ride', 'leanL', 'leanR'].filter(k => rr[k]).length,
                   geeseOnSocket: socket.children.filter(c => c.userData.gooseSeat).length,
                   oldGone: before[s] !== rr.root ? !before[s].parent : 'same', visible: rr.root.visible };
    }
    // legs follow the crank; foot-to-pin distance stays constant over the turn (its offset is the sole)
    const k = model.scale.x, v = () => new model.position.constructor();
    const PIN = { Captain: { L: 'PedalPin_FL', R: 'PedalPin_FR' }, Stoker: { L: 'PedalPin_RL', R: 'PedalPin_RR' } };
    const span = {};
    let legMoved = true;
    for (const s of ['Captain', 'Stoker']) {
      g.setCrank(0); g.update();
      const q0 = g.riders[s].root.getObjectByName('LeftUpLeg').quaternion.clone();
      g.setCrank(Math.PI / 2); g.update();
      if (g.riders[s].root.getObjectByName('LeftUpLeg').quaternion.angleTo(q0) < 1e-3) legMoved = false;
    }
    for (let deg = 0; deg < 360; deg += 10) {
      g.setCrank(deg * Math.PI / 180); g.update(); b.group.updateMatrixWorld(true);
      for (const s of ['Captain', 'Stoker']) for (const side of ['L', 'R']) {
        const t = g.riders[s].root.getObjectByName(side === 'L' ? 'LeftToeBase' : 'RightToeBase').getWorldPosition(v());
        const d = t.distanceTo(model.getObjectByName(PIN[s][side]).getWorldPosition(v())) / k;
        const id = s + side;
        span[id] = span[id] || [1e9, -1e9];
        span[id] = [Math.min(span[id][0], d), Math.max(span[id][1], d)];
      }
    }
    const footSpanMm = Math.max(...Object.values(span).map(([a, z]) => (z - a) * 1000));
    return { paths: b._gooseRiderPaths, seats, legMoved, footSpanMm: +footSpanMm.toFixed(1),
             btn: document.getElementById('opt-outfit-' + key)?.classList.contains('active'),
             saved: localStorage.getItem('tandemonium_goose_outfit') };
  }, key, solo);
  const okPaths = r.paths.Captain.endsWith(files[0]) && r.paths.Stoker.endsWith(files[1]);
  const okSeats = ['Captain', 'Stoker'].every(s => r.seats[s].socket === `Seat_${s}` && r.seats[s].clips === 4 &&
    r.seats[s].geeseOnSocket === 1 && r.seats[s].oldGone !== false);
  check(`Goose Outfits '${key}': ${files.join(' + ')} seated, old geese gone, legs + feet on the crank`,
    okPaths && okSeats && r.legMoved && r.footSpanMm < 6 && r.btn && r.saved === key &&
    r.seats.Stoker.visible === !solo && r.seats.Captain.visible, r);
  // #524 · the front rider cam shows the captain's whole head, hat included
  const head = await page.evaluate(() => {
    const gm = window._game, b = gm.bike, fv = gm.frontView;
    if (!fv) return null;
    fv.reset(); fv.update(b, 0.016);
    fv.camera.aspect = 1; fv.camera.updateProjectionMatrix(); fv.camera.updateMatrixWorld(true);
    const root = b.goose.riders.Captain.root; root.updateMatrixWorld(true);
    const v = new fv.camera.position.constructor(); let top = null;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i); if (o.isSkinnedMesh) o.applyBoneTransform(i, v); v.applyMatrix4(o.matrixWorld);
        if (!top || v.y > top.y) top = v.clone();
      }
    });
    return top && +top.project(fv.camera).y.toFixed(3);
  });
  check(`Goose Outfits '${key}': the front cam shows the captain's whole head (hat top at NDC y ${head} ≤ 0.9)`, head != null && head <= 0.9 && head > 0.3, head);
  await new Promise(res => setTimeout(res, 1500));
  await page.screenshot({ path: path.join(OUT, `smoke-goose-outfit-${key}.png`) });
}
await page.evaluate(() => window._game._setShowSolo(false));
// Goose Colours: every colourway of every pair visibly recolours both geese -- checked on rendered pixels, with
// a bike colour preset applied first (presets used to clone the geese's materials and drop the colourway shader)
for (const key of Object.keys(EXPECT)) {
  const r = await page.evaluate(async (key) => {
    const gm = window._game, b = gm.bike;
    gm._setGooseOutfit(key);
    await b._gooseSwap;
    b.applyPreset({});                               // a preset pass (resets the bike's materials)
    const THREE_ = { V: gm.camera.position.constructor };
    const model = b.group.children[0];
    const shot = (seat) => {                          // mean colour of a close render of one rider's torso + lap
      b.goose.update(); b.group.updateMatrixWorld(true);
      const V = THREE_.V, k = model.scale.x;
      const cap = model.getObjectByName('Seat_Captain').getWorldPosition(new V());
      const sto = model.getObjectByName('Seat_Stoker').getWorldPosition(new V());
      const fwd = cap.clone().sub(sto); fwd.y = 0; fwd.normalize();
      const side = fwd.clone().cross(new V(0, 1, 0)).normalize();
      const c = (seat === 'Captain' ? cap : sto).clone().add(new V(0, 0.35 * k, 0));
      const cam = gm.camera.clone();
      cam.fov = 20; cam.aspect = 1; cam.near = 0.05 * k; cam.far = 50 * k;
      cam.position.copy(c).addScaledVector(side, 2.0 * k).add(new V(0, 0.2 * k, 0));
      cam.lookAt(c); cam.updateProjectionMatrix();
      const hid = [];
      for (const o of gm.scene.children) if (o !== b.group && !o.isLight && o.visible) { o.visible = false; hid.push(o); }
      gm.renderer.render(gm.scene, cam);
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const cx = cv.getContext('2d');
      const src = gm.renderer.domElement, s0 = Math.min(src.width, src.height);
      cx.drawImage(src, (src.width - s0) / 2 + s0 * 0.3, (src.height - s0) / 2 + s0 * 0.3, s0 * 0.4, s0 * 0.4, 0, 0, 64, 64);
      for (const o of hid) o.visible = true;
      const d = cx.getImageData(0, 0, 64, 64).data;
      let rr = 0, gg = 0, bb = 0;
      for (let i = 0; i < d.length; i += 4) { rr += d[i]; gg += d[i + 1]; bb += d[i + 2]; }
      const n = d.length / 4;
      return [rr / n, gg / n, bb / n];
    };
    const diff = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
    gm._setGooseColourway(0);
    await new Promise(r_ => setTimeout(r_, 300));
    const base = { Captain: shot('Captain'), Stoker: shot('Stoker') };
    const res = [];
    for (let i = 1; i < 4; i++) {
      gm._setGooseColourway(i);
      // the load path Pete hit: riders coloured, then the bike preset's first pass snapshots + clones materials
      b._originalMats = null;
      b.applyPreset({});
      await new Promise(r_ => setTimeout(r_, 300));
      res.push({ label: document.getElementById('opt-colour-' + i).textContent,
                 active: document.getElementById('opt-colour-' + i).classList.contains('active'),
                 dCaptain: Math.round(diff(shot('Captain'), base.Captain)), dStoker: Math.round(diff(shot('Stoker'), base.Stoker)) });
    }
    gm._setGooseColourway(0);
    await new Promise(r_ => setTimeout(r_, 300));
    return { ways: res, back: Math.round(diff(shot('Stoker'), base.Stoker)), label0: document.getElementById('opt-colour-0').textContent };
  }, key);
  check(`Goose Colours '${key}': each colourway visibly recolours both geese (even after a bike preset); Original restores`,
    r.ways.every(w => w.active && w.dCaptain >= 8 && w.dStoker >= 8 && w.label && w.label !== '-') && r.back <= 2 && r.label0 === 'Original', r);
}
{ const realAll = errors.filter(e => !/Failed to load resource/.test(e)); check('no script errors', realAll.length === 0, realAll.slice(0, 5)); }
check('every goose asset served', !missing.some(u => /goose/.test(u)), missing);

console.log(JSON.stringify(results, null, 1));
console.log(fail.length ? `FAIL: ${fail.join(', ')}` : 'PASS: goose riders');
await browser.close(); server.close();
process.exit(fail.length ? 1 : 0);
