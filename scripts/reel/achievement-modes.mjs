// achievement-modes.mjs — the reels that are not a RIDE TOGETHER (#506): the Slingshot (a launch and its flight),
// the garage (a purchase, a rebuild) and versus (a split-screen race). Used by achievements-all.mjs.
//
// Slingshot and the garage live under SOLO in the game, so those reels are SOLO (one goose, a DualSense), tagged
// <id>_solo. Versus is two to four pads on one screen: the Gamepad-API fakes (scripts/lib/fake-gamepads.mjs) join
// the real versus roster by pressing A, then the rider bots drive every member. A versus frame is two halves side
// by side, so versus is captured at 16:9 whatever the reel's aspect; edit.py fits it into a 9:16 reel.
//
// Scenario fields (achievement-scenarios.mjs), on top of the ride ones:
//   kind       'sling' | 'garage' | 'versus'
//   wallet     tandemonium_wallet to start from: { coins, lv: { sling, wheels, magnet }, rebuilds }
//   sling      tandemonium_slingshot: { stage, best, runs }
//   records    tandemonium_records (a stage's medal gate: a gold on Grandma's opens stage 7)
//   daily      true: Today's Launch instead of the stage
//   pull/side  the drag (0..1 / -1..1), wait: seconds the bike rests before the drag
//   target     'ramp' | 'jackpot' | 'trail' | null: the lane the bot steers for after launch (null: no steering)
//   buy        upgrade id to buy in the garage; rebuild: true clicks REBUILD
//   players    versus: 2 (1v1) or 4 (2v2); teams: [{ cadence }, { cadence }] per team (A first); comeback: true
import fs from 'node:fs';
import path from 'node:path';
import { launch, advance, sleep } from './lib.mjs';
import { ASPECT, PORT, SALT, AOUT, IDS, others, TOAST_CSS, BASE, gyroCoop, installLogs, take, bots, STILL, state as rideState } from './achievements.mjs';
import { installFakeGamepads, fakePads } from '../lib/fake-gamepads.mjs';

/** From here both passes see the same virtual time and the same random numbers (Math.random re-seeded). */
export const anchor = (page) => page.evaluate(() => {
  let a = 0x2545F491;
  Math.random = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  window.__ach.t0 = window.__vclock.t; window.__ach.anchor = window.__vclock.t;
});
/** Math.random seeded from the page's first instant (the lobby's own animations then draw the same numbers). */
const seedRandom = (p) => p.evaluateOnNewDocument(() => {
  let a = 0x9E3779B9;
  Math.random = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
});
export const vt = (page) => page.evaluate(() => (window.__vclock.t - window.__ach.anchor) / 1000);

/**
 * Lifetime stats with day keys: 'rel:k' is the game's own dailyKey k days ago; a list field ('rel:n') is the n
 * days ending yesterday. Written to tandemonium_achievement_stats (v2) and re-read by the game.
 */
export async function seedStats(page, seed) {
  await page.evaluate(async (seed) => {
    const { dailyKey } = await import('/js/daily-seed.js');
    const key = (k) => dailyKey(new Date(Date.now() - k * 86400000));
    const out = { v: 2 };
    for (const [k, v] of Object.entries(seed)) {
      if (typeof v === 'string' && v.startsWith('rel:')) {
        const n = +v.slice(4);
        out[k] = (k === 'dayList' || k === 'launchDays') ? Array.from({ length: n }, (_, i) => key(n - i)) : key(n);
      } else out[k] = v;
    }
    localStorage.setItem('tandemonium_achievement_stats', JSON.stringify(out));
    window._game.achievements.reload();
  }, seed);
}

/** localStorage for a scenario: the seeded stats, the wallet, the Slingshot save, the records. */
export function storageOf(sc) {
  const st = { ...(sc.storage || {}) };
  if (sc.seed) st.tandemonium_achievement_stats = JSON.stringify({ v: 2, ...sc.seed });
  if (sc.wallet) st.tandemonium_wallet = JSON.stringify({ v: 1, coins: 0, earned: 0, lv: {}, rebuilds: 0, ...sc.wallet, earned: Math.max(sc.wallet.coins || 0, sc.wallet.earned || 0) });
  if (sc.sling || sc.kind === 'sling' || sc.kind === 'garage') st.tandemonium_slingshot = JSON.stringify({ v: 3, best: 0, runs: 0, stage: 1, ...(sc.sling || {}) });
  if (sc.records) st.tandemonium_records = JSON.stringify(sc.records);
  return st;
}

