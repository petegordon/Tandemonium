#!/usr/bin/env node
// grandma-trailer.mjs — gameplay shots for the "Grandma's Waiting" trailer (tandemonium-trailers/grandmas-waiting).
// Same plumbing as attraction.mjs (lib.mjs virtual clock, page-bot.js bots + camera); shots land in
// renders/reel/clips/gw-<shot>.mp4.
//   node scripts/reel/grandma-trailer.mjs              every shot
//   node scripts/reel/grandma-trailer.mjs probe ...    just these
// Grandma is the 3D Grandma (js/grandma-finish.js on this branch); page-bot's face layer gives the riders a honk
// and a startle (eyes wide, head jerk, blink).
import fs from 'node:fs';
import path from 'node:path';
import { launch, record, encode, advance, sleep, OUT } from './lib.mjs';

let LAST = null;
const PORT = 8963;   // (8951 is the achievement reels)
const STORAGE = { tandemonium_show_riders: 'on', tandemonium_show_solo: 'off' };
const SWAY = { cap: { amp: 0.6, freq: 0.31, phase: 0 }, sto: { amp: 0.6, freq: 0.43, phase: 1 } };

/** Start a co-op ride with bot riders; `warm` seconds of riding after the countdown (0 = still on the line). */
async function ride({ level = 'grandma', difficulty = 'adventurous', outfit = 'victorian', sway = SWAY, warm = 6,
  cadence = 3.2, pedal = true, hud = 'clean', collect = true, keepRoad = true, storage = {} } = {}) {
  const s = await launch({ storage: { ...STORAGE, ...storage }, port: PORT });
  LAST = s;
  const { page } = s;
  page.on('console', (m) => { if (m.type() === 'error') s.errors.push('console: ' + m.text().slice(0, 300)); });
  await page.click('#tap-to-start').catch(() => {});
  await sleep(600);
  await page.evaluate(async (o) => {
    const g = window._game, R = window.__reel, L = g.lobby;
    const { getLevelById } = await import('/js/race-config.js');
    L.selectedLevel = L.resolveRoadLevel ? L.resolveRoadLevel(getLevelById(o.level)) : getLevelById(o.level);
    L.selectedDifficulty = o.difficulty;
    L._hideLobby();
    const p2 = R.newInput();
    g._onLocalReady({ inputP2: p2, sourceType: 'keyboard' });
    R.attach(g.input, () => g.bike, { role: 'captain', sway: o.sway.cap, cadence: o.cadence, pedal: o.pedal, collect: o.collect });
    R.attach(p2, () => g.bike, { role: 'stoker', sway: o.sway.sto, cadence: o.cadence, pedal: o.pedal, collect: o.collect });
    R.keepRoad = o.keepRoad;
    g._onTimerExpired = () => {};
    // and no 'too many crashes' modal: a bot's spill on the way is reset at once (the next spill is the first again)
    const ocr = g._onCrashRecovered.bind(g); g._onCrashRecovered = () => { g._crashState = null; ocr(); };   // no TOO SLOW! mid-take (the slow approach to Grandma would trip it)
  }, { level, difficulty, sway, cadence, pedal, collect, keepRoad });
  await sleep(400);
  await page.evaluate(() => { document.getElementById('instructions')?.click(); });
  await page.waitForFunction(() => window._game.bike.modelLoaded && window._game.bike.goose, { timeout: 120000 });
  await page.evaluate(async (k) => {
    const g = window._game;
    if (k) { g._setGooseOutfit(k); await g.bike._gooseSwap; }
  }, outfit);
  await page.waitForFunction(() => { const b = window._game.bike.goose; return b && b.riders.Captain && b.riders.Stoker; }, { timeout: 120000 });
  await page.evaluate((k) => window.__reel.setupFaces(k), outfit);
  await sleep(500);
  await page.evaluate((clean) => clean ? window.__reel.clean(true) : window.__reel.gameplayHud(), hud === 'clean');
  await advance(page, 4 + warm);
  return s;
}

