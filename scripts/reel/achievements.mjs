#!/usr/bin/env node
// achievements.mjs — one short reel per achievement (tandemonium-trailers/achievement-reels).
// Every reel is a brand-new browser profile riding solo with the bot, and records the real moment the game
// awards the achievement and shows its own toast. Everything the same moment would ALSO award (a tutorial
// finish earns four at once) is marked earned beforehand, so each reel shows only its own toast.
//   node scripts/reel/achievements.mjs kickoff,learner,natural,madeit,goosedown --aspect 9x16|16x9
//   node scripts/reel/achievements.mjs probe_tutorial|probe_geese|probe_audio
// Out: renders/reel/clips/ach-<shot>-<aspect>.mp4 (silent), renders/reel/ach/<shot>-<aspect>.wav (the game's own
// sound effects for that footage, rendered offline from the logged audio calls) and .json (toast times).
import fs from 'node:fs';
import path from 'node:path';
import { launch, record, encode, advance, sleep, ROOT, OUT } from './lib.mjs';

const PORT = 8951;   // beside attraction.mjs (8941) and the other reel scripts
const ASPECT = process.argv.includes('--aspect') ? process.argv[process.argv.indexOf('--aspect') + 1] : '16x9';
const TALL = ASPECT === '9x16';
// 9:16 is a phone-sized page (540x960 CSS px) at 2x, so the HUD, toast and result sheets read at phone size
const VIEW = TALL ? { width: 540, height: 960, scale: 2 } : { width: 1920, height: 1080 };
const BASE = { tandemonium_show_riders: 'on' };
const SALT = Number(process.env.SALT || 424242);
const AOUT = path.join(OUT, 'ach');
fs.mkdirSync(AOUT, { recursive: true });