const hasRel = (seed) => !!seed && JSON.stringify(seed).includes('rel:');

// ─────────────────────────────── the garage ───────────────────────────────

/** Open the game at the Slingshot garage (SOLO → the Slingshot card), the P1 pad seated. */
async function openGarage(id, sc) {
  const s = await gyroCoop({ keep: id, solo: true, start: 'garage', storage: storageOf(sc), query: sc.query || '',
    prep: async (page) => { if (hasRel(sc.seed)) await seedStats(page, sc.seed); if (sc.prep) await sc.prep(page); } });
  return s;
}

/** A click in the garage: the upgrade row `buy`, or REBUILD. */
const garageClick = (page, sc) => page.evaluate((o) => {
  if (o.buy) { document.querySelector(`#sling-garage .sling-up[data-up="${o.buy}"]`).click(); return 'buy ' + o.buy; }
  // REBUILD arms on the first press ("PRESS AGAIN ...") and rebuilds on the second
  if (o.rebuild) { const b = document.querySelector('#sling-garage .sling-rebuild'); b.click(); return 'rebuild ' + b.textContent.slice(0, 24); }
  return 'nothing';
}, { buy: sc.buy || null, rebuild: !!sc.rebuild });
const ARM = 0.7;   // seconds between REBUILD's two presses

/** One pass: the garage, a beat, the click, the toast. Returns what recordMoment returns. */
export async function garageMoment(id, sc, { probe = false } = {}) {
  const s = await openGarage(id, sc);
  const { page } = s;
  await advance(page, 0.001);
  await anchor(page);
  const pre = sc.pre ?? 1.5, post = sc.post ?? 3.0;
  if (probe) {
    await advance(page, pre);
    let what = await garageClick(page, sc);
    if (sc.rebuild) { await advance(page, ARM); what += ' / ' + await garageClick(page, sc); }
    await advance(page, post);
    const toasts = await page.evaluate(() => window.__ach.toasts);
    await s.close();
    return { T: toasts[0] ? toasts[0][0] : null, st: { state: 'slingGarage', what }, toasts, earned: [] };
  }
  const at = Math.round(pre * 60), at2 = at + Math.round(ARM * 60);
  await take(`${id}_solo`, s, pre + post, async (i) => { if (i === at || (sc.rebuild && i === at2)) console.log('  garage:', await garageClick(page, sc)); });
  return { pre, post, tag: `${id}_solo` };
}

// ─────────────────────────────── the Slingshot ───────────────────────────────

/** A sling run's state for the pass loops. */
const slingState = (page) => page.evaluate(() => {
  const g = window._game, b = g.bike, r = g._slingRun || {};
  return { state: g.state, speed: +(b.speed || 0).toFixed(2), d: +(b.distanceTraveled || 0).toFixed(1), x: +(b._lateralOffset || 0).toFixed(2),
    fallen: !!b.fallen, launched: !!r.launched, air: !!b.air, bigAirs: r.bigAirs || 0, coins: r.coins || 0,
    earned: [...(g.achievements?._earned?.keys?.() || [])].filter(i => !window.__achPre.includes(i)) };
});

/**
 * Open the garage, LAUNCH (or Today's Launch), wait for the bike in the slingshot, attach the rider bot, anchor.
 * The drag itself is a per-frame hook in the page, so both passes run it on the same frames.
 */
