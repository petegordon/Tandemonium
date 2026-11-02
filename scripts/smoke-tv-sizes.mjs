#!/usr/bin/env node
// smoke:tv-sizes · text and targets sized for a TV at 1080p.
//
//   TV-01  tutorial coaching (#541): the instruction line, phase dots, COLLECT
//          marker and dodge arrow are at the kit's TV sizes, not phone pixels.
//   TV-02  Steering feel (#542): the Stable / Responsive labels and the slider
//          thumb are readable / reachable, on the tutorial finish screen and
//          in the Controls sheet.
//   TV-04  a TV's own browser (Android TV, 960×540, no touch): TV lobby laid out
//          1920 wide, Phone as controller (no WebHID Pair), Low tier, a
//          "Press any button" boot veil, and the perf readout names the device.
import { startHarness } from './lib/smoke-harness.mjs';

const h = await startHarness({ port: 8994, outDir: 'tandemonium-tv-sizes' });
const { check } = h;
const page = await h.gamePage({ viewport: { width: 1920, height: 1080 }, storage: { tandemonium_tutorial_done: 'smoke' } });
await page.waitForFunction(() => window._game && window._game.lobby, { timeout: 90000, polling: 100 });
const kit = () => page.evaluate(() => {
  const probe = document.createElement('span'); document.body.appendChild(probe);
  const px = (v) => { probe.style.fontSize = `var(${v})`; return parseFloat(getComputedStyle(probe).fontSize); };
  const out = { md: px('--uf-size-md'), lg: px('--uf-size-lg'), xl: px('--uf-size-xl'), x2: px('--uf-size-2xl') };
  probe.remove(); return out;
});
const K = await kit();

// ── TV-03 · first lobby page: dimmed geese art behind, right panel fades into it (#553) ──
await page.waitForFunction(() => document.getElementById('lobby-mode')?.hasAttribute('active') && document.getElementById('lobby-img-right').complete, { timeout: 30000, polling: 100 });
const art = await page.evaluate(() => {
  const bg = getComputedStyle(document.getElementById('lobby'), '::before');
  const right = getComputedStyle(document.getElementById('lobby-img-right'));
  return { bg: bg.backgroundImage, filter: bg.filter, mask: right.maskImage || right.webkitMaskImage };
});
check(/large_action_behind/.test(art.bg) && /brightness/.test(art.filter), 'TV-03 first page: the geese painting fills the stage, dimmed', art);
check(/linear-gradient/.test(art.mask || ''), 'TV-03 first page: the right panel fades into the backdrop', art);
const tops = await page.evaluate(() => ({
  chooser: Math.round(document.getElementById('bike-carousel').getBoundingClientRect().top),
  together: Math.round(document.getElementById('btn-together').getBoundingClientRect().top),
  chooserBottom: Math.round(document.getElementById('bike-carousel').getBoundingClientRect().bottom),
  barTop: Math.round(document.getElementById('lobby-bar').getBoundingClientRect().top),
}));
check(Math.abs(tops.chooser - tops.together) <= 6 && tops.barTop - tops.chooserBottom >= 24, 'TV-03 first page: the bike chooser sits low, its top level with RIDE TOGETHER', tops);
// A DualSense driving the menus: the chooser's arrows read L1 / R1, big enough for the couch.
await page.evaluate(() => {
  document.body.classList.add('pad-menus');
  customElements.get('uf-controller-glyph').setDefault({ family: 'playstation' });
});
await page.waitForFunction(() => document.querySelector('#bike-prev uf-controller-glyph')?.textContent.trim() === 'L1', { timeout: 10000, polling: 100 });
const nav = await page.evaluate(() => {
  const g = (id) => document.querySelector(`#${id} uf-controller-glyph`), ufg = (id) => g(id).querySelector('.ufg');
  const arrow = getComputedStyle(document.querySelector('#bike-prev .bike-nav-arrow')).display;
  const r = (id) => ufg(id).getBoundingClientRect(), btn = document.getElementById('bike-prev').getBoundingClientRect();
  return { prev: g('bike-prev').textContent.trim(), next: g('bike-next').textContent.trim(), font: parseFloat(getComputedStyle(ufg('bike-prev')).fontSize), arrow, fits: r('bike-prev').width <= btn.width && r('bike-next').width > 0 };
});
check(nav.prev === 'L1' && nav.next === 'R1' && nav.arrow === 'none', 'TV-03 bike chooser: with a pad the arrows read L1 / R1', nav);
check(nav.font >= K.md && nav.fits, 'TV-03 bike chooser: L1 / R1 are TV-sized and fit their tabs', { ...nav, md: K.md });
await h.shot(page, '0-lobby-art');
await page.evaluate(() => document.body.classList.remove('pad-menus'));

