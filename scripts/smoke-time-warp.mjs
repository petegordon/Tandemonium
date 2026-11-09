#!/usr/bin/env node
// smoke:time-warp · #611 the Time Warp bike: a special bike in the chooser, its own model on the tandem's rig.
//
//   TW-01  the Time Warp sits before the Gold Standard at the chooser's end: locked it shows a dark silhouette with "n of N" over it
//          (N = the non-calendar achievements less 5: 90 once the #608 swap lands),
//          and picking it leaves the ride on the default bike
//   TW-02  with all non-calendar achievements but 5 it unlocks: its colours come back, its clock and flames
//          run in the preview, and it becomes the pick
//   TW-03  a solo ride loads time_warp_tandem.glb: both geese seated on its sockets, the TimeWarpFX loop playing
//          (cut to the clock + flame bones), the wheel measured, and sized exactly like the goose tandem
//   TW-04  Show Riders off rides the plain frame; on again brings the Time Warp back
//   TW-05  picking a paint preset again rides the goose tandem
//   TW-06  at 1080p the count is readable and the bike's name shows inside the preview
//   AT-01  the chooser turns to the next bike every 5 s on its own (Pete); AT-02 leaving the mode screen puts the
//          player's own bike back; AT-03 RB stops it for good; locked reward bikes show the lock + their icon;
//          AT-04 the bike is remembered between sessions (never a locked one)
//   DR-01  the Dressing Room seats the goose on the chooser's pick (Gold Standard, a paint, Solo Flight when alone)
//   SF-01  Solo Flight (the Penny-Farthing, player bots) sits before it: a locked silhouette with "n of N solo
//          achievements"; once earned it shows in colour and is the pick (#644: it rides, smoke:solo-flight)
//   GS-01  the Gold Standard closes the chooser: a locked silhouette with "n of 100 achievements"
//   GS-02  with all 100 it shows in its own colours and is the pick
//   GS-03  a solo ride loads gold_standard_tandem.glb: both geese seated on its sockets, sized like the goose tandem
import { startHarness, sleep } from './lib/smoke-harness.mjs';

const h = await startHarness({ port: 8974, outDir: 'tandemonium-time-warp' });
const { check } = h;
const until = (page, fn, arg, timeout = 90000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const page = await h.gamePage({ storage: { tandemonium_tutorial_done: 'smoke', tandemonium_show_riders: 'on' } });
await until(page, () => window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel);

const chooser = () => page.evaluate(() => {
  const l = window._game.lobby;
  const sp = (l._specialPreviews || {}).time_warp;
  const hint = document.getElementById('bike-hint');
  return {
    key: l._presetKeys[l._presetIndex], picked: l.selectedPresetKey,
    name: document.getElementById('bike-name').textContent,
    hint: hint && hint.style.display !== 'none' ? hint.textContent.replace(/\s+/g, ' ').trim() : '',
    tandemShown: !!l._previewModel && l._previewModel.visible,
    twShown: !!(sp && sp.model && sp.model.visible), dark: !!(sp && sp.dark), fxTime: sp && sp.fx ? +sp.fx.time.toFixed(3) : null,
  };
});

console.log('TW-01 locked: the silhouette and its count');
await page.evaluate(() => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('time_warp'); l._applyPresetToPreview(); });
await until(page, () => { const sp = (window._game.lobby._specialPreviews || {}).time_warp; return !!(sp && sp.model && sp.model.visible); });
let c = await chooser();
check(c.key === 'time_warp' && /Time Warp/.test(c.name) && c.name.startsWith('🔒'), 'TW-01: the Time Warp is locked', c);
check(await page.evaluate(() => window._game.lobby._presetKeys.slice(-3).join(',')) === 'solo_flight,time_warp,gold_standard', 'TW-01: Solo Flight, Time Warp, then Gold Standard close the chooser (the reward ladder)');

