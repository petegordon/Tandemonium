#!/usr/bin/env node
// smoke:tv-sizes · text and targets sized for a TV at 1080p.
//
//   TV-01  tutorial coaching (#541): the instruction line, phase dots, COLLECT
//          marker and dodge arrow are at the kit's TV sizes, not phone pixels.
//   TV-02  Steering feel (#542): the Stable / Responsive labels and the slider
//          thumb are readable / reachable, on the tutorial finish screen and
//          in the Controls sheet.
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

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
