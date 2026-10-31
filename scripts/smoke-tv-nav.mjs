#!/usr/bin/env node
// smoke:tv-nav · the TV / Steam pad fixes from #517, at 1080p with one pad.
//
//   LY-06  level step: ↓ from Chill Ride → START RIDE; ↓ from the far-left and
//          far-right cards → the difficulty row (not the system bar).
//   LY-07  Slingshot card selects like a level; START RIDE opens its garage.
//   LY-08  Music pill: the pad moves through the volume picker, A picks, B closes.
//   LY-09  Settings: focus starts at the top, moves only over shown options,
//          stays on screen; the right stick scrolls the card. #523: kit text
//          sizes, one row per choice, two columns; → along a row, ↓ by column.
//   LY-10  Leaderboard is a kit sheet like Help (its Close, B closes it); the
//          desktop app's Quit pill is the bar's last pill.
//   LY-11  First Grandma's finish: the unlocks fit, ← / → walk the button row.
import { startHarness, waitState } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const h = await startHarness({ port: 8993, outDir: 'tandemonium-tv-nav' });
const { check } = h;
const page = await h.gamePage({
  viewport: { width: 1920, height: 1080 },
  storage: { tandemonium_tutorial_done: 'smoke' },
  before: (p) => installFakeGamepads(p, { atBoot: ['dualsense'] }),
});
const pads = fakePads(page);

/** Poll until fn() (in the page) is truthy; returns its value or null. */
const until = async (fn, arg, timeout = 15000) => {
  try { const hnd = await page.waitForFunction(fn, { timeout, polling: 50 }, arg); return await hnd.jsonValue(); } catch { return null; }
};
/** Press a pad button and wait until the focus (by selector list) changes or `timeout`. */
const focusKey = () => page.evaluate(() => Array.from(document.querySelectorAll('.gamepad-focus')).map((e) => e.id || e.dataset.difficulty || e.dataset.levelId || e.dataset.vol || e.textContent.trim().slice(0, 12)).join('|'));
const press = async (b) => {
  const before = await focusKey();
  await pads.press(0, b, 160);
  await until((prev) => {
    const k = Array.from(document.querySelectorAll('.gamepad-focus')).map((e) => e.id || e.dataset.difficulty || e.dataset.levelId || e.dataset.vol || e.textContent.trim().slice(0, 12)).join('|');
    return k !== prev;
  }, before, 2500);
  await new Promise((r) => setTimeout(r, 220));   // the release edge
};
/** Put the lobby's step focus on `sel`. */
const focusStep = (sel) => page.evaluate((s) => {
  const f = window._game.lobby._stepFocus; const el = document.querySelector(s);
  f.focusedEl?.classList.remove('gamepad-focus'); f.focusedEl = el; el.classList.add('gamepad-focus');
}, sel);
const stepFocused = () => page.evaluate(() => { const el = window._game.lobby._stepFocus.focusedEl; return el ? (el.id || el.dataset.difficulty || el.dataset.levelId || '') : null; });

await until(() => window._game && window._game.input && window._game.input.gamepadConnected);
await pads.press(0, 'A', 160);
await new Promise((r) => setTimeout(r, 400));

// ── LY-06 · level step ──
await page.evaluate(() => document.getElementById('btn-solo').click());
await until(() => document.querySelectorAll('#level-cards .level-card').length >= 3 && window._game.lobby._stepFocus.items.length > 0);
await focusStep('.difficulty-btn[data-difficulty="chill"]');
await press('DOWN');
check((await stepFocused()) === 'btn-start-ride', 'LY-06 ↓ from Chill Ride lands on START RIDE', await stepFocused());
const edges = await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll('#level-cards .level-card')).filter((c) => c.getBoundingClientRect().width > 0)
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  return [cards[0].dataset.levelId, cards[cards.length - 1].dataset.levelId];
});
for (const id of edges) {
  await focusStep(`#level-cards .level-card[data-level-id="${id}"]`);
  await press('DOWN');
  const got = await stepFocused();
  check(['chill', 'adventurous', 'daredevil'].includes(got), `LY-06 ↓ from the ${id} card lands on the difficulty row`, got);
}
await h.shot(page, '1-level');