async function slingRide(id, sc) {
  const s = await openGarage(id, sc);
  const { page } = s;
  await page.evaluate((daily) => { const g = window._game; g._startSlingRun(daily ? { daily: true } : {}); }, !!sc.daily);
  await page.waitForFunction(() => window._game.state === 'slingAim' && window._game.bike.modelLoaded && !!window._game._slingRig, { timeout: 120000 });
  await sleep(300);
  await page.evaluate(() => { window.__reel.gameplayHud(); try { window.__fakeHid.quiet('ds'); } catch (e) { /* no stream */ } });
  // the rider bot: no pedalling (nothing to pedal here), lean only where the scenario steers for a lane
  await page.evaluate((o) => {
    const g = window._game, R = window.__reel;
    // no target: follow the road with a hand so light the game does not call it steering (Straight Shooter); the
    // slingshot road bends after its first 80 m and a bike that never leans runs onto the grass and stalls
    R.attach(g.input, () => g.bike, { role: 'captain', pedal: false, sway: { amp: 0, freq: 0, phase: 0 }, steer: 0.9, maxOut: o.target ? 1 : 0.2, dodge: false, offset: 0, collect: false });
    // the drag: finger down mid-screen, back (and aside) over 0.8 s, a short hold, let go
    const W = window.innerWidth, H = window.innerHeight, x0 = W / 2, y0 = H * 0.38;
    const dx = (o.side || 0) * 0.25 * W, dy = (o.pull ?? 1) * 0.3 * H;
    const t0 = o.wait ?? 1.0, dur = 0.8, hold = 0.3;
    const ev = (type, x, y) => {
      const el = document.elementFromPoint(x, y) || document.body;
      el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
    };
    const drag = { t: 0, phase: 0 };
    R.hooks = R.hooks || [];
    R.hooks.push((dt) => {
      if (drag.phase > 2 || g.state !== 'slingAim') return;
      drag.t += dt;
      if (drag.phase === 0 && drag.t >= t0) { ev('pointerdown', x0, y0); drag.phase = 1; }
      else if (drag.phase === 1) {
        const k = Math.min(1, (drag.t - t0) / dur), e = k * k * (3 - 2 * k);
        ev('pointermove', x0 + dx * e, y0 + dy * e);
        if (drag.t >= t0 + dur + hold) { ev('pointerup', x0 + dx, y0 + dy); drag.phase = 2; }
      } else if (drag.phase === 2 && g._slingRun && g._slingRun.launched) drag.phase = 3;
    });
    window.__slingDrag = drag;
  }, { pull: sc.pull, side: sc.side, wait: sc.wait, target: sc.target });
  await advance(page, 0.001);
  await anchor(page);
  return s;
}

/** After the launch: the lane path for the scenario's target, from the course the game built. */
async function slingPath(page, sc) {
  if (!sc.target || page.__slingPathed) return;
  page.__slingPathed = true;
  const p = await page.evaluate((target) => {
    const g = window._game, items = (g._slingProps && g._slingProps.items) || [], coins = (g.collectibleManager && g.collectibleManager._items) || [];
    const REST = 5.2, g1 = REST + 45, g2 = REST + 110;
    const hay = items.filter(i => i.kind === 'hay').sort((a, b) => a.d - b.d);
    const fan1 = coins.find(c => Math.abs(c.absoluteD - (g1 - 6)) < 0.5), fan2 = coins.find(c => Math.abs(c.absoluteD - (g2 - 6)) < 0.5);
    const c1 = fan1 ? fan1.lateralOffset : [-1.6, 0, 1.6].find(l => !hay[0] || Math.abs(l - hay[0].offset) > 0.5);
    const c2 = fan2 ? fan2.lateralOffset : 0;
    const h1 = hay[0] ? hay[0].offset : null;
    // the target's lane from the launch, unless gate 1's hay bale sits in it: then gate 1's coin lane first
    const to = (lane, after) => (h1 != null && Math.abs(lane - h1) < 0.5) ? [[0, c1], [g1 + 6, lane]] : [[0, lane], ...(after || [])];
    let path = [[0, c1]];
    if (target === 'ramp') { const r = items.filter(i => i.kind === 'ramp').sort((a, b) => a.d - b.d)[0]; if (r) path = to(r.offset); }
    else if (target === 'jackpot') { const j = items.find(i => i.kind === 'jackpot'); if (j) path = to(j.offset); }
    else if (target === 'trail') { const t = coins.find(c => c.absoluteD > g2 + 20); path = [[0, c1], [g1 + 6, c2]]; if (t) path.push([g2 + 10, t.lateralOffset]); }
    return { path, items: items.map(i => [i.kind, +i.d.toFixed(1), i.offset]), coins: coins.length };
  }, sc.target);
  await bots(page, { path: p.path, dodge: false, collect: false });
  console.log('  sling path', JSON.stringify(p.path), 'props', JSON.stringify(p.items.slice(0, 6)));
}