console.log('SF-01 Solo Flight: locked silhouette, "n of N solo achievements"; earned = in colour, the pick');
const sf = async () => {
  await page.evaluate(() => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('solo_flight'); l._applyPresetToPreview(); });
  await until(page, () => { const sp = (window._game.lobby._specialPreviews || {}).solo_flight; return !!(sp && sp.model && sp.model.visible); });
  return page.evaluate(() => {
    const l = window._game.lobby, sp = l._specialPreviews.solo_flight, h = document.getElementById('bike-hint');
    return { name: document.getElementById('bike-name').textContent, hint: h && h.style.display !== 'none' ? h.textContent.replace(/\s+/g, ' ').trim() : '',
      dark: sp.dark, picked: l.selectedPresetKey, tandem: l._previewModel.visible,
      others: Object.entries(l._specialPreviews).filter(([k, v]) => k !== 'solo_flight' && v.model && v.model.visible).map(([k]) => k) };
  });
};
let s1 = await sf();
const sfNeed = await page.evaluate(async () => (await import('/js/rewards.js')).playerBotsProgress([]).need);
check(s1.name.startsWith('\uD83D\uDD12') && s1.name.includes('Solo Flight') && s1.dark && s1.picked === 'default', 'SF-01: Solo Flight is a locked dark silhouette; the ride stays on the default', s1);
check(s1.hint.replace(/\s+/g, '') === `0of${sfNeed}soloachievements`, 'SF-01: "n of N solo achievements" over it (N = solo less 1: 80 once #608 lands)', [s1.hint, sfNeed]);
check(s1.others.length === 0 && !s1.tandem, 'SF-01: only its own model shows', s1);
await page.evaluate(async () => {
  const { soloAchievementIds } = await import('/js/rewards.js');
  const ach = window._game.lobby._achievements;
  window.__sfBackup = new Map(ach._earned);
  for (const id of soloAchievementIds().slice(1)) ach._earned.set(id, { id, earnedAt: 1 });
});
s1 = await sf();
check(!s1.dark && !s1.hint && s1.picked === 'solo_flight', 'SF-01: earned, it shows in colour and is the pick (#644)', s1);
await h.shot(page, 'sf01-earned');
await page.evaluate(() => { window._game.lobby._achievements._earned = window.__sfBackup; });
await page.evaluate(() => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('time_warp'); l._applyPresetToPreview(); });
const need = await page.evaluate(async () => (await import('/js/rewards.js')).timeWarpProgress([]).need);
check(c.hint.replace(/\s+/g, '') === `0of${need}non-calendarachievements`, 'TW-01: "n of N" over the silhouette (N = non-calendar less 5)', [c.hint, need]);
const sizes = await page.evaluate(() => { const h = document.getElementById('bike-hint'); const sp = h.querySelectorAll('span');
  return { count: parseFloat(getComputedStyle(sp[0]).fontSize), label: parseFloat(getComputedStyle(sp[1]).fontSize) }; });
check(sizes.count >= sizes.label, 'TW-01: the count is at least as big as its label (the TV scales the label)', sizes);
check(c.twShown && !c.tandemShown && c.dark, 'TW-01: its own model, dark', c);
check(c.picked === 'default', 'TW-01: a locked Time Warp leaves the ride on the default bike', c.picked);
await h.shot(page, 'tw01-locked');

console.log('TW-02 unlocked with all non-calendar achievements but 5');
await page.evaluate(async () => {
  const { isCalendarAchievement } = await import('/js/rewards.js');
  const { ACHIEVEMENTS } = await import('/js/achievement-defs.js');
  const ach = window._game.lobby._achievements;
  for (const a of ACHIEVEMENTS.filter(d => !isCalendarAchievement(d)).slice(5)) ach._earned.set(a.id, { id: a.id, earnedAt: 1 });
  window._game.lobby._applyPresetToPreview();
});
c = await chooser();
check(c.picked === 'time_warp' && c.name.includes('Time Warp') && !c.name.startsWith('🔒') && !c.hint, 'TW-02: unlocked, it is the pick', c);
check(c.twShown && !c.dark, 'TW-02: in its own colours', c);
await sleep(600);
const c2 = await chooser();
check(c.fxTime !== null && c2.fxTime !== c.fxTime, 'TW-02: its clock and flames run in the preview', [c.fxTime, c2.fxTime]);
await h.shot(page, 'tw02-unlocked');