const cam = (page, shot) => page.evaluate((s) => window.__reel.setCamera(s), shot);
const bots = (page, patch) => page.evaluate((p) => { for (const b of window.__reel.bots) Object.assign(b, p); }, patch);
const probe = (page) => page.evaluate(() => {
  const g = window._game, b = g.bike, w = g.world, gf = w._grandmaFinish, L = w.roadPath.loopLength;
  const d = ((b.distanceTraveled % L) + L) % L;
  let ahead = gf ? gf.grandmaD - d : null;
  if (ahead != null) { if (ahead > L / 2) ahead -= L; if (ahead < -L / 2) ahead += L; }
  const cm = g.collectibleManager;
  return { state: g.state, speed: +b.speed.toFixed(2), d: +(b.distanceTraveled || 0).toFixed(1), fallen: b.fallen,
    grandmaAhead: ahead == null ? null : +ahead.toFixed(1), grandmaReady: !!(gf && gf.grandma.ready),
    presents: cm ? cm.collected : null, geese: g.geeseManager ? g.geeseManager.getDisruptedCount() : null,
    lat: +(b._lateralOffset || 0).toFixed(2), lean: +(b.lean || 0).toFixed(3) };
});
/** Ride on (uncaptured) until Grandma is `units` ahead of the bike. */
async function untilGrandma(page, units, maxS = 200) {
  for (let k = 0; k < maxS * 5; k++) {
    const p = await probe(page);
    if (p.grandmaAhead != null && p.grandmaAhead <= units) return p;
    await advance(page, 0.2);
  }
  throw new Error('never reached Grandma ' + JSON.stringify(await probe(page)));
}

/** Freeze the shot camera where it is (the rig would follow the seats into the dirt and spin with them). */
const lockCam = (page) => page.evaluate(() => {
  const R = window.__reel, st = R.camState;
  if (st && st.ctr) { const ctr = st.ctr.clone(), fwd = st.fwd.clone(); R._bikeFrame = () => ({ ctr: ctr.clone(), fwd: fwd.clone() }); }
});
const holdDown = (page) => page.evaluate(() => { const b = window._game.bike; if (b.fallen) b.fallTimer = 99; });

/** take() with a per-frame log (presents, geese, state) next to the clip: the edit finds its moments from it. */
async function take(name, s, seconds, opts = {}) {
  const log = [];
  const user = opts.perFrame;
  opts = { ...opts, perFrame: async (i, t) => { if (user) await user(i, t); if (i % 6 === 0) log.push({ t: +t.toFixed(3), ...(await probe(s.page)) }); } };
  await record(s.page, 'gw-' + name, seconds, opts);
  fs.mkdirSync(path.join(OUT, 'clips'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'clips', 'gw-' + name + '.json'), JSON.stringify(log));
  const out = await encode('gw-' + name);
  if (s.errors.length) console.log('  page errors:', s.errors.slice(0, 3));
  await s.close();
  console.log('  ->', out);
  return out;
}

const still = async (page, name) => {
  const dir = path.join(OUT, 'stills'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name + '.jpg');
  const client = await page.createCDPSession();
  await page.evaluate(() => { window.__reel.tick(1 / 60); window.__vclock.step(1000 / 60); });
  const { data } = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.writeFileSync(f, Buffer.from(data, 'base64')); await client.detach();
  console.log('  still', f);
};

// ---------------------------------------------------------------- shots
const STILL = { cap: { amp: 0, freq: 0, phase: 0 }, sto: { amp: 0, freq: 0, phase: 0 } };
const BEAT = 60 / 123.36;
const env = (k, d) => (process.env[k] != null ? Number(process.env[k]) : d);