export async function slingFind(id, sc, name) {
  const s = await slingRide(id, sc);
  const { page } = s;
  let T = null, st = null, over = 0;
  for (let t = 0; t < 200; t += 0.25) {
    await advance(page, 0.25);
    st = await slingState(page);
    if (st.launched) await slingPath(page, sc);
    T = await page.evaluate((nm) => { const x = window.__ach.toasts.find(y => y[1] === nm); return x ? x[0] : null; }, name);
    if (T != null) break;
    if (['slingResults', 'lobby', 'slingGarage'].includes(st.state)) { if (++over > 40) break; }
  }
  const info = await page.evaluate(() => ({ earned: [...(window._game.achievements?._earned?.keys?.() || [])].filter(i => !window.__achPre.includes(i)), toasts: window.__ach.toasts,
    run: (() => { const r = window._game._slingRun || {}; return { coins: r.coins, bigAirs: r.bigAirs, jackpot: !!r.jackpot, steerAt: r.steerAt, crash: r.crashDistance }; })() }));
  await s.close();
  return { T, st, ...info };
}

export async function slingRecord(id, sc, T) {
  const MARGIN = 0.75;
  const pre = (sc.pre ?? 2.5) + MARGIN, post = (sc.post ?? 3.0) + MARGIN;
  const s = await slingRide(id, sc);
  const { page } = s;
  const startAt = Math.max(0, T - pre);
  for (;;) {
    const now = await vt(page);
    if (now >= startAt - 0.26) break;
    await advance(page, 0.25);
    const st = await slingState(page);
    if (st.launched) await slingPath(page, sc);
  }
  for (;;) { const now = await vt(page); if (now >= startAt) break; await advance(page, 1 / 60); }
  const tag = `${id}_solo`;
  await take(tag, s, pre + post, async () => { const st = await slingState(page); if (st.launched) await slingPath(page, sc); });
  return { pre, post, tag };
}

// ─────────────────────────────── versus ───────────────────────────────

const VERSUS_VIEW = { width: 1920, height: 1080 };
const VERSUS_CSS = `#achievement-toast-container { zoom: 2.0; top: 11% !important; z-index: 9999 !important; }`;

/** The race's state for the pass loops (team A's bike, and both distances). */
const versusState = (page) => page.evaluate(() => {
  const g = window._game, rigs = g.versusRigs || [], b = rigs[0] ? rigs[0].bike : g.bike;
  return { state: g.state, speed: +(b.speed || 0).toFixed(2), d: +(b.distanceTraveled || 0).toFixed(1), x: +(b._lateralOffset || 0).toFixed(2), fallen: !!b.fallen,
    dist: rigs.map(r => +r.bike.distanceTraveled.toFixed(1)), speeds: rigs.map(r => +r.bike.speed.toFixed(1)),
    taps: rigs.map(r => r.pedalCtrl && r.pedalCtrl.stats ? r.pedalCtrl.stats.totalTaps : null), power: rigs.map(r => r.pedalCtrl ? +(r.pedalCtrl.pedalPower || 0).toFixed(2) : null),
    inputs: rigs.map(r => r.members.map(m => m.input === g.input ? 'P1' : (m.input === g.inputP2 ? 'P2' : 'own'))),
    xs: rigs.map(r => +(r.bike._lateralOffset || 0).toFixed(2)), leans: rigs.map(r => +(r.bike.lean || 0).toFixed(2)), edge: rigs.map(r => +(r.bike._edgeIntensity || 0).toFixed(2)),
    wob: rigs.map(r => +(r.bike.wobble || r.bike._wobble || 0).toFixed(2)), acc: rigs.map(r => r.pedalCtrl && r.pedalCtrl._lastResult ? +r.pedalCtrl._lastResult.acceleration.toFixed(2) : null), half: rigs[0] && rigs[0].raceManager ? rigs[0].raceManager.raceDistance / 2 : null,
    winner: g._versusWinner ? g._versusWinner.id : null,
    earned: [...(g.achievements?._earned?.keys?.() || [])].filter(i => !window.__achPre.includes(i)) };
});

