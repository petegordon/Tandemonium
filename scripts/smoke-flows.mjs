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
//          and by Esc
//   SR-09  game-over: RESTART rides again, END RIDE goes to the lobby, SAVE CLIP
//          shows only while recording (and opens the preview), no GARAGE
//   SR-10  victory: NEXT LEVEL rides the next level, PLAY AGAIN rides the same
//          one, END RIDE goes to the lobby, no GARAGE
//          (the garage is Slingshot-only: js/economy-mode.js _showRideCoins)
//   SR-27  (#459) every end screen is the result-screen shell: a headline kit
//          sheet, one action row, focus on its primary (game over, victory,
//          demo end, partner left)
//   SR-29  (#459) the pause menu: Start / Esc mid-ride opens it and the ride
//          (physics + race clock) stops; B / Start / Esc / RESUME continue;
//          SETTINGS opens Options over it and B comes back to the menu;
//          View opens Help over it and B comes back; RESTART rides again;
//          END RIDE returns to the lobby
//   BL-13  (#459) a modal (Help) closes on B and on Esc with focus restored
//   QT     #172 quit from the lobby: no Quit pill on the web build; in the
//          desktop app (Electron UA + the preload bridge from fake-steam.mjs)
//          the pill shows on mode select only, the pad reaches it, A opens the
//          confirm with QUIT focused, B / Esc / CANCEL close it without
//          quitting, and QUIT calls the bridge's quit() once
//
// KNOWN checks print "KNOWN BUG" instead of failing the run, so CI stays green
// while the bug is open; they print "FIXED" once the game behaves, which is the
// cue to turn them into normal checks.
import { startHarness, sleep, clickId } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';
import { installFakeSteam, fakeSteam, ELECTRON_UA } from './lib/fake-steam.mjs';

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
  check(!(await opts()), 'BL-08 Esc: Esc closes Options');
  await clickId(page, 'options-close-btn'); await sleep(400);
  // With Options open on level select, Esc steps the lobby back underneath it.
  await clickId(page, 'btn-solo'); await sleep(700);
  await clickId(page, 'ctrl-settings-btn'); await sleep(500);
  await esc();
  const under = await look();
  check(under.step === 'lobby-level', 'BL-08 Esc: Esc with Options open leaves the lobby step alone', under.step);
  await clickId(page, 'options-close-btn'); await sleep(400);
  await show('modeStep'); await sleep(400);
}

// ── BL-13: a modal on the sheet shell (Help) closes on B / Esc, focus restored ──
console.log('modal shell');
{
  const helpState = () => page.evaluate(() => {
    const sheet = document.getElementById('help-modal');
    const f = document.querySelector('.gamepad-focus');
    return { open: !!sheet && sheet.open, sheetTag: sheet ? sheet.tagName.toLowerCase() : null, focus: f ? (f.id || f.className) : null };
  });
  const before = await look();
  await pads.tap(0, 'SELECT'); await sleep(500);   // View / Share / Create = Help (#459 item 18)
  let s = await helpState();
  check(s.open && s.sheetTag === 'uf-sheet', 'BL-13 pad: the View button opens Help, a kit sheet', s);
  await padB();
  s = await helpState();
  check(!s.open, 'BL-13 pad: B closes Help');
  check(s.focus === before.focus, 'BL-13 pad: focus is back where it was', { before: before.focus, after: s.focus });
  await clickId(page, 'bar-help'); await sleep(500);
  check((await helpState()).open, 'BL-13 mouse: the Help pill opens Help');
  await esc();
  s = await helpState();
  check(!s.open && (await look()).step === 'lobby-mode', 'BL-13 Esc closes Help and does not step the lobby back', s);
  await clickId(page, 'credits-btn'); await sleep(500);
  const scrolled = await page.evaluate(() => { const b = document.getElementById('help-modal').body; return { open: document.getElementById('help-modal').open, top: b.scrollTop }; });
  check(scrolled.open && scrolled.top > 0, 'BL-13 the footer © opens Help at its attributions', scrolled);
  await esc();
}

