#!/usr/bin/env node
// achievements.mjs — one short reel per achievement (tandemonium-trailers/achievement-reels).
// Every reel is a brand-new browser profile riding solo with the bot, and records the real moment the game
// awards the achievement and shows its own toast. Everything the same moment would ALSO award (a tutorial
// finish earns four at once) is marked earned beforehand, so each reel shows only its own toast.
//   node scripts/reel/achievements.mjs kickoff,learner,natural,madeit,goosedown --aspect 9x16|16x9     SOLO RIDE
//   node scripts/reel/achievements.mjs kickoff_together,learner_together,... --aspect 9x16|16x9     RIDE TOGETHER
//   node scripts/reel/achievements.mjs kickoff_lead,learner_lead,... --aspect 9x16|16x9             #506 lead-ins
//   node scripts/reel/achievements.mjs nothumbs|nothumbs_solo --aspect 9x16|16x9                   #101 (gyro rig, NT_* env)
//   node scripts/reel/achievements.mjs probe_tutorial|probe_geese|probe_gyro|probe_tiles|probe_choreo|probe_tut_together
// Env: SALT (the ride's placement salt, default 424242), MI_DEG (Made It side camera), NT_* (Look, No Thumbs).
// The full recipe per reel: tandemonium-trailers/achievement-reels/README.md "Repeat a reel".
// Out: renders/reel/clips/ach-<shot>-<aspect>.mp4 (silent), renders/reel/ach/<shot>-<aspect>.wav (the game's own
// sound effects for that footage, rendered offline from the logged audio calls) and .json (toast times).
import fs from 'node:fs';
import path from 'node:path';
import { launch, record, encode, advance, sleep, ROOT, OUT } from './lib.mjs';
import { installFakeWebHid, hidDevice, FACE_A } from '../lib/fake-webhid.mjs';

const PORT = Number(process.env.REEL_PORT || 8951);   // beside attraction.mjs (8941) and the other reel scripts

/** Seed Math.random in the page before any game script: with the salt pinned, two runs ride the same ride. */
const seedRandom = (p) => p.evaluateOnNewDocument(() => {
  let a = 0x9E3779B9;
  Math.random = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
});
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
  const st = { ...BASE, tandemonium_show_solo: 'on', ...others(keep), ...storage };   // SOLO RIDE: one goose
  if (tutorial) st.tandemonium_tutorial_done = null;
  const s = await launch({ ...VIEW, port: PORT, storage: st, before: seedRandom });
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
      if (typeof eng[m] !== 'function') continue;   // the bike loop (startBike/updateBike/...) is gone (#502)
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
      if (m === 'pedalTap') continue;   // Pete: no pedal sounds in the reels
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
    // the take's clock starts here: the sounds logged before it (the countdown, the first strokes, the versus
    // "fight" clatter) would otherwise replay inside the take at their old times; a running bike keeps its hum
    if (i === 0) await s.page.evaluate(() => { const A = window.__ach; A.t0 = window.__vclock.t;
      A.calls = A.calls.some(c => c[1] === 'startBike') && !A.calls.some(c => c[1] === 'stopBike' && c[0] > A.calls.findLast(x => x[1] === 'startBike')[0]) ? [[0, 'startBike', A.calls.findLast(c => c[1] === 'startBike')[2]]] : [];
      A.toasts = []; });
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
  await s.page.evaluate(() => { for (const b of window.__reel.bots) b.human = 0.35; });
  await watchTutorial(s.page);
  await bots(s.page, { path: TUT_PATH });
  return s;
}

/**
 * #506 · the lead-in: the game's own achievements screen (the lobby's "Your Rides" tab), the achievement still
 * locked; a settle, an eased scroll to it, a soft highlight, then the badge lifts off the page toward the camera
 * (the list behind dims and blurs) and fills the screen. The real DOM, driven frame by frame on the virtual
 * clock (no CSS transitions). edit.py dissolves it into the ride.
 * Out: clips/ach-lead-<shot>-<aspect>.mp4 (silent) + ach/lead-<shot>-<aspect>.json (seconds, when the lift ends).
 */