console.log('TW-03 a solo ride on the Time Warp');
await page.evaluate(() => window._game._onSolo());
const loaded = await until(page, () => { const b = window._game.bike; return b._modelPath.endsWith('time_warp_tandem.glb') && b.modelLoaded && b.goose && Object.keys(b.goose.riders).length === 2; }, null, 180000);
const ride = await page.evaluate(() => {
  const b = window._game.bike, g = b.goose;
  const model = b.group.children[0];
  const tracks = g && g.fx ? [...new Set(g.fx.getClip().tracks.map(t => t.name.slice(0, t.name.lastIndexOf('.'))))] : [];
  const t0 = g && g.fx ? g.fx.time : null;
  return { path: b._modelPath, seats: g ? Object.fromEntries(Object.entries(g.riders).map(([s, r]) => [s, r.root.parent && r.root.parent.name])) : null,
    fx: !!(g && g.fx), fxBones: tracks, t0, wheel: g ? +g.wheelCircumference.toFixed(3) : 0, scale: model ? +model.scale.x.toFixed(4) : 0 };
});
check(loaded && ride.seats && ride.seats.Captain === 'Seat_Captain' && ride.seats.Stoker === 'Seat_Stoker', 'TW-03: both geese seated on the Time Warp', ride);
check(ride.fx && ride.fxBones.length === 12 && ride.fxBones.every(n => /^(Clock|Flame)/.test(n)), 'TW-03: TimeWarpFX bound, cut to the clock + flame bones', ride.fxBones);
await sleep(700);
const t1 = await page.evaluate(() => { const g = window._game.bike.goose; g.update(); return g.fx.time; });
check(t1 !== ride.t0, 'TW-03: the effects run on the wall clock', [ride.t0, t1]);
check(ride.wheel > 3.5 && ride.wheel < 4.0, 'TW-03: the rear wheel measured (wheels turn with the distance)', ride.wheel);
check(Math.abs(ride.scale - 4.4 / 2.466) < 0.002, 'TW-03: sized like the goose tandem (same geese)', ride.scale);
await h.shot(page, 'tw03-ride');

console.log('TW-04 Show Riders off / on');
// (the Options button waits for the lobby mid-ride; _applyShowRiders is what it runs there)
await page.evaluate(() => window._game._applyShowRiders(false));
check(await until(page, () => window._game.bike._modelPath.endsWith('tandem_bicycle.glb')), 'TW-04: riders off rides the plain frame', await page.evaluate(() => window._game.bike._modelPath));
await page.evaluate(() => window._game._applyShowRiders(true));
check(await until(page, () => window._game.bike._modelPath.endsWith('time_warp_tandem.glb')), 'TW-04: riders on again brings the Time Warp back', await page.evaluate(() => window._game.bike._modelPath));