// ── LY-10 · leaderboard sheet ──
await page.evaluate(() => document.getElementById('bar-leaderboard').click());
const lbOpen = await until(() => document.getElementById('leaderboard-modal').open === true);
const lbShell = await page.evaluate(() => {
  const s = document.getElementById('leaderboard-modal');
  return { sheet: s.tagName.toLowerCase(), close: !!s.querySelector('.uf-sheet__close'), help: document.getElementById('help-modal').tagName.toLowerCase() };
});
check(lbOpen && lbShell.sheet === 'uf-sheet' && lbShell.help === 'uf-sheet' && lbShell.close, 'LY-10 the Leaderboard opens as the same kit sheet as Help, with its Close', lbShell);
const sectionPx = await page.evaluate(async () => {
  document.querySelector('#lb-main-tabs .lb-tab[data-tab-id="you"]')?.click();
  for (let i = 0; i < 40 && !document.querySelector('.lb-ach-section-title'); i++) await new Promise((r) => setTimeout(r, 100));
  const t = document.querySelector('.lb-ach-section-title');
  return t ? parseFloat(getComputedStyle(t).fontSize) : 0;
});
check(sectionPx >= 16, 'LY-10 achievement category headings are at least 16px at 1080p', sectionPx);
await h.shot(page, '2-leaderboard');
await pads.press(0, 'B', 160);
check(await until(() => document.getElementById('leaderboard-modal').open === false), 'LY-10 B closes the Leaderboard');
const barOrder = await page.evaluate(() => Array.from(document.querySelectorAll('#lobby-bar uf-button')).map((b) => b.id));
check(barOrder[barOrder.length - 1] === 'bar-quit', 'LY-10 Quit is the bar\'s last pill', barOrder.join(','));

// ── LY-08 · music picker ──
await focusStep('#bar-music');
await new Promise((r) => setTimeout(r, 300));
await pads.press(0, 'A', 160);
check(await until(() => document.getElementById('volume-picker').classList.contains('visible')), 'LY-08 A on Music opens the volume picker');
const pickerFocus = await until(() => document.querySelector('#volume-picker .vol-btn.gamepad-focus')?.dataset.vol || null);
check(pickerFocus !== null, 'LY-08 the pad focus moves into the picker', pickerFocus);
await press('UP');
const upVol = await page.evaluate(() => document.querySelector('#volume-picker .vol-btn.gamepad-focus')?.dataset.vol);
check(upVol && upVol !== pickerFocus, 'LY-08 ↑ moves along the picker', `${pickerFocus} → ${upVol}`);
await pads.press(0, 'A', 160);
const picked = await until(() => !document.getElementById('volume-picker').classList.contains('visible') && window._game.lobby.musicVolume);
check(picked !== null && Math.abs(Number(picked) - Number(upVol)) < 1e-6, 'LY-08 A picks that volume and closes the picker', { picked, upVol });
await focusStep('#bar-music');
await new Promise((r) => setTimeout(r, 300));
await pads.press(0, 'A', 160);
await until(() => document.getElementById('volume-picker').classList.contains('visible'));
await new Promise((r) => setTimeout(r, 300));
await pads.press(0, 'B', 160);
check(await until(() => !document.getElementById('volume-picker').classList.contains('visible')), 'LY-08 B closes the picker');

// ── LY-09 · settings ──
await page.evaluate(() => document.getElementById('bar-settings').click());
await until(() => document.getElementById('options-overlay').classList.contains('visible'));
const first = await until(() => window._game._overlayFocus.focused?.id || null);
check(first === 'opt-high', 'LY-09 Settings focus starts at the top', first);
// #523 · readable from the couch: kit text sizes, one row per choice, two columns.
const optLayout = await page.evaluate(() => {
  const card = document.querySelector('#options-overlay .options-card');
  const probe = document.createElement('div'); document.body.appendChild(probe);
  const px = (v) => { probe.style.fontSize = `var(${v})`; return parseFloat(getComputedStyle(probe).fontSize); };
  const sm = px('--uf-size-sm'), md = px('--uf-size-md'); probe.remove();
  const small = [];
  for (const el of card.querySelectorAll('*')) {
    if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) || !el.getBoundingClientRect().width) continue;
    if (parseFloat(getComputedStyle(el).fontSize) < sm - 0.01) small.push(el.id || el.className || el.tagName);
  }
  const btns = [...card.querySelectorAll('.opt-btn')].filter((b) => b.getBoundingClientRect().width);
  const r = (id) => document.getElementById(id).getBoundingClientRect();
  const tops = ['opt-high', 'opt-medium', 'opt-low', 'opt-auto'].map((id) => Math.round(r(id).top));
  return { sm, md, small, btnMin: Math.min(...btns.map((b) => parseFloat(getComputedStyle(b).fontSize))),
    oneRow: tops.every((t) => t === tops[0]), twoCols: r('opt-ds-auto').left > r('opt-auto').right && Math.round(r('opt-ds-auto').top) === tops[0] };
});
check(optLayout.small.length === 0 && optLayout.btnMin >= optLayout.md, 'LY-09 every Settings text is at least --uf-size-sm and the options at least --uf-size-md (#523)', optLayout);
check(optLayout.oneRow && optLayout.twoCols, 'LY-09 each choice is one row (High | Medium | Low | Auto), sections in two columns (#523)', optLayout);
await press('RIGHT');
const rightOf = await page.evaluate(() => window._game._overlayFocus.focused?.id);
await press('DOWN');
const below = await page.evaluate(() => window._game._overlayFocus.focused?.id);
check(rightOf === 'opt-medium' && /^opt-gyro-/.test(below || ''), 'LY-09 → moves along the row, ↓ to the next row in the same column (#523)', { rightOf, below });
let allShown = true, allInView = true, moved = 0, last = first;
for (let i = 0; i < 10; i++) {
  await press('DOWN');
  const st = await page.evaluate(() => {
    const el = window._game._overlayFocus.focused; const r = el.getBoundingClientRect();
    const c = document.querySelector('#options-overlay .options-card').getBoundingClientRect();
    return { id: el.id, shown: r.width > 0, inView: r.top >= c.top - 1 && r.bottom <= c.bottom + 1 };
  });
  if (st.id !== last) moved++;
  last = st.id; allShown &&= st.shown; allInView &&= st.inView;
}
// #523: two columns make fewer rows, so ten presses reach the bottom (the tools row).
check(moved >= 5 && allShown && /^options-(perf|devtools|browserdev|close)-btn$/.test(last), 'LY-09 ↓ walks the shown options down to the tools row', { moved, last });
check(allInView, 'LY-09 the focused option stays inside the card');
// Back to the top, so the stick has room to scroll down.
const scrolled = await page.evaluate(() => { const c = document.querySelector('#options-overlay .options-card'); c.scrollTop = 0; return c.scrollTop; });
await pads.stick(0, 'RY', 1);
const stickScrolled = await until((s0) => document.querySelector('#options-overlay .options-card').scrollTop > s0 + 20, scrolled, 4000);
await pads.stick(0, 'RY', 0);
check(!!stickScrolled, 'LY-09 the right stick scrolls Settings');
await h.shot(page, '3-settings');
await pads.press(0, 'B', 160);
check(await until(() => !document.getElementById('options-overlay').classList.contains('visible')), 'LY-09 B closes Settings');