const LEAD = { hold: 0.3, scroll: 0.7, glow: 0.35, lift: 0.8, tail: 0.5 };   // seconds; the scroll is skipped when it would be short
async function leadIn(shot, id) {
  const s = await launch({ ...VIEW, port: PORT, storage: { ...BASE } });   // a fresh player: everything locked
  const { page } = s;
  await page.click('#tap-to-start').catch(() => {});
  await sleep(600);
  await page.addStyleTag({ content: `
    #leaderboard-video, #lb-sub-tabs { display: none !important; }
    #leaderboard-modal { z-index: 9000; }
    .leaderboard-box { max-height: 80vh !important; transition: none !important; }
    .lb-ach-item { transition: none !important; }
    .lb-ach-item.lead-glow { opacity: 1 !important; border-color: rgba(255, 204, 0, var(--glow, 0)) !important;
      box-shadow: 0 0 calc(18px * var(--glow, 0)) rgba(255, 204, 0, calc(0.55 * var(--glow, 0))) !important;
      background: rgba(255, 204, 0, calc(0.10 * var(--glow, 0))) !important; }
    #lead-lift { position: fixed; z-index: 9999; pointer-events: none; transform-origin: 50% 50%; opacity: 1 !important;
      border-radius: 10px; background: rgba(34, 32, 48, 0.98) !important; border: 1.5px solid rgba(255, 204, 0, 0.9) !important;
      box-shadow: 0 0 30px rgba(255, 204, 0, 0.45), 0 30px 60px rgba(0, 0, 0, 0.6) !important; }
    #lead-lift .lb-ach-name { color: rgba(255, 255, 255, 0.92) !important; }
  ` });
  const info = await page.evaluate(async (id) => {
    const L = window._game.lobby;
    L._lbMainTab = 'you';
    await L._openLeaderboard();
    L._renderAchievements();
    const item = document.querySelector(`.lb-ach-item[data-ach="${id}"]`);
    if (!item) return null;
    const box = document.querySelector('.leaderboard-box');
    // where the tile would be centred in the scrolling box
    const r0 = item.getBoundingClientRect(), b0 = box.getBoundingClientRect();
    const target = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, box.scrollTop + (r0.top + r0.height / 2) - (b0.top + b0.height / 2)));
    window.__lead = { item, box, from: box.scrollTop, to: target };
    return { from: box.scrollTop, to: target, locked: item.classList.contains('locked'), name: item.querySelector('.lb-ach-name')?.textContent };
  }, id);
  if (!info) { console.log('  no tile for', id); await s.close(); return; }
  const scrollSec = Math.abs(info.to - info.from) < 40 ? 0 : LEAD.scroll;
  const T = { glowAt: LEAD.hold + scrollSec, liftAt: LEAD.hold + scrollSec + LEAD.glow };
  const seconds = T.liftAt + LEAD.lift + LEAD.tail;
  console.log(`  lead-in ${shot}: ${info.name} locked=${info.locked} scroll ${info.from.toFixed(0)}->${info.to.toFixed(0)} (${scrollSec} s), ${seconds.toFixed(2)} s`);
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  // the real icon and name, for the reveal of a hidden achievement's "?" tile (from the game's definitions)
  const def = DEFS.match(new RegExp(`\\{ id: '${id}',[^\\n]*?name: '((?:[^'\\\\]|\\\\.)*)',\\s*icon: '([^']*)'`));
  const reveal = def ? { name: def[1].replace(/\\'/g, "'"), icon: def[2] } : { name: info.name, icon: '?' };
  const tag = `ach-lead-${shot}-${ASPECT}`;
  await record(page, tag, seconds, { perFrame: async (i, t) => {
    const u = scrollSec ? Math.max(0, Math.min(1, (t - LEAD.hold) / scrollSec)) : 1;
    const glow = Math.max(0, Math.min(1, (t - T.glowAt) / LEAD.glow));
    const lift = Math.max(0, Math.min(1, (t - T.liftAt) / LEAD.lift));
    await page.evaluate((o) => {
      const D = window.__lead, E = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);   // ease in-out cubic
      D.box.scrollTop = D.from + (D.to - D.from) * E(o.u);
      D.item.classList.add('lead-glow');
      D.item.style.setProperty('--glow', String(o.glow));
      if (o.lift > 0) {
        if (!D.clone) {
          const r = D.item.getBoundingClientRect();
          const c = D.item.cloneNode(true);
          c.id = 'lead-lift';
          c.classList.add('lead-glow');
          c.style.setProperty('--glow', '1');
          c.style.left = r.left + 'px'; c.style.top = r.top + 'px'; c.style.width = r.width + 'px'; c.style.height = r.height + 'px';
          c.style.boxSizing = 'border-box';
          document.body.appendChild(c);
          D.clone = c; D.rect = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
          D.item.style.visibility = 'hidden';
        }
        const k = E(o.lift), W = window.innerWidth, H = window.innerHeight;
        // a hidden achievement (the Chaos set) sits in the list as a "?" / "???" tile: as it lifts, the real badge is
        // revealed (a dip to black on the icon and name, then the achievement's own icon and name)
        if (!D.revealed && D.clone.querySelector('.lb-ach-name')?.textContent.trim() === '???') {
          const ic = D.clone.querySelector('.lb-ach-icon'), nm = D.clone.querySelector('.lb-ach-name');
          const dip = k < 0.35 ? 0 : Math.min(1, (k - 0.35) / 0.3);   // 0.35..0.65 of the lift
          ic.style.opacity = nm.style.opacity = String(dip < 0.5 ? 1 - dip * 2 : (dip - 0.5) * 2);
          if (dip >= 0.5 && !D.swapped) { D.swapped = true; ic.textContent = o.reveal.icon; nm.textContent = o.reveal.name; }
          if (dip >= 1) D.revealed = true;
        }
        const S = 1 + (Math.min(0.82 * W / D.rect.w, 0.6 * H / D.rect.h) - 1) * k;
        const dx = (W / 2 - D.rect.x) * k, dy = (H / 2 - D.rect.y) * k;
        D.clone.style.transform = `translate(${dx}px, ${dy}px) scale(${S})`;
        D.box.style.filter = `blur(${(8 * k).toFixed(2)}px) brightness(${(1 - 0.6 * k).toFixed(3)})`;
        document.getElementById('leaderboard-modal').style.background = `rgba(0, 0, 0, ${(0.65 * k).toFixed(3)})`;
      }
    }, { u, glow, lift, reveal });
  } });
  const clip = await encode(tag);
  fs.writeFileSync(path.join(AOUT, `lead-${shot}-${ASPECT}.json`), JSON.stringify({ seconds, liftEnd: T.liftAt + LEAD.lift, ...info }));
  console.log('  ->', clip);
  if (s.errors.length) console.log('  page errors:', s.errors.slice(0, 3));
  await s.close();
}

