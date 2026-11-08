#!/usr/bin/env node
// smoke:players · #646 — Players replaces Controls, through the real lobby, ControllerManager
// and fake pads (scripts/lib/fake-gamepads.mjs); the API is faked in the page (no network).
//
//   PL-01  co-op, P2 seated on a DualSense: the bar's Players pill opens Players with two
//          rows, each with its own controller (model, light, Buzz) and that controller's
//          settings; P1 is a Guest with Sign in; Use your phone instead is there
//   PL-02  P2's Steering feel: only the DualSense's setting changes (P1's Xbox and TUNE keep
//          theirs), it lands on P2's InputManager, and P2's balance controller rides with it
//   PL-03  P2's Stick steering toggles P2's stick only (P1's stays)
//   PL-04  P2 signs in (device code: QR + code on P2's row), then Sign out: back to Guest
//   PL-05  P1 signed in on the web: Sign out signs the device out
//   PL-06  TV: P1's pad walks to P2's Stick steering, A toggles it, B closes Players
//   PL-07  versus (a new launch): the DualSense kept its own Stick choice; a connected,
//          unseated Pro Controller is under Available controllers; selecting it makes it
//          Player 3 (a ControllerManager slot); Players shows 3 rows
//   PL-08  Steam build: P1 (signed in by Steam) has no Sign out
//   screenshots: pl-tv-2p, pl-tv-3p (1920×1080), pl-phone-2p (390×844)
import { startHarness, clickId } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';
import { installFakeSteam, ELECTRON_UA } from './lib/fake-steam.mjs';
import fs from 'node:fs';
import path from 'node:path';

const h = await startHarness({ port: 8998, outDir: 'tandemonium-players' });
const { check } = h;
const until = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, { timeout, polling: 50 }, arg).then(() => true, () => false);
// Screenshots also go where the caller asks (SHOTS_DIR), with the pl- prefix.
const SHOTS = process.env.SHOTS_DIR || null;
const shot = async (page, name) => {
  const f = await h.shot(page, name);
  if (SHOTS && f) { fs.mkdirSync(SHOTS, { recursive: true }); fs.copyFileSync(f, path.join(SHOTS, name + '.png')); }
};

