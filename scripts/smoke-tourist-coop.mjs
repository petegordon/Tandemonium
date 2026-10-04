#!/usr/bin/env node
// smoke-tourist-coop.mjs — #400: Tourist's world swap and co-op Tourist.
//
// 3d-tiles-renderer is replaced by a stand-in module (no Google, no CDN, no
// streaming), so the tiles WORLD really loads, parks the procedural World, and
// is really disposed — the swap and the ready barrier run on the real code.
// The two online riders are two pages joined by a relay instead of PeerJS:
// what is tested is the room protocol and the game's barrier, not WebRTC.
//
//   1. swap-back: Tourist ride → lobby → Grandma's runs on the procedural
//      World with its real road (twice, so a second route is no double swap).
//   2. online co-op: the captain's Tourist card (RIDE TOGETHER) → touristPlan
//      round-trip → stoker rebuilds the same route → both tiles worlds up →
//      barrier → both on the instructions screen; RETURN TO ROOM restores both.
//   3. barrier failure: a stoker with no Maps key fails fast → both back in the
//      room with a message; a partner that never answers → timeout, never a hang.
//   4. couch co-op: one screen, P2 seated, Tourist card → a 'local' tiles ride.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
const ROOT=process.cwd(); const PORT=8939;
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.json':'application/json'};
const server=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'index.html':u);
 fs.stat(f,(e,st)=>{if(e||st.isDirectory())return r.writeHead(404).end();r.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r);});});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const errors=[];

const STUB_TILES = `import * as THREE from 'three';
export class TilesRenderer {
  constructor() { this.group = new THREE.Group(); this.group.name = 'stub-tiles'; this.downloadQueue = {}; this.lruCache = {}; }
  registerPlugin() {} addEventListener() {} setCamera() {} setResolutionFromRenderer() {} update() {} raycast() {}
  getAttributions() { return []; }
  dispose() { window.__tilesDisposed = (window.__tilesDisposed || 0) + 1; }
}`;
const STUB_PLUGINS = ['GoogleCloudAuthPlugin', 'GLTFExtensionsPlugin', 'TileCompressionPlugin', 'TilesFadePlugin', 'ReorientationPlugin']
  .map(n => `export class ${n} { constructor() {} }`).join('\n');

async function open(withKey) {
  const page=await browser.newPage(); await page.setViewport({width:1280,height:800});
  if (withKey) await page.evaluateOnNewDocument(() => { window.__TOURIST_MAPS_KEY__ = 'test-key-not-real'; });
  await page.setRequestInterception(true);
  page.on('request',(req)=>{const u=req.url(); if(u.startsWith(`http://127.0.0.1:${PORT}`))return req.continue();
   if(/esm\.sh\/3d-tiles-renderer/.test(u))
     return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:/\/plugins/.test(u)?STUB_PLUGINS:STUB_TILES});
   let m=u.match(/three@[^/]+\/build\/three\.module\.js/);
   if(m)return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(path.join(ROOT,'node_modules/three/build/three.module.js'))});
   m=u.match(/three@[^/]+\/examples\/jsm\/(.+)$/); const f=m&&path.join(ROOT,'node_modules/three/examples/jsm/'+m[1]);
   if(f&&fs.existsSync(f))return req.respond({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:fs.readFileSync(f)});
   return req.abort();});
  page.on('pageerror', e => { errors.push(e.message); console.log('  PAGEERROR:', e.message); });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window._game,{timeout:30000});
  await page.evaluate(() => document.getElementById('tap-to-start')?.click());
  return page;
}

/** What the world looks like right now. */
const worldState = (page) => page.evaluate(() => {
  const g = window._game;
  const w = g.world;
  const chunks = w.roadChunks ? w.roadChunks._chunks : [];
  const p0 = w.roadPath && w.roadPath.getPointAtDistance ? w.roadPath.getPointAtDistance(0) : null;
  const p1 = w.roadPath && w.roadPath.getPointAtDistance ? w.roadPath.getPointAtDistance(120) : null;
  return {
    kind: w.constructor.name,
    parked: !!w.parked,
    chunksInScene: chunks.length > 0 && chunks.every(c => c.group.parent === g.scene),
    floorInScene: !!(w.floor && w.floor.parent === g.scene),
    sunInScene: !!(w.sun && w.sun.parent === g.scene),
    bikeOnRoad: !!g.bike.roadPath && g.bike.roadPath === w.roadPath,
    roadIsReal: !!(p0 && p1 && Math.hypot(p1.x - p0.x, p1.z - p0.z) > 50),
    stubInScene: g.scene.children.some(o => o.name === 'stub-tiles'),
    fog: g.scene.fog ? g.scene.fog.density : null,
    far: g.camera.far,
    tilesDisposed: window.__tilesDisposed || 0,
    isTourist: !!g.isTourist,
    state: g.state,
    mode: g.mode,
    level: g.lobby.selectedLevel && g.lobby.selectedLevel.id,
  };
});

