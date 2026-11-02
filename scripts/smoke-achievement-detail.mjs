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
//          hidden one stays ??? / "Hidden".
//   AD-06  B closes the Achievements sheet.
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
  tandemonium_achievement_stats: JSON.stringify({ v: 2, rides: 1 }),
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
    heading: s.heading, state: q('.ach-detail').dataset.state,
    kicker: q('.ach-detail-kicker')?.textContent, name: q('.ach-detail-name')?.textContent, desc: q('.ach-detail-desc')?.textContent,
    status: q('.ach-detail-status')?.textContent, count: q('.ach-detail-count')?.textContent, bar: !!q('.ach-detail-bar'),
    namePx: px(q('.ach-detail-name')), descPx: px(q('.ach-detail-desc')), badgePx: q('.ach-detail-badge')?.getBoundingClientRect().width || 0,
    fits: cr.left >= 0 && cr.top >= 0 && cr.right <= innerWidth + 0.5 && cr.bottom <= innerHeight + 0.5, cardW: Math.round(cr.width),
  };
});

await until(() => window._game && window._game.input && window._game.input.gamepadConnected);
await pads.press(0, 'A', 160);
await new Promise((r) => setTimeout(r, 400));

// ── AD-01 · the bar's Achievements pill, its own sheet ──
await h.shot(page, '0-tv-lobby');
const bar = await page.evaluate(() => {
  const ids = Array.from(document.querySelectorAll('#lobby-bar uf-button')).filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.id);
  return { ids, label: document.getElementById('bar-achievements')?.textContent.trim() };
});
check(bar.ids.indexOf('bar-achievements') === bar.ids.indexOf('bar-leaderboard') + 1 && bar.label === 'Achievements', 'AD-01 the bar has an Achievements pill right after Leaderboard', bar);
await page.evaluate(() => document.getElementById('bar-leaderboard').click());
await until(() => document.getElementById('leaderboard-modal').open === true);
const lbYou = await page.evaluate(async () => {
  document.querySelector('#lb-main-tabs .lb-tab[data-tab-id="you"]')?.click();
  await new Promise((r) => setTimeout(r, 300));
  return { heading: document.getElementById('leaderboard-modal').heading, badges: document.querySelectorAll('#leaderboard-modal .lb-ach-item').length };
});
check(lbYou.badges === 0, 'AD-01 the Leaderboard\'s You tab no longer carries the badge grid', lbYou);
await pads.press(0, 'B', 160);
await until(() => document.getElementById('leaderboard-modal').open === false);
await new Promise((r) => setTimeout(r, 300));
await page.evaluate(() => document.getElementById('bar-achievements').click());
const achOpen = await until(() => document.getElementById('achievements-modal').open === true && document.querySelectorAll('#achievements-modal .lb-ach-item').length > 0);
const grid = await page.evaluate(() => ({
  heading: document.getElementById('achievements-modal').heading,
  badges: document.querySelectorAll('#achievements-modal button.lb-ach-item').length,
  sections: document.querySelectorAll('#achievements-modal .lb-ach-section').length,
}));
check(achOpen && grid.heading === 'Achievements' && grid.badges === 100 && grid.sections === 15, 'AD-01 the Achievements sheet opens with all 100 badges as buttons, in 15 sections', grid);
await h.shot(page, '1-tv-grid');

// ── AD-02 · pad focus over the badges, scrolling with it ──
const f0 = await until(() => document.querySelector('#achievements-modal .lb-ach-item.gamepad-focus')?.getAttribute('data-ach') || null, null, 3000);
check(!!f0, 'AD-02 the pad\'s focus starts on a badge', f0);
let moved = null;
for (let i = 0; i < 12; i++) { await press('DOWN'); moved = await focusedAch(); }
const inView = await page.evaluate(() => {
  const f = document.querySelector('#achievements-modal .lb-ach-item.gamepad-focus'); if (!f) return null;
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
check(await page.evaluate(() => !document.getElementById('ach-lift') && !document.querySelector('.lb-ach-item.lifting')), 'AD-03 the lifting copy of the badge is gone once the card shows');
await h.shot(page, '2-tv-detail');
await pads.press(0, 'B', 160);
const closed = await until(() => document.getElementById('ach-detail').open === false, null, 3000);
await new Promise((r) => setTimeout(r, 250));
const after = await focusedAch();
const stillOpen = await page.evaluate(() => document.getElementById('achievements-modal').open);
check(closed && stillOpen && after === before, 'AD-04 B closes the card; the focus is back on the same badge, the sheet still open', { before, after, stillOpen });

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
const hidden = await open('false_start');
check(!!hidden && hidden.state === 'secret' && hidden.name === '???' && hidden.kicker === 'Hidden', 'AD-05 a hidden achievement keeps its ??? and says Hidden', hidden);
await h.shot(page, '5-tv-detail-hidden');
await closeCard();

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
check(await pUntil(() => document.getElementById('achievements-modal').open === true && document.querySelectorAll('#achievements-modal .lb-ach-item').length === 100), 'AD-07 a tap on ⭐ opens the Achievements sheet');
await h.shot(ph, '6-phone-grid');
await ph.tap('#achievements-modal .lb-ach-item[data-ach="first_finish"]');
const phOpen = await pUntil(() => document.getElementById('ach-detail').open === true, null, 3000);
const pc = phOpen ? await ph.evaluate(() => {
  const s = document.getElementById('ach-detail');
  const cr = s.querySelector('.uf-sheet__card').getBoundingClientRect();
  return { name: s.querySelector('.ach-detail-name')?.textContent, fits: cr.left >= 0 && cr.right <= innerWidth + 0.5 && cr.top >= 0 && cr.bottom <= innerHeight + 0.5,
    namePx: parseFloat(getComputedStyle(s.querySelector('.ach-detail-name')).fontSize), scrollW: document.documentElement.scrollWidth, w: Math.round(cr.width) };
}) : null;
check(!!pc && pc.name === 'Made It' && pc.fits && pc.scrollW <= 390 && pc.namePx >= 24, 'AD-07 the card fits the phone (no sideways scroll, name ≥24px)', pc);
await h.shot(ph, '7-phone-detail');
await ph.tap('#ach-detail .uf-sheet__close');
const back = await pUntil(() => document.getElementById('ach-detail').open === false && document.getElementById('achievements-modal').open === true, null, 3000);
check(!!back, 'AD-07 Close returns to the grid');

await h.finish();
