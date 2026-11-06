#!/usr/bin/env node
// smoke:seat-churn · standing a player up and sitting them down, over and over,
// must not cost the game its renderer (TV playtest 2026-11-06).
//
//   SC-01  co-op, two Steam Controllers on one Puck, controller overlay on:
//          body 2 stands up (B) and sits down (A) 20 times. The game's WebGL
//          context is never lost, the page never reloads, and live WebGL
//          contexts stay bounded (each seat tile used to keep its context
//          until garbage collection; past Chromium's 16 the oldest, the
//          game's, was dropped and the game reloaded to the lobby).
//   SC-02  the stoker is still seated on body 2 after the churn.
//   SC-03  one B stands the stoker up and they stay up: the held B never
//          re-seats them on a new slot, even with a DualSense also listed
//          ("press B twice to stand up", same playtest). A guard: on the TV the
//          held B was re-claimed onto a new slot by Steam's live behaviour,
//          which these fakes do not reproduce, so this passes on the old code
//          too; the TV diag log is the evidence for the fix.
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeGamepads } from './lib/fake-gamepads.mjs';
import { installFakeWebHid, hidDevice, FACE_A } from './lib/fake-webhid.mjs';
import { installFakeSteam } from './lib/fake-steam.mjs';
import { fakePads } from './lib/fake-gamepads.mjs';

const ROUNDS = 20;
const WAIT_MS = 45000;
const h = await startHarness({ port: 8992, outDir: 'tandemonium-seat-churn' });
const { check } = h;

// Count every WebGL context the page creates, which ones are still alive, and
// whether the game's own canvas (the first full-screen one) loses its context.
const instrument = (p) => p.evaluateOnNewDocument(() => {
  const st = window.__gl = { created: 0, lost: 0, lostGame: 0, live: new Set(), reloadMarker: sessionStorage.getItem('__sc_boot') };
  sessionStorage.setItem('__sc_boot', String(Date.now()));
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const had = this.__glctx;
    const ctx = orig.call(this, type, attrs);
    if (ctx && /webgl/.test(type) && !had) {
      this.__glctx = ctx;
      st.created++;
      st.live.add(ctx);
      this.addEventListener('webglcontextlost', () => {
        st.lost++; st.live.delete(ctx);
        if (this === (window._game && window._game.renderer && window._game.renderer.domElement)) st.lostGame++;
      });
    }
    return ctx;
  };
});

const page = await h.gamePage({
  storage: { tandemonium_tutorial_done: 'smoke', tandemonium_controller_overlay: 'on' },
  before: async (p) => {
    p.setDefaultNavigationTimeout(180000); p.setDefaultTimeout(180000);
    await instrument(p);
    await installFakeWebHid(p, [hidDevice.steamPuck('body-1'), hidDevice.steamPuck('body-2'), hidDevice.puckIdleSibling('puck-idle'), hidDevice.dualsenseUsb('ds')]);
    await installFakeGamepads(p);
    // Under Steam each Steam Controller is ALSO a virtual XInput pad that
    // mirrors its presses (the TV setup: two Puck bodies, two XInput slots).
    await installFakeSteam(p, { xinput: [{ index: 0, handle: '100', type: '14' }, { index: 1, handle: '200', type: '14' }] });
  },
});

