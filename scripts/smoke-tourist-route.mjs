#!/usr/bin/env node
// smoke-tourist-route.mjs — E-6/E-7/E-8: the entry stays hidden without a Maps
// key; with one, two addresses plan a ride, the route is remembered, the goal
// counts down, and arriving produces a shareable result. Google and the tiles
// CDN are blocked here on purpose: none of this may depend on them to be tested.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8933;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json'};
const server=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
 fs.stat(f,(e,st)=>{if(e||st.isDirectory())return r.writeHead(404).end();r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});

async function open(withKey) {
  const page=await browser.newPage(); await page.setViewport({width:1280,height:800});
  if (withKey) await page.evaluateOnNewDocument(() => { window.__TOURIST_MAPS_KEY__ = 'test-key-not-real'; });
  await page.setRequestInterception(true);
  page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
   let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
   if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
   m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
   if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
   return req.abort();});   // Google Maps + the tiles CDN are aborted: no key, no billing
  page.on('pageerror', e => console.log('  PAGEERROR:', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window._game,{timeout:30000});
  return page;
}

// 1. No key: the entry point must not exist. An entry that fails is worse than none.
const noKey = await open(false);
const hidden = await noKey.evaluate(() => {
  const b = document.getElementById('btn-tourist');
  return { exists: !!b, visible: b ? b.style.display !== 'none' : false };
});
console.log('without a key:', JSON.stringify(hidden));

// 2. With a key: the entry appears, the form works, the plan is right.
const page = await open(true);
const flow = await page.evaluate(async () => {
  const l = window._game.lobby;
  document.getElementById('tap-to-start')?.click();
  const btn = document.getElementById('btn-tourist');
  const shown = btn.style.display !== 'none';
  btn.click();
  const stepShown = document.getElementById('lobby-tourist').style.display !== 'none';

  // Geocoding needs Google, which is aborted here — so plan straight from the
  // pure module, exactly as _planTouristRide does once it has the two points.
  const { planRoute } = await import('./js/tourist-route.js');
  const from = { lat: 39.9612, lon: -82.9988, label: 'Columbus, OH' };
  const to   = { lat: 39.7392, lon: -104.9903, label: 'Denver, CO' };
  const plan = planRoute(from, to);
  l._touristPlan = plan;
  l._saveRoute(from, to);

  // E-8: the route comes back on the next visit.
  const saved = l._loadSavedRoute();
  l._prefillTouristForm();
  const prefilled = {
    from: document.getElementById('tourist-from').value,
    to: document.getElementById('tourist-to').value,
    button: document.getElementById('btn-tourist-ride').textContent,
    preview: document.getElementById('tourist-preview').textContent
  };

  return {
    shown, stepShown, savedOk: !!saved,
    headline: plan.headline, capped: plan.route.capped,
    ridableKm: Math.round(plan.route.ridableM / 1000),
    prefilled
  };
});
console.log('with a key:', JSON.stringify(flow, null, 1));

// 3. The ride itself: it gets its OWN level (not whatever was selected last),
//    the goal readout counts down, and arrival is the ordinary finish — the
//    pseudo-level's distance IS the destination, so there is one win path.
const ride = await page.evaluate(async () => {
  const g = window._game;
  const { planRoute } = await import('./js/tourist-route.js');
  const plan = planRoute({ lat: 39.9612, lon: -82.9988, label: 'Home' },
                         { lat: 39.9784, lon: -83.0043, label: 'Theirs' });

  // Something else was selected first: the tourist ride must not inherit it.
  g.lobby.selectedLevel = { id: 'grandma', name: "Grandma's", distance: 250, checkpointInterval: 62 };
  await g._onTouristReady({ plan });

  const level = g.lobby.selectedLevel;
  g.state = 'playing';
  g._showTouristGoal();

  g.bike.distanceTraveled = 0;
  g._updateTouristGoal();
  const atStart = document.getElementById('tourist-goal').textContent;

  g.bike.distanceTraveled = plan.route.ridableM / 2;
  g._updateTouristGoal();
  const halfway = document.getElementById('tourist-goal').textContent;

  // The victory screen's tourist block, as _showVictory calls it.
  const html = g._touristVictoryHtml(plan.route.ridableM);

  return {
    atStart, halfway,
    levelId: level.id,
    levelIsTourist: !!level.isTourist,
    timerEnabled: level.timerEnabled,
    finishesAtDestination: Math.abs(level.distance - plan.route.ridableM) < 2,
    title: document.getElementById('victory-title').textContent,
    dest: document.getElementById('victory-destination').textContent,
    html,
    strip: g._dailyStripText
  };
});
console.log('the ride:', JSON.stringify(ride, null, 1));

const ok = !hidden.visible && flow.shown && flow.stepShown && flow.savedOk
  && /1,8\d\d km/.test(flow.headline) && flow.capped && flow.ridableKm === 5
  && flow.prefilled.from === 'Columbus, OH' && /RIDE IT AGAIN/.test(flow.prefilled.button)
  && /to go/.test(ride.atStart) && ride.atStart !== ride.halfway
  && ride.levelId === 'tourist' && ride.levelIsTourist && ride.timerEnabled === false
  && ride.finishesAtDestination
  && /MADE IT TO THEM/.test(ride.title) && /Theirs/.test(ride.dest)
  && /Ride the distance between you/.test(ride.strip);
console.log(ok ? '✔ hidden without a key; plans, remembers, counts down, and arrives with a shareable result'
               : '✖ tourist flow wrong');
await browser.close(); server.close(); process.exit(ok?0:1);