// ── TV-01 · tutorial coaching ──
const coach = await page.evaluate(() => {
  const g = window._game;
  g._tutTargetPhase = 1; g._tutCompletedPhases = new Set();
  g._showTutorialPhase(1);
  document.getElementById('coaching-collect-indicator').classList.add('visible');
  document.getElementById('coaching-dodge-arrow').classList.add('visible');
  const fs = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).fontSize);
  const r = (sel) => document.querySelector(sel).getBoundingClientRect();
  return {
    prompt: fs('#tutorial-prompt-text'), promptOnScreen: r('#tutorial-prompt-text').right <= innerWidth && r('#tutorial-prompt-text').left >= 0,
    dot: r('.tutorial-dot').width, collectText: fs('#coaching-collect-indicator .collect-text'), collectIcon: fs('#coaching-collect-indicator .collect-icon'),
    arrow: r('#coaching-dodge-arrow svg').width,
  };
});
check(coach.prompt >= K.x2 - 0.5 && coach.promptOnScreen, 'TV-01 the tutorial instruction is at --uf-size-2xl and fits on screen', { ...coach, K });
check(coach.collectText >= K.lg - 0.5 && coach.collectIcon >= K.x2 * 2, 'TV-01 the COLLECT marker (text and gift icon) is TV-sized', coach);
check(coach.dot >= K.md * 0.6 && coach.arrow >= K.x2 * 3.5, 'TV-01 the phase dots and dodge arrow are TV-sized', coach);
await h.shot(page, '1-coaching');
await page.evaluate(() => {
  for (const id of ['tutorial-prompt', 'coaching-collect-indicator', 'coaching-dodge-arrow']) document.getElementById(id).classList.remove('visible');
});

// ── TV-02 · Steering feel, tutorial finish ──
await page.evaluate(() => {
  const g = window._game;
  Object.assign(g, { _tutPhase1Samples: [], _tutPhase2Samples: [], _tutPhase2Speeds: [], _tutPhase3Recovery: [] });
  g._tutorialComplete();
});
await page.waitForFunction(() => document.getElementById('tutorial-complete').classList.contains('visible'), { timeout: 15000, polling: 100 });
const fin = await page.evaluate(() => {
  const ends = [...document.querySelectorAll('#tutorial-complete .steering-feel-end')].map((e) => parseFloat(getComputedStyle(e).fontSize));
  const s = document.getElementById('steering-feel-slider');
  const r = s.getBoundingClientRect();
  return { ends, trackH: r.height, sliderW: r.width };
});
check(fin.ends.length === 2 && fin.ends.every((v) => v >= K.md - 0.5), 'TV-02 tutorial finish: Stable / Responsive at --uf-size-md', { ...fin, md: K.md });
check(fin.trackH >= K.md * 0.35 && fin.sliderW >= 200, 'TV-02 tutorial finish: the slider track is TV-sized (thumb scales with it)', fin);
await h.shot(page, '2-tutorial-finish');
await page.evaluate(() => document.getElementById('tutorial-complete').classList.remove('visible'));

// ── TV-02 · Steering feel, Controls sheet ──
await page.evaluate(() => document.getElementById('bar-controls').click());
await page.waitForFunction(() => document.getElementById('controls-sheet').open === true, { timeout: 15000, polling: 100 });
const ctl = await page.evaluate(() => {
  const gyro = document.getElementById('set-gyro'); gyro.checked = true;   // the detail row shows with gyro on
  const ends = [...document.querySelectorAll('#controls-sheet .set-feel-end')].map((e) => parseFloat(getComputedStyle(e).fontSize));
  const s = document.getElementById('set-feel-slider'), r = s.getBoundingClientRect();
  return { ends, w: r.width, h: r.height };
});
check(ctl.ends.length === 2 && ctl.ends.every((v) => v >= K.md - 0.5), 'TV-02 Controls sheet: Stable / Responsive at --uf-size-md', { ...ctl, md: K.md });
check(ctl.h >= 24, 'TV-02 Controls sheet: the slider is taller than the browser default', ctl);
await h.shot(page, '3-controls');