const PLAN_JS = `(async () => {
  const { planRoute } = await import('./js/tourist-route.js');
  return planRoute({ lat: 39.9612, lon: -82.9988, label: 'Home' }, { lat: 39.9784, lon: -83.0043, label: 'Theirs' });
})()`;

// ── 1. swap-back ───────────────────────────────────────────────────────────
const solo = await open(true);
const before = await worldState(solo);
const swap = [];
for (let lap = 0; lap < 2; lap++) {
  await solo.evaluate(async (planJs) => {
    const plan = await eval(planJs);
    await window._game._onTouristReady({ plan });
  }, PLAN_JS);
  const during = await worldState(solo);
  await solo.evaluate(async () => {
    const g = window._game, l = g.lobby;
    const { LEVELS } = await import('./js/race-config.js');
    g._returnToLobby();
    l.selectedLevel = LEVELS.find(x => x.id === 'grandma');
    l._forceWizard = false;
    g._onSolo();
  });
  const after = await worldState(solo);
  swap.push({ during, after });
}
console.log('before:', JSON.stringify(before));
console.log('swap:', JSON.stringify(swap, null, 1));
const swapOk = swap.every(({ during, after }) =>
    during.kind === 'TouristWorld' && during.stubInScene && !during.chunksInScene && !during.floorInScene &&
    after.kind === 'World' && !after.parked && after.chunksInScene && after.floorInScene && after.sunInScene &&
    after.bikeOnRoad && after.roadIsReal && !after.stubInScene && !after.isTourist &&
    after.fog === before.fog && after.far === before.far && after.level === 'grandma') &&
  swap[1].after.tilesDisposed === 2;

// ── 2-3. online co-op over a relay ─────────────────────────────────────────
// Each page gets a fake net whose sendProfile/sendEvent land on the other
// page's current handlers (lobby's room handler, then the game's).
async function pair(stokerHasKey) {
  const cap = await open(true);
  const sto = await open(stokerHasKey);
  const pages = { captain: cap, stoker: sto };
  const drop = { captain: new Set(), stoker: new Set() };   // message types not delivered FROM a side
  for (const [role, page] of Object.entries(pages)) {
    const other = role === 'captain' ? sto : cap;
    await page.exposeFunction('__relay', (kind, json) => {
      const msg = JSON.parse(json);
      if (kind === 'profile' && drop[role].has(msg.type)) return;
      other.evaluate((kind, msg) => {
        const n = window.__fakeNet;
        if (kind === 'profile' && n.onProfileReceived) n.onProfileReceived(msg);
        if (kind === 'event' && n.onEventReceived) n.onEventReceived(msg);
      }, kind, msg).catch(() => {});
    });
    await page.evaluate((role) => {
      const l = window._game.lobby;
      const net = {
        connected: true, roomCode: 'TSTX', transport: 'relay', audioEnabled: false, _localMediaStream: null,
        sendProfile: (p) => window.__relay('profile', JSON.stringify(p)),
        sendEvent: (e) => window.__relay('event', JSON.stringify(e)),
        sendState() {}, sendLean() {}, sendPedal() {}, getQualityStats: () => null, destroy() {},
      };
      window.__fakeNet = net;
      l.net = net;
      l._roomRole = role;
      l._pendingMode = 'multiplayer';
      net.onProfileReceived = (p) => l._handleRoomMessage(p);
      l._showRoomLevelsStep();
    }, role);
  }
  return { cap, sto, drop };
}

const waitState = (page, states, ms = 15000) =>
  page.waitForFunction((s) => s.includes(window._game.state) || window._game._lastTouristAbort,
    { timeout: ms, polling: 100 }, states).catch(() => null);

