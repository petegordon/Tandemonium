#!/usr/bin/env node
// achievements-all.mjs — the other 95 achievement reels, from one scenario table (#506).
//
//   node scripts/reel/achievements-all.mjs <id,...|all|section:<name>> [--aspect 9x16|16x9] [--probe] [--lead]
//
// Every reel is a RIDE TOGETHER (local co-op, both pads, both geese: achievements.mjs gyroCoop) that earns the
// achievement for real, with the scenario's lifetime stats seeded so the moment comes in a short ride
// (achievement-scenarios.mjs). Two passes per reel, both on the virtual clock with Math.random seeded and the
// placement salt pinned, so they ride the same ride:
//   1. ride without recording until the game shows this achievement's toast: that is the moment, T;
//   2. ride again, record from T - pre to T + post (the toast lands at `pre`), with the game's own sound.
// --probe runs pass 1 only and prints what happened (T, the finish state, what else was earned): use it to tune a
// scenario. --lead also captures the achievements-screen lead-in (achievements.mjs leadIn) for each id.
// Out: clips/ach-<id>_together-<aspect>.mp4, ach/<id>_together-<aspect>.{wav,json} (edit.py's tag scheme).
import fs from 'node:fs';
import path from 'node:path';
import { advance, sleep, OUT } from './lib.mjs';
import { ASPECT, IDS, AOUT, together, take, until, cam, bots, leadIn, state as rideState } from './achievements.mjs';
import { SCENARIOS, HAND_MADE } from './achievement-scenarios.mjs';
import { garageMoment, slingFind, slingRecord, versusFind, versusRecord, storageOf, seedStats } from './achievement-modes.mjs';

const args = process.argv.slice(2);
const PROBE = args.includes('--probe');
const LEAD = args.includes('--lead');