const SHOTS = {
  kickoff_lead: () => leadIn('kickoff', 'first_pedal'),
  learner_lead: () => leadIn('learner', 'tutorial_done'),
  natural_lead: () => leadIn('natural', 'tutorial_clean'),
  madeit_lead: () => leadIn('madeit', 'first_finish'),
  goosedown_lead: () => leadIn('goosedown', 'first_crash'),
  nothumbs_lead: () => leadIn('nothumbs', 'look_no_thumbs'),
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
    // a low three-quarter side view: legs and cranks turning all the way to the line (Pete: show the pedalling)
    await cam(s.page, { stiff: 0.3, keys: [{ t: 0, deg: Number(process.env.MI_DEG || -62), dist: TALL ? 4.6 : 5.2, h: 0.35, look: 0.45, fov: TALL ? 48 : 36 }] });
    await take('madeit', s, 13.5, async () => { await s.page.evaluate(() => { if (window._game.state !== 'playing' && window.__reel.cam) window.__reel.setCamera(null); }); });
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

// The controller tiles, big enough to read in the reel (capture-only).
const GYRO_CSS = `
  .cohud-tile { transition: none !important; }
  .front-view-frame, #partner-pip-wrap { display: none !important; }
  /* the line flashes CHECKPOINT with its arch out of this camera's view: hide the flash in this reel */
  #checkpoint-flash { display: none !important; }
`;

// ── #500 LOOK, NO THUMBS: local co-op, P1 on a DualSense, P2 on a Steam Controller (2026), both steering by gyro ──
// Both pads are simulated at the HID level (scripts/lib/fake-webhid.mjs) and run through the real drivers, the
// ControllerManager, the sensor fusion and the in-game controller overlay. Each frame the rider bot's wanted lean
// becomes a controller ROLL: gravity turned in the report's accelerometer + the matching gyro rate, closed-loop on
// what the game reads back (InputManager.getMotionLean), so the steering is the game's own gyro path end to end.
// Pedalling pulls the real triggers in the reports. No stick, D-pad or keyboard lean, ever.
async function gyroCoop(o = {}) {
  const st0 = { ...BASE, ...others(o.keep || 'look_no_thumbs'), tandemonium_controller_overlay: o.overlay === false ? 'off' : 'on', ...(o.solo ? { tandemonium_show_solo: 'on' } : {}), ...(o.storage || {}) };
  const s = await launch({ ...VIEW, port: PORT, storage: st0, query: o.query || '',
    before: async (p) => { await seedRandom(p); await installFakeWebHid(p, o.solo ? [hidDevice.dualsenseUsb('ds')] : [hidDevice.dualsenseUsb('ds'), hidDevice.steamPuck('sc')]); } });
  try { return await gyroCoopOn(s, o); } catch (e) { await s.close().catch(() => {}); throw e; }
}
async function gyroCoopOn(s, { keep = 'look_no_thumbs', level = 'grandma', difficulty = 'chill', storage = {}, sign = [1, 1], solo = false, overlay = true, steer = 'gyro', cadence = 2.8, human = 1, prep = null, start = 'ride', salt = SALT } = {}) {
  const { page } = s;
  await page.evaluate((pre) => { window.__achPre = pre; }, IDS.filter(i => i !== keep));
  // the live report writer: IMU (roll about the pad's forward axis) + analog triggers, per device
  await page.evaluate(() => {
    const W = (u8, o, v) => { const x = Math.round(Math.max(-32768, Math.min(32767, v))) & 0xffff; u8[o] = x & 0xff; u8[o + 1] = x >> 8; };
    const G = window.__gy = { ds: { roll: 0, rate: 0, l: 0, r: 0, n: 0 }, sc: { roll: 0, rate: 0, l: 0, r: 0, n: 0 } };
    const DPS = 32768 / 2000;   // raw per deg/s (both drivers: +-2000 dps)
    window.__fakeHidMutate = {
      ds(u8, id) {            // DualSense USB report 0x01: gyro x,y,z @15, accel x,y,z @21 (frame: gravity on +Y, roll about Z)
        if (id !== 0x01) return;
        const g = G.ds, k = 8192, nz = (g.n++ % 3) - 1;
        W(u8, 15, nz); W(u8, 17, -nz); W(u8, 19, g.rate * DPS);
        W(u8, 21, k * Math.sin(g.roll)); W(u8, 23, k * Math.cos(g.roll)); W(u8, 25, nz * 20);
        u8[4] = Math.round(g.l * 255); u8[5] = Math.round(g.r * 255);
        u8[8] = (u8[8] & ~0x0c) | (g.l > 0.5 ? 0x04 : 0) | (g.r > 0.5 ? 0x08 : 0);
      },
      sc(u8, id) {            // Steam STATE 0x45: accel raw x@33, y@35, z@37; gyro raw x@39, y@41, z@43; frame = (x, z, -y)
        if (id !== 0x45 && id !== 0x42) return;
        const g = G.sc, k = 16384, nz = (g.n++ % 3) - 1;
        W(u8, 33, k * Math.sin(g.roll)); W(u8, 37, k * Math.cos(g.roll)); W(u8, 35, nz * 20);
        W(u8, 39, nz); W(u8, 43, -nz); W(u8, 41, -g.rate * DPS);
        W(u8, 5, g.l * 0x7fff); W(u8, 7, g.r * 0x7fff);
      },
    };
  });
  await page.click('#tap-to-start').catch(() => {});
  await sleep(1500);
  await page.addStyleTag({ content: TOAST_CSS + GYRO_CSS });
  await installLogs(page);
  // local co-op host step (no relay needed for a local ride), then each pad joins by pressing its A / cross
  if (!solo) await page.evaluate(() => {
    const l = window._game.lobby;
    document.getElementById('room-code-display').textContent = 'TNDM-LOCL';
    l._pendingMode = 'multiplayer'; l._roomRole = 'captain';
    l._showStep(l.hostStep); l._refreshHostNext();
  });
  const seat = async (key, bit, pred, what) => {
    for (let t0 = Date.now(); Date.now() - t0 < 45000;) {
      await page.evaluate((k, o, m) => window.__fakeHid.hold(k, o, m, true), key, bit.offset, bit.mask);
      await sleep(300);
      await page.evaluate((k, o, m) => window.__fakeHid.hold(k, o, m, false), key, bit.offset, bit.mask);
      await sleep(500);
      if (await page.evaluate(pred)) return;
    }
    console.log('  seat debug', JSON.stringify(await page.evaluate(() => { const m = window.__controllerManager, l = window._game.lobby; return { P1: [m.getSlot('P1').state, m.getSlot('P1').hidDevice?.__fakeKey], P2: [m.getSlot('P2').state, m.getSlot('P2').hidDevice?.__fakeKey], seated: !!l._localSeatedOnHost, step: document.getElementById('lobby-flow')?.current, mobile: !!window._game.isMobile }; })));
    throw new Error('could not seat ' + what);
  };
  await seat('ds', FACE_A.ds5Usb, () => window.__controllerManager.getSlot('P1').hidDevice?.__fakeKey === 'ds', 'P1 DualSense');
  if (!solo) await seat('sc', FACE_A.steam, () => !!window._game.lobby._localP2InputManager && window.__controllerManager.getSlot('P2').hidDevice?.__fakeKey === 'sc', 'P2 Steam Controller');
  console.log('  seated', JSON.stringify(await page.evaluate(() => ['P1', 'P2'].map(id => { const sl = window.__controllerManager.getSlot(id); return [id, sl.state, sl.driver?.entry?.name]; }))));
  if (prep) await prep(page);   // achievements-all: a scenario's set-up (bike colour, ...) before the ride starts
  if (solo && start === 'garage') {
    // the Slingshot (achievement-modes.mjs): SOLO -> the Slingshot card -> the garage; the scenario takes it from there
    await page.evaluate(() => document.getElementById('btn-solo').click());
    await page.waitForFunction(() => !!document.querySelector('#level-cards .level-card-slingshot'), { timeout: 20000 });
    await page.evaluate(() => document.querySelector('#level-cards .level-card-slingshot').click());
    await page.waitForFunction(() => window._game.state === 'slingGarage', { timeout: 20000 });
    await sleep(300);
    return s;
  }
  if (solo) {
    await page.evaluate(async (o) => {
      const g = window._game, L = g.lobby, { getLevelById } = await import('/js/race-config.js');
      L.selectedLevel = L.resolveRoadLevel ? L.resolveRoadLevel(getLevelById(o.level)) : getLevelById(o.level);
      L.selectedDifficulty = o.difficulty;
      L._hideLobby();
      g._onSolo();
    }, { level, difficulty });
    await sleep(400);
    await page.evaluate((salt) => {
      const real = Date.now;
      Date.now = () => Math.floor(real() / 1e6) * 1e6 + salt;
      document.getElementById('instructions')?.click();
      Date.now = real;
    }, salt);
  } else await page.evaluate(async (o) => {
    const L = window._game.lobby, { getLevelById } = await import('/js/race-config.js');
    if (document.getElementById('lobby-flow')?.current !== 'lobby-level') document.getElementById('btn-host-local-next').click();
    L.selectedLevel = L.resolveRoadLevel ? L.resolveRoadLevel(getLevelById(o.level)) : getLevelById(o.level);
    L.selectedDifficulty = o.difficulty;
    if (o.level === 'tutorial') L._forceWizard = true;
  }, { level, difficulty });
  if (!solo) await sleep(800);
  if (!solo) await page.evaluate((salt) => {
    const real = Date.now;
    Date.now = () => Math.floor(real() / 1e6) * 1e6 + salt;
    document.getElementById('btn-start-ride').click();
    Date.now = real;
  }, salt);
  // Today's Road asks practice or ranked before it starts (D-2): practice (the capture has no server)
  if (!solo) for (let i = 0; i < 10; i++) { await sleep(300); if (await page.evaluate(() => { const o = document.getElementById('daily-mode-overlay'); if (!o || !o.classList.contains('visible')) return false; document.getElementById('btn-daily-practice')?.click(); return true; })) break; }
  await page.waitForFunction((m) => window._game.mode === m && window._game.bike.modelLoaded && window._game.bike.goose, { timeout: 120000 }, solo ? 'solo' : 'local');
  // the rider bots work out the lean each rider wants; a hook turns that into a controller roll + trigger pulls
  await page.evaluate((sign, solo, steer, cadence, human) => {
    const g = window._game, R = window.__reel;
    R.hooks = R.hooks || [];
    const riders = [['ds', g.input, 'captain', 0, sign[0]], ['sc', g.inputP2, 'stoker', 0.5, sign[1]]].slice(0, solo ? 1 : 2).map(([key, input, role, ph, sg]) => {
      const orig = input.getGamepadLean.bind(input);
      const bot = R.attach(input, () => g.bike, { role, pedal: false, cadence: 2.8, sway: { amp: 0.32, freq: 0.27, phase: ph } });
      if (steer === 'gyro') input.getGamepadLean = orig;   // no stick lean: the bot's lean goes out through the gyro below
      return { key, input, bot, acc: role === 'stoker' ? 0.5 : 0, foot: role === 'stoker' ? 1 : 0, pull: 0, sign: sg };
    });
    window.__gyRiders = riders;
    // from here the hook sends one report per virtual frame: stop the real-time stream, whose extra reports (stamped
    // with a frozen clock while a frame is being saved) upset the fusion
    for (const r of riders) window.__fakeHid.quiet(r.key);
    R.hooks.push((dt) => {
      if (dt <= 0) return;
      // the fake HID streams on a REAL interval, which barely runs under the virtual clock: send one report per
      // virtual frame, stamped with the frame time, so the fusion calibrates and integrates at 60 Hz
      for (const k of riders.map((x) => x.key)) window.__fakeHid.hold(k, 0, 0, false);
      for (const [ri, r] of riders.entries()) {
        const G = window.__gy[r.key];
        const playing = g.state === 'playing';
        // closed loop: turn the pad until the game reads the lean the rider wants
        const cw = window.__choreoWant ? window.__choreoWant(ri, r.bot.leanOut) : null;   // a scripted beat overrides the bot
        // capture-only: during a beat the gyro drift re-centring is paused, so a held tilt reads as the lean it is
        if (cw != null && r.driftRate == null) { r.driftRate = r.input._driftRate; r.input._driftRate = 0; }
        if (cw == null && r.driftRate != null) { r.input._driftRate = r.driftRate; r.driftRate = null; }
        const want = playing && steer === 'gyro' ? (cw != null ? cw : r.bot.leanOut) : 0;
        const got = r.input.getMotionLean ? r.input.getMotionLean() : 0;
        const prev = G.roll;
        let roll = prev + r.sign * (want - got) * (cw != null ? 4.0 : Number(window.__gyGain || 1.6)) * dt;
        const lim = cw != null ? 0.65 : 1.0;   // a beat holds ~37°; outside one the rider may tilt further to recover
        roll = Math.max(-lim, Math.min(lim, roll));
        if (!playing) roll *= Math.max(0, 1 - dt * 3);   // level out between rides (the countdown recentres)
        G.rate = ((roll - prev) / dt) * 180 / Math.PI; G.roll = roll;
        // pedal: alternate trigger pulls at the cadence (a quick squeeze the overlay shows)
        // a scenario's brake (window.__gyBrake = { on, off } frames): both triggers held for `on` frames in every
        // `on + off`, which bleeds speed (a 60 s calm ride on a road the bike would otherwise cross in 25)
        const brk = window.__gyBrake;
        if (playing && brk) { r.bt = (r.bt || 0) + 1; if ((r.bt % (brk.on + brk.off)) < brk.on) { G.l = G.r = 1; continue; } }
        if (playing) {
          r.t = (r.t || 0) + dt;
          r.acc += dt * (cw != null ? Number(window.__choreoCadence || 2.2) : cadence) * (1 + human * (0.07 * Math.sin(r.t * 1.45 + ri * 1.3) + 0.04 * Math.sin(r.t * 0.53 + 0.7)));   // slower through the beats: less drift
          if (r.need == null) { r.rnd = ((a) => () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; })(ri ? 97 : 31); r.need = 1; }
          if (ri === 0) {
            // the captain sets a human rhythm (each stroke its own length, the cadence drifting)...
            if (r.acc >= r.need) {
              r.acc -= r.need; r.need = 1 + (r.rnd() - 0.5) * 0.26 * human; r.foot ^= 1; r.pull = 0.16;
              const o = riders[1];
              // (window.__gyDesync: the stoker follows that much later instead: out of step, which the pair's pedal
              // controller pays with speed, for the slow rides)
              if (o) { o.wait = window.__gyDesync || (0.065 + r.rnd() * 0.03); o.nextFoot = r.foot ^ 1; }
            }
          } else if (r.wait != null) {
            // ...and the stoker follows each stroke ~80 ms later on the other foot, as a pair does (out-of-step
            // pedalling is a crank fight in this game)
            r.wait -= dt;
            if (r.wait <= 0) { r.wait = null; r.foot = r.nextFoot; r.pull = 0.16; }
          }
          r.pull = Math.max(0, r.pull - dt);
          const v = r.pull > 0 ? Math.min(1, (0.16 - r.pull) / 0.05 + 0.2) : 0;
          G.l = r.foot === 0 ? v : 0; G.r = r.foot === 1 ? v : 0;
        } else { G.l = G.r = 0; }
      }
    });
  }, sign, solo, steer, cadence, human);
  await sleep(500);
  await page.evaluate(() => window.__reel.gameplayHud());
  return s;
}