// 2. happy path
let { cap, sto } = await pair(true);
const cards = {
  captain: await cap.evaluate(() => !!document.querySelector('#level-cards .level-card[data-level-id="tourist"]')),
  stoker: await sto.evaluate(() => !!document.querySelector('#level-cards .level-card[data-level-id="tourist"]')),
};
await cap.evaluate(async (planJs) => {
  const l = window._game.lobby;
  document.querySelector('#level-cards .level-card[data-level-id="tourist"]').click();
  window.__stepShown = document.getElementById('lobby-tourist').style.display !== 'none';
  window.__touristFor = l._touristFor;
  const plan = await eval(planJs);
  l._touristPlan = plan;
  l._startTouristRide(plan);   // what RIDE IT does once the plan is on screen
}, PLAN_JS);
await waitState(cap, ['instructions']);
await waitState(sto, ['instructions']);
const coop = {
  step: await cap.evaluate(() => ({ shown: window.__stepShown, for: window.__touristFor })),
  cap: await worldState(cap),
  sto: await worldState(sto),
  sameRoute: await cap.evaluate(() => window._game._touristRoute.headline) ===
             await sto.evaluate(() => window._game._touristRoute && window._game._touristRoute.headline),
  sameGoal: await cap.evaluate(() => window._game.lobby.selectedLevel.distance) ===
            await sto.evaluate(() => window._game.lobby.selectedLevel.distance),
};
await cap.evaluate(() => window._game._returnToRoom());
await sto.waitForFunction(() => window._game.state === 'lobby', { timeout: 5000, polling: 100 }).catch(() => null);
coop.capBack = await worldState(cap);
coop.stoBack = await worldState(sto);
console.log('co-op:', JSON.stringify(coop, null, 1));
const coopOk = cards.captain && !cards.stoker && coop.step.shown && coop.step.for === 'multiplayer' &&
  coop.cap.state === 'instructions' && coop.sto.state === 'instructions' &&
  coop.cap.kind === 'TouristWorld' && coop.sto.kind === 'TouristWorld' &&
  coop.cap.mode === 'captain' && coop.sto.mode === 'stoker' &&
  coop.cap.level === 'tourist' && coop.sto.level === 'tourist' && coop.sameRoute && coop.sameGoal &&
  coop.capBack.kind === 'World' && coop.capBack.bikeOnRoad && coop.capBack.chunksInScene &&
  coop.stoBack.kind === 'World' && coop.stoBack.bikeOnRoad && coop.stoBack.chunksInScene;
await cap.close(); await sto.close();

// 3a. the stoker cannot load (no Maps key): both back in the room, fast, with a reason.
({ cap, sto } = await pair(false));
let t0 = Date.now();
await cap.evaluate(async (planJs) => {
  const l = window._game.lobby;
  document.querySelector('#level-cards .level-card[data-level-id="tourist"]').click();
  l._startTouristRide(await eval(planJs));
}, PLAN_JS);
await cap.waitForFunction(() => !!window._game._lastTouristAbort, { timeout: 15000, polling: 100 }).catch(() => null);
await sto.waitForFunction(() => !!window._game._lastTouristAbort, { timeout: 15000, polling: 100 }).catch(() => null);
const fail = {
  ms: Date.now() - t0,
  cap: { ...(await worldState(cap)), why: await cap.evaluate(() => window._game._lastTouristAbort) },
  sto: { ...(await worldState(sto)), why: await sto.evaluate(() => window._game._lastTouristAbort) },
  capInRoom: await cap.evaluate(() => window._game.lobby._currentStep === window._game.lobby.roomStep),
};
console.log('no key on the stoker:', JSON.stringify(fail, null, 1));
const failOk = fail.ms < 10000 && fail.cap.state === 'lobby' && fail.sto.state === 'lobby' &&
  fail.cap.kind === 'World' && fail.sto.kind === 'World' && fail.capInRoom &&
  /could not load|didn.t load/.test(fail.cap.why + ' ' + fail.sto.why);
await cap.close(); await sto.close();

// 3b. the stoker never answers: the captain times out and goes back to the room.
let drop;
({ cap, sto, drop } = await pair(true));
drop.stoker.add('touristReady');
await cap.evaluate(() => { window._game._touristReadyTimeoutMs = 1500; });
await sto.evaluate(() => { window._game._touristReadyTimeoutMs = 1500; });
t0 = Date.now();
await cap.evaluate(async (planJs) => {
  const l = window._game.lobby;
  document.querySelector('#level-cards .level-card[data-level-id="tourist"]').click();
  l._startTouristRide(await eval(planJs));
}, PLAN_JS);
await cap.waitForFunction(() => !!window._game._lastTouristAbort, { timeout: 10000, polling: 100 }).catch(() => null);
await sto.waitForFunction(() => !!window._game._lastTouristAbort, { timeout: 10000, polling: 100 }).catch(() => null);
const timeout = {
  ms: Date.now() - t0,
  cap: { ...(await worldState(cap)), why: await cap.evaluate(() => window._game._lastTouristAbort) },
  sto: { ...(await worldState(sto)), why: await sto.evaluate(() => window._game._lastTouristAbort) },
};
console.log('silent stoker:', JSON.stringify(timeout, null, 1));
const timeoutOk = timeout.ms < 8000 && /took too long/.test(timeout.cap.why || '') &&
  timeout.cap.state === 'lobby' && timeout.sto.state === 'lobby' &&
  timeout.cap.kind === 'World' && timeout.sto.kind === 'World';
await cap.close(); await sto.close();

