#!/usr/bin/env node
// smoke:ach-detail · #540: Achievements as a sibling of the Leaderboard, and a
// detail card for each badge — on a TV with a pad, and on a phone by touch.
//
//   AD-01  TV bar: an Achievements pill next to Leaderboard opens its own
//          sheet with the 100 badges; the Leaderboard's You tab is rides only.
//   AD-02  The pad's focus starts on a badge; ↓ moves to another badge and the
//          sheet scrolls so the focused badge stays in view.
//   AD-03  A opens the detail card: badge large, name, what to do, status — at
//          the kit's TV sizes, the whole card on screen.
//   AD-04  B closes the card and the focus is back on the same badge, with the
//          Achievements sheet still open.
//   AD-05  Unlocked shows its date; a counter shows its progress with a bar; a
//          best-so-far shows "45 / 50 km/h" and its "Best: <ride> · <date, time>"
//          line under the bar; a hidden one stays ??? / "Hidden".
//          #634: the grid and the card are the kit's <uf-achievement-grid> /
//          <uf-achievement-detail>.
//   AD-06  B closes the Achievements sheet.
//   AD-08  Hold to scroll (Steam playtest 2026-11-07): a d-pad tap moves one
//          row; holding ↓ ~1.5 s runs past No. 40 with the focus in view;
//          releasing stops; the left stick holds the same way; LB / RB jump
//          a section (and leave the bike alone).
//   AD-07  Phone: the ⭐ toggle opens the sheet; a tap on a badge opens its
//          card, which fits the phone; Close returns to the grid.
import { startHarness } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const h = await startHarness({ port: 8996, outDir: 'tandemonium-ach-detail' });
const { check } = h;

const EARNED_AT = Date.UTC(2026, 10, 1, 15, 0, 0);   // 1 November 2026
const storage = {
  tandemonium_tutorial_done: 'smoke',
  tandemonium_achievements: JSON.stringify([{ id: 'first_pedal', name: 'Kick Off', icon: '🦶', earnedAt: EARNED_AT }]),
  // a best-so-far with where + when it was set (Terminal Goose: 45 of 50 km/h on the Daily Ride)
  tandemonium_achievement_stats: JSON.stringify({ v: 2, rides: 1, bests: { terminal_goose: 45 }, grandmaGoldBikes: ['default', 'bike_red'], modesFinished: ['grandma'], bestsAt: { terminal_goose: { level: 'daily', at: Date.UTC(2026, 10, 7, 22, 0) } } }),
};

// ── TV, one pad ──
const page = await h.gamePage({
  viewport: { width: 1920, height: 1080 },
  storage,
  before: (p) => installFakeGamepads(p, { atBoot: ['dualsense'] }),
});
const pads = fakePads(page);
const until = async (fn, arg, timeout = 15000) => {
  try { const hnd = await page.waitForFunction(fn, { timeout, polling: 50 }, arg); return await hnd.jsonValue(); } catch { return null; }
};
const focusedAch = () => page.evaluate(() => document.querySelector('#achievements-modal .gamepad-focus')?.getAttribute('data-ach') || document.querySelector('#achievements-modal .gamepad-focus')?.className || null);
const press = async (b) => {
  const before = await focusedAch();
  await pads.press(0, b, 160);
  await until((prev) => {
    const f = document.querySelector('#achievements-modal .gamepad-focus');
    return (f?.getAttribute('data-ach') || f?.className || null) !== prev;
  }, before, 2500);
  await new Promise((r) => setTimeout(r, 220));
};
const kit = await page.evaluate(() => {
  const probe = document.createElement('span'); document.body.appendChild(probe);
  const px = (v) => { probe.style.fontSize = `var(${v})`; return parseFloat(getComputedStyle(probe).fontSize); };
  const out = { md: px('--uf-size-md'), lg: px('--uf-size-lg'), x2: px('--uf-size-2xl') };
  probe.remove(); return out;
});
const card = () => page.evaluate(() => {
  const s = document.getElementById('ach-detail');
  if (!s.open) return null;
  const q = (sel) => s.querySelector(sel);
  const px = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0);
  const cr = s.querySelector('.uf-sheet__card').getBoundingClientRect();
  return {
    heading: s.heading, state: q('uf-achievement-detail').dataset.state,
    kicker: q('.uad-kicker')?.textContent, name: q('.uad-name')?.textContent, desc: q('.uad-desc')?.textContent,
    status: q('.uad-status')?.textContent, count: q('.uad-count')?.textContent, bar: !!q('.uad-bar'),
    namePx: px(q('.uad-name')), descPx: px(q('.uad-desc')), badgePx: q('.uad-badge')?.getBoundingClientRect().width || 0,
    fits: cr.left >= 0 && cr.top >= 0 && cr.right <= innerWidth + 0.5 && cr.bottom <= innerHeight + 0.5, cardW: Math.round(cr.width),
  };
});