const gyState = (page) => page.evaluate(() => {
  const g = window._game, b = g.bike;
  const rd = (r) => ({ roll: +(window.__gy[r.key].roll * 57.3).toFixed(1), want: +r.bot.leanOut.toFixed(2),
    got: +(r.input.getMotionLean() || 0).toFixed(2), gyro: r.input.gyroConnected, motion: r.input.motionEnabled,
    cal: r.input._slot?.fusion?.calibrating, ml: +(r.input.motionLean || 0).toFixed(2), off: r.input.motionOffset, acc: +(r.input._accelRoll || 0).toFixed(1), mode: r.input._gyroRollMode, src: r.input._dualsenseSource, gv: r.input._slot?.fusion?._gravityVec && [r.input._slot.fusion._gravityVec.x.toFixed(2), r.input._slot.fusion._gravityVec.y.toFixed(2), r.input._slot.fusion._gravityVec.z.toFixed(2)] });
  return { state: g.state, mode: g.mode, d: +(b.distanceTraveled || 0).toFixed(1), speed: +(b.speed || 0).toFixed(1),
    x: +(b._lateralOffset || 0).toFixed(2), fallen: !!b.fallen,
    p1: rd(window.__gyRiders[0]), p2: window.__gyRiders[1] ? rd(window.__gyRiders[1]) : null,
    sf1: g.balanceCtrl.steerFrames, sf2: g.balanceCtrlP2 && g.balanceCtrlP2.steerFrames,
    tiles: document.querySelectorAll('canvas').length,
    earned: [...(g.achievements?._earned?.keys?.() || [])].filter(i => !window.__achPre.includes(i)) };
});

