#!/usr/bin/env node
// smoke:bike-ladder · #736 the bike ladder and the "New bike!" screen.
//
//   BL-01  full game, no achievements: Berry and Cherry ride; Jungle is locked with "0 of 35 achievements"
//   BL-02  the pill says the next bike ("35 to Jungle Cruiser")
//   BL-02b the line keeps the bar one row: on the 1280x720 menu it drops (the tooltip still names the
//          bike); the 1280x720 join step (no art panel) and the 1600x900 menu have room, so it shows
//   BL-03  the first menu visit takes what the player has as seen (no screen)
//   BL-04  35 achievements, back on the menu: "New bike!" with Jungle Cruiser; RIDE IT NOW picks it and opens SOLO RIDE
//   BL-05  the Jungle ride to Grandma's that is also the 50th: "2 new bikes!" (Banana Delivery + Christmas Cruiser), one screen
//   BL-06  the end-of-ride screen: the next-bike line in the unlocked list, and "New bike!" over it with RIDE IT NOW
//   BL-09  the chooser: a locked colour bike keeps its paint; holiday bikes lit with their outfit geese; reward bikes silhouettes
//   BL-10  Settings › Bike Chooser Geese: beside the bike (the geese stand either side); back to on the bike
//   BL-07  demo → full game: one welcome screen, "Your demo riding earned you 32 achievements and 4 new bikes."
import { startHarness, sleep } from './lib/smoke-harness.mjs';