console.log('TW-05 back to a paint preset');
await page.evaluate(() => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('bike_red'); l._applyPresetToPreview(); window._game._applyBikeChoice(); });
check(await until(page, () => window._game.bike._modelPath.endsWith('goose_tandem.glb')), 'TW-05: a paint preset rides the goose tandem again', await page.evaluate(() => window._game.bike._modelPath));
console.log('GS-01 Gold Standard locked: the silhouette and "0 of 100 achievements"');
const gs = async () => {
  await page.evaluate(() => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('gold_standard'); l._applyPresetToPreview(); });
  await until(page, () => { const sp = (window._game.lobby._specialPreviews || {}).gold_standard; return !!(sp && sp.model && sp.model.visible); });
  return page.evaluate(() => {
    const l = window._game.lobby, sp = l._specialPreviews.gold_standard, h = document.getElementById('bike-hint');
    return { name: document.getElementById('bike-name').textContent, hint: h && h.style.display !== 'none' ? h.textContent.replace(/\s+/g, ' ').trim() : '',
      dark: sp.dark, picked: l.selectedPresetKey, tandem: l._previewModel.visible, last: l._presetKeys[l._presetKeys.length - 1],
      sparkle: sp.sparkle ? sp.sparkle.meshes.some(m => m.visible) : null,
      others: Object.entries(l._specialPreviews).filter(([k, v]) => k !== 'gold_standard' && v.model && v.model.visible).map(([k]) => k) };
  });
};
await page.evaluate(() => { const ach = window._game.lobby._achievements; window.__gsBackup = new Map(ach._earned); ach._earned = new Map(); });
let g1 = await gs();
check(g1.last === 'gold_standard' && g1.name.startsWith('\uD83D\uDD12') && g1.name.includes('Gold Standard') && g1.dark && g1.picked === 'default',
  'GS-01: the last entry is the locked Gold Standard, a dark silhouette; the ride stays on the default', g1);
check(g1.hint.replace(/\s+/g, '') === '0of100achievements', 'GS-01: "0 of 100 achievements" over it', g1.hint);
check(g1.others.length === 0 && !g1.tandem, 'GS-01: only its own model shows', g1);
check(g1.sparkle === false, 'GS-01: a locked silhouette does not sparkle (#697)', g1.sparkle);
await h.shot(page, 'gs01-locked');
console.log('GS-02 all 100: its colours, the pick');
await page.evaluate(async () => {
  const { ACHIEVEMENTS } = await import('/js/achievement-defs.js');
  const ach = window._game.lobby._achievements;
  for (const a of ACHIEVEMENTS.slice(1)) ach._earned.set(a.id, { id: a.id, earnedAt: 1 });
});
g1 = await gs();
check(g1.dark && g1.hint.replace(/\s+/g, '') === '99of100achievements', 'GS-02: 99 of 100 is still locked', g1);
await page.evaluate(async () => {
  const { ACHIEVEMENTS } = await import('/js/achievement-defs.js');
  window._game.lobby._achievements._earned.set(ACHIEVEMENTS[0].id, { id: ACHIEVEMENTS[0].id, earnedAt: 1 });
});
g1 = await gs();
check(!g1.dark && !g1.hint && g1.picked === 'gold_standard' && g1.name.includes('Gold Standard') && !g1.name.startsWith('\uD83D\uDD12'),
  'GS-02: all 100, it shows in its own colours and is the pick', g1);
check(g1.sparkle === true, 'GS-02: earned, its gold sparkles (#697)', g1.sparkle);
await h.shot(page, 'gs02-unlocked');
console.log('GS-03 the Gold Standard swapped in mid-ride (as the chooser does)');
await page.evaluate(() => window._game._applyBikeChoice());
const gsLoaded = await until(page, () => { const b = window._game.bike; return b._modelPath.endsWith('gold_standard_tandem.glb') && b.modelLoaded && b.goose && Object.keys(b.goose.riders).length === 2; }, null, 180000);
const gsRide = await page.evaluate(() => {
  const b = window._game.bike, g = b.goose, model = b.group.children[0];
  return { path: b._modelPath, seats: g ? Object.fromEntries(Object.entries(g.riders).map(([s, r]) => [s, r.root.parent && r.root.parent.name])) : null,
    wheel: g ? +g.wheelCircumference.toFixed(3) : 0, scale: model ? +model.scale.x.toFixed(4) : 0,
    sparkles: (() => { let n = 0; b.group.traverse(o => { if (o.material && o.material.name === 'bike-sparkle' && o.visible) n++; }); return n; })() };
});
check(gsRide.sparkles > 0, 'GS-03: its gold sparkles in the ride (#697)', gsRide.sparkles);
check(gsLoaded && gsRide.seats && gsRide.seats.Captain === 'Seat_Captain' && gsRide.seats.Stoker === 'Seat_Stoker', 'GS-03: both geese seated on the Gold Standard', gsRide);
check(gsRide.wheel > 3.5 && gsRide.wheel < 4.0, 'GS-03: the rear wheel measured', gsRide.wheel);
check(Math.abs(gsRide.scale - 4.4 / 2.466) < 0.002, 'GS-03: sized like the goose tandem (same geese)', gsRide.scale);
await sleep(1500);
await h.shot(page, 'gs03-ride');
await page.evaluate(() => { window._game.lobby._achievements._earned = window.__gsBackup; });
console.log('TW-06 the count on a 1080p screen (the TV / Steam big-screen lobby)');
const big = await h.gamePage({ viewport: { width: 1920, height: 1080 }, storage: { tandemonium_tutorial_done: 'smoke', tandemonium_show_riders: 'on' } });
await until(big, () => window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel);
const bigSizes = await big.evaluate(() => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('time_warp'); l._applyPresetToPreview();
  const h = document.getElementById('bike-hint'); const sp = h.querySelectorAll('span');
  return { text: h.textContent.replace(/\s+/g, ' ').trim(), count: parseFloat(getComputedStyle(sp[0]).fontSize), label: parseFloat(getComputedStyle(sp[1]).fontSize) }; });