// every achievement id, in definition order
const DEFS = fs.readFileSync(path.join(ROOT, 'js/achievement-defs.js'), 'utf8');
const IDS = [...DEFS.matchAll(/\{ id: '([a-z0-9_]+)',\s*section:/g)].map(m => m[1]);
/** localStorage that marks every achievement but `keep` earned (each reel toasts only its own). */
const others = (keep) => ({ tandemonium_achievements: JSON.stringify(IDS.filter(i => i !== keep).map(id => ({ id, earnedAt: 1 }))) });

// The toast's slide-in is a CSS transition on wall-clock time (a blink under the virtual clock): show it settled,
// and larger so it reads on a phone (it is the game's own <uf-achievement> badge). Over the tutorial-complete
// sheet it sits on top. The Steam widget is an iframe the capture can't load: hidden.
const TOAST_CSS = `
  #achievement-toast-container { zoom: ${TALL ? 1.6 : 2.0}; top: ${TALL ? '18%' : '11%'} !important; z-index: 9999 !important; }
  .achievement-toast { transition: none !important; }
  .achievement-toast.show { opacity: 1 !important; transform: none !important; }
  /* the badge's own "new" fill mixes into a near-transparent surface-3; back it with the panel colour the
     end-screen rule intends (css/end-screens.css), so it reads over the road */
  .achievement-toast uf-achievement { background: color-mix(in srgb, #ffcc00 14%, #1a1a2e) !important; }
  #steam-cta { display: none !important; }
  /* on the finish sheet the game lists it under "unlocked this ride": the same badge, at a readable size */
  #victory-unlocked uf-achievement { zoom: 1.35; background: color-mix(in srgb, #ffcc00 14%, #1a1a2e) !important; }
  body:has(#tutorial-complete.visible) #achievement-toast-container { top: ${TALL ? '7%' : '4.5%'} !important; }
`;

const state = (page) => page.evaluate(() => {
  const g = window._game, b = g.bike;
  return { state: g.state, tut: !!g._tutorialActive, tp: g._tutTargetPhase, speed: +(b.speed || 0).toFixed(2),
    d: +(b.distanceTraveled || 0).toFixed(1), x: +(b._lateralOffset || 0).toFixed(2), fallen: !!b.fallen,
    earned: [...(g.achievements?._earned?.keys?.() || [])].filter(i => !window.__achPre.includes(i)) };
});

/** Fresh player, solo. tutorial: true = the first-ride tutorial (as a new player gets), else `level`. */
async function solo({ keep, tutorial = false, level = 'grandma', difficulty = 'chill', cadence = 3.0,
  sway = { amp: 0.25, freq: 0.3, phase: 0 }, collect = true, storage = {} } = {}) {
  const st = { ...BASE, ...others(keep), ...storage };
  if (tutorial) st.tandemonium_tutorial_done = null;
  const s = await launch({ ...VIEW, port: PORT, storage: st });
  const { page } = s;
  await page.evaluate((pre) => { window.__achPre = pre; }, IDS.filter(i => i !== keep));
  await page.click('#tap-to-start').catch(() => {});
  await sleep(600);
  await page.addStyleTag({ content: TOAST_CSS });
  await installLogs(page);
  await page.evaluate(async (o) => {
    const g = window._game, R = window.__reel, L = g.lobby;
    const { getLevelById } = await import('/js/race-config.js');
    if (o.tutorial) L._forceWizard = true;
    else {
      L.selectedLevel = L.resolveRoadLevel ? L.resolveRoadLevel(getLevelById(o.level)) : getLevelById(o.level);
      L.selectedDifficulty = o.difficulty;
    }
    L._hideLobby();
    g._onSolo();
    R.attach(g.input, () => g.bike, { role: 'captain', sway: o.sway, cadence: o.cadence, pedal: true, collect: o.collect });
  }, { tutorial, level, difficulty, cadence, sway, collect });
  await sleep(400);
  // the ride's placement salt (presents, pylons, geese) is Date.now() % 1e6 at the start: pin it, so every take
  // of a shot rides the same road
  await page.evaluate((salt) => {
    const real = Date.now;
    Date.now = () => Math.floor(real() / 1e6) * 1e6 + salt;
    document.getElementById('instructions')?.click();
    Date.now = real;
  }, SALT);
  await page.waitForFunction(() => window._game.bike.modelLoaded && window._game.bike.goose, { timeout: 120000 });
  await sleep(500);
  await page.evaluate(() => window.__reel.gameplayHud());
  return s;
}

/**
 * In the page: log every top-level AudioEngine call and every achievement badge that appears, stamped with the
 * virtual clock (relative to __ach.t0, set when recording starts). The calls are replayed offline afterwards.
 */
async function installLogs(page) {
  await page.evaluate(() => {
    const g = window._game, eng = g.audioEngine, A = window.__ach = { t0: null, calls: [], toasts: [], pre: [] };
    const now = () => (A.t0 == null ? null : (window.__vclock.t - A.t0) / 1000);   // seconds
    let depth = 0;
    const SKIP_LOG = new Set(['honkBurst']);   // its honks come later from setTimeout and are logged one by one
    for (const m of ['tone', 'toneSlide', 'chime', 'gooseHonk', 'honkBurst', 'pedalTap', 'crash', 'startBike', 'stopBike',
      'updateBike', 'setCobbles']) {
      const orig = eng[m].bind(eng);
      eng[m] = (...args) => {
        const t = now();
        if (depth === 0 && t != null && !SKIP_LOG.has(m)) A.calls.push([t, m, JSON.parse(JSON.stringify(args))]);
        // the bike's running sound started before the take: replay its set-up at the take's first instant
        if (depth === 0 && t == null && ['startBike', 'stopBike', 'setCobbles'].includes(m)) A.pre.push([0, m, JSON.parse(JSON.stringify(args))]);
        depth++;
        try { return orig(...args); } finally { depth--; }
      };
    }
    new MutationObserver((muts) => {
      for (const mu of muts) for (const n of mu.addedNodes) {
        const b = n.nodeName === 'UF-ACHIEVEMENT' ? n : (n.querySelector && n.querySelector('uf-achievement'));
        if (b) A.toasts.push([now(), b.name || b.getAttribute('name') || '']);
        // on the finish sheet it joins a scrolled list: bring it into view, as a player would scroll to it
        if (b && b.closest('#victory-unlocked, #gameover-unlocked')) setTimeout(() => b.scrollIntoView({ block: 'end' }), 0);
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * Replay the logged calls into an OfflineAudioContext through a second AudioEngine (same code, same buses,
 * the real goose recording), suspending at each call's time. Returns a 48 kHz stereo 16-bit WAV.
 */
async function renderAudio(page, seconds) {
  const b64 = await page.evaluate(async (dur) => {
    const A = window.__ach, AE = window._game.audioEngine.constructor, sr = 48000;
    const off = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
    const Real = window.AudioContext;
    window.AudioContext = function () { return off; };
    const e = new AE();
    e.ensureContext();
    window.AudioContext = Real;
    e.resume = () => {};                                  // the offline render must not be resumed by a sound
    await e.loadGooseSample('assets/goose-honk.mp3');
    const q = 128 / sr, groups = new Map();
    for (const [t, m, args] of [...A.pre, ...A.calls]) {
      if (t < 0 || t >= dur - 0.01) continue;
      const k = Math.max(1, Math.round(t / q));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push([m, args]);
    }
    for (const [k, list] of groups) {
      off.suspend(k * q).then(() => {
        for (const [m, args] of list) { try { e[m](...args); } catch (err) { console.log('[reel] replay ' + m + ' ' + err.message); } }
        off.resume();
      });
    }
    const buf = await off.startRendering();
    const n = buf.length, L = buf.getChannelData(0), R = buf.getChannelData(1);
    const wav = new DataView(new ArrayBuffer(44 + n * 4));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) wav.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); wav.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true); wav.setUint16(22, 2, true); wav.setUint32(24, sr, true); wav.setUint32(28, sr * 4, true);
    wav.setUint16(32, 4, true); wav.setUint16(34, 16, true); w(36, 'data'); wav.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) {
      wav.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
      wav.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
    }
    const bytes = new Uint8Array(wav.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, seconds);
  return Buffer.from(b64, 'base64');
}

const cam = (page, shot) => page.evaluate((s) => window.__reel.setCamera(s), shot);
const bots = (page, patch) => page.evaluate((p) => { for (const b of window.__reel.bots) Object.assign(b, p); }, patch);

/** Record `seconds` (perFrame optional), then write the clip, the game-audio WAV and the toast times. */
async function take(name, s, seconds, perFrame = null) {
  const tag = `ach-${name}-${ASPECT}`;
  await record(s.page, tag, seconds, { perFrame: async (i, t) => {
    if (i === 0) await s.page.evaluate(() => { window.__ach.t0 = window.__vclock.t; });
    if (perFrame) await perFrame(i, t);
  } });
  const clip = await encode(tag);
  const wav = await renderAudio(s.page, seconds);
  fs.writeFileSync(path.join(AOUT, `${name}-${ASPECT}.wav`), wav);
  const log = await s.page.evaluate(() => ({ toasts: window.__ach.toasts, calls: window.__ach.calls.length,
    kinds: [...new Set(window.__ach.calls.map(c => c[1]))],
    events: window.__ach.calls.filter(c => !["updateBike", "pedalTap"].includes(c[1])).map(c => [+c[0].toFixed(3), c[1]]) }));
  fs.writeFileSync(path.join(AOUT, `${name}-${ASPECT}.json`), JSON.stringify({ seconds, ...log }));
  console.log('  ->', clip, JSON.stringify(log.toasts[0] || null), log.calls + ' calls', JSON.stringify(log.events.slice(0, 30)));
  if (s.errors.length) console.log('  page errors:', s.errors.slice(0, 3));
  await s.close();
}

/** Step virtual time (no capture) until pred(state) or `max` seconds. */
async function until(page, pred, max = 300, step = 0.25) {
  for (let t = 0; t < max; t += step) {
    const st = await state(page);
    if (pred(st)) return st;
    await advance(page, step);
  }
  return state(page);
}

// the tutorial's line (game.js TUTORIAL_ITEMS): phase 1 presents ±1.0; phase 2 presents ±1.8 with pylons between
// that must be passed on the far side. Targets lead the items by a few metres (the bike follows with a lag).
const TUT_PATH = [[0, 0], [28, 0], [32, 1.0], [52, 1.0], [58, -1.0], [79, -1.0], [88, 0.4], [96, 1.8], [104, 1.8],
  [109, 1.2], [114, 0], [118, -1.8], [121, -1.8], [124, -0.6], [127, 1.2], [130, 2.2], [137, 2.0], [146, 0.8]];
const STILL = { amp: 0, freq: 0, phase: 0 };

async function watchTutorial(page) {
  await page.evaluate(() => {
    const g = window._game, orig = g._tutorialPhaseRetry.bind(g);
    g._tutorialPhaseRetry = (tp, hint) => { console.log('[reel] RETRY phase ' + tp + ': ' + hint + ' d=' + g.bike.distanceTraveled.toFixed(1)); return orig(tp, hint); };
  });
}

async function tutorial(keep) {
  const s = await solo({ keep, tutorial: true, cadence: 2.6, sway: STILL });
  await watchTutorial(s.page);
  await bots(s.page, { path: TUT_PATH });
  return s;
}

const SHOTS = {
  // #1 KICK OFF: a new player's very first ride; the countdown, GO, the first push on the pedals
  async kickoff() {
    const s = await tutorial('first_pedal');
    await cam(s.page, { keys: [{ t: 0, deg: 35, dist: 4.4, h: 0.15, look: 0.65, fov: TALL ? 46 : 34 },
      { t: 8, deg: 18, dist: 5.2, h: 0.3, look: 0.6, fov: TALL ? 46 : 34 }] });
    await take('kickoff', s, 8);
  },
  // #2 LEARNER'S PERMIT: the tutorial's last weave (present, pylon, present) and over the line
  async learner() {
    const s = await tutorial('tutorial_done');
    await until(s.page, st => st.d >= 117);
    await take('learner', s, 6.5);
  },
  // #3 NATURAL: the same finale without a single retry, seen from beside the riders
  async natural() {
    const s = await tutorial('tutorial_clean');
    await until(s.page, st => st.d >= 112);
    await cam(s.page, { stiff: 0.3, keys: [{ t: 0, deg: 60, dist: 4.2, h: 0.4, look: 0.3, fov: TALL ? 50 : 36 },
      { t: 5, deg: 75, dist: 3.8, h: 0.3, look: 0.3, fov: TALL ? 50 : 36 }] });
    await take('natural', s, 7);
  },
  // #4 MADE IT: the first real level, Grandma's: the last stretch, Grandma waving at her gate, over the line
  async madeit() {
    const s = await solo({ keep: 'first_finish', level: 'grandma', difficulty: 'chill', cadence: 3.8 });
    console.log('  at', JSON.stringify(await until(s.page, st => st.d >= 212, 120, 0.5)));
    await take('madeit', s, 13.5);
  },
  // #5 GOOSE DOWN: head-on into a pylon (#478's 3D cone, a real collision): the cone flies, the tandem comes apart,
  // both geese are thrown with their hats in the crash's slow-mo moment (#484), and the toast lands
  async goosedown() {
    const s = await solo({ keep: 'first_crash', level: 'grandma', difficulty: 'adventurous', sway: STILL, cadence: 3.8,
      storage: { tandemonium_physics_fx: 'on' } });
    const { page } = s;
    // Rapier is fetched during the countdown (vendor/rapier.mjs: the capture blocks the CDN)
    await until(page, st => st.state === 'playing' && st.d > 40 && st.speed > 6, 120, 0.5);
    const ready = await page.evaluate(() => !!(window._game.physicsFx && window._game.physicsFx.ready));
    if (!ready) throw new Error('Physics FX not ready: is vendor/rapier.mjs there?');
    const d0 = (await state(page)).d;
    const p = await page.evaluate((d) => {
      const items = (window._game.obstacleManager._items || []).filter(i => i.absoluteD > d + 30 && !i._hidden)
        .sort((x, y) => x.absoluteD - y.absoluteD);
      return items[0] ? { d: items[0].absoluteD, x: items[0].lateralOffset } : null;
    }, d0);
    if (!p) throw new Error('no pylon ahead');
    console.log('  pylon at', JSON.stringify(p), 'from d', d0);
    await bots(page, { dodge: false, offset: p.x, path: null });
    await until(page, st => st.d > p.d - 30 || st.fallen, 60, 1 / 30);
    // front-side and low: the cone in frame before the hit; the captain crosses the frame over the bars
    await cam(page, { stiff: 0.3, keys: [{ t: 0, deg: TALL ? 40 : 58, dist: TALL ? 13 : 9, h: TALL ? 1.1 : 0.6, look: -0.3, fov: TALL ? 56 : 50 }] });
    let locked = false;
    await take('goosedown', s, 7.5, async (i, t) => {
      const st = await page.evaluate(() => {
        for (const mk of (window._game.world && window._game.world._raceMarkers) || [])
          if (mk.type === 'checkpoint') { mk._permanentlyHidden = true; mk.mesh.visible = false; }
        const b = window._game.bike;
        return { d: b.distanceTraveled, fallen: b.fallen, scene: !!b.crashScene, parts: b.crashScene ? b.crashScene.parts.length : 0 };
      });
      if (i % 15 === 0) console.log('   ', t.toFixed(2), JSON.stringify(st));
      if (st.fallen && !locked) {
        locked = true;   // hold the crash site: the rig would follow the seats into the dirt
        await page.evaluate(() => {
          const R = window.__reel, cs = R.camState;
          if (cs && cs.ctr) { const ctr = cs.ctr.clone().addScaledVector(cs.fwd, 4.5), fwd = cs.fwd.clone(); R._bikeFrame = () => ({ ctr: ctr.clone(), fwd: fwd.clone() }); }
        });
      }
      // stays down for the toast and the end card (simulated seconds: past the slow-mo, the parts settle)
      if (st.fallen) await page.evaluate(() => { const b = window._game.bike; if (b.fallTimer < 50) b.fallTimer = 99; });
    });
  },
};

SHOTS.probe_geese = async () => {
  const s = await solo({ keep: 'first_crash' });
  await advance(s.page, 5);
  console.log(JSON.stringify(await s.page.evaluate(() => {
    const g = window._game;
    return { len: g.lobby.selectedLevel.distance, geese: g.geeseManager._items.slice(0, 30).map(i => [+i.absoluteD.toFixed(1), +i.lateralOffset.toFixed(2)]),
      obstacles: (g.obstacleManager._items || []).slice(0, 12).map(i => [+i.absoluteD.toFixed(1), +i.lateralOffset.toFixed(2)]) };
  })));
  console.log('salt', await s.page.evaluate(() => window._game._placementSalt));
  await s.close();
};

SHOTS.probe_tutorial = async () => {
  const s = await tutorial('tutorial_clean');
  for (let k = 0; k < 40; k++) {
    await advance(s.page, 1);
    const p = await state(s.page);
    console.log(' ', k + 1, JSON.stringify(p));
    if (p.state === 'gameover') break;
  }
  await s.close();
};

const want = (process.argv[2] || '').split(',').filter(Boolean);
for (const k of want) {
  if (!SHOTS[k]) { console.log('no shot', k); continue; }
  console.log('== shot', k, ASPECT);
  try { await SHOTS[k](); } catch (e) { console.log('  FAILED', k, e.stack); }
}
process.exit(0);