const h = await startHarness({ port: 8981, outDir: 'tandemonium-bike-ladder' });
const { check } = h;
const until = (page, fn, arg, timeout = 90000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const ready = (page) => until(page, () => window._game && window._game.lobby._presetKeys && window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel);

/** Give the page's player n achievements (none of the colour ones) plus `extra`. */
const grant = (page, n, extra = []) => page.evaluate(async ({ n, extra }) => {
  const { ACHIEVEMENTS } = await import('/js/achievement-defs.js');
  const filler = ACHIEVEMENTS.map(a => a.id).filter(id => !/^grandma_(default|orange|magenta|red|blue|green|yellow)$/.test(id));
  const ach = window._game.lobby._achievements;
  ach._earned = new Map();
  for (const id of [...filler.slice(0, n - extra.length), ...extra]) ach._earned.set(id, { id, earnedAt: 1 });
}, { n, extra });

const sheet = (page) => page.evaluate(() => {
  const s = document.getElementById('new-bike-sheet');
  return {
    open: !!(s && s.open),
    heading: s ? s.heading : '',
    bikes: s ? [...s.querySelectorAll('.nb-card')].map(c => c.dataset.bike) : [],
    welcome: s && s.querySelector('.nb-welcome') ? s.querySelector('.nb-welcome').textContent : '',
    ride: s ? [...s.querySelectorAll('.nb-ride')].map(b => b.textContent) : [],
    next: s && s.querySelector('.nb-next') ? s.querySelector('.nb-next').textContent : '',
  };
});

const page = await h.gamePage({ viewport: { width: 1600, height: 900 }, storage: { tandemonium_tutorial_done: 'smoke' } });
await ready(page);

// ── BL-01 the chooser ──
console.log('BL-01 the chooser');
await grant(page, 0);
const ch = await page.evaluate(() => {
  const l = window._game.lobby;
  const show = (k) => { l._presetIndex = l._presetKeys.indexOf(k); l._applyPresetToPreview();
    const hint = document.getElementById('bike-hint');
    return { picked: l.selectedPresetKey, name: document.getElementById('bike-name').textContent,
      hint: hint && hint.style.display !== 'none' ? hint.innerText.replace(/\s+/g, ' ').trim() : '' }; };
  return { berry: show('bike_magenta'), cherry: show('bike_red'), jungle: show('bike_green'), ocean: show('bike_blue') };
});
check(ch.berry.picked === 'bike_magenta' && ch.cherry.picked === 'bike_red', 'BL-01: Berry and Cherry come with the full game', ch);
check(ch.jungle.picked === 'default' && ch.jungle.name.startsWith('🔒') && ch.jungle.hint === '0 of 35 achievements',
  'BL-01: Jungle is locked with "0 of 35 achievements"', ch.jungle);
check(ch.ocean.hint === '0 of 65 achievements', 'BL-01: Ocean at 65', ch.ocean);
await page.evaluate(() => { const l = window._game.lobby; l._presetIndex = 0; l._applyPresetToPreview(); });

// ── BL-02 the pill ──
console.log('BL-02 the pill');
const pillOk = await until(page, () => (document.getElementById('bar-achievements-next') || {}).textContent === '35 to Jungle Cruiser', null, 5000);
check(pillOk, 'BL-02: the Achievements pill says the next bike', await page.evaluate(() => ({
  next: (document.getElementById('bar-achievements-next') || {}).textContent, title: document.getElementById('bar-achievements').title })));

// ── BL-02b the line keeps the bar one row ──
console.log('BL-02b the bar stays one row');
const barAt = async (w, hh) => {
  await page.setViewport({ width: w, height: hh });
  await sleep(500);
  return page.evaluate(() => {
    const bar = document.getElementById('lobby-bar'); const next = document.getElementById('bar-achievements-next');
    const rows = new Set(Array.from(bar.querySelectorAll('uf-button')).filter((b) => b.getBoundingClientRect().width > 0)
      .map((b) => Math.round(b.getBoundingClientRect().top / 10))).size;
    return { shown: !!next && next.getBoundingClientRect().width > 0, rows, title: document.getElementById('bar-achievements').title };
  });
};
const narrowMenu = await barAt(1280, 720);
await page.evaluate(() => { const l = window._game.lobby; l._showStep(l.joinStep); });
const narrowJoin = await barAt(1280, 720);
await page.evaluate(() => { const l = window._game.lobby; l._showStep(l.modeStep); });
const wide = await barAt(1600, 900);
check(!narrowMenu.shown && narrowMenu.rows === 1 && /Jungle Cruiser/.test(narrowMenu.title) && narrowJoin.shown && narrowJoin.rows === 1 && wide.shown && wide.rows === 1,
  'BL-02b: the next-bike line drops on a narrow bar (tooltip keeps it), and is back when the bar fits one row', { narrowMenu, narrowJoin, wide });

// ── BL-03 first visit: seeded, no screen ──
console.log('BL-03 first menu visit');
await page.evaluate(() => { localStorage.removeItem('tandemonium_bike_ladder'); const l = window._game.lobby; l._showStep(l.modeStep); });
await sleep(1200);
const seeded = await page.evaluate(() => JSON.parse(localStorage.getItem('tandemonium_bike_ladder') || 'null'));
check(!(await sheet(page)).open && seeded && seeded.bikes.length === 4 && seeded.edition === 'full',
  'BL-03: the first visit takes the four bikes as seen (no screen)', seeded);

// ── BL-04 crossing 35 ──
console.log('BL-04 crossing 35');
await grant(page, 35);
await page.evaluate(() => { const l = window._game.lobby; l._showStep(l.modeStep); });
await until(page, () => { const s = document.getElementById('new-bike-sheet'); return !!(s && s.open); }, null, 5000);
await sleep(1200);   // the roll-in
const s4 = await sheet(page);
await h.shot(page, 'bl04-new-bike');
check(s4.open && s4.heading === 'New bike!' && s4.bikes.join() === 'bike_green' && s4.ride.join() === 'RIDE IT NOW',
  'BL-04: "New bike!" with Jungle Cruiser and RIDE IT NOW', s4);
check(s4.next === 'Next: 15 more achievements to Banana Delivery', 'BL-04: it says the next bike', s4.next);
const pic = await until(page, () => {
  const sc = window._game.lobby.bikeCelebration._showcase;
  const c = document.querySelector('#new-bike-sheet canvas.nb-bike');
  if (!sc || !c || !sc.drawn('bike_green')) return false;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
  return lit > 2000;
}, null, 20000);
const nameLine = await page.evaluate(() => document.querySelector('#new-bike-sheet .nb-name').textContent);
// Pete, 2026-11-09: a bike that brings no outfit rolls in alone (no geese)
const alone = await until(page, () => window._game.lobby.bikeCelebration._showcase.rolledIn('bike_green'), null, 15000);
await h.shot(page, 'bl04-new-bike-alone');
check(alone && await page.evaluate(() => window._game.lobby.bikeCelebration._showcase.geese('bike_green')) === 0 && !(await page.evaluate(() => document.querySelector('#new-bike-sheet .nb-gift'))),
  'BL-04: Jungle brings no outfit: the bike rolls in alone and stops');
check(pic && nameLine === '🌿 Jungle Cruiser', 'BL-04: the bike turns in the card, its name below with the icon in front', { pic, nameLine });
await page.evaluate(() => document.querySelector('#new-bike-sheet .nb-ride').click());
const rode = await until(page, () => { const l = window._game.lobby; return l._currentStep === l.levelStep && l.selectedPresetKey === 'bike_green'; }, null, 5000);
check(rode && !(await sheet(page)).open, 'BL-04: RIDE IT NOW picks Jungle Cruiser and opens SOLO RIDE', await page.evaluate(() => ({
  step: window._game.lobby._currentStep === window._game.lobby.levelStep, pick: window._game.lobby.selectedPresetKey, saved: localStorage.getItem('tandemonium_bike_pick') })));
await page.evaluate(() => { const l = window._game.lobby; l._showStep(l.modeStep); });
await sleep(1200);
check(!(await sheet(page)).open, 'BL-04: each bike is celebrated once');

// ── BL-05 two at once ──
console.log('BL-05 two bikes at once');
await grant(page, 50, ['grandma_red', 'grandma_green']);
await page.evaluate(() => { const l = window._game.lobby; l._showStep(l.modeStep); });
await until(page, () => { const s = document.getElementById('new-bike-sheet'); return !!(s && s.open); }, null, 5000);
await sleep(4500);   // (both have rolled in)
const s5 = await sheet(page);
await h.shot(page, 'bl05-two-bikes');
check(s5.heading === '2 new bikes!' && s5.bikes.join() === 'bike_yellow,bike_christmas' && s5.ride.length === 2,
  'BL-05: "2 new bikes!" — Banana Delivery and Christmas Cruiser on one screen', s5);
const gift = await page.evaluate(() => (document.querySelector('#new-bike-sheet .nb-card[data-bike="bike_christmas"] .nb-gift') || {}).textContent);
const cyclists = await until(page, () => { const sc = window._game.lobby.bikeCelebration._showcase; const e = sc._entries.find(x => x.key === 'bike_christmas'); return !!e && e.actors.length === 2 && e.actors.every(a => /cyclist/.test(a.name)); }, null, 60000);
check(gift === '+ 🚴 Cyclists outfit' && cyclists, 'BL-05: the Christmas Cruiser brings the Cyclists: said on its card, and its geese wear them', { gift, cyclists });
await page.evaluate(() => document.getElementById('new-bike-later').click());
await sleep(300);
check(!(await sheet(page)).open, 'BL-05: LATER closes it');

// ── BL-06 the end-of-ride screen ──
console.log('BL-06 the end-of-ride screen');
await grant(page, 64, ['grandma_red', 'grandma_green']);
await page.evaluate(() => {
  const g = window._game;
  document.getElementById('victory-overlay').classList.add('visible');
  const u = document.getElementById('victory-unlocked'); u.replaceChildren(); u.hidden = true;
  g.state = 'victory';
});
await grant(page, 65, ['grandma_red', 'grandma_green']);
await page.evaluate(() => window._game._celebrateNewBikes('victory'));
await until(page, () => { const s = document.getElementById('new-bike-sheet'); return !!(s && s.open); }, null, 5000);
await sleep(1200);
const s6 = await sheet(page);
const goalLine = await page.evaluate(() => { const p = document.querySelector('#victory-unlocked .end-bike-goal'); return p ? p.textContent : ''; });
await h.shot(page, 'bl06-end-screen');
check(s6.bikes.join() === 'bike_blue' && s6.ride.join() === 'RIDE IT NOW', 'BL-06: "New bike!" over the end screen, with RIDE IT NOW (a solo ride)', s6);
check(/^Next bike: \d+ more .+ to .+/.test(goalLine), 'BL-06: the end screen says the next bike', goalLine);
await page.evaluate(() => { window._game._hideVictory(); window._game.state = 'lobby'; });
check(!(await sheet(page)).open, 'BL-06: leaving the end screen closes it');

// ── BL-08 the Solo Flight: a full-screen reward first, its Robot geese; then the other new bikes ──
console.log('BL-08 the Solo Flight, full screen');
await page.evaluate(async () => {
  const { soloAchievementIds } = await import('/js/rewards.js');
  const ach = window._game.lobby._achievements;
  for (const id of soloAchievementIds().slice(1)) ach._earned.set(id, { id, earnedAt: 1 });
  const l = window._game.lobby; l._showStep(l.modeStep);
});
await until(page, () => { const s = document.getElementById('new-bike-sheet'); return !!(s && s.open); }, null, 5000);
const hero = await page.evaluate(() => {
  const s = document.getElementById('new-bike-sheet'); const r = s.querySelector('.uf-sheet__card').getBoundingClientRect();
  return { hero: s.hasAttribute('data-hero'), bikes: [...s.querySelectorAll('.nb-card')].map(c => c.dataset.bike), full: r.width >= innerWidth - 2 && r.height >= innerHeight - 2,
    gift: (s.querySelector('.nb-gift') || {}).textContent, next: (document.getElementById('new-bike-later') || {}).textContent };
});
const robots = await until(page, () => { const e = window._game.lobby.bikeCelebration._showcase._entries[0]; return !!e && e.actors.length === 2 && e.actors.every(a => /robot/.test(a.name)); }, null, 30000);
await until(page, () => window._game.lobby.bikeCelebration._showcase.rolledIn('solo_flight'), null, 20000);
await sleep(1500);
await h.shot(page, 'bl08-solo-flight-hero');
check(hero.hero && hero.full && hero.bikes.join() === 'solo_flight' && hero.gift === '+ 🤖 Robot outfit' && robots && hero.next === 'NEXT',
  'BL-08: the Solo Flight fills the screen on its own, its Robot geese with it; NEXT for the rest', { ...hero, robots });
await page.evaluate(() => document.getElementById('new-bike-later').click());
const rest = await until(page, () => { const s = document.getElementById('new-bike-sheet'); return !!(s && s.open && !s.hasAttribute('data-hero') && s.querySelectorAll('.nb-card').length > 0); }, null, 5000);
check(rest, 'BL-08: then the other new bikes, on the card screen', await page.evaluate(() => [...document.querySelectorAll('#new-bike-sheet .nb-card')].map(c => c.dataset.bike)));
await page.evaluate(() => document.getElementById('new-bike-later').click());

// ── BL-09 the chooser's locked bikes (Pete, 2026-11-10) ──
//   a locked colour bike keeps its paint (a lock on its name); a holiday bike shows fully lit, locked or not,
//   its outfit geese riding it and "+ 🚴 Cyclists outfit" under it; the reward bikes stay silhouettes (Solo Flight's
//   Robot geese with it)
console.log('BL-09 the chooser: paint, outfit geese, silhouettes');
await grant(page, 10);
await page.evaluate(() => window._game._setChooserGeese('ride'));   // BL-09 checks "On the bike"; BL-10 the default
const pick = (k) => page.evaluate((k) => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf(k); l._applyPresetToPreview(); }, k);
const view = (k) => page.evaluate((k) => {
  const l = window._game.lobby, sp = (l._specialPreviews || {})[k], hint = document.getElementById('bike-hint');
  let grey = 0, painted = 0;
  if (!sp) l._previewModel.traverse((o) => { if (o.isMesh && o.material.color) { if (o.material.color.getHex() === 0x444444) grey++; else painted++; } });
  return { name: document.getElementById('bike-name').textContent, picked: l.selectedPresetKey,
    hint: hint && hint.style.display !== 'none' ? hint.innerText.replace(/\s+/g, ' ').trim() : '',
    frame: !!l._previewModel.visible, grey, painted,
    special: sp ? { visible: !!(sp.model && sp.model.visible), dark: sp.dark, riders: !!sp.riders, outfit: sp.outfit,
      frameColour: (() => { const m = sp.model && sp.model.getObjectByName('Cylinder006_cycle_0'); return m ? m.material.color.getHexString() : null; })(),
      seatColour: (() => { const m = sp.model && sp.model.getObjectByName('seat_cycle_0'); return m ? m.material.color.getHexString() : null; })() } : null };
}, k);
const seated = (k) => until(page, (k) => { const sp = (window._game.lobby._specialPreviews || {})[k]; return !!(sp && sp.model && sp.model.visible && sp.riders); }, k, 60000);