SHOTS.probe_gyro = async () => {
  const sign = (process.env.GYSIGN || '1,1').split(',').map(Number);
  const s = await gyroCoop({ sign });
  for (let k = 0; k < 90; k++) {
    await advance(s.page, 1);
    const p = await gyState(s.page);
    console.log(' ', k + 1, JSON.stringify(p));
    if (['victory', 'gameover'].includes(p.state) && k > 5) break;
    if (process.env.GYMAX && k + 1 >= +process.env.GYMAX) break;
  }
  if (s.errors.length) console.log('  page errors:', s.errors.slice(0, 3));
  await s.close();
};

/** Capture-only tile staging for the #101 reel. window.__tileMode: 'ds' / 'sc' = a close-up of that pad filling the
 *  upper frame (the other tile parked off-screen); 'band' = both pads in a big bottom band (the bottom ~40% in 9:16,
 *  each tile half the width). The float layout (triggers, bumpers, Steam paddles popped off the body) is switched on
 *  and every tile's camera moves to a raised three-quarter view that shows the popped parts. */
const CAM = (process.env.NT_CAM || (TALL ? '0.16,0.30,0.20' : '0.12,0.225,0.15')).split(',').map(Number);   // 16:9 tiles are wide: sit closer
const stageTiles = (page) => page.evaluate((tall, cam) => {
  const g = window._game, hud = g.controllerHud, R = window.__reel;
  window.__tileMode = 'band';
  hud._layout = function () {
    const w = window.innerWidth, h = window.innerHeight, m = tall ? 10 : 24, gap = tall ? 10 : 20;
    const mode = window.__tileMode;
    for (const t of this.tiles.values()) {
      const ds = t.profile === 'dualsense';
      let r;
      if (mode === 'band') {
        const tw = Math.floor((w - 2 * m - gap) / 2), th = tall ? Math.round(h * 0.40) : Math.round(h * 0.44);
        r = { left: ds ? w - m - tw : m, top: h - m - th, width: tw, height: th };   // P1 (DualSense) right, P2 left
      } else {
        const focus = (mode === 'ds') === ds;
        const tw = tall ? w - 2 * m : Math.round(w * 0.62), th = tall ? Math.round(h * 0.62) : h - 2 * m - 60;
        r = focus ? { left: Math.round((w - tw) / 2), top: tall ? Math.round(h * 0.16) : 60 + m, width: tw, height: th }
          : { left: -4000, top: 0, width: 300, height: 200 };
      }
      if (!t.__r || t.__r.left !== r.left || t.__r.width !== r.width || t.__r.height !== r.height || t.__r.top !== r.top) {
        t.__r = r; t.applyRect(r);
      }
    }
  };
  R.hooks.push(() => {
    hud._layout();
    for (const t of hud.tiles.values()) {
      if (t.overlay && !t.__staged) {
        t.__staged = true;
        try { t.overlay.setFloatParts(true); } catch (e) { console.log('[reel] float failed ' + e.message); }
        try { t.overlay.setCameraPreset('top'); } catch (e) {}   // the lab's default: the pad as the player holds it
      }
    }
  });
  R.noPip = true; R.keepRoad = true;   // no selfie PiP drawn over the tiles; the road (arches too) stays
}, TALL, CAM);