// ── LY-07 · slingshot ──
await page.evaluate(() => document.querySelector('#level-cards .level-card-slingshot').click());
await new Promise((r) => setTimeout(r, 400));
const slingSel = await page.evaluate(() => ({
  state: window._game.state,
  selected: document.querySelector('#level-cards .level-card.selected')?.dataset.levelId,
  start: !document.getElementById('btn-start-ride').disabled,
}));
check(slingSel.state === 'lobby' && slingSel.selected === 'slingshot' && slingSel.start, 'LY-07 picking Slingshot selects it and waits for START RIDE', slingSel);
await page.evaluate(() => document.querySelector('#level-cards .level-card[data-level-id="grandma"]').click());
const back = await page.evaluate(() => ({ sel: document.querySelector('#level-cards .level-card.selected')?.dataset.levelId, diffOn: !document.querySelector('.difficulty-btn[data-difficulty="adventurous"]').disabled }));
check(back.sel === 'grandma' && back.diffOn, 'LY-07 picking a road after it brings the difficulty row back', back);

// ── LY-11 · first Grandma's finish ──
await page.evaluate(() => {
  const d = document.querySelector('.difficulty-btn[data-difficulty="chill"]'); d && d.click();
  document.getElementById('btn-start-ride').click();
});
await waitState(page, 'playing');
await page.evaluate(() => window._game._playPedalTaps({ tapEvents: [{ kind: 'good', gap: 0.5 }] }));
await page.evaluate(() => { const g = window._game; g.bike.distanceTraveled = g.lobby.selectedLevel.distance - 0.5; g.bike.speed = 10; });
await waitState(page, 'victory', 240000);
await until(() => document.querySelectorAll('#victory-unlocked uf-achievement').length >= 5, null, 15000);
await new Promise((r) => setTimeout(r, 1500));
await h.shot(page, '4-victory');
const fit = await page.evaluate(() => {
  const b = document.getElementById('victory-sheet').body;
  const last = Array.from(document.querySelectorAll('#victory-unlocked uf-achievement')).pop();
  const br = b.getBoundingClientRect(), lr = last.getBoundingClientRect();
  return { n: document.querySelectorAll('#victory-unlocked uf-achievement').length, overflow: b.scrollHeight - b.clientHeight, lastInView: lr.bottom <= br.bottom + 1 };
});
check(fit.lastInView, 'LY-11 a first finish\'s unlocks all show without scrolling at 1080p', fit);
await until(() => !!window._game._overlayFocus.focused);
const f0 = await page.evaluate(() => window._game._overlayFocus.focused?.id);
await new Promise((r) => setTimeout(r, 1300));   // the victory confirm cooldown doesn't gate moves, but let the screen settle
await press('RIGHT');
const f1 = await page.evaluate(() => window._game._overlayFocus.focused?.id);
check(f0 && f1 && f1 !== f0, 'LY-11 → moves along the result buttons', `${f0} → ${f1}`);
await press('LEFT');
const f2 = await page.evaluate(() => window._game._overlayFocus.focused?.id);
check(f2 === f0, 'LY-11 ← comes back', f2);

await h.finish();