await pick('bike_green');
const jungle = await view('bike_green');
await h.shot(page, 'bl09-jungle-locked');
check(jungle.name.startsWith('🔒') && jungle.picked === 'default' && jungle.frame && jungle.grey === 0 && jungle.painted > 0,
  'BL-09: a locked colour bike shows its paint, with a lock', jungle);

await pick('bike_christmas');
check(await seated('bike_christmas'), 'BL-09: the Christmas Cruiser\'s Cyclists geese are seated');
const xmas = await view('bike_christmas');
await sleep(500);
await h.shot(page, 'bl09-christmas-locked');
check(xmas.name.startsWith('🔒') && xmas.picked === 'default' && !xmas.frame && xmas.special.visible && xmas.special.dark === false
  && xmas.special.outfit === 'cyclists' && xmas.hint.endsWith('+ 🚴 Cyclists outfit')
  && xmas.special.frameColour === '2eff46' && xmas.special.seatColour === 'bd0000',
  'BL-09: a locked holiday bike: fully lit in its own paint (green frame, red seats), its Cyclists geese riding, the outfit named', xmas);

await pick('solo_flight');
check(await seated('solo_flight'), 'BL-09: the Solo Flight\'s Robot geese are seated');
const solo = await view('solo_flight');
await h.shot(page, 'bl09-solo-flight-locked');
check(solo.special.dark === true && solo.special.outfit === 'robot' && solo.hint.endsWith('+ 🤖 Robot outfit'),
  'BL-09: a locked reward bike stays a silhouette (its Robot geese too), the outfit named', solo);