/** TOGETHER → VERSUS, the pads join by pressing A, CHOOSE LEVEL → START RIDE, the bots take every seat, anchor. */
async function versusRide(id, sc) {
  const n = sc.players || 2;
  const st = { ...BASE, ...others(id), ...storageOf(sc) };
  const s = await launch({ ...VERSUS_VIEW, port: PORT, storage: st, query: sc.query || '', before: async (p) => {
    await seedRandom(p);
    await installFakeGamepads(p, { atBoot: ['xbox'] });
  } });
  const { page } = s;
  try {
    await page.evaluate((pre) => { window.__achPre = pre; }, IDS.filter(i => i !== id));
    const click = (el) => page.evaluate((i) => document.getElementById(i)?.click(), el);
    await page.click('#tap-to-start').catch(() => {});
    await sleep(1200);
    await page.addStyleTag({ content: TOAST_CSS + VERSUS_CSS });
    await installLogs(page);
    await click('btn-together'); await sleep(800);
    await click('btn-versus');
    await page.waitForFunction(() => window._game.lobby._currentStep === window._game.lobby.versusStep, { timeout: 20000 });
    await sleep(600);
    const pads = fakePads(page);
    for (const model of ['dualsense', 'switchpro', 'steam'].slice(0, n - 1)) {
      const i = await pads.plug(model);
      await sleep(500);
      await pads.tap(i, 'A', 200);
      await sleep(500);
    }
    const roster = await page.evaluate(() => window._game.lobby._versusPlayers.map(p => [p.n, p.team, p.type]));
    console.log('  versus roster', JSON.stringify(roster));
    if (roster.length !== n) throw new Error(`versus roster has ${roster.length} players, wanted ${n}`);
    await click('btn-versus-continue'); await sleep(800);
    await page.evaluate(async (o) => {
      const L = window._game.lobby, { getLevelById } = await import('/js/race-config.js');
      L.selectedLevel = L.resolveRoadLevel ? L.resolveRoadLevel(getLevelById(o.level)) : getLevelById(o.level);
      L.selectedDifficulty = o.difficulty;
    }, { level: sc.level || 'grandma', difficulty: sc.difficulty || 'chill' });
    if (hasRel(sc.seed)) await seedStats(page, sc.seed);
    if (sc.prep) await sc.prep(page);
    await page.evaluate((salt) => {
      const real = Date.now;
      Date.now = () => Math.floor(real() / 1e6) * 1e6 + salt;
      document.getElementById('btn-start-ride').click();
      Date.now = real;
    }, SALT);
    await page.waitForFunction(() => window._game.mode === 'versus' && !!window._game.versusRigs && window._game.versusRigs.length === 2, { timeout: 180000 });
    await sleep(1500);
    // REEL_TEAMS=3.4,3.4 / REEL_PHASE=0.37: an experiment's cadences, and team B's first-stroke offset
    const teams = process.env.REEL_TEAMS ? process.env.REEL_TEAMS.split(',').map(c => ({ cadence: +c })) : (sc.teams || [{ cadence: 3.6 }, { cadence: 3.0 }]);
    await page.evaluate((teams, human, phase) => {
      const g = window._game, R = window.__reel;
      g.versusRigs.forEach((rig, i) => rig.members.forEach((m, j) => {
        R.attach(m.input, () => rig.bike, { role: j ? 'stoker' : 'captain', cadence: (teams[i] || teams[0]).cadence, human, pedal: true, collect: false,
          sway: { amp: 0, freq: 0, phase: 0 }, team: i, clearTaps: true, acc: i ? phase : 0 });
      }));
      R.gameplayHud();
    }, teams, sc.human ?? 0, process.env.REEL_PHASE ? +process.env.REEL_PHASE : 0);
    await advance(page, 0.001);
    await anchor(page);
    return s;
  } catch (e) { await s.close().catch(() => {}); throw e; }
}