const floatState = (page) => page.evaluate(() => [...window._game.controllerHud.tiles.values()].map(t => ({
  profile: t.profile, float: !!(t.overlay && t.overlay._floatActive), parts: t.overlay ? (t.overlay._floatWrappers || []).length : 0,
  shrink: t.overlay && t.overlay.bodyGroup ? +t.overlay.bodyGroup.scale.x.toFixed(2) : null })));

/** A weaving line (metres along the road -> lateral metres) so the riders visibly lean and the pads rock. */
const WEAVE = (from, to, amp = 2.7, period = 22) => {
  const p = [];
  for (let d = from, i = 0; d <= to; d += period / 2, i++) p.push([d, i === 0 ? 0 : (i % 2 ? amp : -amp)]);
  p.push([to + 8, 0]);
  return p;
};
const weaveBots = (page, from, to) => page.evaluate((path) => { for (const b of window.__reel.bots) { b.path = path; b.sway = { amp: 0.08, freq: 0.3, phase: 0 }; } }, WEAVE(from, to));

/** Capture-only: a "← TILT" / "TILT →" tag on each tile while that rider is clearly tilting (the lean the game reads
 *  from the gyro: negative = left, as the A key), so the link between the pad and the lean can't be missed. */
const tiltLabels = (page) => page.evaluate((tall) => {
  const g = window._game, hud = g.controllerHud, R = window.__reel;
  const css = document.createElement('style');
  css.textContent = `.reel-tilt { position: absolute; left: 0; right: 0; bottom: ${tall ? 10 : 14}px; text-align: center;
    font: 800 ${tall ? 22 : 30}px/1 'Helvetica Neue', Arial, sans-serif; letter-spacing: 2px; color: #fff;
    text-shadow: 0 2px 6px rgba(0,0,0,.85); opacity: 0; transition: none; pointer-events: none; }`;
  document.head.appendChild(css);
  R.hooks.push(() => {
    for (const t of hud.tiles.values()) {
      if (!t.el) continue;
      let tag = t.el.querySelector('.reel-tilt');
      if (!tag) { tag = document.createElement('div'); tag.className = 'reel-tilt'; t.el.appendChild(tag); }
      const input = t.profile === 'dualsense' ? g.input : g.inputP2;
      const lean = input ? (input.getMotionLean() || 0) : 0;
      const on = g.state === 'playing' && Math.abs(lean) > 0.16;
      const want = on ? (lean < 0 ? '◀ TILT' : 'TILT ▶') : '';
      if (want) tag.textContent = want;
      const target = on ? 1 : 0;
      const cur = Number(tag.style.opacity || 0);
      tag.style.opacity = String(cur + (target - cur) * 0.35);
    }
  });
}, TALL);

/** Pete's beats for #101 (each rider leans by their OWN pad's gyro; negative = left, as the A key):
 *  together left -> opposite (captain left, stoker right) -> together right -> opposite (captain right, stoker left),
 *  then the bots ride home. [start s, end s, caption, P1 lean, P2 lean], eased in and out. */
const LEAN = Number(process.env.NT_LEAN || 0.5);
const LEAN_T = Number(process.env.NT_LEAN_T || 0.3);   // together: both the same way (the bike turns, so keep it brief)
// [start s, end s, caption, P1, P2, kind]: T = absolute lean; O = the bot's own steering + a split (the bike's average
// still follows the road while the two riders lean apart)
// short gaps between beats hand the steering back to the riders' road sense, so the bike stays on the road
const BEATS = [[0.3, 1.4, 'TOGETHER', -LEAN_T, -LEAN_T, 'T'], [1.6, 3.0, 'OPPOSITE', -LEAN, LEAN, 'O'],
  [3.5, 4.6, 'TOGETHER', LEAN_T, LEAN_T, 'T'], [5.3, 6.6, 'OPPOSITE', LEAN, -LEAN, 'O']];
const LEAN_S = Number(process.env.NT_LEAN_S || 0.32);
const BEATS_SOLO = [[0.3, 1.3, 'LEAN LEFT', -LEAN_S, 0, 'T'], [1.3, 2.5, 'LEAN RIGHT', LEAN_S, 0, 'T'],
  [2.5, 3.5, 'LEAN LEFT', -LEAN_S, 0, 'T'], [3.5, 4.6, 'LEAN RIGHT', LEAN_S, 0, 'T']];