await grant(page, 40, ['grandma_green', 'grandma_red']);
await pick('bike_christmas');
const xmas2 = await view('bike_christmas');
await sleep(600);
await h.shot(page, 'bl09-christmas-earned');
check(xmas2.name.startsWith('🏆') && xmas2.picked === 'bike_christmas' && xmas2.special.dark === false && xmas2.hint === '+ 🚴 Cyclists outfit',
  'BL-09: the earned Christmas Cruiser: rideable, its geese pedalling', xmas2);
await page.evaluate(() => { const l = window._game.lobby; l._presetIndex = 0; l._applyPresetToPreview(); });

// ── BL-10 the Bike Chooser Geese setting: beside the bike (Pete, 2026-11-10; the default since 2026-11-11) ──
console.log('BL-10 Bike Chooser Geese: beside the bike');
await grant(page, 10);
const opt = (id) => page.evaluate((id) => !!document.getElementById(id), id);
check(await opt('opt-chooser-geese-ride') && await opt('opt-chooser-geese-stand')
  && await page.evaluate(async () => {   // (unset, then put back: the setting is 'ride' from BL-09)
    const k = 'tandemonium_chooser_geese', was = localStorage.getItem(k);
    localStorage.removeItem(k);
    const mode = (await import('./js/config.js')).getChooserGeese();
    if (was !== null) localStorage.setItem(k, was);
    return mode === 'stand';
  }),
  'BL-10: Settings has "Bike Chooser Geese" (On the bike / Beside the bike), beside the bike by default');