/** The comeback: team A trails at halfway, then rides team B down. */
async function versusSteer(page, sc, st) {
  if (sc.comeback && !page.__cb && st.half && Math.max(...st.dist) >= st.half + 2) {
    page.__cb = true;
    await page.evaluate((c) => { for (const b of window.__reel.bots) b.cadence = b.team === 0 ? c[0] : c[1]; }, sc.comeback);
    console.log('  comeback: halfway at', JSON.stringify(st.dist), '-> cadences', JSON.stringify(sc.comeback));
  }
}

export async function versusFind(id, sc, name) {
  const s = await versusRide(id, sc);
  const { page } = s;
  let T = null, st = null, over = 0;
  for (let t = 0; t < 200; t += 0.25) {
    await advance(page, 0.25);
    st = await versusState(page);
    await versusSteer(page, sc, st);
    if (process.env.REEL_VDIAG && Math.round(t * 4) === 60) console.log('  vdiag', await page.evaluate(() => JSON.stringify(window._game.versusRigs.map(r => {
      const b = r.bike, o = {}; for (const k of Object.keys(b)) { const v = b[k]; if (/speed|accel|drag|mass|tune|power|boost|coast|assist|resist|friction|surface|wobble|fallen|air/i.test(k) && (typeof v !== 'object' || v === null)) o[k] = typeof v === 'number' ? +v.toFixed(3) : v; }
      return { stats: r.pedalCtrl && r.pedalCtrl.stats, power: r.pedalCtrl && r.pedalCtrl.pedalPower, last: r.pedalCtrl && r.pedalCtrl.lastPedal, bike: o, same: b === window._game.bike, preset: b.preset && b.preset.name };
    }))));
    if (Math.round(t * 4) % 20 === 0) console.log(`  versus t=${t.toFixed(0)} ${st.state} dist=${JSON.stringify(st.dist)} speeds=${JSON.stringify(st.speeds)} taps=${JSON.stringify(st.taps)} power=${JSON.stringify(st.power)} inputs=${JSON.stringify(st.inputs)} xs=${JSON.stringify(st.xs)} leans=${JSON.stringify(st.leans)} edge=${JSON.stringify(st.edge)} wob=${JSON.stringify(st.wob)}`);
    T = await page.evaluate((nm) => { const x = window.__ach.toasts.find(y => y[1] === nm); return x ? x[0] : null; }, name);
    if (T != null) break;
    if (['versusResults', 'lobby'].includes(st.state)) { if (++over > 40) break; }
  }
  const info = await page.evaluate(() => ({ earned: [...(window._game.achievements?._earned?.keys?.() || [])].filter(i => !window.__achPre.includes(i)), toasts: window.__ach.toasts,
    winner: window._game._versusWinner ? window._game._versusWinner.id : null }));
  await s.close();
  return { T, st, ...info };
}

export async function versusRecord(id, sc, T) {
  const MARGIN = 0.75;
  const pre = (sc.pre ?? 2.5) + MARGIN, post = (sc.post ?? 3.0) + MARGIN;
  const s = await versusRide(id, sc);
  const { page } = s;
  page.__reelClip = null;   // the full 16:9 viewport
  const startAt = Math.max(0, T - pre);
  for (;;) {
    const now = await vt(page);
    if (now >= startAt - 0.26) break;
    await advance(page, 0.25);
    await versusSteer(page, sc, await versusState(page));
  }
  for (;;) { const now = await vt(page); if (now >= startAt) break; await advance(page, 1 / 60); }
  const tag = `${id}_together`;
  await take(tag, s, pre + post, async () => { await versusSteer(page, sc, await versusState(page)); });
  return { pre, post, tag };
}