await until(() => window._game && window._game.input && window._game.input.gamepadConnected);
await pads.press(0, 'A', 160);
await new Promise((r) => setTimeout(r, 400));

// ── AD-01 · the bar's Achievements pill, its own sheet ──
await h.shot(page, '0-tv-lobby');
const bar = await page.evaluate(() => {
  const pills = Array.from(document.querySelectorAll('#lobby-bar uf-button')).filter((b) => getComputedStyle(b).display !== 'none');
  const tops = new Set(pills.map((b) => Math.round(b.getBoundingClientRect().top)));
  const lb = document.getElementById('bar-leaderboard');
  const bare = (id) => document.getElementById(id).textContent.trim() === '';
  return { ids: pills.map((b) => b.id), label: document.getElementById('bar-achievements-count')?.textContent.trim(), next: document.getElementById('bar-achievements-next')?.textContent, title: document.getElementById('bar-achievements')?.title, rows: tops.size,
    iconOnly: bare('bar-leaderboard') && lb.title === 'Leaderboard' && bare('bar-settings') && bare('bar-music') };
});
check(bar.ids.indexOf('bar-achievements') === bar.ids.indexOf('bar-leaderboard') + 1 && bar.label === '1 of 100' && /^Achievements( · Next bike: .+)?$/.test(bar.title), 'AD-01 the bar\'s Achievements pill (★ earned / total) sits right after Leaderboard', bar);
check(bar.rows === 1 && bar.iconOnly, 'AD-01 Leaderboard, Music and Settings are icon-only pills and the bar stays on one row at 1920', bar);
await page.evaluate(() => document.getElementById('bar-leaderboard').click());
await until(() => document.getElementById('leaderboard-modal').open === true);
const lbYou = await page.evaluate(async () => {
  document.querySelector('#lb-main-tabs .lb-tab[data-tab-id="you"]')?.click();
  await new Promise((r) => setTimeout(r, 300));
  return { heading: document.getElementById('leaderboard-modal').heading, badges: document.querySelectorAll('#leaderboard-modal .uag-item').length };
});
check(lbYou.badges === 0, 'AD-01 the Leaderboard\'s You tab no longer carries the badge grid', lbYou);
await pads.press(0, 'B', 160);
await until(() => document.getElementById('leaderboard-modal').open === false);
await new Promise((r) => setTimeout(r, 300));
await page.evaluate(() => document.getElementById('bar-achievements').click());
const achOpen = await until(() => document.getElementById('achievements-modal').open === true && document.querySelectorAll('#achievements-modal .uag-item').length > 0);
const grid = await page.evaluate(() => ({
  heading: document.getElementById('achievements-modal').heading,
  badges: document.querySelectorAll('#achievements-modal button.uag-item').length,
  sections: document.querySelectorAll('#achievements-modal .uag-section').length,
}));
check(achOpen && grid.heading === 'Achievements' && grid.badges === 100 && grid.sections === 15, 'AD-01 the Achievements sheet opens with all 100 badges as buttons, in 15 sections', grid);
const kitEls = await page.evaluate(() => ({ grid: !!document.querySelector('#lb-achievements > uf-achievement-grid .uag-item'), card: document.getElementById('ach-detail-card')?.localName }));
check(kitEls.grid && kitEls.card === 'uf-achievement-detail', 'AD-01 #634: the badges and the card are the kit uf-achievement-grid / uf-achievement-detail', kitEls);
await h.shot(page, '1-tv-grid');

