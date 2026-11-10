#!/usr/bin/env node
// smoke:bike-ladder · #736 the bike ladder and the "New bike!" screen.
//
//   BL-01  full game, no achievements: Berry and Cherry ride; Jungle is locked with "0 of 35 achievements"
//   BL-02  the pill says the next bike ("35 to Jungle Cruiser")
//   BL-03  the first menu visit takes what the player has as seen (no screen)
//   BL-04  35 achievements, back on the menu: "New bike!" with Jungle Cruiser; RIDE IT NOW picks it and opens SOLO RIDE
//   BL-05  the Jungle ride to Grandma's that is also the 50th: "2 new bikes!" (Banana Delivery + Christmas Cruiser), one screen
//   BL-06  the end-of-ride screen: the next-bike line in the unlocked list, and "New bike!" over it with RIDE IT NOW
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
await sleep(1400);
const s5 = await sheet(page);
await h.shot(page, 'bl05-two-bikes');
check(s5.heading === '2 new bikes!' && s5.bikes.join() === 'bike_yellow,bike_christmas' && s5.ride.length === 2,
  'BL-05: "2 new bikes!" — Banana Delivery and Christmas Cruiser on one screen', s5);
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
await sleep(1600);
const s7 = await sheet(full);
await h.shot(full, 'bl07-demo-welcome');
check(s7.welcome === 'Your demo riding earned you 32 achievements and 4 new bikes.' && s7.heading === '4 new bikes!'
  && s7.bikes.join() === 'bike_magenta,bike_red,bike_green,bike_yellow', 'BL-07: the demo → full game welcome, one screen', s7);

await h.finish();