await page.evaluate(() => window._game._setChooserGeese('stand'));
const standing = (k) => until(page, (k) => { const sp = (window._game.lobby._specialPreviews || {})[k];
  return !!(sp && sp.model && sp.model.visible && sp.stand && sp.stand.visible && sp.actors && sp.actors.length === 2); }, k, 60000);
await pick('bike_christmas');
check(await standing('bike_christmas'), 'BL-10: the Christmas Cruiser\'s Cyclists geese stand beside it');
await sleep(1500);
const xs = await page.evaluate(() => { const sp = window._game.lobby._specialPreviews.bike_christmas;
  return { riders: !!sp.riders, dark: sp.dark, mode: sp.geeseMode, xs: sp.actors.map(a => +a.root.position.x.toFixed(2)),
    frame: sp.model.getObjectByName('Cylinder006_cycle_0').material.color.getHexString() }; });
await h.shot(page, 'bl10-christmas-beside');
check(!xs.riders && xs.dark === false && xs.mode === 'stand' && Math.min(...xs.xs) < 0 && Math.max(...xs.xs) > 0 && xs.frame === '2eff46',
  'BL-10: one goose either side, none on the bike, the bike in its own paint', xs);
await pick('solo_flight');
check(await standing('solo_flight'), 'BL-10: the Solo Flight\'s Robot geese stand beside it');
await sleep(800);
await h.shot(page, 'bl10-solo-flight-beside');
check(await page.evaluate(() => window._game.lobby._specialPreviews.solo_flight.dark === true), 'BL-10: locked, the Solo Flight and its geese are silhouettes');
await page.evaluate(() => window._game._setChooserGeese('ride'));
await pick('bike_christmas');
check(await seated('bike_christmas'), 'BL-10: back to "On the bike": the geese ride it again');
// a player who rides as a goose still sees a gander and a goose (Pete, 2026-11-11: both were geese)
await page.evaluate(() => { const L = window.__playerLooks; L.set(1, undefined, { ...L.get(1), body: 'f' }); window._game.lobby.chooserGeeseChanged(); });
await pick('bike_christmas');
await until(page, () => { const sp = window._game.lobby._specialPreviews.bike_christmas; return !!(sp && sp.riders && sp.geeseBodies); }, null, 60000);
const pair = await page.evaluate(() => window._game.lobby._specialPreviews.bike_christmas.geeseBodies);
check(pair && pair.Captain === 'f' && pair.Stoker === 'm', 'BL-10: a goose player: the captain rides as a goose, the stoker as a gander', pair);
await page.evaluate(() => { const L = window.__playerLooks; L.set(1, undefined, { ...L.get(1), body: 'm' }); });
await page.evaluate(() => { const l = window._game.lobby; l._presetIndex = 0; l._applyPresetToPreview(); });