// ── AD-02 · pad focus over the badges, scrolling with it ──
const f0 = await until(() => document.querySelector('#achievements-modal .uag-item.gamepad-focus')?.getAttribute('data-ach') || null, null, 3000);
check(!!f0, 'AD-02 the pad\'s focus starts on a badge', f0);
let moved = null;
for (let i = 0; i < 12; i++) { await press('DOWN'); moved = await focusedAch(); }
const inView = await page.evaluate(() => {
  const f = document.querySelector('#achievements-modal .uag-item.gamepad-focus'); if (!f) return null;
  const r = f.getBoundingClientRect(), b = document.getElementById('achievements-modal').querySelector('.uf-sheet__body').getBoundingClientRect();
  return { ach: f.dataset.ach, inView: r.top >= b.top - 1 && r.bottom <= b.bottom + 1, scrolled: document.getElementById('achievements-modal').querySelector('.uf-sheet__body').scrollTop };
});
check(inView && inView.ach !== f0 && inView.inView && inView.scrolled > 0, 'AD-02 ↓ walks the badges and the sheet scrolls to keep the focused one in view', inView);

// ── AD-03 / AD-04 · A opens the card, B returns to the same badge ──
const before = await focusedAch();
await pads.press(0, 'A', 160);
const opened = await until(() => document.getElementById('ach-detail').open === true, null, 3000);
const c1 = opened ? await card() : null;
check(!!c1 && !!c1.name && !!c1.desc && !!c1.status && /No\. \d+ of 100/.test(c1.count || ''), 'AD-03 A opens the detail card: name, what to do, status, its number', c1);
check(!!c1 && c1.namePx >= kit.x2 - 0.5 && c1.descPx >= kit.lg - 0.5 && c1.badgePx >= 120 && c1.fits, 'AD-03 the card reads at TV size (name 2xl, text lg, badge ≥120px) and is all on screen', c1 && { ...c1, kit });
check(await page.evaluate(() => !document.getElementById('ach-lift') && !document.querySelector('.uag-item.lifting')), 'AD-03 the lifting copy of the badge is gone once the card shows');
await h.shot(page, '2-tv-detail');
await pads.press(0, 'B', 160);
const closed = await until(() => document.getElementById('ach-detail').open === false, null, 3000);
await new Promise((r) => setTimeout(r, 250));
const after = await focusedAch();
const stillOpen = await page.evaluate(() => document.getElementById('achievements-modal').open);
check(closed && stillOpen && after === before, 'AD-04 B closes the card; the focus is back on the same badge, the sheet still open', { before, after, stillOpen });
// #576: the grid was still blurred after the card closed.
await new Promise((r) => setTimeout(r, 600));
const blur = await page.evaluate(() => {
  const s = document.getElementById('achievements-modal');
  const els = [s, s.querySelector('.uf-sheet__card'), s.querySelector('.uf-sheet__body')].filter(Boolean);
  return els.map((el) => ({ cls: el.className, filter: getComputedStyle(el).filter, backdrop: getComputedStyle(el).backdropFilter, anims: el.getAnimations().length }));
});
check(blur.every((b) => b.filter === 'none' && b.anims === 0), 'AD-04 the grid is sharp again once the card closes (no blur left on it)', blur);
await h.shot(page, '2b-tv-after-close');