check(bigSizes.count >= bigSizes.label && /non-calendar achievements$/.test(bigSizes.text), 'TW-06: at 1080p the count is at least as big as "non-calendar achievements"', bigSizes);
const nameBox = await big.evaluate(() => {
  const n = document.getElementById('bike-name').getBoundingClientRect(), w = document.getElementById('bike-preview-wrap').getBoundingClientRect();
  return { text: document.getElementById('bike-name').textContent, inside: n.top >= w.top && n.bottom <= w.bottom && n.left >= w.left && n.right <= w.right, h: Math.round(n.height) };
});
check(nameBox.inside && nameBox.h > 0 && /Time Warp/.test(nameBox.text), 'TW-06: the bike name shows inside the preview (it clips; a name above it was cut off)', nameBox);
await h.shot(big, 'tw06-1080p');

console.log('AT-01..03 the chooser shows itself off (every 5 s) until Player 1 takes it');
const at = await h.gamePage({ viewport: { width: 1600, height: 900 }, storage: { tandemonium_tutorial_done: 'smoke', tandemonium_show_riders: 'on', tandemonium_chooser_attract: 'on' } });
await until(at, () => window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel);
const nKeys = await at.evaluate(() => window._game.lobby._presetKeys.length);
const idx = () => at.evaluate(() => ({ i: window._game.lobby._presetIndex, key: window._game.lobby._presetKeys[window._game.lobby._presetIndex],
  picked: window._game.lobby.selectedPresetKey, name: document.getElementById('bike-name').textContent }));