// ── QT: quit from the lobby, desktop app only (#172) ──
console.log('quit (desktop only)');
{
  /** Poll `fn` until truthy (the smokes run at 1-3 fps on CI: never a fixed wait). */
  const until = async (fn, timeout = 12000) => {
    const t0 = Date.now();
    for (;;) { if (await fn()) return true; if (Date.now() - t0 > timeout) return false; await sleep(150); }
  };
  const quitShown = (p) => p.evaluate(() => {
    const b = document.getElementById('bar-quit');
    if (!b || getComputedStyle(b).display === 'none') return false;
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  check(await page.evaluate(() => !window.electronApp), 'QT-01 web build: no Electron bridge');
  check(!(await quitShown(page)), 'QT-01 web build: no Quit pill in the bar');

  // The desktop app: Electron UA + the preload's bridge (fake-steam.mjs, Steam
  // itself off as when launched outside Steam), one pad at boot.
  const desk = await h.gamePage({
    userAgent: ELECTRON_UA,
    storage: { tandemonium_tutorial_done: 'smoke' },
    before: async (p) => {
      await installFakeSteam(p, { available: false, controllers: [] });
      await installFakeGamepads(p, { atBoot: ['xbox'] });
    },
  });
  const dpads = fakePads(desk);
  const dsteam = fakeSteam(desk);
  const dlook = () => desk.evaluate(() => {
    const flow = document.getElementById('lobby-flow');
    const f = Array.from(document.querySelectorAll('.gamepad-focus')).find((el) => !el.closest('#options-overlay')) || null;
    const sheet = /** @type {any} */ (document.getElementById('quit-sheet'));
    return { step: flow ? flow.current : null, focus: f ? (f.id || f.className) : null, open: !!(sheet && sheet.open) };
  });
  await until(async () => (await dlook()).step === 'lobby-mode' && (await dlook()).focus);
  check(await desk.evaluate(() => typeof window.electronApp?.quit === 'function'), 'QT-02 desktop: the bridge offers quit()');
  check(await quitShown(desk), 'QT-02 desktop: Quit pill shown on mode select');
  check(await desk.evaluate(() => window._game.lobby._stepFocus.items.includes(document.getElementById('bar-quit'))), 'QT-02 desktop: Quit pill is in the pad\'s focus scope');

  // Pad-navigable: walk down to the bar, then along it to Quit (bounded).
  // Quit is second from the left (Help, Quit, Leaderboard, Profile … end pills).
  let s = await dlook();
  for (let i = 0; i < 16 && s.focus !== 'bar-quit'; i++) {
    const inBar = (s.focus || '').startsWith('bar-');
    const dir = !inBar ? 'DOWN' : (s.focus === 'bar-help' ? 'RIGHT' : 'LEFT');
    await dpads.tap(0, dir);
    const before = s.focus;
    await until(async () => (await dlook()).focus !== before, 1500);
    s = await dlook();
  }
  check(s.focus === 'bar-quit', 'QT-03 pad: d-pad reaches the Quit pill', s.focus);

  await dpads.tap(0, 'A');
  check(await until(async () => (await dlook()).open), 'QT-03 pad: A on Quit opens the confirm');
  check(await until(async () => (await dlook()).focus === 'quit-confirm'), 'QT-03 pad: QUIT is the focused control in the confirm', (await dlook()).focus);
  await dpads.tap(0, 'B');
  check(await until(async () => !(await dlook()).open), 'QT-04 pad: B closes the confirm');
  s = await dlook();
  check(s.step === 'lobby-mode' && await dsteam.quitCalls() === 0, 'QT-04 pad: B cancels without quitting or stepping the lobby', s);
  check(await until(async () => (await dlook()).focus === 'bar-quit'), 'QT-04 pad: focus returns to the Quit pill', (await dlook()).focus);

  await clickId(desk, 'bar-quit');
  check(await until(async () => (await dlook()).open), 'QT-05 mouse: the Quit pill opens the confirm');
  await desk.keyboard.press('Escape');
  check(await until(async () => !(await dlook()).open), 'QT-05 Esc closes the confirm');
  check((await dlook()).step === 'lobby-mode', 'QT-05 Esc with the confirm open leaves the lobby step alone');
  await clickId(desk, 'bar-quit');
  await until(async () => (await dlook()).open);
  await clickId(desk, 'quit-cancel');
  check(await until(async () => !(await dlook()).open) && await dsteam.quitCalls() === 0, 'QT-05 CANCEL closes the confirm without quitting');

  // Only the first step offers it.
  await clickId(desk, 'btn-solo');
  check(await until(async () => (await dlook()).step === 'lobby-level' && !(await quitShown(desk))), 'QT-06 Quit pill hidden off the mode step');
  await desk.evaluate(() => { const l = window._game.lobby; l._showStep(l.modeStep); });
  check(await until(async () => (await dlook()).step === 'lobby-mode' && await quitShown(desk)), 'QT-06 Quit pill back on mode select');

  // Confirm: A on QUIT asks the bridge to quit, once.
  await clickId(desk, 'bar-quit');
  await until(async () => (await dlook()).focus === 'quit-confirm');
  await dpads.tap(0, 'A');
  check(await until(async () => (await dsteam.quitCalls()) === 1), 'QT-07 pad: A on QUIT calls electronApp.quit() once', await dsteam.quitCalls());
  check(await desk.evaluate(() => document.getElementById('quit-confirm').hasAttribute('disabled')), 'QT-07 QUIT disables itself after the request (no double quit)');
  await desk.close();
}

// ── SR-09 / SR-10: game-over and victory buttons ──
const waitState = (st, timeout = 240000) => page.waitForFunction((x) => window._game?.state === x, { timeout, polling: 100 }, st);
const shown = (id) => page.evaluate((i) => { const e = document.getElementById(i); return !!e && e.style.display !== 'none' && e.getBoundingClientRect().width > 0; }, id);
const levelId = () => page.evaluate(() => window._game.lobby.selectedLevel?.id || null);
/** SR-27: the result-screen shell — a headline kit sheet, one action row in DOM order, focus on `wantFocus`. */
const shell = (sheetId) => page.evaluate((id) => {
  const sheet = document.getElementById(id);
  if (!sheet) return { sheet: false };
  const vis = (e) => e.style.display !== 'none' && !e.hidden && e.getBoundingClientRect().width > 0;
  const row = sheet.querySelector('[slot="actions"]');
  const actions = row ? Array.from(row.querySelectorAll('uf-button, button')).filter(vis).map((b) => b.id) : [];
  const f = sheet.querySelector('.gamepad-focus');
  const title = sheet.querySelector('.uf-sheet__title');
  return { sheet: sheet.tagName.toLowerCase() === 'uf-sheet' && sheet.hasAttribute('headline'), visible: sheet.getBoundingClientRect().width > 0,
    heading: title ? title.textContent : null, actions, focus: f ? f.id : null, rows: row ? 1 : 0 };
}, sheetId);
const checkShell = async (name, sheetId, wantFocus) => {
  const s = await shell(sheetId);
  check(s.sheet && s.visible && s.rows === 1 && s.heading, `SR-27 ${name}: a headline kit sheet with one action row`, s);
  check(s.focus === wantFocus && s.actions[0] === wantFocus, `SR-27 ${name}: the primary (${wantFocus}) is first and focused`, { focus: s.focus, actions: s.actions });
  return s;
};

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
  await checkShell('game over', 'gameover-sheet', 'btn-restart');
  await h.shot(page, 'shell-gameover');
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
  await checkShell('victory', 'victory-sheet', hasNext ? 'btn-next-level' : 'btn-play-again');
  await h.shot(page, 'shell-victory');
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

// ── SR-27: the other end screens on the shell (forced, as smoke:layout does) ──
console.log('end screen shell');
{
  await page.evaluate(() => { const g = window._game; g.mode = 'solo'; g._showDemoEnd(); });
  await sleep(400);
  await checkShell('demo end', 'demo-end-sheet', await shown('btn-wishlist-demo-end') ? 'btn-wishlist-demo-end' : 'btn-demo-lobby');
  await h.shot(page, 'shell-demo-end');
  await page.evaluate(() => window._game._hideDemoEnd());
  await page.evaluate(() => { const g = window._game; g.mode = 'captain'; g._showDisconnect('Your partner lost connection'); });
  await sleep(400);
  const dc = await checkShell('partner left', 'disconnect-sheet', 'btn-return-lobby');
  check(dc.heading === 'Your partner lost connection', 'SR-27 partner left: the sheet heading is the notice', dc.heading);
  await h.shot(page, 'shell-partner-left');
  await page.evaluate(() => { const g = window._game; document.getElementById('disconnect-overlay').style.display = 'none'; g._clearOverlayButtons(); g.mode = 'solo'; });
  await show('modeStep'); await sleep(300);
}

// ── SR-29: the pause menu ──
console.log('pause menu');
{
  const pause = () => page.evaluate(() => {
    const g = window._game, sheet = document.getElementById('pause-sheet');
    const f = sheet ? sheet.querySelector('.gamepad-focus') : null;
    const rm = g.raceManager;
    return { open: !!g._pause && !!sheet && sheet.open, state: g.state, focus: f ? f.id : null,
      clockPaused: !!(rm && rm.paused), elapsed: rm ? Math.round(rm.getElapsedMs()) : null,
      options: document.getElementById('options-overlay').classList.contains('visible'),
      help: !!document.getElementById('help-modal').open, sub: (document.getElementById('pause-sub') || {}).textContent };
  });
  const waitPause = (open) => page.waitForFunction((o) => !!window._game._pause === o, { timeout: 10000, polling: 100 }, open).then(() => true).catch(() => false);
  const countSteps = () => page.evaluate(() => {
    const rm = window._game.raceManager;
    if (!rm.__counted) { const up = rm.update.bind(rm); rm.update = (...a) => { window.__rmCalls++; return up(...a); }; rm.__counted = true; }
    window.__rmCalls = 0;
  });

  await startGrandma();
  await page.evaluate(() => { const g = window._game; g.raceManager.noteFirstPedal(); });
  // Start opens it; the ride and the clock stop.
  await pads.tap(0, 'START');
  check(await waitPause(true), 'SR-29 pad: Start mid-ride opens the pause menu');
  let p = await pause();
  check(p.open && p.state === 'playing' && p.focus === 'btn-pause-resume', 'SR-29 the menu opens over the ride with RESUME focused', p);
  check(p.clockPaused && /clock is stopped/.test(p.sub || ''), 'SR-29 the race clock is held', { paused: p.clockPaused, sub: p.sub });
  await countSteps();
  const e0 = p.elapsed;
  await sleep(1500);
  const steps = await page.evaluate(() => window.__rmCalls);
  p = await pause();
  check(steps === 0 && p.elapsed === e0, 'SR-29 physics + race clock not stepped while paused', { steps, e0, e1: p.elapsed });
  await h.shot(page, 'pause-menu');
  // B = Resume.
  await padB();
  check(await waitPause(false), 'SR-29 pad: B resumes');
  p = await pause();
  check(!p.open && p.state === 'playing' && !p.clockPaused, 'SR-29 after Resume the ride and clock run', p);
  await sleep(1200);
  check(await page.evaluate(() => window.__rmCalls) > 0, 'SR-29 race steps again after Resume');
  // Start again = Resume; Esc opens and closes.
  await pads.tap(0, 'START'); await waitPause(true);
  await pads.tap(0, 'START');
  check(await waitPause(false), 'SR-29 pad: Start again resumes');
  await page.keyboard.press('Escape');
  check(await waitPause(true), 'SR-29 keyboard: Esc opens the pause menu');
  await page.keyboard.press('Escape');
  check(await waitPause(false), 'SR-29 keyboard: Esc closes it (resume)');
  // RESUME by A on the focused button.
  await pads.tap(0, 'START'); await waitPause(true); await sleep(400);
  await pads.tap(0, 'A');
  check(await waitPause(false), 'SR-29 pad: A on RESUME resumes');
  // SETTINGS opens Options over the menu; B returns to the menu with focus.
  await pads.tap(0, 'START'); await waitPause(true); await sleep(400);
  await pads.tap(0, 'DOWN'); await sleep(300); await pads.tap(0, 'DOWN'); await sleep(300);
  p = await pause();
  check(p.focus === 'btn-pause-settings', 'SR-29 pad: ↓↓ reaches SETTINGS', p.focus);
  await pads.tap(0, 'A'); await sleep(600);
  p = await pause();
  check(p.options && p.open, 'SR-29 SETTINGS opens Options over the paused ride', p);
  await padB();
  p = await pause();
  check(!p.options && p.open && p.focus === 'btn-pause-resume' && p.state === 'playing' && p.clockPaused, 'SR-29 B closes Options; the menu has focus again, still paused', p);
  // View opens Help over the menu; B comes back.
  await pads.tap(0, 'SELECT'); await sleep(600);
  p = await pause();
  check(p.help && p.open, 'SR-29 pad: View opens Help over the pause menu', p);
  await h.shot(page, 'pause-help');
  await padB();
  p = await pause();
  check(!p.help && p.open && p.focus === 'btn-pause-resume', 'SR-29 B closes Help; focus is back on the menu', p);
  // RESTART rides again.
  await pads.tap(0, 'DOWN'); await sleep(300);
  p = await pause();
  check(p.focus === 'btn-pause-restart', 'SR-29 pad: ↓ reaches RESTART', p.focus);
  await pads.tap(0, 'A');
  check(await waitPause(false), 'SR-29 RESTART closes the menu');
  await waitState('playing', 60000).catch(() => {});
  p = await pause();
  check(p.state === 'playing' && !p.clockPaused, 'SR-29 RESTART rides the same level again', p);
  // END RIDE returns to the lobby.
  await pads.tap(0, 'START'); await waitPause(true); await sleep(400);
  for (let i = 0; i < 3; i++) { await pads.tap(0, 'DOWN'); await sleep(300); }
  p = await pause();
  check(p.focus === 'btn-pause-end', 'SR-29 pad: ↓↓↓ reaches END RIDE', p.focus);
  await pads.tap(0, 'A');
  await waitState('lobby', 30000).catch(() => {});
  const s = await look();
  check(s.state === 'lobby' && !!s.step && !(await pause()).open, 'SR-29 END RIDE returns to the lobby', s);
  // Touch: the quick menu's PAUSE entry.
  await startGrandma();
  await page.evaluate(() => { window._game.quickMenu.show(); });
  await sleep(300);
  const qm = await page.evaluate(() => { const b = document.getElementById('qm-pause'); return { shown: !!b && !b.hidden && b.getBoundingClientRect().width > 0 }; });
  check(qm.shown, 'SR-29 touch: the quick menu offers PAUSE while riding', qm);
  await clickId(page, 'qm-pause');
  check(await waitPause(true), 'SR-29 touch: PAUSE opens the pause menu');
  await clickId(page, 'btn-pause-resume');
  check(await waitPause(false), 'SR-29 touch: RESUME resumes');
  await page.evaluate(() => window._game._returnToLobby());
  await sleep(600);
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