/** The API, answered in the page: Sam signs in on a seat; Steam answers for P1. */
function fakeApi() {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = (sub) => b64({ alg: 'HS256' }) + '.' + b64({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';
  const pic = (c) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="${c}"/></svg>`);
  window.__api = { polls: 0 };
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const real = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    if (!/tandemonium-api|workers\.dev/.test(url)) return real(input, init);
    const p = new URL(url).pathname;
    if (p === '/auth/discord/begin') { window.__api.polls = 0; return json({ id: 'd1', secret: 's', code: 'Q4MZ', url: 'https://tandemonium-api.example.workers.dev/auth/discord/go?r=d1', expires_in: 600 }); }
    if (p === '/auth/poll') {
      window.__api.polls++;
      if (window.__api.polls < 2) return json({ status: 'pending' });
      return json({ status: 'done', token: jwt(42), user: { id: 42, name: 'Sam', avatar: pic('#5865f2'), identities: { discord: { name: 'Sam', avatar: pic('#5865f2') } } } });
    }
    if (p === '/auth/steam') return json({ token: jwt(7), user: { id: 7, name: 'pete_steam', avatar: pic('#66c0f4'), identities: { steam: { name: 'pete_steam', avatar: pic('#66c0f4') } } } });
    if (p === '/me') return json({ user: { id: 7, display_name: 'pete_steam', identities: {} }, achievements: [], bestScores: [] });
    if (p === '/achievements/sync') return json({ achievements: [] });
    return json({ error: 'not faked' }, 404);
  };
}

/** One Players row, as data. */
const row = (page, n) => page.evaluate((k) => {
  const el = document.querySelector(`#players-sheet .pl-row[data-n="${k}"]`);
  if (!el) return null;
  const person = el.querySelector('.pl-who uf-person');
  return {
    who: person ? person.getAttribute('name') : el.querySelector('.pl-who')?.textContent.trim(),
    source: person ? person.getAttribute('source') : null,
    pad: el.querySelector('.pl-pad-name')?.textContent.trim() || '',
    led: !!el.querySelector('.pl-led'),
    buzz: !!el.querySelector('[data-act="buzz"]'),
    settings: [...el.querySelectorAll('uf-setting[data-set]')].map((s) => s.dataset.set),
    stick: el.querySelector('uf-setting[data-set="stick"]')?.checked ?? null,
    feel: el.querySelector('input.pl-feel-slider') ? Number(el.querySelector('input.pl-feel-slider').value) : null,
    acts: [...el.querySelectorAll('[data-act]')].map((b) => b.dataset.act),
    code: el.querySelector('.pl-acc-code')?.textContent || '',
    qr: !!el.querySelector('.pl-acc-qr svg'),
    note: el.querySelector('.pl-acc-note')?.textContent || '',
  };
}, n);
const rowCount = (page) => page.evaluate(() => document.querySelectorAll('#players-sheet .pl-row').length);
const act = (page, n, a) => page.evaluate(([k, x]) => { const b = document.querySelector(`#players-sheet .pl-row[data-n="${k}"] [data-act="${x}"]`); if (!b) return false; b.click(); return true; }, [n, a]);

/** Open the game, go to the co-op host step and seat a DualSense as Player 2. */
async function coop(viewport) {
  const page = await h.gamePage({
    viewport,
    storage: { tandemonium_tutorial_done: 'smoke', tandemonium_steering_feel: '0.4' },
    before: async (p) => { await installFakeGamepads(p, { atBoot: ['xbox'] }); await p.evaluateOnNewDocument(fakeApi); },
  });
  const pads = fakePads(page);
  await until(page, () => !!window.__controllerManager);
  await page.evaluate(() => {
    const l = window._game.lobby;
    document.getElementById('room-code-display').textContent = 'TNDM-PLAY';
    l._pendingMode = 'multiplayer'; l._roomRole = 'captain';
    l._showStep(l.hostStep); l._refreshHostNext();
  });
  await pads.tap(0, 'A');   // P1's Xbox claims slot P1
  const p2 = await pads.plug('dualsense');
  await until(page, () => (window._game.lobby._detectLocalJoinCandidates() || []).length > 0);
  await pads.tap(p2, 'A');
  const seated = await until(page, () => !!window._game.lobby._localP2InputManager);
  return { page, pads, p2, seated };
}

// ── PL-01..06 · web, local co-op, TV size ──
{
  const { page, pads, p2, seated } = await coop({ width: 1920, height: 1080 });
  check(seated, 'setup: the DualSense seats Player 2');
  await clickId(page, 'bar-players');
  check(await until(page, () => document.getElementById('players-sheet').open === true), 'PL-01 the Players pill opens Players');
  check(await until(page, () => document.querySelectorAll('#players-sheet .pl-row').length === 2), 'PL-01 two rows: P1 and P2', await rowCount(page));
  let r1 = await row(page, 1), r2 = await row(page, 2);
  check(r1 && /xbox/i.test(r1.pad) && r1.led && r1.buzz, "PL-01 P1's row: the Xbox pad, its light and Buzz", r1);
  check(r2 && /dualsense/i.test(r2.pad) && r2.led && r2.buzz, "PL-01 P2's row: the DualSense, its light and Buzz", r2);
  check(r1.settings.join() === 'stick,gyro,prompts' && r2.settings.join() === 'stick,gyro,prompts', "PL-01 each row has its controller's Stick / Gyro / Button prompts", [r1.settings, r2.settings]);
  check(r1.who === 'Guest' && r1.acts.includes('signin') && r2.who === 'Guest' && r2.acts.includes('signin'), 'PL-01 signed out: Guest with Sign in on both rows', [r1.who, r2.who]);
  check(await page.evaluate(() => !!document.querySelector('#players-sheet #set-phone')), 'PL-01 Use your phone instead is in Players');
  check(await page.evaluate(() => document.getElementById('bar-players-label').textContent === 'Players · 2'), 'PL-01 the pill counts the seats');
  // Migration: the old screen-wide feel (0.4) is where every pad starts.
  check(r1.feel === 40 && r2.feel === 40, 'PL-01 migration: both controllers start at the old Steering feel', [r1.feel, r2.feel]);

  // PL-02 · P2's feel only.
  const before = await page.evaluate(() => ({ tune: window._game.lobby.constructor && window.__tune ? null : null, p1: window._game.lobby.seatPadSettings(1), feel: window._game.lobby.controllerSettings.get('pad:054c:0ce6').feel }));
  await page.evaluate(() => {
    const s = document.querySelector('#players-sheet .pl-row[data-n="2"] input.pl-feel-slider');
    s.value = '85'; s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const after = await page.evaluate(async () => {
    const l = window._game.lobby;
    const { TUNE } = await import('/js/config.js');
    return {
      p2: l.controllerSettings.get('pad:054c:0ce6').feel, p1: l.seatPadSettings(1).feel, p1Key: l._p1SettingsKey(),
      tune: TUNE.steeringFeel, imTune: l._localP2InputManager.controllerTune ? l._localP2InputManager.controllerTune.steeringFeel : null,
      stored: JSON.parse(localStorage.getItem('tandemonium_controller_settings')),
    };
  });
  check(after.p2 === 0.85 && before.feel === 0.4, "PL-02 the DualSense's Steering feel is now 0.85", after.p2);
  check(after.p1 === 0.4 && after.tune === 0.4, "PL-02 P1's Xbox and Player 1's TUNE keep 0.4", { p1: after.p1, tune: after.tune, key: after.p1Key });
  check(after.imTune === 0.85, "PL-02 P2's InputManager steers with the DualSense's feel", after.imTune);
  check(after.stored && after.stored.pads['pad:054c:0ce6'] && after.stored.pads['pad:054c:0ce6'].feel === 0.85 && !after.stored.pads[after.p1Key], 'PL-02 saved against the DualSense only', after.stored);

  // PL-03 · P2's stick only.
  const p1Stick = await page.evaluate(() => window._game.lobby.joystickActive);
  const s0 = (await row(page, 2)).stick;
  await page.evaluate(() => document.querySelector('#players-sheet .pl-row[data-n="2"] uf-setting[data-set="stick"]').activate());
  const st = await page.evaluate(() => { const l = window._game.lobby; return { im: !l._localP2InputManager.suppressGamepadLean, saved: l.controllerSettings.get('pad:054c:0ce6').stick, p1: l.joystickActive }; });
  check(st.im === !s0 && st.saved === !s0, "PL-03 P2's Stick steering flips P2's stick and is saved on the DualSense", { was: s0, ...st });
  check(st.p1 === p1Stick, "PL-03 Player 1's stick is untouched", st.p1);
  await page.evaluate(() => document.querySelector('#players-sheet .pl-row[data-n="2"] uf-setting[data-set="stick"]').activate());   // back
  await shot(page, 'pl-tv-2p');
  // Screenshot only: the Steering feel row as a gyro pad shows it (these fake pads have none).
  await page.evaluate(() => { for (const g of document.querySelectorAll('#players-sheet uf-setting[data-set="gyro"]')) { g.disabled = false; g.checked = true; } });
  await shot(page, 'pl-tv-2p-feel');
  await page.evaluate(() => { const ps = window._game.lobby._players; ps._sig = ''; ps.sync(); });

  // PL-04 · P2 signs in, then out.
  await act(page, 2, 'signin');
  check(await until(page, () => document.querySelector('#players-sheet .pl-row[data-n="2"] .pl-acc-code')?.textContent === 'Q4MZ'), "PL-04 P2's Sign in shows a QR + code on P2's row");
  r2 = await row(page, 2); r1 = await row(page, 1);
  check(r2.qr && r2.acts.includes('cancel'), "PL-04 P2's row: QR and Hide", r2);
  check(!r1.qr, "PL-04 P1's row has no QR", r1);
  await shot(page, 'pl-tv-2p-signin');
  check(await until(page, () => document.querySelector('#players-sheet .pl-row[data-n="2"] .pl-who uf-person')?.getAttribute('name') === 'Sam', null, 15000), 'PL-04 P2 is signed in as Sam');
  r2 = await row(page, 2);
  check(r2.source === 'discord' && r2.acts.includes('signout') && !r2.acts.includes('signin'), "PL-04 P2's row: Sam's picture + Discord badge and Sign out", r2);
  check(!(await page.evaluate(() => window._game.lobby.auth.isLoggedIn())), 'PL-04 Player 1 is still signed out');
  await act(page, 2, 'signout');
  check(await until(page, () => document.querySelector('#players-sheet .pl-row[data-n="2"] .pl-guest')?.textContent === 'Guest'), 'PL-04 Sign out: P2 is a Guest again');
  check(await page.evaluate(() => window._game.lobby.seatAccounts.get(2) === null), "PL-04 P2's seat session is gone");

  // PL-05 · P1 signed in on the web has Sign out, and it signs the device out.
  await page.evaluate(() => {
    const a = window._game.lobby.auth;
    const b64 = (o) => btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    a.token = b64({ alg: 'HS256' }) + '.' + b64({ sub: 9, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';
    a.user = { id: 9, serverId: 9, name: 'Pete', provider: 'discord', identities: { discord: { name: 'Pete', avatar: '' } } };
    window._game.lobby._players.sync();
  });
  check(await until(page, () => !!document.querySelector('#players-sheet .pl-row[data-n="1"] [data-act="signout"]')), 'PL-05 web: signed-in P1 has Sign out');
  await act(page, 1, 'signout');
  check(await until(page, () => !window._game.lobby.auth.isLoggedIn()), 'PL-05 Sign out signs Player 1 out');
  check(await until(page, () => document.querySelector('#players-sheet .pl-row[data-n="1"] .pl-guest')?.textContent === 'Guest'), 'PL-05 P1 is a Guest again');

  // PL-06 · TV: P1's pad reaches P2's Stick steering, A toggles it, B closes.
  const stickBefore = await page.evaluate(() => !window._game.lobby._localP2InputManager.suppressGamepadLean);
  let reached = false;
  for (let i = 0; i < 14 && !reached; i++) {
    reached = await page.evaluate(() => document.querySelector('#players-sheet .pl-row[data-n="2"] uf-setting[data-set="stick"]')?.classList.contains('gamepad-focus'));
    if (reached) break;
    const where = await page.evaluate(() => { const f = window._game.lobby._stepFocus.focusedEl; const r = f && f.closest('.pl-row'); return r ? Number(r.dataset.n) : 0; });
    await pads.tap(0, where === 1 ? 'RIGHT' : 'DOWN');
  }
  check(reached, "PL-06 the d-pad reaches P2's Stick steering");
  await pads.tap(0, 'A');
  check(await until(page, (b) => !window._game.lobby._localP2InputManager.suppressGamepadLean === !b, stickBefore), "PL-06 A toggles P2's stick from P1's pad");
  await shot(page, 'pl-tv-2p-focus');
  await pads.tap(0, 'B');
  check(await until(page, () => document.getElementById('players-sheet').open === false), 'PL-06 B closes Players');

  // PL-02b · the ride: P2's balance controller steers with the DualSense's feel.
  const ride = await page.evaluate(() => {
    const g = window._game, l = g.lobby;
    g._onLocalReady({ inputP2: l._localP2InputManager, sourceType: 'gamepad' });
    const t = g.balanceCtrlP2 && g.balanceCtrlP2.input.controllerTune;
    const p1 = g.balanceCtrl.input.controllerTune;
    // A change made now (Players during the ride's lobby) reaches the live ride too.
    l.setSeatSteering(2, { feel: 0.2 });
    return { feel: t ? t.steeringFeel : null, p1, live: g.balanceCtrlP2.input.controllerTune.steeringFeel };
  });
  check(ride.feel === 0.85 && ride.p1 == null, "PL-02 P2's balance controller rides with the DualSense's feel (P1's with TUNE)", ride);
  check(ride.live === 0.2, "PL-02 a later change reaches P2's balance controller", ride.live);
  void p2;
  await page.close();
}

// ── PL-07 · versus: Available controllers → Player 3 ──
{
  const page = await h.gamePage({
    viewport: { width: 1920, height: 1080 },
    storage: { tandemonium_tutorial_done: 'smoke' },
    before: async (p) => { await installFakeGamepads(p, { atBoot: ['xbox'] }); await p.evaluateOnNewDocument(fakeApi); },
  });
  const pads = fakePads(page);
  await until(page, () => !!window.__controllerManager);
  await pads.tap(0, 'A');
  // TOGETHER → VERSUS, as a player gets there.
  await until(page, () => !!document.getElementById('btn-together') && document.getElementById('btn-together').offsetParent !== null, null, 15000);
  await clickId(page, 'btn-together');
  await until(page, () => !!document.getElementById('btn-versus') && document.getElementById('btn-versus').offsetParent !== null, null, 15000);
  await clickId(page, 'btn-versus');
  await until(page, () => window._game.lobby._currentStep === window._game.lobby.versusStep && window._game.lobby._versusPlayers.length === 1, null, 20000);
  const ds = await pads.plug('dualsense');
  await until(page, () => (window._game.lobby._versusCandidates || []).length > 0);
  await pads.tap(ds, 'A');
  check(await until(page, () => window._game.lobby._versusPlayers.length === 2), 'PL-07 setup: the DualSense joins as Player 2');
  await pads.plug('switchpro');
  await until(page, () => (window._game.lobby._versusCandidates || []).some((c) => /switch pro|pro controller/i.test(c.name || '')));
  await clickId(page, 'bar-players');
  await until(page, () => document.getElementById('players-sheet').open === true);
  check(await until(page, () => document.querySelectorAll('#players-sheet .pl-row').length === 2), 'PL-07 two rows before', await rowCount(page));
  // The co-op page (same browser storage) turned the DualSense's stick off in PL-06: a new launch keeps it.
  check((await row(page, 2)).stick === false && await page.evaluate(() => window._game.lobby._versusPlayers[1].input.suppressGamepadLean === true),
    "PL-07 the DualSense kept its own Stick steering (Off) on a new launch", await row(page, 2));
  const avail = await page.evaluate(() => [...document.querySelectorAll('#pl-available .ucr-row')].map((r) => ({ key: r.dataset.key, text: r.textContent, focusable: r.hasAttribute('data-focusable') })));
  const pro = avail.find((a) => /switch pro|pro controller/i.test(a.text));
  check(pro && pro.focusable && /Player 3/.test(pro.text), 'PL-07 the Pro Controller is under Available controllers, ready to be Player 3', avail);
  await page.evaluate((k) => document.querySelector(`#pl-available .ucr-row[data-key="${CSS.escape(k)}"]`)?.click(), pro ? pro.key : '');
  check(await until(page, () => window._game.lobby._versusPlayers.length === 3), 'PL-07 selecting it seats it');
  const p3 = await page.evaluate(() => { const p = window._game.lobby._versusPlayers.find((x) => x.n === 3); const s = p && window.__controllerManager.getSlot(p.slotId); return p ? { slotId: p.slotId, slot: s ? s.state : null } : null; });
  check(p3 && /^P[2-4]$/.test(p3.slotId) && p3.slot === 'claimed', 'PL-07 Player 3 holds a ControllerManager slot', p3);
  check(await until(page, () => document.querySelectorAll('#players-sheet .pl-row').length === 3), 'PL-07 Players shows three rows', await rowCount(page));
  check(/switch pro|pro controller/i.test((await row(page, 3)).pad), "PL-07 P3's row names the Pro Controller", await row(page, 3));
  check(await until(page, () => !document.querySelector('#pl-available .ucr-row')), 'PL-07 nothing left under Available');
  await page.evaluate(() => { document.querySelector('#players-sheet .uf-sheet__body').scrollTop = 0; });
  await shot(page, 'pl-tv-3p');
  await page.close();
}

// ── Phone layout: two players ──
{
  const { page, seated } = await coop({ width: 390, height: 844 });
  check(seated, 'phone setup: P2 seated');
  await page.evaluate(() => window._game.lobby._openPlayersSheet());
  check(await until(page, () => document.querySelectorAll('#players-sheet .pl-row').length === 2), 'phone: Players lists both seats');
  const fit = await page.evaluate(() => {
    const card = document.querySelector('#players-sheet .uf-sheet__card').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#players-sheet .pl-row')].map((r) => r.getBoundingClientRect());
    return { card: [card.left, card.right], inside: rows.every((r) => r.left >= card.left - 1 && r.right <= card.right + 1), docW: document.documentElement.scrollWidth };
  });
  check(fit.inside && fit.docW <= 390, 'phone: rows fit the sheet, no sideways scroll', fit);
  await shot(page, 'pl-phone-2p');
  await page.close();
}

// ── PL-08 · Steam build: P1 has no Sign out ──
{
  const page = await h.gamePage({
    viewport: { width: 1920, height: 1080 },
    userAgent: ELECTRON_UA,
    storage: { tandemonium_tutorial_done: 'smoke' },
    before: async (p) => {
      await installFakeGamepads(p, { atBoot: ['xbox'] });
      await installFakeSteam(p, { subscribed: true });
      await p.evaluateOnNewDocument(() => { window.steam.getAuthTicket = () => Promise.resolve('tkt'); });
      await p.evaluateOnNewDocument(fakeApi);
    },
  });
  const pads = fakePads(page);
  await until(page, () => !!window.__controllerManager);
  await pads.tap(0, 'A');
  check(await until(page, () => window._game.lobby.auth.isLoggedIn(), null, 15000), 'PL-08 Steam: P1 signs in by Steam');
  await clickId(page, 'bar-players');
  await until(page, () => document.getElementById('players-sheet').open === true);
  check(await until(page, () => document.querySelector('#players-sheet .pl-row[data-n="1"] .pl-who uf-person')?.getAttribute('source') === 'steam'), 'PL-08 P1 shows their Steam account', await row(page, 1));
  const r = await row(page, 1);
  check(r && !r.acts.includes('signout') && /Steam/.test(r.note), 'PL-08 Steam: P1 has no Sign out', r);
  await page.close();
}

await h.finish();