// ── AD-08 · hold to scroll fast; LB / RB jump a section ──
const achAt = () => page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('#achievements-modal .uag-item'));
  const f = document.querySelector('#achievements-modal .uag-item.gamepad-focus');
  const body = document.getElementById('achievements-modal').querySelector('.uf-sheet__body').getBoundingClientRect();
  const r = f ? f.getBoundingClientRect() : null;
  return { i: f ? items.indexOf(f) : -1, top: r ? Math.round(r.top) : null, inView: !!r && r.top >= body.top - 1 && r.bottom <= body.bottom + 1,
    section: f ? f.closest('.uag-section')?.dataset.section : null, bike: window._game.lobby._presetIndex ?? null };
});
const toTop = async () => {
  await page.evaluate(() => { const L = window._game.lobby; L._achievementsSheet.body.scrollTop = 0; L._achResetFocus(); });
  await new Promise((r) => setTimeout(r, 300));
};
await toTop();
const t0 = await achAt();
await pads.press(0, 'DOWN', 160);
await new Promise((r) => setTimeout(r, 600));
const t1 = await achAt();
const perRow = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('#achievements-modal .uag-item'));
  const top0 = Math.round(items[0].getBoundingClientRect().top);
  return items.filter((el) => Math.round(el.getBoundingClientRect().top) === top0).length;
});
check(t0.i === 0 && t1.i > 0 && t1.i <= perRow && t1.top > t0.top, 'AD-08 a d-pad tap moves one row', { t0, t1, perRow });
await toTop();
await pads.hold(0, 'DOWN', true);
await new Promise((r) => setTimeout(r, 1500));
await pads.hold(0, 'DOWN', false);
await new Promise((r) => setTimeout(r, 120));
const h1 = await achAt();
await new Promise((r) => setTimeout(r, 700));
const h2 = await achAt();
check(h1.i >= 40 && h1.inView, 'AD-08 holding d-pad ↓ for 1.5 s runs past No. 40, the focused badge in view', h1);
check(h2.i === h1.i, 'AD-08 releasing stops on that badge', { h1, h2 });
await h.shot(page, '2c-tv-held-down');
await toTop();
await pads.stick(0, 'LY', 0.9);
await new Promise((r) => setTimeout(r, 1500));
await pads.stick(0, 'LY', 0);
await new Promise((r) => setTimeout(r, 120));
const s1 = await achAt();
await new Promise((r) => setTimeout(r, 500));
const s2 = await achAt();
check(s1.i >= 40 && s1.inView && s2.i === s1.i, 'AD-08 holding the left stick ↓ does the same, and stops on release', { s1, s2 });
await toTop();
const bikeBefore = (await achAt()).bike;
await pads.press(0, 'RB', 160); await new Promise((r) => setTimeout(r, 300));
const r1 = await achAt();
await pads.press(0, 'RB', 160); await new Promise((r) => setTimeout(r, 300));
const r2 = await achAt();
await pads.press(0, 'LB', 160); await new Promise((r) => setTimeout(r, 300));
const l1 = await achAt();
const secs = await page.evaluate(() => Array.from(document.querySelectorAll('#achievements-modal .uag-section')).map((s) => ({ id: s.dataset.section, first: Array.from(document.querySelectorAll('#achievements-modal .uag-item')).indexOf(s.querySelector('.uag-item')) })));
check(r1.section === secs[1].id && r1.i === secs[1].first && r2.section === secs[2].id && r2.i === secs[2].first && l1.section === secs[1].id && l1.i === secs[1].first && r2.inView,
  'AD-08 RB jumps to the next section’s first badge, LB back', { r1, r2, l1, secs: secs.slice(0, 3) });
check(l1.bike === bikeBefore, 'AD-08 LB / RB over the sheet leave the bike colour alone', { bikeBefore, after: l1.bike });
await toTop();