// ── BL-07 demo → full game ──
console.log('BL-07 demo → full game');
const ids = await page.evaluate(async () => {
  const { ACHIEVEMENTS } = await import('/js/achievement-defs.js');
  return ACHIEVEMENTS.map(a => a.id).filter(id => !/^grandma_(default|orange|magenta|red|blue|green|yellow)$/.test(id)).slice(0, 52);
});
const full = await h.gamePage({ viewport: { width: 1600, height: 900 }, storage: {
  tandemonium_tutorial_done: 'smoke',
  tandemonium_achievements: JSON.stringify(ids.map(id => ({ id, earnedAt: 1 }))),
  tandemonium_bike_ladder: JSON.stringify({ bikes: ['default', 'bike_orange'], edition: 'demo', count: 20 }),
} });
await ready(full);
await until(full, () => { const s = document.getElementById('new-bike-sheet'); return !!(s && s.open); }, null, 15000);
const riding = await until(full, () => { const sc = window._game.lobby.bikeCelebration._showcase; return !!sc && sc.mode === 'riding' && ['bike_magenta', 'bike_red', 'bike_green', 'bike_yellow'].every(k => sc.drawn(k) && sc.geese(k) === 0); }, null, 40000);
check(riding, 'BL-07: four colour bikes (no outfits): four bikes turning, no geese');
await sleep(800);
const s7 = await sheet(full);
await h.shot(full, 'bl07-demo-welcome');
check(s7.welcome === 'Your demo riding earned you 32 achievements and 4 new bikes.' && s7.heading === '4 new bikes!'
  && s7.bikes.join() === 'bike_magenta,bike_red,bike_green,bike_yellow' && s7.ride.join() === 'RIDE,RIDE,RIDE,RIDE', 'BL-07: the demo → full game welcome, one screen', s7);

await h.finish();