// ── 4. couch co-op on one screen ───────────────────────────────────────────
const couch = await open(true);
const local = await couch.evaluate(async (planJs) => {
  const g = window._game, l = g.lobby;
  const { InputManager } = await import('./js/input-manager.js');
  l._localP2InputManager = new InputManager({ enableKeyboard: true, enableMotion: false, enableTouch: false });
  l._localP2Type = 'keyboard';
  l._pendingMode = 'local';
  l._showStep(l.levelStep);
  const card = document.querySelector('#level-cards .level-card[data-level-id="tourist"]');
  if (!card) return { card: false };
  card.click();
  const touristFor = l._touristFor;
  l._startTouristRide(await eval(planJs));
  for (let i = 0; i < 100 && g.state !== 'instructions'; i++) await new Promise(r => setTimeout(r, 100));
  return { card: true, touristFor, mode: g.mode, state: g.state, hasP2: !!g.inputP2,
           kind: g.world.constructor.name, level: l.selectedLevel.id };
}, PLAN_JS);
console.log('couch co-op:', JSON.stringify(local));
const localOk = local.card && local.touristFor === 'local' && local.mode === 'local' && local.hasP2 &&
  local.state === 'instructions' && local.kind === 'TouristWorld' && local.level === 'tourist';

// ── 5. #400 · one address = open world at THAT place; two = a route from the first ──
const where = await open(true);
const anchor = await where.evaluate(async () => {
  const g = window._game, l = g.lobby;
  const { planRoute, planExplore, headingForBearing } = await import('./js/tourist-route.js');
  const home = { lat: 39.9451, lon: -82.7905, label: '7958 Norman St, Pickerington, OH' };
  const cbus = { lat: 39.9612, lon: -82.9988, label: 'Columbus, OH' };

  // The form: one field by default, a button for the second.
  try { localStorage.removeItem('tandemonium_tourist_route'); } catch {}
  l._pendingMode = 'solo';
  l._openTouristStep();
  const vis = id => document.getElementById(id).style.display !== 'none';
  const go = document.getElementById('btn-tourist-ride');
  document.getElementById('tourist-from').value = 'Pickerington, OH';
  document.getElementById('tourist-from').dispatchEvent(new Event('input'));
  const form1 = { toRow: vis('tourist-to-row'), add: vis('btn-tourist-add-to'), go: go.textContent, enabled: !go.disabled };
  document.getElementById('btn-tourist-add-to').click();
  const form2 = { toRow: vis('tourist-to-row'), add: vis('btn-tourist-add-to'), go: go.textContent, enabled: !go.disabled };
  document.getElementById('btn-tourist-remove-to').click();
  const form3 = { toRow: vis('tourist-to-row'), go: go.textContent };

  const route = planRoute(home, cbus);
  await g._onTouristReady({ plan: route });
  const r = {
    lat: g.world._origin.lat, lon: g.world._origin.lon,
    startHeading: g.bike.startHeading, want: headingForBearing(route.bearing), heading: g.bike.heading,
  };
  g._returnToLobby();
  const ex = planExplore(home);
  await g._onTouristReady({ plan: ex });
  g._updateTouristGoal();
  const e = {
    lat: g.world._origin.lat, lon: g.world._origin.lon, radius: g.world._maxRadiusM,
    levelDistance: l.selectedLevel.distance, levelName: l.selectedLevel.name,
    goal: document.getElementById('tourist-goal').textContent, startHeading: g.bike.startHeading,
  };
  g._returnToLobby();
  return { form1, form2, form3, route: r, explore: e, after: g.bike.startHeading };
});
console.log('anchor + form:', JSON.stringify(anchor, null, 1));
const near = (a, b) => Math.abs(a - b) < 1e-9;
const anchorOk =
  !anchor.form1.toRow && anchor.form1.add && anchor.form1.go === 'EXPLORE HERE' && anchor.form1.enabled &&
  anchor.form2.toRow && !anchor.form2.add && anchor.form2.go === 'PLAN THE RIDE' && !anchor.form2.enabled &&
  !anchor.form3.toRow && anchor.form3.go === 'EXPLORE HERE' &&
  near(anchor.route.lat, 39.9451) && near(anchor.route.lon, -82.7905) &&
  near(anchor.route.startHeading, anchor.route.want) && near(anchor.route.heading, anchor.route.want) &&
  near(anchor.explore.lat, 39.9451) && anchor.explore.radius === 3000 &&
  anchor.explore.levelDistance === 100000 && anchor.explore.levelName === 'Map Tourist' &&
  /Exploring 7958 Norman St/.test(anchor.explore.goal) && /ridden/.test(anchor.explore.goal) &&
  anchor.explore.startHeading === 0 && anchor.after === 0;
await where.close();

const checks = { swapOk, coopOk, failOk, timeoutOk, localOk, anchorOk, noPageErrors: errors.length === 0 };
console.log(checks);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? '✔ tourist rides hand the real road back; co-op Tourist meets at a ready barrier that never hangs'
               : '✖ tourist world swap / co-op wrong');
await browser.close(); server.close(); process.exit(ok?0:1);