const state = () => page.evaluate(() => {
  if (!window._game || !window._game.lobby || !window.__controllerManager) return { gl: { reloaded: true, lostGame: 0, live: 0 } };
  const m = window.__controllerManager, l = window._game.lobby, im = l._localP2InputManager;
  const p1 = m.slots.find((s) => s.id === 'P1');
  const streaming = [...m._hidPool.values()].filter((e) => e.hidActiveSince > 0).length + m.slots.filter((s) => s._hidEntry && s._hidEntry.hidActiveSince > 0).length;
  return {
    p1: p1 && p1.state === 'claimed' && p1.hidDevice && p1.hidDevice.__fakeKey,
    seated: !!(im && l._localSeatedOnHost),
    p2Hid: im && im._slot && im._slot.hidDevice ? im._slot.hidDevice.__fakeKey : null,
    streaming,
    gl: { created: window.__gl.created, live: window.__gl.live.size, lost: window.__gl.lost, lostGame: window.__gl.lostGame, reloaded: !!window.__gl.reloadMarker },
    tiles: document.querySelectorAll('#controller-overlay .cohud-tile').length,
  };
});
const until = async (pred, ms = WAIT_MS) => { let s; for (const t0 = Date.now(); ;) { s = await state(); if (pred(s) || Date.now() - t0 > ms) return s; await sleep(200); } };
const hold = async (key, bit, pred) => {
  await page.evaluate((k, o, m) => window.__fakeHid.hold(k, o, m, true), key, bit.offset, bit.mask); await page.evaluate((i, b, v) => window.__fakePads.hold(i, b, v), TWIN[key], bit.mask === 0x02 ? 'B' : 'A', true);
  const s = await until(pred);
  await page.evaluate((k, o, m) => window.__fakeHid.hold(k, o, m, false), key, bit.offset, bit.mask); await page.evaluate((i, b, v) => window.__fakePads.hold(i, b, v), TWIN[key], bit.mask === 0x02 ? 'B' : 'A', false);
  await sleep(400);
  return s;
};
const A = FACE_A.steam;
const TWIN = { 'body-1': 0, 'body-2': 1 };
const B = { offset: FACE_A.steam.offset, mask: 0x02 };

await until((s) => s.streaming >= 3);
const pads = fakePads(page);
await pads.plug('xbox');
await pads.plug('xbox');
await hold('body-1', A, (s) => s.p1 === 'body-1');
await page.evaluate(() => {
  const l = window._game.lobby;
  document.getElementById('room-code-display').textContent = 'TNDM-LOCL';
  l._pendingMode = 'multiplayer'; l._roomRole = 'captain';
  l._showStep(l.hostStep); l._refreshHostNext();
});
let s = await hold('body-2', A, (x) => x.seated);
const start = s.gl;
console.log('  start', JSON.stringify(s));
let failedAt = null;
let reseated = 0;
for (let i = 1; i <= ROUNDS; i++) {
  // A real press: B stays down a few hundred ms after the stoker stands up.
  await page.evaluate((o, m) => window.__fakeHid.hold('body-2', o, m, true), B.offset, B.mask); await page.evaluate((v) => window.__fakePads.hold(1, 'B', v), true);
  s = await until((x) => !x.seated);
  await sleep(400);
  const during = (await state()).seated;
  await page.evaluate((o, m) => window.__fakeHid.hold('body-2', o, m, false), B.offset, B.mask); await page.evaluate((v) => window.__fakePads.hold(1, 'B', v), false);
  await sleep(800);
  if (s.seated) { failedAt = `round ${i}: B did not stand up`; break; }
  if (during || (await state()).seated) { reseated++; s = await hold('body-2', B, (x) => !x.seated); }
  s = await hold('body-2', A, (x) => x.seated);
  if (!s.seated) { failedAt = `round ${i}: A did not sit down`; break; }
  if (i % 5 === 0) console.log(`  round ${i}`, JSON.stringify(s.gl), 'tiles', s.tiles);
  if (s.gl.lostGame || s.gl.reloaded) { failedAt = `round ${i}: game context lost`; break; }
}
await sleep(5000);   // the game reloads 4 s after a lost context
s = await state();
check(!s.gl.lostGame && !s.gl.reloaded, `SC-01 ${ROUNDS} stand-up/sit-down rounds: the game's WebGL context is never lost and the page never reloads`, { ...s.gl, failedAt });
check(!s.gl.reloaded && s.gl.live <= start.live + 2, 'SC-01 live WebGL contexts stay bounded (released tiles free their context)', { start, end: s.gl });
check(!failedAt && s.seated && s.p2Hid === 'body-2', 'SC-02 after the churn the stoker is seated on body 2', { failedAt, seated: s.seated, p2Hid: s.p2Hid });
check(reseated === 0, 'SC-03 one B stands the stoker up and they stay up (never re-seated by the held B)', { reseated, rounds: ROUNDS });
await h.shot(page, 'sc-end');
await h.finish();