function wanted(spec) {
  if (!spec || spec === 'all') return IDS.filter(id => !HAND_MADE[id]);
  if (spec.startsWith('section:')) {
    const sec = spec.slice(8);
    const defs = fs.readFileSync(path.join(OUT, '..', '..', 'js', 'achievement-defs.js'), 'utf8');
    return [...defs.matchAll(/\{ id: '([a-z0-9_]+)',\s*section: '([a-z]+)'/g)].filter(m => m[2] === sec).map(m => m[1]).filter(id => !HAND_MADE[id]);
  }
  return spec.split(',').filter(Boolean);
}

/** Storage for a scenario: the seeded lifetime stats (v2), the wallet / Slingshot save / records, anything else it names. */
const storageFor = storageOf;

/** Launch the ride for a scenario (co-op rig), apply its bots / prep, and anchor the virtual clock. */
async function ride(id, sc) {
  const s = await together(id, {
    level: sc.level || 'grandma', difficulty: sc.difficulty || (sc.crash ? 'adventurous' : 'chill'), cadence: sc.cadence || 3.4,
    human: sc.human == null ? 1 : sc.human, storage: storageFor(sc), query: sc.query || '',
    prep: async (page) => {
      // day keys in the seed ('rel:k'): the game's own dailyKey (its rollover hour), then the stats are re-read
      if (sc.seed && JSON.stringify(sc.seed).includes('rel:')) await seedStats(page, sc.seed);
      // the bike colour: the game paints from the lobby's preset OBJECT (selectedPreset), the key only names it for the stats
      if (sc.bike) await page.evaluate(async (k) => {
        const lb = window._game.lobby;
        if (!lb._presetData || !Object.keys(lb._presetData).length) lb._presetData = await (await fetch('tandem-3d/bike-presets.json')).json();
        if (!lb._presetData[k]) throw new Error('no bike preset ' + k);
        lb.selectedPresetKey = k; lb.selectedPreset = lb._presetData[k];
      }, sc.bike);
      // one gust at `gustAt` metres (the game's own ?disrupt=gust debug road, which URL tidying would drop)
      if (sc.gustAt) await page.evaluate(async (at) => {
        const { TELEGRAPH_S, DURATION, KIND } = await import('/js/disruptions.js');
        window._game._overrideDisruptions = () => [{ kind: KIND.GUST, atM: at, telegraphM: Math.max(0, at - TELEGRAPH_S * 8), duration: DURATION.gust }];
        console.log('[reel] gust override installed at ' + at + ' m');
      }, sc.gustAt);
      // a pair streak: Today's Road ridden with this partner in each of the last N ISO weeks (the daily save)
      if (sc.pairWeeks) await page.evaluate(async (n) => {
        const { dailyKey } = await import('/js/daily-seed.js');
        const all = JSON.parse(localStorage.getItem('tandemonium_daily') || '{}');
        for (let w = 1; w <= n; w++) all[dailyKey(new Date(Date.now() - 7 * w * 86400000))] = { practice: 1, partners: ['local:p2'] };
        localStorage.setItem('tandemonium_daily', JSON.stringify(all));
      }, sc.pairWeeks);
      // the pair summary (Regulars, A Hundred Together) comes from the server, which the capture blocks: answer
      // for it with the summary this ride brings the pair to
      if (sc.pairRides || sc.pairDistance) await page.evaluate((o) => {
        const g = window._game, sum = { rides: o.rides + 1, distance: o.distance + 250 };
        g._lastPairSummary = sum;                                   // what the finish reads (pairRides, pairDistanceKm)
        if (g.auth) g.auth.fetchPair = async () => sum;             // and what a refresh would fetch
      }, { rides: sc.pairRides || 0, distance: sc.pairDistance || 0 });
      if (sc.prep) await sc.prep(page);
      // the pylons and presents are placed when the ride starts, from Math.random: re-seed it here (the lobby's own
      // animations drew a run-dependent number before this), so both passes, and every take, ride one layout
      await page.evaluate(() => { let a = 0x1F2E3D4C; Math.random = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; });
    },
  });
  const { page } = s;
  if (sc.bots) await bots(page, sc.bots);
  if (sc.brake) await page.evaluate((b) => { window.__gyBrake = b; }, sc.brake);
  if (sc.desync) await page.evaluate((d) => { window.__gyDesync = d; }, sc.desync);
  // a speed cap (m/s): the pair rides at the road's top speed whatever the cadence; a calm 60 s needs a slower bike
  if (sc.maxSpeed) await page.evaluate(async (v) => { const { TUNE } = await import('/js/config.js'); TUNE.maxSpeed = v; if (window._game.bike) window._game.bike.maxSpeed = v; }, sc.maxSpeed);
  // no presents: a boost (from a present the line happens to cross) would double the pace of a ride that wants to be slow
  if (sc.noPresents) await page.evaluate(() => { const cm = window._game.collectibleManager; if (!cm) return;
    for (const it of cm._items || []) it.collected = true; for (const slot of cm._pool || []) for (const v of Object.values(slot)) if (v && v.isObject3D) v.visible = false; });
  await advance(page, 0.001);
  // the anchor: from here both passes see the same virtual time and the same random numbers (the lobby's own
  // animations consumed a different number of them before the ride, so Math.random is re-seeded here)
  await page.evaluate(() => {
    let a = 0x2545F491;
    Math.random = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    window.__ach.t0 = window.__vclock.t; window.__ach.anchor = window.__vclock.t;
    // Date.now too (a crash's re-placement salts itself with it): from here it runs from the top of the real hour,
    // so both passes see the same clock (and the same day key)
    { const vc = window.__vclock, b = vc.t, origin = Date.now() - (Date.now() % 3600000); Date.now = () => origin + (vc.t - b); }
  });
  return s;
}

const vt = (page) => page.evaluate(() => (window.__vclock.t - window.__ach.anchor) / 1000);
const toastFor = (page, id, name) => page.evaluate((nm) => { const t = window.__ach.toasts.find(x => x[1] === nm); return t ? t[0] : null; }, name);
const nameOf = (id) => { const m = fs.readFileSync(path.join(OUT, '..', '..', 'js', 'achievement-defs.js'), 'utf8').match(new RegExp(`id: '${id}',[^\\n]*?name: (["'])((?:\\\\.|(?!\\1).)*)\\1`)); return m ? m[2] : id; };

/** The scenario's one-off actions while riding: a crash on a pylon after `crash` m, a false start, the Share button. */
async function steer(page, sc, st) {
  if (sc.crash && !page.__crashed && st.d >= sc.crash - 40 && st.state === 'playing') {
    const p = await page.evaluate((d) => {
      const items = (window._game.obstacleManager._items || []).filter(i => i.absoluteD > d + 20 && !i._hidden).sort((x, y) => x.absoluteD - y.absoluteD);
      return items[0] ? { d: items[0].absoluteD, x: items[0].lateralOffset } : null;
    }, st.d);
    if (p) { await bots(page, { dodge: false, offset: p.x, path: null, collect: false, sway: { amp: 0, freq: 0, phase: 0 } }); page.__crashed = p; console.log('  crash: aiming at the pylon', JSON.stringify(p), 'from d', st.d); }
    else if (!page.__noPylon) { page.__noPylon = true; console.log('  crash: no pylon ahead of d', st.d); }
  }
  if (sc.crash && page.__crashed && st.fallen && !page.__recovered) { page.__recovered = true; await bots(page, { dodge: true, offset: 0 }); }
  // Did It Myself: crash on pylon after pylon until the game offers ASSIST (the third crash in a segment brings the
  // game-over sheet with the ASSIST button), RESTART without it, then ride clean to the line
  if (sc.assist && !page.__assistDone) {
    if (st.state === 'playing' && !st.fallen && (!page.__aim || page.__wasFallen)) {
      page.__wasFallen = false;
      const p = await page.evaluate((d) => {
        // pylons past the first checkpoint only: a game-over before it rebuilds the race (and the ride tracker's offer
        // with it), one after it resumes from the checkpoint
        const from = Math.max(d + 12, (window._game.raceManager.checkpoints[0] || 62) + 10);
        const items = (window._game.obstacleManager._items || []).filter(i => i.absoluteD > from && !i._hidden).sort((x, y) => x.absoluteD - y.absoluteD);
        return items[0] ? { d: items[0].absoluteD, x: items[0].lateralOffset } : null;
      }, st.d);
      if (p) { page.__aim = p; await bots(page, { dodge: false, offset: p.x, path: null, collect: false, sway: { amp: 0, freq: 0, phase: 0 } }); console.log('  assist: aiming at the pylon', JSON.stringify(p), 'from d', st.d); }
    }
    if (st.fallen) page.__wasFallen = true;
    // (the DDA counts game-overs in a segment, not crashes: ASSIST comes with the second game-over there)
    if (st.state === 'gameover' && !page.__go) {
      page.__go = true;
      const offered = await page.evaluate(() => { const b = document.getElementById('assist-btn'); return !!b && b.style.display !== 'none'; });
      console.log('  assist: game over, ASSIST offered =', offered);
      await page.evaluate(() => document.getElementById('btn-restart').click());
      if (offered) { page.__assistDone = true; await bots(page, { dodge: true, offset: 0, collect: false }); }
      else page.__aim = null;   // keep crashing
    }
    if (st.state === 'playing') page.__go = false;
  }
  // a crash on a pylon standing between crashWindow[0] and [1] metres (So Close: within 10 m of the line)
  if (sc.crashWindow && !page.__cw && st.d >= sc.crashWindow[0] - 70 && st.state === 'playing') {
    const p = await page.evaluate((w) => {
      const items = (window._game.obstacleManager._items || []).filter(i => i.absoluteD >= w[0] && i.absoluteD <= w[1] && !i._hidden).sort((x, y) => x.absoluteD - y.absoluteD);
      if (items[0]) return { d: items[0].absoluteD, x: items[0].lateralOffset, what: 'pylon' };
      // no pylon there: the nearest roadside tree in the window (the road's right vector is (cos h, -sin h), as the collectibles place themselves)
      const g = window._game, rp = g.world.roadPath;
      const trees = (g.world._treePool || []).filter(t => t.active && t.mesh.visible && t.roadD >= w[0] && t.roadD <= w[1]).map(t => {
        const pt = rp.getPointAtDistance(t.roadD);
        return { d: t.roadD, x: (t.mesh.position.x - pt.x) * Math.cos(pt.heading) - (t.mesh.position.z - pt.z) * Math.sin(pt.heading), what: 'tree' };
      }).sort((p, q) => Math.abs(p.x) - Math.abs(q.x));
      return trees[0] || { all: trees.length };
    }, sc.crashWindow);
    page.__cw = true;
    if (p.d) { await bots(page, { dodge: false, offset: p.x, path: null, collect: false, sway: { amp: 0, freq: 0, phase: 0 } }); console.log('  crash window: aiming at the ' + p.what, JSON.stringify(p), 'from d', st.d); }
    else console.log('  crash window: no pylon in', JSON.stringify(sc.crashWindow), 'near:', JSON.stringify(p.all));
  }
  // a false start: at GO both riders throw their weight one way (no road-following, no steadying) until they are down
  if (sc.falseStart && st.state === 'playing' && !page.__fs) { page.__fs = true; await bots(page, { extra: 1.0, steer: 0, stab: 0, sway: { amp: 0, freq: 0, phase: 0 } }); }
  if (sc.leanOutAt && st.d >= sc.leanOutAt && st.state === 'playing' && !page.__lo) { page.__lo = true; await bots(page, { extra: 1.0, steer: 0, stab: 0, sway: { amp: 0, freq: 0, phase: 0 } }); }
  if (sc.falseStart && page.__fs && st.fallen && !page.__fsDone) { page.__fsDone = true; await bots(page, { extra: 0, steer: 0.9, stab: 0.35 }); }
  if (sc.share && ['victory', 'gameover'].includes(st.state) && !page.__shared) {
    page.__shared = true;
    await page.evaluate(() => { const b = document.getElementById('btn-daily-share-victory') || document.getElementById('btn-daily-share-gameover'); if (b) b.click(); });
  }
}

/** Pass 1: ride until this achievement's toast (or the ride is over). Returns {T, st, earned, pair}. */
async function findMoment(id, sc, name) {
  const s = await ride(id, sc);
  const { page } = s;
  let T = null, st = null, over = 0;
  for (let t = 0; t < 200; t += 0.25) {
    await advance(page, 0.25);
    st = await rideState(page);
    await steer(page, sc, st);
    if (sc.gustAt && t === 1) console.log('  disruptions', await page.evaluate(() => JSON.stringify({ planned: window._game._disruptions, active: !!window._game._activeDisruption, state: window._game.state, mode: window._game.mode })));
    // REEL_TRACE=1: the bike's line every poll (what breaks a strip / steady run)
    if (process.env.REEL_TRACE && Math.round(t * 4) % 2 === 0) console.log('  trace', t.toFixed(1), await page.evaluate(() => { const g = window._game, b = g.bike, r = g.achievements.ride; return JSON.stringify({ st: g.state, d: +b.distanceTraveled.toFixed(0), x: +(b._lateralOffset || 0).toFixed(2), v: +b.speed.toFixed(1), lean: +(b.lean || 0).toFixed(2), edge: +(b._edgeIntensity || 0).toFixed(2), strip: !!b.onCenterStrip, sRun: +(r.stripRun || 0).toFixed(1), stRun: +(r.steadyRun || 0).toFixed(1), lo: +(window.__reel.bots[0]?.leanOut || 0).toFixed(2), dis: g._activeDisruption ? g._activeDisruption.phase : null, gust: !!g.achievements.ride.gustActive }); }));
    T = await toastFor(page, id, name);
    if (T != null) break;
    // a toast up before the anchor (Team Player: safe riding from the first frame) is logged with no time: the moment is the start
    if (sc.atStart && await page.evaluate((nm) => window.__ach.toasts.some(x => x[1] === nm), name)) { T = 0; break; }
    // the finish's toasts come with the result sheet, after the finish cinematic: wait that out, then 10 s more
    if (['victory', 'gameover', 'lobby'].includes(st.state)) { if (++over > 40) break; }
  }
  const info = await page.evaluate(() => ({ earned: [...(window._game.achievements?._earned?.keys?.() || [])].filter(i => !window.__achPre.includes(i)),
    toasts: window.__ach.toasts, medal: window._game._lastFinish?.medal || null, pair: window._game._lastPairSummary || null, partner: (() => { try { return window._game._partnerKey(); } catch (e) { return null; } })(),
    // the ride's own numbers, for tuning a scenario that missed
    ride: (() => { const r = window._game.achievements.ride || {}; const cm = window._game.collectibleManager, g = window._game; return { strip: +(r.stripBest || 0).toFixed(1), steady: +(r.steadyBest || 0).toFixed(1), treeHits: r.treeHits, offroad: +(r.offroadT || 0).toFixed(1),
      crashes: window.__ach.calls.filter(c => c[1] === 'crash').map(c => +c[0].toFixed(1)), cause: g._lastCrashCause || null,
      assist: { offered: r.assistOffered, used: r.assistUsed, weight: g._assistWeight || 0, ref: r.ref === g.raceManager }, restarts: g.raceManager ? g.raceManager.restartCount : null, timeLeft: g.raceManager && g.raceManager.timeRemaining != null ? +g.raceManager.timeRemaining.toFixed(1) : null,
      missed: ((cm && cm._items) || []).filter(i => !i.collected).map(i => [+i.absoluteD.toFixed(0), +i.lateralOffset.toFixed(1)]),
      // the pylon nearest each missed present
      beside: ((cm && cm._items) || []).filter(i => !i.collected).map(i => { const near = (g.obstacleManager._items || []).map(o => [+o.absoluteD.toFixed(0), +o.lateralOffset.toFixed(1), Math.abs(o.absoluteD - i.absoluteD)]).sort((a, b) => a[2] - b[2])[0]; return near ? [+i.absoluteD.toFixed(0), near[0], near[1]] : null; }) }; })() }));
  await s.close();
  return { T, st, ...info };
}

/** Pass 2: ride again and record from T - pre to T + post. */
async function recordMoment(id, sc, T) {
  const MARGIN = 0.75;   // the passes agree to a few tenths of a second; edit.py cuts by the logged toast
  const pre = (sc.pre ?? 2.5) + MARGIN, post = (sc.post ?? 3.0) + MARGIN;
  const s = await ride(id, sc);
  const { page } = s;
  const startAt = Math.max(0, T - pre);
  for (;;) {
    const now = await vt(page);
    if (now >= startAt - 0.26) break;
    await advance(page, 0.25);
    await steer(page, sc, await rideState(page));
  }
  for (;;) { const now = await vt(page); if (now >= startAt) break; await advance(page, 1 / 60); }
  if (sc.cam) await cam(page, sc.cam);
  const tag = `${id}_together`;
  await take(tag, s, pre + post, async () => {
    const st = await rideState(page);
    await steer(page, sc, st);
    if (sc.cam) await page.evaluate(() => { if (window._game.state !== 'playing' && window.__reel.cam) window.__reel.setCamera(null); });
  });
  return { pre, post, tag };
}

// the other rigs (achievement-modes.mjs): the Slingshot, the garage, versus
const FIND = { sling: slingFind, versus: versusFind };
const RECORD = { sling: slingRecord, versus: versusRecord };

const list = wanted(args.find(a => !a.startsWith('--')));
const results = [];
for (const id of list) {
  const sc = SCENARIOS[id];
  const name = nameOf(id);
  if (!sc) { console.log(`== ${id}: no scenario`); results.push({ id, skipped: 'no scenario' }); continue; }
  if (sc.todo) { console.log(`== ${id}: TODO ${sc.todo}`); results.push({ id, skipped: sc.todo }); continue; }
  console.log(`== ${id} (${name}) ${ASPECT}`);
  try {
    if (LEAD) await leadIn(id, id);
    if (sc.kind === 'garage') {
      // one pass: the garage, a beat, the click, the toast (nothing to find first)
      if (PROBE) { const m = await garageMoment(id, sc, { probe: true }); console.log(`  moment T=${m.T == null ? 'NONE' : m.T.toFixed(2) + ' s'} ${JSON.stringify(m.st)} toasts=${JSON.stringify(m.toasts)}`); results.push(m.T == null ? { id, failed: 'no toast', st: m.st } : { id, T: m.T }); continue; }
      const r = await garageMoment(id, sc);
      const meta = JSON.parse(fs.readFileSync(path.join(AOUT, `${r.tag}-${ASPECT}.json`), 'utf8'));
      const got = meta.toasts[0] ? meta.toasts[0][0] : null;
      console.log(`  recorded ${r.pre + r.post} s, toast at ${got == null ? 'NONE' : got.toFixed(2)} (expected ~${r.pre + 0.1})`);
      results.push(got == null ? { id, failed: 'no toast' } : { id, T: got, toastAt: got });
      continue;
    }
    const m = await (FIND[sc.kind] || findMoment)(id, sc, name);
    console.log(`  moment T=${m.T == null ? 'NONE' : m.T.toFixed(2) + ' s'} state=${JSON.stringify(m.st)} earned=${JSON.stringify(m.earned)} partner=${m.partner} toasts=${JSON.stringify((m.toasts || []).map(t => [+(t[0] || 0).toFixed(2), t[1]]))}${m.ride ? ' ride=' + JSON.stringify(m.ride) : ''}${m.run ? ' run=' + JSON.stringify(m.run) : ''}${m.winner ? ' winner=' + m.winner : ''}`);
    if (m.T == null) { results.push({ id, failed: 'no toast', st: m.st, earned: m.earned, ride: m.ride }); continue; }
    if (PROBE) { results.push({ id, T: m.T, earned: m.earned }); continue; }
    const r = await (RECORD[sc.kind] || recordMoment)(id, sc, m.T);
    const metaPath = path.join(AOUT, `${r.tag}-${ASPECT}.json`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (sc.atStart && !(meta.toasts[0] && meta.toasts[0][0] != null)) { meta.toasts = [[0, name]]; fs.writeFileSync(metaPath, JSON.stringify(meta)); }   // up from the first frame
    const got = meta.toasts[0] ? meta.toasts[0][0] : null;
    console.log(`  recorded ${r.pre + r.post} s, toast at ${got == null ? 'NONE' : got.toFixed(2)} (expected ${r.pre})`);
    results.push({ id, T: m.T, toastAt: got, drift: got == null ? null : +(got - r.pre).toFixed(2) });
  } catch (e) {
    console.log('  FAILED', id, e.stack);
    results.push({ id, failed: e.message });
  }
}
fs.writeFileSync(path.join(AOUT, `all-${ASPECT}${PROBE ? '-probe' : ''}.json`), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results));
process.exit(0);
