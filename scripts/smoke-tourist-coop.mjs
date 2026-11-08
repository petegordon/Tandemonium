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
//   PR #397 M1 / m10 / m15 / m16 / m17 — mixed editions and versions in a room:
//   6. #666 guest pass: the HOST's (captain's) edition sets the room.
//      a. a full captain + a demo stoker: a "Full game room" on both sides
//         (no Daily cap), the Map Tourists card (a level the demo lacks) rides
//         together, the real Daily Ride too; the demo side's full-game
//         achievement is earned but HELD (never sent to the Steam fake), its
//         demo one still goes, and the end card says how many it holds.
//      b. a demo captain + a full stoker: a "Demo room" (3 rides a day), no
//         Map Tourists, nothing held.
//   7. an OLD-client stoker (room profile without caps): no Map Tourists card,
//      no helping hand on the captain (a NEW full stoker does get it, on the
//      Daily Ride too).
//   8. a captain whose own Tourist load fails still returns a silent stoker
//      to the room (EVT_RETURN_ROOM always).
//   9. a demo stoker refuses a level its edition lacks (Map Tourists from a
//      new captain; an old #400 demo captain's 'weekly' road), stays on the
//      level list and tells the captain.
//  10. a touristReady lost in a blip is resent from onConnected.
//  m15: the partner failing ends the barrier while this side is still loading.
//  m16: the stoker uses the captain's anchor height.
//  m10: couch co-op's level list has no Slingshot card.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer';
import { installFakeSteam, fakeSteam } from './lib/fake-steam.mjs';
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