const BOTW = Number(process.env.NT_BOTW || 1.0);   // opposite beats: how much of the bot's road-following steering stays in
const choreo = (page, beats = BEATS) => page.evaluate((beats, tall, botw) => {
  const g = window._game, R = window.__reel;
  const cap = document.createElement('div');
  cap.id = 'reel-beat';
  cap.style.cssText = `position:fixed;left:0;right:0;top:${tall ? '17%' : '15%'};text-align:center;z-index:60;pointer-events:none;
    font:900 ${tall ? 30 : 46}px/1 'Helvetica Neue',Arial,sans-serif;letter-spacing:4px;color:#fff;
    text-shadow:0 3px 10px rgba(0,0,0,.8);opacity:0`;
  document.body.appendChild(cap);
  window.__choreo = { t0: null, beats, botw };
  // the gyro rider hook reads this: the lean each rider should hold right now (null = ride normally)
  window.__choreoWant = (i, bot = 0) => {
    const c = window.__choreo; if (c.t0 == null) return null;
    const t = (window.__vclock.t - c.t0) / 1000;
    for (const [a, b, , l1, l2, kind] of c.beats) {
      if (t >= a && t < b) {
        const ramp = Math.min(1, (t - a) / 0.3, (b - t) / 0.3 + 0.6);   // ease in, hold, ease toward the next beat
        const v = (i === 0 ? l1 : l2) * Math.max(0, ramp);
        if (kind !== 'O') return v;
        // opposite: keep some road-following under the split, but each rider stays clearly on their own side
        let o = c.botw * bot + v;
        if (Math.sign(o) !== Math.sign(v) || Math.abs(o) < 0.25 * Math.abs(ramp)) o = Math.sign(v) * Math.max(Math.abs(o) * (Math.sign(o) === Math.sign(v) ? 1 : 0), 0.25 * Math.max(0, ramp));
        return Math.max(-1, Math.min(1, o));
      }
    }
    return null;
  };
  R.hooks.push(() => {
    const c = window.__choreo; if (c.t0 == null) return;
    const t = (window.__vclock.t - c.t0) / 1000;
    const beat = c.beats.find(([a, b]) => t >= a && t < b);
    const target = beat ? 1 : 0;
    if (beat) cap.textContent = beat[2];
    const cur = Number(cap.style.opacity || 0);
    cap.style.opacity = String(cur + (target - cur) * 0.3);
  });
}, beats, TALL, BOTW);

// #101 LOOK, NO THUMBS: a close-up of each pad (DualSense, then Steam Controller), then both riders weaving home by
// tilting their pads, the two controllers big along the bottom of the frame
const NT = { from: Number(process.env.NT_FROM || 195), closeDs: 0, closeSc: 0, secs: Number(process.env.NT_SECS || 22) };
const nothumbsShot = (solo) => async () => {
  const s = await gyroCoop({ sign: [-1, -1], solo });
  await stageTiles(s.page);
  await tiltLabels(s.page);
  await choreo(s.page, solo ? BEATS_SOLO : BEATS);
  await s.page.evaluate((k) => { window.__gyGain = k; }, Number(process.env.NT_GAIN || 3.5));   // a quicker hand on the pad
  const from = solo ? Number(process.env.NT_FROM_SOLO || 212) : NT.from;   // close to the finish: one continuous take, no cut
  await until(s.page, st => st.d >= from - 22 || ['finishCinematic', 'victory', 'gameover'].includes(st.state), 120, 0.25);
  await s.page.evaluate((o) => { for (const b of window.__reel.bots) { b.dodge = false; b.offset = o; } }, solo ? 0 : Number(process.env.NT_PRE || -1.3));
  const go = await until(s.page, st => st.d >= from || ['finishCinematic', 'victory', 'gameover'].includes(st.state), 120, 0.25);
  console.log('  from', JSON.stringify({ d: go.d, state: go.state }), JSON.stringify(await floatState(s.page)));
  // behind the riders, aimed a little under the seats so they sit above the controller band
  await cam(s.page, { keys: [{ t: 0, deg: 158, dist: TALL ? 6.2 : 6.4, h: TALL ? 2.4 : 1.9, look: TALL ? -1.1 : -0.5, fov: TALL ? 50 : 40 }] });
  await take(solo ? 'nothumbs_solo' : 'nothumbs', s, NT.secs, async (i) => {
    if (i === 0) await s.page.evaluate(() => { window.__choreo.t0 = window.__vclock.t; for (const b of window.__reel.bots) { b.offset = 0; } });
    // over the line the game's own finish (Grandma at her gate) takes the camera
    await s.page.evaluate(() => { if (window._game.state !== 'playing' && window.__reel.cam) window.__reel.setCamera(null); });
  });
};
SHOTS.nothumbs = nothumbsShot(false);

