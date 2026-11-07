#!/usr/bin/env node
// smoke:time-warp · #611 the Time Warp bike: a special bike in the chooser, its own model on the tandem's rig.
//
//   TW-01  the chooser's last entry is the Time Warp: locked it shows a dark silhouette with "n of N" over it
//          (N = the non-calendar achievements less 5: 90 once the #608 swap lands),
//          and picking it leaves the ride on the default bike
//   TW-02  with all non-calendar achievements but 5 it unlocks: its colours come back, its clock and flames
//          run in the preview, and it becomes the pick
//   TW-03  a solo ride loads time_warp_tandem.glb: both geese seated on its sockets, the TimeWarpFX loop playing
//          (cut to the clock + flame bones), the wheel measured, and sized exactly like the goose tandem
//   TW-04  Show Riders off rides the plain frame; on again brings the Time Warp back
//   TW-05  picking a paint preset again rides the goose tandem
//   SF-01  Solo Flight (the Penny-Farthing, player bots) sits before it: a locked silhouette with "n of N solo
//          achievements"; once earned it shows in colour as "Coming soon" and the ride stays on the default
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
check(c.key === 'time_warp' && /Time Warp/.test(c.name) && c.name.startsWith('🔒'), 'TW-01: the last chooser entry is the locked Time Warp', c);
check(await page.evaluate(() => window._game.lobby._presetKeys.slice(-2).join(',')) === 'solo_flight,time_warp', 'TW-01: Solo Flight then Time Warp close the chooser (the reward ladder)');

console.log('SF-01 Solo Flight: locked silhouette, "n of N solo achievements"; earned = coming soon, not ridden yet');
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
check(!s1.dark && /Coming soon/.test(s1.hint) && s1.picked === 'default', 'SF-01: earned, it shows in colour as coming soon and is not ridden yet', s1);
await h.shot(page, 'sf01-coming-soon');
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
console.log('TW-06 the count on a 1080p screen (the TV / Steam big-screen lobby)');
const big = await h.gamePage({ viewport: { width: 1920, height: 1080 }, storage: { tandemonium_tutorial_done: 'smoke', tandemonium_show_riders: 'on' } });
await until(big, () => window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel);
const bigSizes = await big.evaluate(() => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('time_warp'); l._applyPresetToPreview();
  const h = document.getElementById('bike-hint'); const sp = h.querySelectorAll('span');
  return { text: h.textContent.replace(/\s+/g, ' ').trim(), count: parseFloat(getComputedStyle(sp[0]).fontSize), label: parseFloat(getComputedStyle(sp[1]).fontSize) }; });
check(bigSizes.count >= bigSizes.label && /non-calendar achievements$/.test(bigSizes.text), 'TW-06: at 1080p the count is at least as big as "non-calendar achievements"', bigSizes);
await h.shot(big, 'tw06-1080p');
await h.finish();