async function open(withKey, query = '', storage = null, before = null) {
  const page=await browser.newPage(); await page.setViewport({width:1280,height:800});
  if (before) await before(page);
  if (storage) await page.evaluateOnNewDocument((s) => { try { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } catch {} }, storage);
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
  await page.goto(`http://127.0.0.1:${PORT}/index.html${query}`,{waitUntil:'domcontentloaded'});
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
// The timed barrier scenarios skip the captain's one anchor lookup (m16): the
// elevation services are unreachable here and each can take its own timeout.
const PLAN_FAST_JS = `(async () => {
  const plan = await ${PLAN_JS};
  plan.anchor = { height: 230, anchored: false };
  return plan;
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
async function pair(stokerHasKey, { stokerQuery = '', captainQuery = '', stokerOld = false, storage = null, stokerBefore = null } = {}) {
  const cap = await open(true, captainQuery, storage);
  const sto = await open(stokerHasKey, stokerQuery, storage, stokerBefore);
  const pages = { captain: cap, stoker: sto };
  const drop = { captain: new Set(), stoker: new Set() };   // message types not delivered FROM a side
  for (const [role, page] of Object.entries(pages)) {
    const other = role === 'captain' ? sto : cap;
    await page.exposeFunction('__relay', (kind, json) => {
      const msg = JSON.parse(json);
      if (kind === 'profile' && drop[role].has(msg.type)) return;
      // An OLD-build stoker: its room profile has no edition / caps.
      if (kind === 'profile' && role === 'stoker' && stokerOld && !msg.type) { delete msg.edition; delete msg.caps; }
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
        sendEventReliable: (e) => window.__relay('event', JSON.stringify(e)),   // #621
        sendState() {}, sendLean() {}, sendPedal() {}, getQualityStats: () => null, destroy() {},
      };
      window.__fakeNet = net;
      l.net = net;
      l._roomRole = role;
      l._pendingMode = 'multiplayer';
      net.onProfileReceived = (p) => l._handleRoomMessage(p);
    }, role);
  }
  // PR #397 M1: the room profiles ({ edition, caps }) cross before the level list.
  for (const page of [cap, sto]) await page.evaluate(() => window._game.lobby._sendRoomProfile());
  await cap.waitForFunction(() => !!window._game.lobby._partnerRoom, { timeout: 5000, polling: 50 }).catch(() => null);
  await sto.waitForFunction(() => !!window._game.lobby._partnerRoom, { timeout: 5000, polling: 50 }).catch(() => null);
  for (const page of [cap, sto]) await page.evaluate(() => window._game.lobby._showRoomLevelsStep());
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
  // m16: one anchor lookup (the captain's), used by both sides.
  capAnchor: await cap.evaluate(() => JSON.stringify(window._game._touristRoute.anchor || null)),
  stoAnchor: await sto.evaluate(() => JSON.stringify(window._game._touristRoute && window._game._touristRoute.anchor || null)),
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
  coop.capAnchor !== 'null' && coop.capAnchor === coop.stoAnchor &&
  coop.capBack.kind === 'World' && coop.capBack.bikeOnRoad && coop.capBack.chunksInScene &&
  coop.stoBack.kind === 'World' && coop.stoBack.bikeOnRoad && coop.stoBack.chunksInScene;
await cap.close(); await sto.close();

// 3a. the stoker cannot load (no Maps key): both back in the room, fast, with a reason.
({ cap, sto } = await pair(false));
// m15: the captain's own load is slow (8 s) — the stoker's instant failure must
// still end the barrier at once, not after the captain's load settles.
await cap.evaluate(() => {
  const g = window._game, orig = g._loadTouristWorld.bind(g);
  window.__slowLoadDone = false;
  g._loadTouristWorld = async (...a) => { await new Promise(r => setTimeout(r, 8000)); window.__slowLoadDone = true; return orig(...a); };
});
let t0 = Date.now();
await cap.evaluate(async (planJs) => {
  const l = window._game.lobby;
  document.querySelector('#level-cards .level-card[data-level-id="tourist"]').click();
  l._startTouristRide(await eval(planJs));
}, PLAN_FAST_JS);
await cap.waitForFunction(() => !!window._game._lastTouristAbort, { timeout: 30000, polling: 100 }).catch(() => null);
const abortedWhileLoading = await cap.evaluate(() => !!window._game._lastTouristAbort && !window.__slowLoadDone);
await sto.waitForFunction(() => !!window._game._lastTouristAbort, { timeout: 30000, polling: 100 }).catch(() => null);
const fail = {
  ms: Date.now() - t0, abortedWhileLoading,
  cap: { ...(await worldState(cap)), why: await cap.evaluate(() => window._game._lastTouristAbort) },
  sto: { ...(await worldState(sto)), why: await sto.evaluate(() => window._game._lastTouristAbort) },
  capInRoom: await cap.evaluate(() => window._game.lobby._currentStep === window._game.lobby.levelStep),
};
console.log('no key on the stoker:', JSON.stringify(fail, null, 1));
const failOk = fail.abortedWhileLoading && fail.cap.state === 'lobby' && fail.sto.state === 'lobby' &&
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
}, PLAN_FAST_JS);
await cap.waitForFunction(() => !!window._game._lastTouristAbort, { timeout: 30000, polling: 100 }).catch(() => null);
await sto.waitForFunction(() => !!window._game._lastTouristAbort, { timeout: 30000, polling: 100 }).catch(() => null);
const timeout = {
  ms: Date.now() - t0,
  cap: { ...(await worldState(cap)), why: await cap.evaluate(() => window._game._lastTouristAbort) },
  sto: { ...(await worldState(sto)), why: await sto.evaluate(() => window._game._lastTouristAbort) },
};
console.log('silent stoker:', JSON.stringify(timeout, null, 1));
const timeoutOk = /took too long/.test(timeout.cap.why || '') &&
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
  // m10: the couch list never offers the (one-rider) Slingshot; its Tourist card is plural.
  const sling = !!document.querySelector('#level-cards .level-card-slingshot');
  const label = card.querySelector('.level-card-name').textContent;
  card.click();
  const touristFor = l._touristFor;
  l._startTouristRide(await eval(planJs));
  for (let i = 0; i < 100 && g.state !== 'instructions'; i++) await new Promise(r => setTimeout(r, 100));
  return { card: true, sling, label, touristFor, mode: g.mode, state: g.state, hasP2: !!g.inputP2,
           kind: g.world.constructor.name, level: l.selectedLevel.id };
}, PLAN_JS);
console.log('couch co-op:', JSON.stringify(local));
const localOk = local.card && !local.sling && local.label === 'Map Tourists' && local.touristFor === 'local' && local.mode === 'local' && local.hasP2 &&
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

// ── 6-10 · PR #397 M1: mixed editions and versions ───────────────────────────
const startCoopRide = async (levelId) => {
  await cap.evaluate((id) => {
    document.querySelector('#level-cards .level-card[data-level-id="' + id + '"]').click();
  }, levelId);
  await cap.waitForFunction((id) => window._game.lobby.selectedLevel && window._game.lobby.selectedLevel.id === id,
    { timeout: 5000, polling: 50 }, levelId).catch(() => null);
  await cap.evaluate(() => document.getElementById('btn-start-ride').click());
  await cap.waitForFunction(() => window._game.mode === 'captain', { timeout: 15000, polling: 100 }).catch(() => null);
  await sto.waitForFunction(() => window._game.mode === 'stoker', { timeout: 15000, polling: 100 }).catch(() => null);
};
const roomView = (page) => page.evaluate(async () => {
  const g = window._game, l = g.lobby, lv = l.selectedLevel || {}, rr = g._roomRules();
  const { dailyKey } = await import('./js/daily-seed.js');
  return { mode: g.mode, level: lv.id, key: lv.key, dailyKey: dailyKey(), seed: lv.seed, diff: l.selectedDifficulty,
    roomDemo: rr.isDemo, rideCap: rr.dailyRideCap, roomTourist: rr.tourist,
    chooser: !!document.getElementById('daily-mode-overlay') };
});

// 6. #666 guest pass: the host's (captain's) edition sets the room.
// The demo's Daily opens after the Tutorial and Grandma's: both sides have earned them.
const OPENED = { tandemonium_achievements: JSON.stringify([
  { id: 'tutorial_done', earnedAt: Date.now() }, { id: 'home_sweet', earnedAt: Date.now() }]) };
const badgeOf = (page) => page.evaluate(() => {
  const l = window._game.lobby; l._levelRoomKey = null; l._syncLevelRoomBar();
  const t = document.getElementById('level-room-team');
  return { badge: t.dataset.roomBadge || '', heading: t.heading || '' };
});
const cardIds = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#level-cards .level-card')).map(c => c.dataset.levelId));

// 6a. full captain + demo stoker (the demo under the Steam fake, which records what reaches Steam).
({ cap, sto } = await pair(true, { stokerQuery: '?demo=1', storage: OPENED,
  stokerBefore: (p) => installFakeSteam(p, { isDemo: true }) }));
const guestCards = await cardIds(cap);
const guestBadges = { cap: await badgeOf(cap), sto: await badgeOf(sto) };
// Map Tourists, the level the demo does not have: the two ride it together.
await cap.evaluate(async (planJs) => {
  const l = window._game.lobby;
  document.querySelector('#level-cards .level-card[data-level-id="tourist"]').click();
  l._startTouristRide(await eval(planJs));
}, PLAN_FAST_JS);
await waitState(cap, ['instructions']);
await waitState(sto, ['instructions']);
const guestTourist = { cap: await worldState(cap), sto: await worldState(sto),
  abort: await cap.evaluate(() => window._game._lastTouristAbort || null) };
await cap.evaluate(() => window._game._returnToRoom());
await sto.waitForFunction(() => window._game.state === 'lobby', { timeout: 5000, polling: 100 }).catch(() => null);
await cap.waitForFunction(() => window._game.state === 'lobby' && window._game.lobby._currentStep === window._game.lobby.levelStep,
  { timeout: 5000, polling: 100 }).catch(() => null);
// ...and the Daily Ride, ridden by the full host's rules (no cap for the guest either).
await startCoopRide('daily');
await cap.evaluate(() => window.__fakeNet.sendProfile({ type: 'dailyMode', mode: 'ranked', key: 'x' }));   // an old build's ranked call: ignored
await cap.waitForFunction(() => window._game.state !== 'lobby', { timeout: 5000, polling: 100 }).catch(() => null);
const guestRoom = { cards: guestCards, badges: guestBadges, tourist: guestTourist, cap: await roomView(cap), sto: await roomView(sto) };
// The demo stoker earns one full-game and one demo achievement mid-ride.
const held = await sto.evaluate(async () => {
  const g = window._game, m = g.achievements;
  const { ACHIEVEMENTS } = await import('./js/achievements.js');
  const earned = new Set(m.getEarnedIds());
  const full = ACHIEVEMENTS.find(a => !a.demo && !earned.has(a.id));
  const demo = ACHIEVEMENTS.find(a => a.demo && !earned.has(a.id));
  const orig = [full.condition, demo.condition];
  full.condition = () => true; demo.condition = () => true;
  const guestPass = m.guestPass;
  try { m.check({}); } finally { [full.condition, demo.condition] = orig; }
  await new Promise(r => setTimeout(r, 0));
  g._updateCtaButtons('victory');   // the end card reads the held count
  const note = document.getElementById('victory-held');
  return { full: full.id, demo: demo.id, guestPass, earned: m.getEarnedIds(), heldIds: m.getHeldIds(),
    note: note && !note.hidden ? note.textContent : '',
    wishlist: document.getElementById('btn-wishlist-victory').style.display !== 'none',
    saved: JSON.parse(localStorage.getItem('tandemonium_achievements') || '[]').map(a => a.id) };
});
held.steam = await fakeSteam(sto).achievements();
guestRoom.held = held;
console.log('full host + demo guest:', JSON.stringify(guestRoom, null, 1));
const guestRoomOk = guestRoom.cards.includes('tourist') &&
  guestRoom.badges.cap.badge === 'Full game room' && guestRoom.badges.sto.badge === 'Full game room' &&
  /Full game room/.test(guestRoom.badges.sto.heading) &&
  guestRoom.tourist.cap.state === 'instructions' && guestRoom.tourist.sto.state === 'instructions' &&
  guestRoom.tourist.sto.kind === 'TouristWorld' && guestRoom.tourist.sto.level === 'tourist' && !guestRoom.tourist.abort &&
  guestRoom.cap.mode === 'captain' && guestRoom.sto.mode === 'stoker' &&
  guestRoom.cap.level === 'daily' && guestRoom.sto.level === 'daily' && guestRoom.sto.key === guestRoom.cap.key &&
  !guestRoom.cap.roomDemo && !guestRoom.sto.roomDemo && guestRoom.cap.rideCap === null && guestRoom.sto.rideCap === null &&
  !guestRoom.cap.chooser && !guestRoom.sto.chooser &&
  held.guestPass && held.earned.includes(held.full) && held.heldIds.includes(held.full) && held.saved.includes(held.full) &&
  !held.steam.includes(held.full.toUpperCase()) && held.steam.includes(held.demo.toUpperCase()) &&
  held.steam.every(id => !held.heldIds.map(h => h.toUpperCase()).includes(id)) &&
  new RegExp('You earned ' + held.heldIds.length + ' achievements? with your friend\\. Get the full game to claim (it|them)\\.').test(held.note) &&
  held.wishlist;
await cap.close(); await sto.close();

// 6b. demo captain + full stoker: a demo room, 3 rides a day, no Map Tourists, nothing held.
({ cap, sto } = await pair(true, { captainQuery: '?demo=1', storage: OPENED }));
const demoCards = await cardIds(cap);
const demoBadges = { cap: await badgeOf(cap), sto: await badgeOf(sto) };
await startCoopRide('daily');
await cap.waitForFunction(() => window._game.state !== 'lobby', { timeout: 5000, polling: 100 }).catch(() => null);
const demoRoom = { cards: demoCards, badges: demoBadges, cap: await roomView(cap), sto: await roomView(sto),
  guestPass: await sto.evaluate(() => window._game.achievements.guestPass || window._game._roomRules().guestPass) };
console.log('demo host + full guest:', JSON.stringify(demoRoom, null, 1));
const demoRoomOk = !demoRoom.cards.includes('tourist') && demoRoom.cards.includes('daily') &&
  demoRoom.badges.cap.badge === 'Demo room' && demoRoom.badges.sto.badge === 'Demo room' &&
  demoRoom.cap.mode === 'captain' && demoRoom.sto.mode === 'stoker' &&
  demoRoom.cap.level === 'daily' && demoRoom.sto.level === 'daily' && demoRoom.sto.key === demoRoom.cap.key &&
  demoRoom.cap.roomDemo && demoRoom.sto.roomDemo && demoRoom.cap.rideCap === 3 && demoRoom.sto.rideCap === 3 &&
  !demoRoom.cap.roomTourist && !demoRoom.sto.roomTourist && !demoRoom.guestPass;
await cap.close(); await sto.close();

// 7. OLD-client stoker: no Map Tourists, no helping hand.
({ cap, sto } = await pair(true, { stokerOld: true }));
const oldCards = await cap.evaluate(() => Array.from(document.querySelectorAll('#level-cards .level-card')).map(c => c.dataset.levelId));
await startCoopRide('grandma');
const oldRoom = { cards: oldCards, cap: await roomView(cap),
  help: await cap.evaluate(() => window._game._helpEligible()), partnerOld: await cap.evaluate(() => window._game._roomRules().partnerOld) };
console.log('old stoker:', JSON.stringify(oldRoom, null, 1));
const oldRoomOk = !oldRoom.cards.includes('tourist') && oldRoom.cap.mode === 'captain' && !oldRoom.cap.roomTourist &&
  oldRoom.cap.level === 'grandma' && oldRoom.help === false && oldRoom.partnerOld === true && !oldRoom.cap.roomDemo;
await cap.close(); await sto.close();
// ...and the same pair with a NEW full stoker does get the helping hand, on the Daily Ride too (#641).
({ cap, sto } = await pair(true));
await startCoopRide('daily');
const newHelp = await cap.evaluate(() => ({ level: window._game.lobby.selectedLevel.id, help: window._game._helpEligible(), mode: window._game.mode }));
const newPairOk = newHelp.level === 'daily' && newHelp.mode === 'captain' && newHelp.help === true;
console.log('new stoker:', JSON.stringify(newHelp));
await cap.close(); await sto.close();

// 8. the captain's own Tourist load fails, the stoker never answers: still back to the room.
({ cap, sto, drop } = await pair(true));
drop.stoker.add('touristReady'); drop.captain.add('touristReady');
await cap.evaluate(() => { window._game._loadTouristWorld = async () => false; });
await sto.evaluate(() => { window._game._touristReadyTimeoutMs = 120000; });
t0 = Date.now();
await cap.evaluate(async (planJs) => {
  const l = window._game.lobby;
  document.querySelector('#level-cards .level-card[data-level-id="tourist"]').click();
  l._startTouristRide(await eval(planJs));
}, PLAN_FAST_JS);
await cap.waitForFunction(() => !!window._game._lastTouristAbort, { timeout: 30000, polling: 100 }).catch(() => null);
await sto.waitForFunction(() => window._game.state === 'lobby' && window._game.lobby._currentStep === window._game.lobby.levelStep,
  { timeout: 30000, polling: 100 }).catch(() => null);
const capFail = { ms: Date.now() - t0, cap: await worldState(cap), sto: await worldState(sto),
  stoInRoom: await sto.evaluate(() => window._game.lobby._currentStep === window._game.lobby.levelStep) };
console.log('captain load fails:', JSON.stringify(capFail, null, 1));
const capFailOk = capFail.cap.state === 'lobby' && capFail.sto.state === 'lobby' &&
  capFail.sto.kind === 'World' && capFail.stoInRoom;
await cap.close(); await sto.close();

// 9. a demo stoker refuses a level its edition lacks (Map Tourists from a new
// captain; an old #400 demo captain's 'weekly' road) and stays on the list.
({ cap, sto } = await pair(true, { stokerQuery: '?demo=1' }));
const before9 = await sto.evaluate(() => JSON.stringify(window._game.lobby.selectedLevel && window._game.lobby.selectedLevel.id || null));
await cap.evaluate(async () => {
  const { RoomProtocol } = await import('./js/lobby/room-protocol.js');
  window.__fakeNet.sendProfile(RoomProtocol.levelSync('tourist', {}));
});
await cap.waitForFunction(() => window._game.lobby._lastLevelRefused === 'tourist', { timeout: 5000, polling: 50 }).catch(() => null);
const refusedNew = await cap.evaluate(() => window._game.lobby._lastLevelRefused);
await cap.evaluate(() => { window._game.lobby._lastLevelRefused = null; });
await cap.evaluate(async () => {   // an old #400 demo captain: its Weekly Ride (#641 retired it)
  const { dailyKey } = await import('./js/daily-seed.js');
  window.__fakeNet.sendProfile({ type: 'levelSync', levelId: 'daily', key: dailyKey(), seed: 99, roadKind: 'weekly', difficulty: 'chill' });
});
await cap.waitForFunction(() => window._game.lobby._lastLevelRefused === 'daily', { timeout: 5000, polling: 50 }).catch(() => null);
const refuse = { refusedNew, refusedOld: await cap.evaluate(() => window._game.lobby._lastLevelRefused),
  stoLevelBefore: before9,
  stoLevelAfter: await sto.evaluate(() => JSON.stringify(window._game.lobby.selectedLevel && window._game.lobby.selectedLevel.id || null)),
  stoMode: await sto.evaluate(() => window._game.mode), stoState: await sto.evaluate(() => window._game.state),
  stoOnList: await sto.evaluate(() => window._game.lobby._currentStep === window._game.lobby.levelStep) };
console.log('demo stoker refuses:', JSON.stringify(refuse));
const refuseOk = refuse.refusedNew === 'tourist' && refuse.refusedOld === 'daily' && refuse.stoLevelAfter === refuse.stoLevelBefore &&
  refuse.stoMode !== 'stoker' && refuse.stoState === 'lobby' && refuse.stoOnList;
await cap.close(); await sto.close();

// 10. m15: the stoker's touristReady is lost in a blip — resent from onConnected.
({ cap, sto, drop } = await pair(true));
drop.stoker.add('touristReady');
await cap.evaluate(async (planJs) => {
  const l = window._game.lobby;
  document.querySelector('#level-cards .level-card[data-level-id="tourist"]').click();
  l._startTouristRide(await eval(planJs));
}, PLAN_FAST_JS);
await sto.waitForFunction(() => !!(window._game._touristBarrierPending && window._game._touristBarrierPending.readySent) ||
  window._game.state === 'instructions', { timeout: 15000, polling: 100 }).catch(() => null);
drop.stoker.delete('touristReady');
await sto.evaluate(() => window.__fakeNet.onConnected && window.__fakeNet.onConnected());
await waitState(cap, ['instructions'], 8000);
await waitState(sto, ['instructions'], 8000);
const blip = { cap: await cap.evaluate(() => window._game.state), sto: await sto.evaluate(() => window._game.state),
  abort: await cap.evaluate(() => window._game._lastTouristAbort || null) };
console.log('ready resent after a blip:', JSON.stringify(blip));
const blipOk = blip.cap === 'instructions' && blip.sto === 'instructions' && !blip.abort;
await cap.close(); await sto.close();

// ── 6. review B3 · the odometer: real frames of the solo loop move the bike, ──
// nothing sets distanceTraveled by hand. A short route arrives (the ordinary
// finish → victory); open world counts what was ridden, and it pays.
const odoPage = await open(true);
await odoPage.setViewport({ width: 480, height: 320 });   // cheaper frames
const odo = await odoPage.evaluate(async () => {
  const g = window._game, l = g.lobby;
  const { planRoute, planExplore } = await import('./js/tourist-route.js');
  // Ride `frames` real _updateSolo frames at `speed` m/s, turning `turn` rad a
  // frame; keep the bike upright and rolling (no rider input headless).
  const rideFrames = (frames, speed, turn = 0, dt = 0.05) => {
    let n = 0;
    for (; n < frames && g.state === 'playing'; n++) {
      g.bike.speed = speed; g.bike.lean = 0; g.bike.leanVelocity = 0; g.bike.fallen = false;
      g.bike.heading += turn;
      g._updateSolo(dt);
    }
    return n;
  };
  const startRide = async (plan) => {
    await g._onTouristReady({ plan });
    g._startCountdown();
    g._updateCountdown(10);   // straight to GO
  };
  const goal = () => document.getElementById('tourist-goal').textContent;

  // Route: ~160 m north-west, so the finish is reachable in a few hundred frames.
  const plan = planRoute({ lat: 39.9612, lon: -82.9988, label: 'Home' },
                         { lat: 39.9624, lon: -82.9998, label: 'Next door' });
  await startRide(plan);
  const r = { state0: g.state, kind: g.world.constructor.name, d0: g.bike.distanceTraveled, goal0: goal(),
              finishM: l.selectedLevel.distance };
  rideFrames(40, 10);                                   // 20 m along the bearing
  r.d20 = g.bike.distanceTraveled; r.goal20 = goal();
  const h = g.bike.heading;
  g.bike.heading = h + Math.PI / 2; rideFrames(40, 10); // 20 m sideways: no progress
  r.dSide = g.bike.distanceTraveled;
  g.bike.heading = h + Math.PI; rideFrames(20, 10);     // 10 m back: never subtracts
  r.dBack = g.bike.distanceTraveled;
  g.bike.heading = h;
  r.frames = rideFrames(2000, 12);                      // on to the door
  r.stateAtLine = g.state;
  r.dLine = g.bike.distanceTraveled;
  for (let i = 0; i < 400 && g.state === 'finishCinematic'; i++) g._updateFinishCinematic(0.1);
  r.end = g.state;
  r.title = document.getElementById('victory-title').textContent;
  g._returnToLobby();

  // Open world: ride a circle; the readout counts it and the payout sees it.
  await startRide(planExplore({ lat: 39.9451, lon: -82.7905, label: '7958 Norman St, Pickerington, OH' }));
  const e = { state0: g.state, d0: g.bike.distanceTraveled, goal0: goal(), payCapM: l.selectedLevel.payCapM };
  rideFrames(200, 10, 0.02);                            // 100 m round a bend
  e.d = g.bike.distanceTraveled;
  e.goal = goal();
  const snap = g._rideSnapshot('abandon');
  e.payM = snap && snap.distance; e.payMode = snap && snap.mode;
  g._returnToLobby();
  return { route: r, explore: e };
});
console.log('odometer:', JSON.stringify(odo, null, 1));
const R = odo.route, E = odo.explore;
const odoOk =
  R.state0 === 'playing' && R.kind === 'TouristWorld' && R.d0 === 0 && /to go/.test(R.goal0) &&
  Math.abs(R.d20 - 20) < 1.5 && R.goal20 !== R.goal0 &&
  Math.abs(R.dSide - R.d20) < 0.5 && R.dBack === R.dSide &&
  R.dLine >= R.finishM && R.stateAtLine === 'finishCinematic' && R.end === 'victory' && /MADE IT TO THEM/.test(R.title) &&
  E.state0 === 'playing' && E.d0 === 0 && /0 m ridden/.test(E.goal0) && E.payCapM === 10000 &&
  Math.abs(E.d - 100) < 3 && /\b\d{2,3} m ridden/.test(E.goal) && !/ 0 m ridden/.test(E.goal) &&
  E.payMode === 'tourist' && Math.abs(E.payM - E.d) < 0.01;
await odoPage.close();

const checks = { swapOk, coopOk, failOk, timeoutOk, localOk, anchorOk, odoOk,
  guestRoomOk, demoRoomOk, oldRoomOk, newPairOk, capFailOk, refuseOk, blipOk, noPageErrors: errors.length === 0 };
console.log(checks);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? '✔ tourist rides hand the real road back; co-op Tourist meets at a ready barrier that never hangs'
               : '✖ tourist world swap / co-op wrong');
await browser.close(); server.close(); process.exit(ok?0:1);