/** RIDE TOGETHER: local co-op, both pads, both geese; the bots steer with the sticks and pedal with the triggers. */
const together = (keep, o = {}) => gyroCoop({ keep, steer: 'stick', overlay: false, sign: [-1, -1], ...o });
SHOTS.learner_together = async () => {
  const s = await together('tutorial_done', { level: 'tutorial', cadence: 2.6, human: 0.35 });
  await bots(s.page, { path: TUT_PATH, sway: STILL });
  await until(s.page, st => st.d >= 117);
  await take('learner_together', s, 6.5);
};
SHOTS.natural_together = async () => {
  const s = await together('tutorial_clean', { level: 'tutorial', cadence: 2.6, human: 0.35 });
  await bots(s.page, { path: TUT_PATH, sway: STILL });
  await until(s.page, st => st.d >= 112);
  await cam(s.page, { stiff: 0.3, keys: [{ t: 0, deg: 60, dist: 4.2, h: 0.4, look: 0.3, fov: TALL ? 50 : 36 },
    { t: 5, deg: 75, dist: 3.8, h: 0.3, look: 0.3, fov: TALL ? 50 : 36 }] });
  await take('natural_together', s, 7);
};
SHOTS.madeit_together = async () => {
  const s = await together('first_finish', { cadence: 3.4 });
  console.log('  at', JSON.stringify(await until(s.page, st => st.d >= 212, 120, 0.5)));
  await cam(s.page, { stiff: 0.3, keys: [{ t: 0, deg: Number(process.env.MI_DEG || -62), dist: TALL ? 4.6 : 5.2, h: 0.35, look: 0.45, fov: TALL ? 48 : 36 }] });
  await take('madeit_together', s, 13.5, async () => { await s.page.evaluate(() => { if (window._game.state !== 'playing' && window.__reel.cam) window.__reel.setCamera(null); }); });
};
SHOTS.goosedown_together = async () => {
  const s = await together('first_crash', { difficulty: 'adventurous', cadence: 3.4, storage: { tandemonium_physics_fx: 'on' } });
  const { page } = s;
  await bots(page, { sway: STILL });
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
  await cam(page, { stiff: 0.3, keys: [{ t: 0, deg: TALL ? 40 : 58, dist: TALL ? 13 : 9, h: TALL ? 1.1 : 0.6, look: -0.3, fov: TALL ? 56 : 50 }] });
  let locked = false;
  await take('goosedown_together', s, 7.5, async (i, t) => {
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
};
SHOTS.nothumbs_solo = nothumbsShot(true);

// #1 KICK OFF, RIDE TOGETHER: local co-op on two pads, the countdown, GO, both riders' first push
SHOTS.kickoff_together = async () => {
  const s = await gyroCoop({ keep: 'first_pedal', sign: [-1, -1], overlay: false });
  await cam(s.page, { keys: [{ t: 0, deg: 35, dist: 4.4, h: 0.15, look: 0.65, fov: TALL ? 46 : 34 },
    { t: 8, deg: 18, dist: 5.2, h: 0.3, look: 0.6, fov: TALL ? 46 : 34 }] });
  await take('kickoff_together', s, 8);
};

SHOTS.probe_tiles = async () => {
  const s = await gyroCoop({ sign: [-1, -1] });
  await stageTiles(s.page);
  await weaveBots(s.page, 30, 232);
  await until(s.page, st => st.d >= 90, 120, 0.25);
  const cdp = await s.page.createCDPSession();
  for (const mode of ['ds', 'sc', 'band']) {
    await s.page.evaluate((m) => { window.__tileMode = m; }, mode);
    await advance(s.page, 0.6);
    console.log(mode, JSON.stringify(await floatState(s.page)), JSON.stringify(await gyState(s.page).then(p => [p.p1.roll, p.p2.roll, p.x])));
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 85, ...(s.page.__reelClip ? { clip: s.page.__reelClip } : {}) });
    fs.writeFileSync(path.join(OUT, `probe_tiles_${mode}_${ASPECT}.jpg`), Buffer.from(data, 'base64'));
  }
  for (let k = 0; k < 6; k++) { await advance(s.page, 1); const p = await gyState(s.page); console.log('  roll', p.p1.roll, p.p2.roll, 'x', p.x, 'd', p.d, p.fallen ? 'FALLEN' : ''); }
  await s.close();
};



SHOTS.probe_choreo = async () => {
  const s = await gyroCoop({ sign: [-1, -1] });
  await stageTiles(s.page); await tiltLabels(s.page); await choreo(s.page);
  await s.page.evaluate((k) => { window.__gyGain = k; }, Number(process.env.NT_GAIN || 3.5));
  await s.page.evaluate((o) => { for (const b of window.__reel.bots) { b.dodge = false; b.offset = o; } }, Number(process.env.NT_PRE || -1.3));
  await until(s.page, st => st.d >= NT.from, 120, 0.25);
  await cam(s.page, { keys: [{ t: 0, deg: 158, dist: TALL ? 6.2 : 6.4, h: TALL ? 2.4 : 1.9, look: TALL ? -1.1 : -0.5, fov: TALL ? 50 : 40 }] });
  await s.page.evaluate(() => window.__vclock.enable());
  await s.page.evaluate(() => { window.__choreo.t0 = window.__vclock.t; for (const b of window.__reel.bots) b.offset = 0; });
  const cdp = await s.page.createCDPSession();
  for (let k = 1; k <= Number(process.env.NT_PK || 36); k++) {
    await advance(s.page, 0.25);
    const p = await s.page.evaluate(() => { const g = window._game, b = g.bike, G = window.__gy;
      return { t: ((window.__vclock.t - window.__choreo.t0) / 1000).toFixed(2), cap: +(b._captainLeanTarget || 0).toFixed(2), sto: +(b._stokerLeanTarget || 0).toFixed(2),
        r1: +(G.ds.roll * 57.3).toFixed(0), r2: +(G.sc.roll * 57.3).toFixed(0), bike: +(b.lean || 0).toFixed(2), x: +(b._lateralOffset || 0).toFixed(2), d: +b.distanceTraveled.toFixed(0), fallen: !!b.fallen, st: g.state }; });
    console.log(' ', JSON.stringify(p));
    if ([5, 11, 17, 23].includes(k)) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, ...(s.page.__reelClip ? { clip: s.page.__reelClip } : {}) });
      fs.writeFileSync(path.join(OUT, `probe_choreo_${k}_${ASPECT}.jpg`), Buffer.from(data, 'base64'));
    }
  }
  await s.close();
};

SHOTS.probe_tut_together = async () => {
  const s = await together('tutorial_done', { level: 'tutorial', cadence: 2.6, human: 0.35 });
  await watchTutorial(s.page);
  await bots(s.page, { path: TUT_PATH, sway: STILL });
  for (let k = 0; k < 40; k++) {
    await advance(s.page, 1);
    const p = await s.page.evaluate(() => { const g = window._game, b = g.bike; return { st: g.state, mode: g.mode, tut: !!g._tutorialActive, tp: g._tutTargetPhase, v: +b.speed.toFixed(1), d: +b.distanceTraveled.toFixed(0), x: +(b._lateralOffset || 0).toFixed(2), lv: g.lobby.selectedLevel && g.lobby.selectedLevel.id, earned: [...g.achievements._earned.keys()].filter(i => !window.__achPre.includes(i)) }; });
    console.log(' ', k + 1, JSON.stringify(p));
    if (p.st === 'gameover' || p.earned.length) break;
  }
  await s.close();
};
// achievements-all.mjs (the other 95) builds on these
export { SHOTS, VIEW, ASPECT, TALL, PORT, BASE, SALT, AOUT, IDS, others, TOAST_CSS, state, solo, together, gyroCoop, installLogs, renderAudio, take, until, cam, bots, leadIn, STILL, TUT_PATH };

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const want = (process.argv[2] || '').split(',').filter(Boolean);
  for (const k of want) {
    if (!SHOTS[k]) { console.log('no shot', k); continue; }
    console.log('== shot', k, ASPECT);
    try { await SHOTS[k](); } catch (e) { console.log('  FAILED', k, e.stack); }
  }
  process.exit(0);
}