/** The honk scene: creep up beside Grandma and stop; frame events are fixed so every camera sees the same take. */
const HONK = { honk: 4.0, startle: 4.7, tip: 5.7, len: 10 };
async function honkScene(name, camShot) {
  const s = await ride({ warm: 2, sway: STILL, collect: 'avoid', difficulty: 'chill' });   // chill: no spills on the way
  await untilGrandma(s.page, env('GFROM', 60));
  // into the lane by her side, slowing to a stop beside her
  await bots(s.page, { dodge: false, offset: env('GLANE', 1.6), cadence: env('GCAD', 2.2) });
  await s.page.evaluate((kl) => { window.__reel.gains.kl = kl; window.__reel._clearRoad(); window._game._assistWeight = 0; }, env('GKL', 0.25));
  for (let k = 0; k < 200; k++) {
    const p = await probe(s.page);
    if (k % 5 === 0) console.log('   ', p.grandmaAhead, p.lat, p.speed);
    if (p.grandmaAhead <= env('GSTOP', 8)) break;
    await advance(s.page, 0.1);
  }
  await bots(s.page, { pedal: false });
  for (let k = 0; k < 300; k++) {          // coast up beside her, then stop there (before the take: not on camera)
    const p = await probe(s.page);
    if (p.grandmaAhead <= env('GAT', 4)) break;
    await advance(s.page, 1 / 30);
  }
  await s.page.evaluate(() => { const b = window._game.bike; b.speed = 0; });
  await s.page.evaluate(() => { const g = window.__reel.grandma(); if (!g._sw) { g._sw = g.setWaving.bind(g); g.setWaving = (on) => g._sw(window.__reel.waveOverride ?? on); } window.__reel.waveOverride = false; });
  await advance(s.page, 0.6);
  console.log('  stopped', await probe(s.page));
  await cam(s.page, camShot);
  if (camShot.hideHouse) await s.page.evaluate(() => {   // the house billboard turns to face the lens: from low and close it reads as a shard
    for (const m of window._game.world._raceMarkers || []) if (m.type === 'destination') { m._permanentlyHidden = true; m.mesh.visible = false; }
  });
  const hold = () => s.page.evaluate(() => { window._game.bike.speed = 0; });   // parked by her: no rolling on down the hill
  await hold();
  const f = (i, t0) => i === Math.round(t0 * 60);
  if (process.env.GDRY) {
    // camera tryouts: stills from each candidate, then a startle seen from the riders' camera
    const C = JSON.parse(process.env.GDRY);
    for (const [k, c] of Object.entries(C)) { await cam(s.page, c); await advance(s.page, 0.2); await still(s.page, 'try-' + k); }
    await cam(s.page, Object.values(C)[0]);
    await s.page.evaluate(() => window.__reel.startle());
    for (let i = 0; i < 8; i++) { await still(s.page, 'try-st' + i); await advance(s.page, 0.1); }
    await s.close(); return;
  }
  await take(name, s, HONK.len, { perFrame: async (i, t) => {
    if (t < HONK.tip) await hold();
    if (f(i, HONK.honk)) await s.page.evaluate(() => window.__reel.grandma().honk());
    if (f(i, HONK.startle)) await s.page.evaluate(() => window.__reel.startle());
    // over they go: Chill's assist would hold them up, so start the bike's own fall (its canned topple) by hand
    if (f(i, HONK.tip)) await s.page.evaluate((side) => { const b = window._game.bike; b.lean = side * 0.25; b._fall(); }, env('GTIP', 1));
    if (f(i, HONK.tip) && camShot.lock !== false) await lockCam(s.page);
    if (t > HONK.tip) await holdDown(s.page);
  } });
}