// ── TV-04 · a TV's built-in browser is a big screen, not a phone ──
const TV_UA = 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K VH2 Build/STT1.211025.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const tvPage = await h.gamePage({ viewport: { width: 960, height: 540, isMobile: true, hasTouch: false }, userAgent: TV_UA, query: '?debug=perf', storage: { tandemonium_tutorial_done: 'smoke' } });
await tvPage.waitForFunction(() => window._game && window._game.lobby && document.getElementById('lobby-mode')?.hasAttribute('active'), { timeout: 90000, polling: 100 });
const tv = await tvPage.evaluate(() => {
  const shown = (id) => { const el = document.getElementById(id); return !!el && el.style.display !== 'none' && el.getClientRects().length > 0; };
  return { tv: window.__tandemoniumTV, width: window.innerWidth, bar: shown('lobby-bar'), phone: shown('btn-mode-phone'), pair: shown('btn-mode-connect-hid'), tier: window._game._quality };
});
check(tv.tv === true && tv.width >= 1024 && tv.bar, 'TV-04 TV browser: laid out 1920 wide with the TV system bar', tv);
check(tv.phone && !tv.pair, 'TV-04 TV browser: Phone as controller is offered; Pair (WebHID) is not', tv);
check(tv.tier === 'low', 'TV-04 TV browser: Auto starts at Low', tv);
await tvPage.waitForFunction(() => /display /.test(document.getElementById('perf-readout')?.textContent || ''), { timeout: 15000, polling: 100 });
const perfLine = await tvPage.evaluate(() => document.getElementById('perf-readout').textContent.split('\n').find((l) => l.startsWith('display ')));
check(/TV browser · BRAVIA 4K VH2 · screen \d+×\d+/.test(perfLine), 'TV-04 perf readout names the display device', perfLine);
await h.shot(tvPage, '4-tv-browser');
// First visit on a TV: the boot veil waits for a press (not a stuck "Loading…"),
// and a remote key (Enter) lifts it.
const firstVisit = await h.gamePage({
  viewport: { width: 960, height: 540, isMobile: true, hasTouch: false }, userAgent: TV_UA, waitGame: false,
  before: (p) => p.evaluateOnNewDocument(() => { try { localStorage.removeItem('tandemonium_started'); } catch {} }),
});
await firstVisit.waitForFunction(() => window._game && window._game.lobby, { timeout: 90000, polling: 100 });
await firstVisit.waitForFunction(() => /Press any button/.test(document.getElementById('tap-to-start-text')?.textContent || ''), { timeout: 15000, polling: 100 }).catch(() => {});
const veilText = await firstVisit.evaluate(() => document.getElementById('tap-to-start-text')?.textContent);
check(veilText === 'Press any button to start', 'TV-04 TV first visit: the boot veil says Press any button to start', veilText);
await firstVisit.keyboard.press('Enter');
const lifted = await firstVisit.waitForFunction(() => !document.getElementById('tap-to-start')?.isConnected || document.getElementById('tap-to-start').classList.contains('fade-out') || getComputedStyle(document.getElementById('tap-to-start')).display === 'none', { timeout: 10000, polling: 100 }).then(() => true, () => false);
check(lifted, 'TV-04 TV first visit: a remote key lifts the boot veil', lifted);

// A phone (touch) with the same width still gets the phone lobby.
const phonePage = await h.gamePage({ viewport: { width: 412, height: 915, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', storage: { tandemonium_tutorial_done: 'smoke' } });
await phonePage.waitForFunction(() => window._game && window._game.lobby, { timeout: 90000, polling: 100 });
const ph = await phonePage.evaluate(() => ({ tv: window.__tandemoniumTV, width: window.innerWidth, phone: document.getElementById('btn-mode-phone')?.style.display }));
check(ph.tv === false && ph.width < 1024 && ph.phone === 'none', 'TV-04 a phone is still a phone', ph);

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
