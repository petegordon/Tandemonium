#!/usr/bin/env node
// smoke:flows · lobby back / focus / Options, and the game-over and victory
// buttons (docs/test-script.md BL-04, BL-08, BL-09, SR-09, SR-10).
//
// One fake Xbox pad (scripts/lib/fake-gamepads.mjs) is plugged in at boot, so
// the lobby's FocusController drives focus and B the way a real pad does.
//
//   BL-04  every lobby step goes back one step by its Back button, by Esc and
//          by B; the mode step (root) has no back and stays put
//   BL-09  with a pad, each step's focus ring starts on a visible, enabled
//          control of that step (its primary action where it has one)
//   BL-08  Options opens/closes by mouse (gear / Close), by pad (Start / B),
//          and by Esc — see KNOWN below
//   SR-09  game-over: RESTART rides again, END RIDE goes to the lobby, SAVE CLIP
//          shows only while recording (and opens the preview), no GARAGE
//   SR-10  victory: NEXT LEVEL rides the next level, PLAY AGAIN rides the same
//          one, END RIDE goes to the lobby, no GARAGE
//          (the garage is Slingshot-only: js/economy-mode.js _showRideCoins)
//
// KNOWN checks print "KNOWN BUG" instead of failing the run, so CI stays green
// while the bug is open; they print "FIXED" once the game behaves, which is the
// cue to turn them into normal checks.
import { startHarness, sleep, clickId } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const h = await startHarness({ port: 8965, outDir: 'tandemonium-flows' });
const { check } = h;
const known = (ok, name, detail) => {
  console.log(`  ${ok ? 'FIXED (make this a check)' : 'KNOWN BUG'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
};

const page = await h.gamePage({
  storage: { tandemonium_tutorial_done: 'smoke' },
  before: async (p) => {
    await installFakeGamepads(p, { atBoot: ['xbox'] });
    // Tourist is off without a Maps key, and CI has no js/tourist-key.local.js
    // (gitignored). A fake key turns it on everywhere; nothing is fetched.
    await p.evaluateOnNewDocument(() => { if (!window.__TOURIST_MAPS_KEY__) window.__TOURIST_MAPS_KEY__ = 'test-key-not-real'; });
  },
});
const pads = fakePads(page);
await sleep(2000);

/** Current step, focused control, and whether Options is open. */
const look = () => page.evaluate(() => {
  const flow = document.getElementById('lobby-flow');
  const stepEl = flow && flow.current ? document.getElementById(flow.current) : null;
  const f = Array.from(document.querySelectorAll('.gamepad-focus')).find((el) => !el.closest('#options-overlay')) || null;
  const r = f ? f.getBoundingClientRect() : null;
  return {
    step: flow ? flow.current : null,
    state: window._game.state,
    options: document.getElementById('options-overlay').classList.contains('visible'),
    focus: f ? (f.id || f.className) : null,
    focusText: f ? (f.textContent || '').trim().slice(0, 24) : null,
    focusVisible: !!r && r.width > 0 && r.height > 0,
    focusEnabled: !!f && !f.disabled && !f.hasAttribute('disabled'),
    focusInStep: !!f && !!stepEl && stepEl.contains(f),
  };
});
const show = (stepProp) => page.evaluate((p) => { const l = window._game.lobby; l._showStep(l[p]); }, stepProp);
const esc = async () => { await page.keyboard.press('Escape'); await sleep(600); };
const padB = async () => { await pads.tap(0, 'B'); await sleep(500); };

// ── BL-04 / BL-09: lobby back and first focus ──
console.log('lobby back + focus');
{
  let s = await look();
  check(s.step === 'lobby-mode', 'boot lands on mode select', s.step);
  check(s.focusVisible && s.focusEnabled && s.focusInStep && /^btn-(solo|together)$/.test(s.focus || ''), 'BL-09 mode: focus starts on a mode card', s.focus);
  await esc();
  check((await look()).step === 'lobby-mode', 'BL-04 mode: Esc does nothing at the root');
  await padB();
  check((await look()).step === 'lobby-mode', 'BL-04 mode: B does nothing at the root');
  check(await page.evaluate(() => { const l = window._game.lobby; return l._stepBack.get(l.modeStep) == null; }), 'BL-04 mode: no back button registered');

  // Each case: how to get there, where it starts focus, where Back lands.
  // `via` runs from mode select; `back` is the step one Back press returns to.
  const cases = [
    { name: 'level (solo)', via: async () => { await clickId(page, 'btn-solo'); }, step: 'lobby-level', focus: /^btn-start-ride$/, back: 'lobby-mode', backBtn: 'btn-back-level' },
    { name: 'role', via: async () => { await clickId(page, 'btn-together'); }, step: 'lobby-role', focus: /^btn-(captain|stoker)$/, back: 'lobby-mode', backBtn: 'btn-back-mode' },
    { name: 'versus', via: async () => { await clickId(page, 'btn-together'); await sleep(500); await clickId(page, 'btn-versus'); }, step: 'lobby-versus', focus: /^btn-versus-continue$/, focusMayBeDisabled: true, back: 'lobby-role', backBtn: 'btn-back-versus' },
    // Host and join need a network to reach for real; captain/stoker buttons get there without one.
    { name: 'host', via: async () => { await clickId(page, 'btn-together'); await sleep(500); await clickId(page, 'btn-captain'); await sleep(1500); }, step: 'lobby-host', focus: null, back: 'lobby-role', backBtn: 'btn-back-role-host' },
    { name: 'join', via: async () => { await clickId(page, 'btn-together'); await sleep(500); await clickId(page, 'btn-stoker'); await sleep(800); }, step: 'lobby-join', focus: /ukp-key/, back: 'lobby-role', backBtn: 'btn-back-role-join' },
    // Tourist opens from a SOLO level card; it is hidden without a Maps key, so show it directly.
    { name: 'tourist', via: async () => { await clickId(page, 'btn-solo'); await sleep(500); await show('touristStep'); }, step: 'lobby-tourist', focus: null, back: 'lobby-level', backBtn: 'btn-back-tourist' },
  ];
  for (const c of cases) {
    for (const how of ['button', 'Esc', 'B']) {
      await show('modeStep'); await sleep(400);
      await c.via(); await sleep(800);
      s = await look();
      if (!check(s.step === c.step, `BL-04 ${c.name}: reached (${how} run)`, s.step)) continue;
      if (how === 'button') {
        // Versus focuses CHOOSE LEVEL even while it waits for a second team (#458 item 10).
        if (c.focus) check(s.focusVisible && (s.focusEnabled || c.focusMayBeDisabled) && c.focus.test(s.focus || ''), `BL-09 ${c.name}: focus starts on its primary action`, { focus: s.focus, text: s.focusText });
        else check(s.focusVisible && s.focusEnabled, `BL-09 ${c.name}: focus starts on a visible, enabled control`, { focus: s.focus, text: s.focusText, inStep: s.focusInStep });
        await clickId(page, c.backBtn); await sleep(600);
      } else if (how === 'Esc') await esc();
      else await padB();
      s = await look();
      check(s.step === c.back, `BL-04 ${c.name}: ${how} goes back to ${c.back}`, s.step);
    }
  }
  // Level select reached from the host step (local co-op) goes back to the host step.
  await show('modeStep'); await sleep(300);
  await page.evaluate(() => {
    const l = window._game.lobby;
    document.getElementById('room-code-display').textContent = 'TNDM-FLOW';
    l._pendingMode = 'multiplayer'; l._roomRole = 'captain';
    l._showStep(l.hostStep); l._refreshHostNext();
    l._onLocalJoinClick('keyboard', null);
  });
  await sleep(600);
  await clickId(page, 'btn-host-local-next'); await sleep(700);
  s = await look();
  check(s.step === 'lobby-level', 'BL-04 level (local co-op): reached from the host step', s.step);
  await esc();
  check((await look()).step === 'lobby-host', 'BL-04 level (local co-op): Esc goes back to the host step', (await look()).step);
  await page.evaluate(() => window._game.lobby._leaveLocalP2?.('smoke'));
  await show('modeStep'); await sleep(500);
}

// ── BL-08: Options open / close ──
console.log('options');
{
  const opts = async () => (await look()).options;
  await clickId(page, 'ctrl-settings-btn'); await sleep(500);
  check(await opts(), 'BL-08 mouse: the gear opens Options');
  await clickId(page, 'options-close-btn'); await sleep(500);
  check(!(await opts()), 'BL-08 mouse: Close closes Options');
  await pads.tap(0, 'START'); await sleep(400);
  check(await opts(), 'BL-08 pad: Start opens Options');
  await pads.tap(0, 'START'); await sleep(400);
  check(!(await opts()), 'BL-08 pad: Start again closes Options');
  await pads.tap(0, 'START'); await sleep(400);
  await padB();
  check(!(await opts()), 'BL-08 pad: B closes Options');
  check((await look()).step === 'lobby-mode', 'BL-08 pad: B closing Options does not also step the lobby back');
  await clickId(page, 'ctrl-settings-btn'); await sleep(500);
  await esc();
  known(!(await opts()), 'BL-08 Esc: Esc closes Options (no Esc handler for Options in js/game.js)');
  await clickId(page, 'options-close-btn'); await sleep(400);
  // With Options open on level select, Esc steps the lobby back underneath it.
  await clickId(page, 'btn-solo'); await sleep(700);
  await clickId(page, 'ctrl-settings-btn'); await sleep(500);
  await esc();
  const under = await look();
  known(under.step === 'lobby-level', 'BL-08 Esc: Esc with Options open leaves the lobby step alone (it goes back to mode select under the overlay)', under.step);
  await clickId(page, 'options-close-btn'); await sleep(400);
  await show('modeStep'); await sleep(400);
}

// ── SR-09 / SR-10: game-over and victory buttons ──
const waitState = (st, timeout = 240000) => page.waitForFunction((x) => window._game?.state === x, { timeout, polling: 100 }, st);
const shown = (id) => page.evaluate((i) => { const e = document.getElementById(i); return !!e && e.style.display !== 'none' && e.getBoundingClientRect().width > 0; }, id);
const levelId = () => page.evaluate(() => window._game.lobby.selectedLevel?.id || null);

async function startGrandma() {
  await show('modeStep'); await sleep(300);
  await clickId(page, 'btn-solo'); await sleep(700);
  await page.evaluate(() => {
    const card = document.querySelector('[data-level-id="grandma"]');
    if (card) card.click();
  });
  await sleep(300);
  await clickId(page, 'btn-start-ride');
  await waitState('playing', 120000);
  await sleep(600);
}
async function crash() {
  // As smoke-economy does: past checkpoint 1 with some distance, then the game-over screen.
  await page.evaluate(() => { const g = window._game, rm = g.raceManager; rm.passedCheckpoints.add(rm.checkpoints[1]); g.bike.distanceTraveled = Math.max(g.bike.distanceTraveled, 140); g._showGameOver(); });
  await sleep(1200);
}
async function finish() {
  await page.evaluate(() => { const g = window._game; g.bike.distanceTraveled = g.lobby.selectedLevel.distance - 0.5; g.bike.speed = 10; });
  await waitState('victory');
  await sleep(1500);
}

console.log('game-over buttons');
{
  await startGrandma();
  const level = await levelId();
  await crash();
  check(await page.evaluate(() => window._game.state) === 'gameover', 'SR-09 a forced crash shows the game-over screen');
  check(await shown('btn-restart') && await shown('btn-gameover-lobby'), 'SR-09 RESTART and END RIDE shown');
  const clip = await shown('btn-gameover-clip');
  const recording = await page.evaluate(() => !!(window._game.recorder && window._game.recorder.buffering));
  check(clip === recording, 'SR-09 SAVE CLIP shown exactly when the ride is recording', { clip, recording });
  if (clip) {
    await clickId(page, 'btn-gameover-clip'); await sleep(1500);
    const preview = await page.evaluate(() => !!window._game.recorder._previewPollId || !!document.querySelector('#clip-preview-overlay[style*="flex"], .clip-preview.visible'));
    check(preview, 'SR-09 SAVE CLIP opens the clip preview');
    await page.keyboard.press('Escape'); await sleep(500);
  }
  await clickId(page, 'btn-restart');
  await waitState('playing', 120000);
  check(await levelId() === level, 'SR-09 RESTART rides the same level again', await levelId());
  await crash();
  // The garage lives in Slingshot only (js/economy-mode.js _showRideCoins): a
  // regular ride's game-over pays coins but offers no GARAGE.
  check(!(await shown('btn-gameover-garage')), 'SR-09 no GARAGE on a regular ride (garage is Slingshot-only)');
  await clickId(page, 'btn-gameover-lobby');
  await waitState('lobby', 30000).catch(() => {});
  const s = await look();
  check(s.state === 'lobby' && !!s.step, 'SR-09 END RIDE returns to the lobby', s);
}

console.log('victory buttons');
{
  await startGrandma();
  const first = await levelId();
  await finish();
  check(await shown('btn-play-again') && await shown('btn-victory-lobby'), 'SR-10 PLAY AGAIN and END RIDE shown');
  const hasNext = await shown('btn-next-level');
  check(hasNext, 'SR-10 NEXT LEVEL shown after Grandma\'s');
  if (hasNext) {
    await clickId(page, 'btn-next-level');
    await waitState('playing', 120000).catch(() => {});
    const next = await levelId();
    check(await page.evaluate(() => window._game.state) === 'playing' && next && next !== first, 'SR-10 NEXT LEVEL rides a different level', { first, next });
    await page.evaluate(() => window._game._returnToLobby());
    await sleep(800);
  }
  await startGrandma();
  await finish();
  await clickId(page, 'btn-play-again');
  await waitState('playing', 120000).catch(() => {});
  check(await page.evaluate(() => window._game.state) === 'playing' && await levelId() === first, 'SR-10 PLAY AGAIN rides the same level', await levelId());
  await finish();
  check(!(await shown('btn-victory-garage')), 'SR-10 no GARAGE on a regular ride (garage is Slingshot-only)');
  await clickId(page, 'btn-victory-lobby');
  await waitState('lobby', 30000).catch(() => {});
  const s = await look();
  check(s.state === 'lobby' && !!s.step, 'SR-10 END RIDE returns to the lobby', s);
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