const a0 = await idx();
await sleep(5600);
const a1 = await idx();
check(a1.i === (a0.i + 1) % nKeys, 'AT-01: after 5 s the chooser turns to the next bike on its own', [a0, a1]);
await sleep(5200);
const a2 = await idx();
check(a2.i === (a1.i + 1) % nKeys, 'AT-01: and again 5 s later', [a1, a2]);
console.log("AT-02 leaving the mode screen mid-show puts the player's own bike back");
await at.evaluate(() => document.getElementById('btn-solo').click());
await sleep(700);
const a3 = await idx();
check(a3.key === 'default' && a3.picked === 'default', "AT-02: Solo Ride while it turns: the ride keeps the player's own bike", a3);
await at.evaluate(() => window._game.lobby._showStep(window._game.lobby.modeStep));
await sleep(5600);
const a4 = await idx();
check(a4.i !== a3.i, 'AT-02: back on the mode screen it shows itself off again', [a3, a4]);
console.log('AT-03 RB (or a click on the arrows) stops it: the bike showing is theirs');
await at.evaluate(() => window._game.lobby._bikeNext());
const a5 = await idx();
await sleep(6000);
const a6 = await idx();
check(a6.i === a5.i && a6.key === a5.key, 'AT-03: after Player 1 takes the chooser it stays put', [a5, a6]);
const lockName = await at.evaluate(() => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('solo_flight'); l._applyPresetToPreview(); return document.getElementById('bike-name').textContent; });
check(lockName.startsWith('\uD83D\uDD12') && lockName.includes('\uD83E\uDEB6') && lockName.includes('Solo Flight'), 'AT-03: a locked reward bike shows the lock and its own icon', lockName);
console.log('AT-04 the bike is remembered between sessions');
const rp = await h.gamePage({ viewport: { width: 1600, height: 900 }, storage: { tandemonium_tutorial_done: 'smoke', tandemonium_show_riders: 'on', tandemonium_bike_pick: 'bike_blue' } });
await until(rp, () => window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel);
await sleep(500);
const r0 = await rp.evaluate(() => ({ key: window._game.lobby._presetKeys[window._game.lobby._presetIndex], picked: window._game.lobby.selectedPresetKey, name: document.getElementById('bike-name').textContent }));
check(r0.key === 'bike_blue' && r0.picked === 'bike_blue', 'AT-04: the saved bike is the one the chooser opens on (and rides)', r0);
const r1 = await rp.evaluate(() => { window._game.lobby._bikeNext(); return { key: window._game.lobby.selectedPresetKey, saved: localStorage.getItem('tandemonium_bike_pick') }; });
check(r1.saved === r1.key && r1.key !== 'bike_blue', 'AT-04: a new pick is saved for next time', r1);
const r2 = await rp.evaluate(() => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('gold_standard') - 1; l._bikeNext(); return { shown: l._presetKeys[l._presetIndex], saved: localStorage.getItem('tandemonium_bike_pick') }; });
check(r2.shown === 'gold_standard' && r2.saved !== 'gold_standard', 'AT-04: a locked reward bike is never saved as the pick', r2);
console.log('DR-01 the Dressing Room seats the goose on the bike picked in the chooser');
const drBike = async (key) => {
  const pg = await h.gamePage({ viewport: { width: 1600, height: 900 }, storage: { tandemonium_tutorial_done: 'smoke', tandemonium_show_riders: 'on' } });
  await until(pg, () => window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel);
  await pg.evaluate(async (k) => {
    const { ACHIEVEMENTS } = await import('/js/achievement-defs.js');
    const a = window._game.lobby._achievements; for (const d of ACHIEVEMENTS) a._earned.set(d.id, { id: d.id, earnedAt: 1 });
    const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf(k); l._applyPresetToPreview(); l._openDressingRoom(1);
  }, key);
  const seated = await until(pg, () => { const p = window._game.lobby._room && window._game.lobby._room._preview; return !!(p && p.loaded('p1')); });
  const out = await pg.evaluate(() => {
    const p = window._game.lobby._room._preview;
    let sparkles = 0, red = false;
    for (const sl of p._slots.values()) sl.bike && sl.bike.traverse((o) => {
      if (o.material && o.material.name === 'bike-sparkle') sparkles++;
      for (const m of [].concat(o.material || [])) if (m && m.color && m.color.r > 0.6 && m.color.g < 0.2 && m.color.b < 0.2) red = true;
    });
    return { bike: p.bikePath, sparkles, red };
  });
  await h.shot(pg, 'dr01-' + key);
  await pg.close();
  return { seated, ...out };
};
const dg = await drBike('gold_standard');
check(dg.seated && /gold_standard_tandem\.glb$/.test(dg.bike) && dg.sparkles > 0, 'DR-01: on the Gold Standard (sparkling) when it is the pick', dg);
const dr = await drBike('bike_red');
check(dr.seated && /goose_tandem\.glb$/.test(dr.bike) && dr.red, 'DR-01: a paint pick: the goose tandem in that paint (not dimmed grey)', dr);
const ds = await drBike('solo_flight');
check(ds.seated && /solo_flight_tandem\.glb$/.test(ds.bike), 'DR-01: Solo Flight with Player 1 alone: the Penny-Farthing (pedalling with its own clips)', ds);
await h.finish();