const SHOTS = {
  // COLD OPEN: Grandma on her own, waiting at the house; a slow push in (the bike is still on the start line)
  async wait() {
    // shot mid-ride, with the riders still ~140 m back down the road (out of shot): by then her house is up
    const s = await ride({ warm: 2, collect: 'avoid', difficulty: 'chill' });
    await untilGrandma(s.page, 140);
    await bots(s.page, { pedal: false });
    await cam(s.page, { anchor: 'grandma', anchorH: 2.1, keys: [{ t: 0, deg: 34, dist: 5.6, h: -0.1, look: -0.1, fov: 30 }, { t: 6, deg: 40, dist: 2.8, h: 0.05, look: 0.05, fov: 30 }] });
    await take('wait', s, 6);
  },
  // "We are not late—" "We're late." "PEDAL!": both faces on the line, then they push off past the lens
  async start() {
    const s = await ride({ warm: 0, pedal: false, sway: STILL });
    await bots(s.page, { steer: 0 });
    await cam(s.page, { keys: [{ t: 0, deg: env('SDEG', 24), dist: 3.6, h: 0.5, look: 0.8, side: env('SSIDE', 0), fov: 32 }] });
    if (process.env.SDRY) { await advance(s.page, 0.3); await still(s.page, 'try-start'); await s.close(); return; }
    await take('start', s, 6, { perFrame: async (i) => {
      if (i === 5) await lockCam(s.page);
      if (i === 150) await bots(s.page, { pedal: true, steer: 0.9, cadence: 3.6 });
    } });
  },
  // the names: low side tracking, a stroke per beat
  async names() {
    const s = await ride({ warm: 5, cadence: 1.6 / BEAT, collect: 'avoid' });
    await cam(s.page, { keys: [{ t: 0, deg: 86, dist: 3.4, h: 0.0, look: 0.2, fov: 34 }, { t: 6, deg: 98, dist: 3.2, h: 0.05, look: 0.2, fov: 34 }] });
    await take('names', s, 6);
  },
  // "we both lean": a chase that banks with the bike, both riders swaying together
  async lean() {
    const big = { cap: { amp: 0.9, freq: 0.45, phase: 0 }, sto: { amp: 0.9, freq: 0.45, phase: 0.25 } };
    const s = await ride({ warm: 4, sway: big, collect: 'avoid' });
    await cam(s.page, { stiff: 0.25, keys: [{ t: 0, deg: 165, dist: 4.2, h: 0.8, look: 0.4, fov: 46 }, { t: 7, deg: 195, dist: 4.0, h: 0.8, look: 0.4, fov: 46 }] });
    await take('lean', s, 7);
  },
  // PRESENTS, as played: the game's chase view and HUD, the bot riding through every present it can reach
  async presents() {
    const s = await ride({ warm: 3, hud: 'gameplay', cadence: 3.4 });
    await take('presents', s, 12);
  },
  // a present grab up close: low and to the side, the gold box swept up as the bike rides through it
  async grab() {
    const s = await ride({ warm: 6, cadence: 3.4 });
    await cam(s.page, { stiff: 0.3, keys: [{ t: 0, deg: 35, dist: 4.6, h: 0.15, look: 0.2, fov: 40 }, { t: 10, deg: 55, dist: 4.4, h: 0.2, look: 0.2, fov: 40 }] });
    await take('grab', s, 10);
  },
  // GEESE!: steer at the next gaggle; they flush as the bike comes through
  async geese() {
    const s = await ride({ warm: 3, cadence: 3.3, collect: 'avoid' });
    const gs = await s.page.evaluate(() => {
      const g = window._game, at = g.bike.distanceTraveled;
      const it = (g.geeseManager._items || []).filter(i => i.state === 0 && i.absoluteD > at + 40).sort((a, b) => a.absoluteD - b.absoluteD)[0];
      return it ? { d: it.absoluteD, lat: it.lateralOffset } : null;
    });
    console.log('  gaggle', gs);
    await bots(s.page, { dodge: false, offset: gs ? gs.lat * env('GEESE_K', 0.55) : 0 });
    for (let k = 0; k < 300; k++) {
      const d = await s.page.evaluate(() => window._game.bike.distanceTraveled);
      if (!gs || d > gs.d - 26) break;
      await advance(s.page, 0.1);
    }
    await cam(s.page, { stiff: 0.3, keys: [{ t: 0, deg: 28, dist: 5.6, h: 0.6, look: 0.1, fov: 44 }, { t: 5, deg: 70, dist: 5.0, h: 0.6, look: 0.1, fov: 44 }] });
    await take('geese', s, 5);
  },
  // AGAINST EACH OTHER, as played: in step, then opposite sways + the same foot -> CRANK FIGHT!
  async fight() {
    const s = await ride({ warm: 7, hud: 'gameplay', cadence: 3.0, collect: 'avoid' });
    await s.page.addStyleTag({ content: '#crank-fight-stamp.show { animation: none !important; opacity: 1 !important; }' });
    await take('fight', s, 6, { perFrame: async (i) => {
      if (i === 90) await s.page.evaluate(() => {
        const [cap, sto] = window.__reel.bots;
        cap.sway = { amp: 0.6, freq: 0.6, phase: 0 }; sto.sway = { amp: 0.6, freq: 0.6, phase: Math.PI };
        sto.foot = cap.foot; sto.acc = cap.acc; sto.role = 'captain';
      });
    } });
  },
  // the crash: both lean the same way at once, over they go; the camera stops with them, they stay down
  // (#484: Physics FX on: the geese are thrown as rag dolls, hats fly, the tandem comes apart, slow-mo moment)
  async crash() {
    const s = await ride({ warm: 7, collect: 'avoid', storage: { tandemonium_physics_fx: 'on' } });
    const ready = await s.page.evaluate(() => !!(window._game.physicsFx && window._game.physicsFx.ready));
    if (!ready) throw new Error('Physics FX not ready (vendor/rapier.mjs?)');
    // no gold present lying in the foreground of the wreck (v1 flaw): the ones just ahead are taken off the road
    await s.page.evaluate(() => {
      const g = window._game, d = g.bike.distanceTraveled;
      for (const it of g.collectibleManager._items) if (it.absoluteD > d - 5 && it.absoluteD < d + 90) it.collected = true;
    });
    // wider than v1: the geese are thrown several metres now
    // (from the side they fall AWAY from: they cartwheel off into the frame, not into the lens)
    await cam(s.page, { keys: [{ t: 0, deg: -130, dist: 6.0, h: 1.0, look: 0.15, fov: 44 }, { t: 3, deg: -110, dist: 6.5, h: 0.9, look: 0.05, fov: 44 }] });
    await take('crash', s, 8, { perFrame: async (i, t) => {
      if (i === 60) await bots(s.page, { extra: 1, steer: 0, sway: { amp: 0, freq: 0, phase: 0 } });
      if (i === 110) await lockCam(s.page);
      if (t > 2) await holdDown(s.page);
    } });
  },
  // the approach: from behind, Grandma waving them in up the road
  async approach() {
    const s = await ride({ warm: 2, collect: 'avoid' });
    await untilGrandma(s.page, 66);
    await cam(s.page, { stiff: 0.3, keys: [{ t: 0, deg: 186, dist: 5.0, h: 0.75, look: 0.55, fov: 30 }, { t: 5, deg: 178, dist: 4.6, h: 0.7, look: 0.5, fov: 30 }] });
    await take('approach', s, 5);
  },
  // the reverse: past Grandma's shoulder as they ride up, waving
  async approach2() {
    const s = await ride({ warm: 2, collect: 'avoid' });
    await untilGrandma(s.page, 48);
    await cam(s.page, { anchor: 'grandma', anchorH: 1.7, keys: [{ t: 0, deg: 155, dist: 3.4, h: 0.45, look: -0.35, fov: 40 }, { t: 4, deg: 145, dist: 3.2, h: 0.45, look: -0.35, fov: 40 }] });
    await take('approach2', s, 4);
  },
  // over the line and the results: the presents tally
  async finish() {
    const s = await ride({ warm: 0, hud: 'gameplay', cadence: 3.5 });
    for (let k = 0; k < 60; k++) {
      const d = await s.page.evaluate(() => window._game.bike.distanceTraveled);
      if (d > 215) break;
      await advance(s.page, 1);
    }
    await take('finish', s, 14);
  },
  // the honk scene, three angles of the same take
  async honkwide() { await honkScene('honkwide', { hideHouse: true, keys: [{ t: 0, deg: 285, dist: 5.6, h: 0.5, look: 0.35, side: -0.6, fov: 34 }] }); },
  async honkg() { await honkScene('honkg', { anchor: 'grandma', anchorH: 2.5, lock: false, keys: [{ t: 0, deg: 38, dist: 0.95, h: 0.0, look: -0.02, fov: 30 }] }); },
  async honkr() { await honkScene('honkr', { hideHouse: true, keys: [{ t: 0, deg: 30, dist: 2.4, h: 0.7, look: 0.82, fov: 28 }] }); },
  // face test: Grandma's honk close-up, then the riders' startle close-up (stills every 0.1 s)
  async facetest() {
    const s = await ride({ warm: 2 });
    await untilGrandma(s.page, 30);
    await bots(s.page, { pedal: false });
    await cam(s.page, { anchor: 'grandma', anchorH: 2.5, keys: [{ t: 0, deg: 35, dist: 0.75, h: 0.0, look: -0.02, fov: 30 }] });
    await advance(s.page, 0.4);
    await s.page.evaluate(() => window.__reel.grandma().honk());
    for (let i = 0; i < 10; i++) { await still(s.page, 'face-g' + i); await advance(s.page, 0.1); }
    await cam(s.page, { keys: [{ t: 0, deg: 35, dist: 1.6, h: 0.75, look: 0.8, fov: 30 }] });
    await advance(s.page, 0.3);
    await s.page.evaluate(() => window.__reel.startle());
    for (let i = 0; i < 12; i++) { await still(s.page, 'face-r' + i); await advance(s.page, 0.1); }
    await s.page.evaluate(() => window.__reel.honk('Captain'));
    for (let i = 0; i < 6; i++) { await still(s.page, 'face-c' + i); await advance(s.page, 0.1); }
    if (s.errors.length) console.log('  page errors:', s.errors.slice(0, 5));
    await s.close();
  },
  // positions + stills: where Grandma stands, how she reads, a honk and a startle frame
  async probe() {
    const s = await ride({ warm: 2 });
    console.log('  start', await probe(s.page));
    console.log('  near', await untilGrandma(s.page, 30));
    await bots(s.page, { pedal: false });
    await cam(s.page, { anchor: 'grandma', anchorH: 1.6, keys: [{ t: 0, deg: 20, dist: 3.2, h: 0.2, look: 0, fov: 30 }] });
    await advance(s.page, 0.5);
    await still(s.page, 'probe-grandma');
    await s.page.evaluate(() => window.__reel.grandma().honk());
    await advance(s.page, 0.45);
    await still(s.page, 'probe-grandma-honk');
    await cam(s.page, { keys: [{ t: 0, deg: 25, dist: 2.4, h: 0.3, look: 0.35, fov: 32 }] });
    await advance(s.page, 0.3);
    await still(s.page, 'probe-riders');
    await s.page.evaluate(() => window.__reel.startle());
    await advance(s.page, 0.3);
    await still(s.page, 'probe-riders-startle');
    await s.page.evaluate(() => window.__reel.honk('Captain'));
    await advance(s.page, 0.5);
    await still(s.page, 'probe-captain-honk');
    console.log('  end', await probe(s.page));
    if (s.errors.length) console.log('  page errors:', s.errors.slice(0, 5));
    await s.close();
  },
};

const want = process.argv.slice(2);
for (const [name, fn] of Object.entries(SHOTS)) {
  if (want.length ? !want.includes(name) : ['probe', 'facetest'].includes(name)) continue;
  console.log('== shot', name);
  try { await fn(); } catch (e) { console.log('  FAILED', name, e.message); try { await LAST.close(); } catch {} }
}
process.exit(0);