// ── AD-05 · unlocked date, progress bar, hidden ──
const open = async (id) => {
  await page.evaluate((i) => window._game.lobby._openAchievementDetail(i), id);
  await until(() => document.getElementById('ach-detail').open === true, null, 3000);
  const c = await card();
  return c;
};
const closeCard = async () => { await page.evaluate(() => window._game.lobby._closeAchievementDetail()); await until(() => document.getElementById('ach-detail').open === false, null, 3000); await new Promise((r) => setTimeout(r, 150)); };
const earned = await open('first_pedal');
check(!!earned && earned.state === 'earned' && earned.name === 'Kick Off' && /^Unlocked November 1, 2026$/.test(earned.status || '') && /unlocked/i.test(earned.kicker || '') && earned.heading === 'First rides', 'AD-05 an unlocked badge says when, under its section heading', earned);
await h.shot(page, '3-tv-detail-earned');
await closeCard();
const prog = await open('rides_10');
check(!!prog && prog.state === 'progress' && prog.bar && /^1 \/ 10/.test(prog.status || ''), 'AD-05 a counter shows its progress with a bar', prog);
await h.shot(page, '4-tv-detail-progress');
await closeCard();
const best = await open('terminal_goose');
const bestLine = await page.evaluate(() => {
  const b = document.querySelector('#ach-detail-card .ach-detail-best');
  return { text: b?.textContent || '', afterBar: !!b && b.previousElementSibling?.classList.contains('uad-bar'), beforeCount: !!b && b.nextElementSibling?.classList.contains('uad-count') };
});
check(!!best && best.state === 'progress' && best.status === '45 / 50 km/h' && best.bar, 'AD-05 a best-so-far shows its progress with the unit and a bar', best);
check(/^Best: Daily Ride · November 7, 2026, \d{1,2}:\d\d [AP]M$/.test(bestLine.text) && bestLine.afterBar && bestLine.beforeCount, 'AD-05 …and where + when the best was set, under the bar', bestLine);
const tile = await page.evaluate(() => document.querySelector('#achievements-modal .uag-item[data-ach="terminal_goose"] .uag-progress')?.textContent || '');
check(tile === '45/50 km/h', 'AD-05 its badge on the grid reads 45/50 km/h', tile);
await h.shot(page, '4c-tv-detail-best');
await closeCard();
const gold = await open('grandma_gold');
const goldTimes = await page.evaluate(() => document.querySelector('#ach-detail .ach-detail-times')?.textContent || '');
check(!!gold && /gold time/i.test(gold.desc || '') && /Gold time on Grandma's/.test(goldTimes) && /Chill[ ]\d:\d\d/.test(goldTimes) && /Adventurous[ ]\d:\d\d/.test(goldTimes) && /Daredevil[ ]\d:\d\d/.test(goldTimes), 'AD-05 a medal badge says what the medal is and lists its live time per difficulty', { desc: gold?.desc, goldTimes });
await h.shot(page, '4b-tv-detail-medal');
await closeCard();
const hidden = await open('false_start');
check(!!hidden && hidden.state === 'secret' && hidden.name === '???' && hidden.kicker === 'Hidden', 'AD-05 a hidden achievement keeps its ??? and says Hidden', hidden);
await h.shot(page, '5-tv-detail-hidden');
await closeCard();
// #769: Rainbow Gold lists the 7 bikes by name, each done, to do, or locked with what unlocks it; Full House its 6 modes.
const checklistOf = () => page.evaluate(() => [...document.querySelectorAll('#ach-detail .ach-checklist .ach-check')].map((li) => ({ key: li.dataset.key, state: li.className.replace(/.*ach-check--/, ''), text: li.textContent })));
await open('rainbow_gold');
const rg = await checklistOf();
const rgBy = Object.fromEntries(rg.map((r) => [r.key, r]));
check(rg.length === 7 && rgBy.default?.state === 'done' && rgBy.bike_red?.state === 'done' && /Grandma's Classic/.test(rgBy.default.text) && /Cherry Bomb/.test(rgBy.bike_red.text)
  && rgBy.bike_orange?.state === 'todo' && /Marmalade Express/.test(rgBy.bike_orange.text)
  && rgBy.bike_blue?.state === 'locked' && /Ocean Breeze\s*65 achievements/.test(rgBy.bike_blue.text), 'AD-09 #769 Rainbow Gold lists all 7 bikes: ✓ gold, ○ to do, 🔒 locked with what unlocks it', rg);
await h.shot(page, '5b-tv-detail-rainbow-gold');
await closeCard();
await open('full_house');
const fh = await checklistOf();
check(fh.length === 6 && fh.filter((r) => r.state === 'done').map((r) => r.key).join() === 'grandma' && fh.some((r) => /Daily Ride/.test(r.text) && r.state === 'todo'), 'AD-09 #769 Full House lists its 6 modes, done or not', fh);
await closeCard();
// #666 → #634: a held one (earned with a friend in a full-game room) keeps its own kicker + status on the kit card.
const held = await page.evaluate(async () => {
  const L = window._game.lobby;
  L._renderAchievementDetail({ ...L._achievements.getAllDefinitions().find((a) => a.id === 'first_pedal'), held: true });
  await Promise.resolve();
  const c = document.getElementById('ach-detail-card');
  return { state: c.dataset.state, kicker: c.querySelector('.uad-kicker')?.textContent, status: c.querySelector('.uad-status')?.textContent };
});
check(held.state === 'earned' && held.kicker === 'Earned with a friend' && held.status === 'Unlocked November 1, 2026 · get the full game to claim it', 'AD-05 a held achievement says Earned with a friend · get the full game to claim it', held);

// ── AD-06 · B closes the sheet ──
await pads.press(0, 'B', 160);
check(await until(() => document.getElementById('achievements-modal').open === false, null, 3000), 'AD-06 B closes the Achievements sheet');
await page.close();

// ── AD-07 · phone, by touch ──
const ph = await h.gamePage({
  viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  storage,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const pUntil = async (fn, arg, timeout = 15000) => {
  try { const hnd = await ph.waitForFunction(fn, { timeout, polling: 50 }, arg); return await hnd.jsonValue(); } catch { return null; }
};
await pUntil(() => document.getElementById('lobby-mode')?.hasAttribute('active'));
const toggle = await ph.evaluate(() => {
  const t = document.getElementById('toggle-achievements'), l = document.getElementById('toggle-leaderboard');
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && getComputedStyle(el).display !== 'none'; };
  return { shown: vis(t) && vis(l), title: t.title, below: t.getBoundingClientRect().top > l.getBoundingClientRect().top, size: Math.round(t.getBoundingClientRect().width) };
});
check(toggle.shown && toggle.title === 'Achievements' && toggle.below, 'AD-07 the phone lobby shows the ⭐ Achievements toggle under 🏆 Leaderboard', toggle);
await h.shot(ph, '6a-phone-lobby');
await ph.tap('#toggle-achievements');
check(await pUntil(() => document.getElementById('achievements-modal').open === true && document.querySelectorAll('#achievements-modal .uag-item').length === 100), 'AD-07 a tap on ⭐ opens the Achievements sheet');
await h.shot(ph, '6-phone-grid');
await ph.tap('#achievements-modal .uag-item[data-ach="first_finish"]');
const phOpen = await pUntil(() => document.getElementById('ach-detail').open === true, null, 3000);
const pc = phOpen ? await ph.evaluate(() => {
  const s = document.getElementById('ach-detail');
  const cr = s.querySelector('.uf-sheet__card').getBoundingClientRect();
  return { name: s.querySelector('.uad-name')?.textContent, fits: cr.left >= 0 && cr.right <= innerWidth + 0.5 && cr.top >= 0 && cr.bottom <= innerHeight + 0.5,
    namePx: parseFloat(getComputedStyle(s.querySelector('.uad-name')).fontSize), scrollW: document.documentElement.scrollWidth, w: Math.round(cr.width) };
}) : null;
check(!!pc && pc.name === 'Made It' && pc.fits && pc.scrollW <= 390 && pc.namePx >= 24, 'AD-07 the card fits the phone (no sideways scroll, name ≥24px)', pc);
await h.shot(ph, '7-phone-detail');
await ph.tap('#ach-detail .uf-sheet__close');
const back = await pUntil(() => document.getElementById('ach-detail').open === false && document.getElementById('achievements-modal').open === true, null, 3000);
check(!!back, 'AD-07 Close returns to the grid');

await h.finish();
