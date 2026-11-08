#!/usr/bin/env node
// smoke:tv-music · #567: the lobby music starts on a TV.
//
//   TVM-01  ?tv=1, first visit, autoplay needs user activation (Chromium's strict policy): the boot try is refused
//           and the Music toggle says so; a synthetic click (what the phone remote and a pad's A send) is no
//           activation and plays nothing; the first remote key (a real keydown) lifts the veil and the music plays
//   TVM-02  ?tv=1, returning visit (no veil), same policy: the first remote key starts the music
//   TVM-03  a TV browser that refuses <audio>.play() but lets Web Audio play (the Google TV browser: effects, no
//           music): the music plays from the AudioContext with no key at all
import { startHarness, sleep } from './lib/smoke-harness.mjs';

// Puppeteer's page.evaluate / waitForFunction run as a user gesture, which would hand the page the very
// activation this smoke is about. Every read here goes through CDP Runtime.evaluate with userGesture off, so
// the only activation the page ever gets is the remote's key.
const cdps = new WeakMap();
async function peek(page, expr) {
  if (!cdps.has(page)) cdps.set(page, await page.createCDPSession());
  const r = await cdps.get(page).send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: false });
  return r.result ? r.result.value : undefined;
}
async function until(page, expr, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await peek(page, expr)) return true; } catch { /* page still booting */ }
    await sleep(150);
  }
  return false;
}
const music = (page) => peek(page, `(() => {
  const g = window._game, m = g._musicEl, ctx = g.audioEngine && g.audioEngine.ctx;
  const t = document.getElementById('toggle-music');
  return { mode: m.mode, blocked: m.blocked, elPaused: m.el.paused, elTime: +m.el.currentTime.toFixed(2), time: +m.currentTime.toFixed(2),
    ctx: ctx ? ctx.state : null, veil: !!document.getElementById('tap-to-start'), toggleBlocked: !!(t && t.classList.contains('music-blocked')),
    activated: !!(navigator.userActivation && navigator.userActivation.hasBeenActive) };
})()`);
/** Playing, and the playhead moves. */
const plays = async (page) => {
  const a = await music(page);
  await sleep(1200);
  const b = await music(page);
  return { ok: !!b.mode && b.time !== a.time, a, b };
};

// ── strict autoplay (needs user activation) ──
const strict = await startHarness({ port: 9041, autoplay: 'document-user-activation-required' });
{
  console.log('TVM-01 first visit, strict autoplay');
  const page = await strict.gamePage({ query: '?tv=1', tapToStart: false, waitGame: false, storage: { tandemonium_started: '', tandemonium_tutorial_done: 'smoke' } });
  await until(page, `!!window._game && !!window._game._musicEl && /press any button/i.test((document.getElementById('tap-to-start-text') || {}).textContent || '')`, 90000);
  await until(page, `!!(window._game && window._game._musicEl && window._game._musicEl.blocked)`, 90000);
  let m = await music(page);
  strict.check(!m.mode && m.blocked === 'NotAllowedError' && m.veil && !m.activated, 'TVM-01: before any key the boot try is refused (NotAllowedError) and the veil waits', m);
  strict.check(m.toggleBlocked, 'TVM-01: the Music toggle shows it is waiting (music-blocked)', m);
  // the phone remote / pad path: a synthetic click, no user activation
  await peek(page, `document.getElementById('lobby').click()`);
  await sleep(800);
  m = await music(page);
  strict.check(!m.mode && !m.activated && m.blocked === 'NotAllowedError' && m.toggleBlocked, 'TVM-01: a synthetic click (phone remote, pad A) is no activation: still no music', m);
  // the TV remote's OK: a real keydown
  await page.keyboard.press('Enter');
  const ok = await until(page, `window._game._musicEl.playing`, 20000);
  const p = await plays(page);
  strict.check(ok && p.ok, 'TVM-01: the first remote key starts the music, and it keeps playing', p);
  strict.check(!p.b.veil && !p.b.toggleBlocked && p.b.blocked === null, 'TVM-01: the veil lifts and the toggle no longer says blocked', p.b);
  await page.close();
}
{
  console.log('TVM-02 returning visit, strict autoplay');
  const page = await strict.gamePage({ query: '?tv=1', tapToStart: false, waitGame: false, storage: { tandemonium_tutorial_done: 'smoke' } });
  await until(page, `!!(window._game && window._game._musicEl && window._game._musicEl.blocked)`, 90000);
  let m = await music(page);
  strict.check(!m.mode && m.blocked === 'NotAllowedError' && !m.veil && !m.activated, 'TVM-02: no veil; the boot try is refused', m);
  await page.keyboard.press('ArrowDown');
  const ok = await until(page, `window._game._musicEl.playing`, 20000);
  const p = await plays(page);
  strict.check(ok && p.ok, 'TVM-02: the first remote key (D-pad) starts the music', p);
  await page.close();
}
await strict.browser.close();
strict.server.close();

// ── the Google TV browser: <audio> refused, Web Audio allowed ──
const tv = await startHarness({ port: 9042 });
{
  console.log('TVM-03 <audio>.play() refused, Web Audio allowed, no key');
  const page = await tv.gamePage({ query: '?tv=1', tapToStart: false, waitGame: false, storage: { tandemonium_tutorial_done: 'smoke' },
    before: (pg) => pg.evaluateOnNewDocument(() => {
      HTMLMediaElement.prototype.play = function () { return Promise.reject(new DOMException('refused like the TV browser', 'NotAllowedError')); };
    }) });
  const ok = await until(page, `!!(window._game && window._game._musicEl && window._game._musicEl.mode === 'webaudio')`, 90000);
  const p = await plays(page);
  tv.check(ok && p.ok && p.b.ctx === 'running' && p.b.elPaused, 'TVM-03: the music plays from the AudioContext (decoded), the element stays paused', p);
  tv.check(!p.b.toggleBlocked, 'TVM-03: the Music toggle is not marked blocked', p.b);
  await page.close();
}
// strict's results count too
for (const r of strict.results) tv.results.push(r);
for (const e of strict.errors) tv.errors.push(e);
await tv.finish();
