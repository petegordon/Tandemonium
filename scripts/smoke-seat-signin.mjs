#!/usr/bin/env node
// smoke:seat-signin · #612 item 5 — every player signs in, through the real lobby,
// ControllerManager and Wardrobe with fake pads (scripts/lib/fake-gamepads.mjs). The
// API is faked in the page (window.fetch), so no network.
//
//   SS-01  local co-op, P2 seated on a DualSense: each Wardrobe card has an account row
//          (Sign in with Discord), reachable by that card's own pad
//   SS-02  P2's Sign in shows a QR + 4-letter code on P2's card only; P1 stays signed out;
//          when the phone finishes, P2's card shows Sam's picture + name + Not me, and the
//          stoker seat card says Sam
//   SS-03  the couch ride's score submit: mode 'local' with P2's own token in seats[]
//          (never an id P1 claims) and Sam's achievements from the ride
//   SS-04  Not me: the card goes back to Sign in, the seat to the pad's name
//   one QR at a time: while a card's code is open the other Sign ins wait (greyed + note); Hide frees them
//   SS-05  Steam: P1's card offers Link Discord; after a ride the Profile card opens once
//          with the reason, LINK DISCORD focused and NOT NOW; not again for a week
//   SS-06  #609 couch pair, both signed in: the pair record is fetched at the ride's start
//          (as P1, about Sam); the finish counts this ride (Regulars progress); after the
//          submit (P2's own token in seats[]) the panel reads "You & Sam · n rides together"
//   SS-07  the 10th couch ride: Regulars for Player 1 AND for Sam (their own achievements)
//   SS-08  P1 signed out: Sam's own session posts the ride (stoker, P1 = this device's guest)
//          and asks /pair?with=guest:<device>; the panel still says You & Sam
//   SS-09  unsigned P2: 'local:p2', no /pair call, no panel
import { startHarness } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';
import { installFakeSteam, ELECTRON_UA } from './lib/fake-steam.mjs';

const h = await startHarness({ port: 8979, outDir: 'tandemonium-seat-signin' });
const { check } = h;
const until = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);

/** The API, answered in the page. Sam signs in on P2's card; scores are recorded. */
function fakeApi() {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = (sub) => b64({ alg: 'HS256' }) + '.' + b64({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';
  const pic = (c) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="${c}"/></svg>`);
  window.__api = { begins: [], scores: [], polls: 0, linked: false, pair: { rides: 0, distance: 0 }, pairCalls: [] };
  const sub = (a) => { try { return JSON.parse(atob(a.split(' ')[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch (e) { return null; } };
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const real = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    if (!/tandemonium-api|workers\.dev/.test(url)) return real(input, init);
    const p = new URL(url).pathname;
    const auth = init.headers && (init.headers.Authorization || init.headers.authorization);
    if (p === '/auth/discord/begin') { window.__api.begins.push({ authed: !!auth }); window.__api.polls = 0; return json({ id: 'd' + window.__api.begins.length, secret: 's', code: 'Q4MZ', url: 'https://tandemonium-api.example.workers.dev/auth/discord/go?r=d1', expires_in: 600 }); }
    if (p === '/auth/poll') {
      window.__api.polls++;
      if (window.__api.polls < 2) return json({ status: 'pending' });
      if (window.__api.polls < 3) return json({ status: 'confirming' });
      return json({ status: 'done', token: jwt(42), user: { id: 42, name: 'Sam', avatar: pic('#5865f2'), identities: { discord: { name: 'Sam', avatar: pic('#5865f2') } } } });
    }
    if (p === '/auth/steam') return json({ token: jwt(7), user: { id: 7, name: 'pete_steam', avatar: pic('#66c0f4'), identities: { steam: { name: 'pete_steam', avatar: pic('#66c0f4') } } } });
    if (p === '/me') return json({ user: { id: 7, display_name: 'pete_steam', identities: { steam: { name: 'pete_steam', avatar: pic('#66c0f4') } } }, achievements: [], bestScores: [] });
    if (p === '/score') {
      const body = JSON.parse(init.body);
      window.__api.scores.push({ body, auth: !!auth, sub: auth ? sub(auth) : null });
      // The server's pair step: a couch ride with P2's checked seat token, or a stoker ride with a guest captain.
      if ((body.mode === 'local' && body.seats && body.seats.length) || (body.mode === 'stoker' && body.contributions?.captain?.guestDeviceId)) {
        window.__api.pair.rides++; window.__api.pair.distance += body.distance;
      }
      return json({ scoreId: 1 });
    }
    if (p === '/pair') {
      window.__api.pairCalls.push({ with: new URL(url).searchParams.get('with'), sub: auth ? sub(auth) : null });
      return json({ ...window.__api.pair, best: { grandma: 250000 }, daily_streak: 0 });
    }
    if (p === '/achievements/sync') return json({ achievements: [] });
    return json({ error: 'not faked' }, 404);
  };
}

const card = (page, n) => page.evaluate((k) => {
  const el = document.querySelector(`#dr-cards .dr-card[data-n="${k}"]`);
  if (!el) return null;
  const acc = el.querySelector('.dr-account');
  return {
    who: el.querySelector('.dr-who')?.textContent || '',
    state: acc?.dataset.state || null,
    buttons: [...(acc?.querySelectorAll('button') || [])].map((b) => b.textContent.trim()),
    code: acc?.querySelector('.dr-acc-code')?.textContent || '',
    qr: !!acc?.querySelector('.dr-acc-qr svg'),
    pics: [...(acc?.querySelectorAll('.dr-acc-pic') || [])].map((i) => i.dataset.provider),
    status: acc?.querySelector('.dr-acc-status')?.textContent || '',
    disabled: [...(acc?.querySelectorAll('button[disabled]') || [])].map((b) => b.textContent.trim()),
  };
}, n);
// The <uf-person> (picture + sign-in badge + name) inside a selector, or null.
const person = (page, sel) => page.evaluate((s) => {
  const p = document.querySelector(s + ' uf-person');
  return p ? { name: p.getAttribute('name'), source: p.getAttribute('source'), pic: !!p.querySelector('img'), badge: p.querySelector('.uf-person__src')?.getAttribute('aria-label') || '' } : null;
}, sel);

/**
 * #609 · one couch ride through the game's own steps: the ride starts (pair prefetch),
 * finishes (achievements), posts and shows the pair panel. Stubs only the ride itself.
 */
const couchRide = (page, { p1SignedIn, pair }) => page.evaluate(async ({ p1SignedIn, pair }) => {
  const g = window._game;
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const auth = g.lobby.auth;
  if (p1SignedIn) {
    auth.token = b64({ alg: 'HS256' }) + '.' + b64({ sub: 7, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';
    auth.user = { id: 7, serverId: 7, name: 'Pete', identities: {} };
  } else { auth.token = null; auth.user = null; }
  if (pair) window.__api.pair = { ...pair };
  const pairCallsBefore = window.__api.pairCalls.length;
  const scoresBefore = window.__api.scores.length;
  const keys = ['mode', 'raceManager', 'contributionTracker', 'collectibleManager', 'bike'];
  const was = Object.fromEntries(keys.map((k) => [k, g[k]]));
  const wasLevel = g.lobby.selectedLevel;
  g.mode = 'local';
  g.bike = Object.assign(Object.create(g.bike || {}), { distanceTraveled: 1200 });
  g.collectibleManager = null;
  g.lobby.selectedLevel = { ...(wasLevel || {}), id: 'grandma', distance: 1200, isDaily: false, key: null };
  g.raceManager = { crashCount: 0, restartCount: 0, getSummary: () => ({ distance: 1200, timeMs: 200000, inputSource: 'gamepad' }) };
  const part = { overallPct: 50, safePct: 90, totalTaps: 10 };
  g.contributionTracker = { getSummary: () => ({ mode: 'multiplayer', captain: { ...part }, stoker: { ...part } }) };
  const out = {};
  try {
    g._prefetchCouchPair();
    for (let i = 0; i < 100 && g._couchPair() && !g._couchPairCache; i++) await new Promise((r) => setTimeout(r, 20));
    out.prefetched = !!g._couchPairCache;
    g._checkFinishAchievements();
    const fs = g.achievements.lastFinishState || {};
    out.finish = { pairRides: fs.pairRides ?? null, pairDistanceKm: fs.pairDistanceKm ?? null };
    out.regulars = (g.achievements.getAllDefinitions().find((a) => a.id === 'pair_10_rides') || {});
    out.regulars = { earned: out.regulars.earned, progress: out.regulars.progress };
    out.p1Earned = g.achievements.getEarnedIds().includes('pair_10_rides');
    out.samEarned = g.lobby.seatAchievements ? g.lobby.seatAchievements.earned(42) : null;
    out.samEarned = Array.isArray(out.samEarned) ? out.samEarned.includes('pair_10_rides') : !!(out.samEarned && out.samEarned.pair_10_rides);
    const submitted = g._submitScore();
    await g._renderPairPanel({ timeMs: 200000 }, submitted);
    const el = document.getElementById('pair-panel');
    out.panel = el && el.style.display === 'block' ? el.textContent : null;
    out.partner = g._partnerKey();
    out.couch = g._couchPair();
  } finally {
    Object.assign(g, was);
    g.lobby.selectedLevel = wasLevel;
    auth.token = null; auth.user = null;
  }
  out.pairCalls = window.__api.pairCalls.slice(pairCallsBefore);
  out.scores = window.__api.scores.slice(scoresBefore);
  return out;
}, { p1SignedIn, pair });

const cardClick = (page, n, sel) => page.evaluate(([k, s]) => { const b = document.querySelector(`#dr-cards .dr-card[data-n="${k}"] ${s}`); if (!b) return false; b.click(); return true; }, [n, sel]);

// ── SS-01..04 · web, local co-op ──
{
  const page = await h.gamePage({
    viewport: { width: 1920, height: 1080 },
    storage: { tandemonium_tutorial_done: 'smoke' },
    before: async (p) => { await installFakeGamepads(p, { atBoot: ['xbox'] }); await p.evaluateOnNewDocument(fakeApi); },
  });
  const pads = fakePads(page);
  await until(page, () => !!window.__controllerManager);
  await page.evaluate(() => {
    const l = window._game.lobby;
    document.getElementById('room-code-display').textContent = 'TNDM-SEAT';
    l._pendingMode = 'multiplayer'; l._roomRole = 'captain';
    l._showStep(l.hostStep); l._refreshHostNext();
  });
  const p2 = await pads.plug('dualsense');
  await until(page, () => (window._game.lobby._detectLocalJoinCandidates() || []).length > 0);
  await pads.tap(p2, 'A');
  check(await until(page, () => window._game.lobby._localSeatedOnHost), 'SS-01: the DualSense seats Player 2');
  await page.evaluate(() => window._game.lobby._openDressingRoom(2));
  await until(page, () => !!document.querySelector('#dr-cards .dr-card[data-n="2"] .dr-account button'));
  let c1 = await card(page, 1), c2 = await card(page, 2);
  check(c1 && c1.state === 'signed-out' && c1.buttons[0] === 'Sign in with Discord', "SS-01: P1's card: Sign in with Discord", c1);
  check(c2 && c2.state === 'signed-out' && c2.buttons[0] === 'Sign in with Discord', "SS-01: P2's card: Sign in with Discord", c2);
  const reach = await page.evaluate(() => { const r = window._game.lobby._room; const c = r.cards.get(2); return r._items(c).some((b) => b.dataset.act === 'acc-signin'); });
  check(reach, "SS-01: P2's own pad can reach their Sign in button");
  await h.shot(page, 'ss01-cards');

  // A desktop-app spy for the click only: P2's sign-in must never open this PC's browser
  // (it is signed in to P1's Discord). Removed right after, so the web run stays the web.
  await page.evaluate(() => { window.__opened = []; window.__hadApp = !!window.electronApp; window.electronApp = window.electronApp || {}; window.__oldOpen = window.electronApp.openSignIn; window.electronApp.openSignIn = (u) => { window.__opened.push(u); return Promise.resolve(true); }; });
  await cardClick(page, 2, '[data-act="acc-signin"]');
  await until(page, () => document.querySelector('#dr-cards .dr-card[data-n="2"] .dr-acc-code')?.textContent === 'Q4MZ');
  const p2Opened = await page.evaluate(() => { const o = window.__opened.slice(); if (window.__hadApp) window.electronApp.openSignIn = window.__oldOpen; else delete window.electronApp; return o; });
  check(p2Opened.length === 0, "SS-01: P2's Sign in shows only the QR, never opens this PC's browser", p2Opened);
  c1 = await card(page, 1); c2 = await card(page, 2);
  check(c2.state === 'pending' && c2.qr && c2.code === 'Q4MZ', "SS-02: P2's card shows its own QR + code", c2);
  check(c1.state === 'signed-out' && !c1.qr, "SS-02: P1's card is untouched", c1);
  check(c1.disabled.includes('Sign in with Discord') && /Waiting for P2 to sign in/.test(c1.status), "SS-02: one QR at a time: P1's Sign in waits, with a note", c1);
  const p1Reach = await page.evaluate(() => { const r = window._game.lobby._room; return r._items(r.cards.get(1)).some((b) => b.dataset.act === 'acc-signin'); });
  check(!p1Reach, "SS-02: P1's pad skips the greyed Sign in");
  check(c2.buttons.includes('Hide'), "SS-02: the open card's button is Hide", c2.buttons);
  const begins = await page.evaluate(() => window.__api.begins);
  check(begins.length === 1 && !begins[0].authed, 'SS-02: the seat sign-in carries no session (it can never link into Player 1)', begins);
  await h.shot(page, 'ss02-p2-qr');
  await until(page, () => document.querySelector('#dr-cards .dr-card[data-n="2"] .dr-account')?.dataset.state === 'signed-in', null, 15000);
  c2 = await card(page, 2);
  check((await card(page, 1)).disabled.length === 0, "SS-02: once P2 is in, P1's Sign in is free again", await card(page, 1));
  check(c2.state === 'signed-in' && c2.pics.join() === 'discord' && c2.buttons.includes('Not me') && /Sam/.test(c2.who), "SS-02: P2's card: Sam's picture, name and Not me", c2);
  check(!(await page.evaluate(() => window._game.lobby.auth.isLoggedIn())), 'SS-02: Player 1 is still signed out');
  const drP2 = await person(page, '#dr-cards .dr-card[data-n="2"] .dr-who');
  check(drP2 && drP2.name === 'Sam' && drP2.source === 'discord' && drP2.pic && drP2.badge === 'Discord', "SS-02: P2's card title: Sam's picture with the Discord badge", drP2);
  check(!(await person(page, '#dr-cards .dr-card[data-n="1"] .dr-who')), "SS-02: signed-out P1's card title has no picture");
  await h.shot(page, 'ss02-p2-signed-in');
  await page.evaluate(() => window._game.lobby._room.close('smoke'));
  check(await until(page, () => document.getElementById('host-seat-stoker')?.who === 'Sam'), 'SS-02: the stoker seat card says Sam', await page.evaluate(() => document.getElementById('host-seat-stoker')?.who));
  const stoSeat = await person(page, '#host-seat-stoker');
  const stoDev = await page.evaluate(() => document.getElementById('host-seat-stoker')?.dev);
  check(stoSeat && stoSeat.name === 'Sam' && stoSeat.source === 'discord' && stoSeat.pic && /dualsense/i.test(stoDev || ''), "SS-02: the stoker seat: Sam's picture + Discord badge over the controller", { stoSeat, stoDev });
  await until(page, () => !!document.querySelector('#host-roster uf-person'));
  const chip = await page.evaluate(() => [...document.querySelectorAll('#host-roster .ucr-chip')].map((c) => ({ person: c.querySelector('uf-person')?.getAttribute('name') || null, source: c.querySelector('uf-person')?.getAttribute('source') || null, text: c.textContent })));
  check(chip.some((c) => c.person === 'Sam' && c.source === 'discord' && /dualsense/i.test(c.text)) && chip.filter((c) => c.person).length === 1, "SS-02: the controller strip: Sam's chip has the picture and the DualSense; P1's has none", chip);
  check(!(await person(page, '#host-seat-captain')), "SS-02: signed-out P1's seat is the controller alone");
  await h.shot(page, 'ss02-host-seats');

  // SS-03 · the couch ride's submit (the finish + submit, with a stub ride).
  const sub = await page.evaluate(async () => {
    const g = window._game;
    const b64 = (o) => btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const auth = g.lobby.auth;
    auth.token = b64({ alg: 'HS256' }) + '.' + b64({ sub: 7, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';
    auth.user = { id: 7, serverId: 7, name: 'Pete', identities: {} };
    const was = { mode: g.mode, rm: g.raceManager, ct: g.contributionTracker };
    g.mode = 'local';
    g.achievements.lastFinishState = { finishedLevel: 'grandma', distance: 1200, raceDistance: 1200, crashes: 0, isCoop: true, isMultiplayer: true };
    g._seatFinish();
    g.raceManager = { getSummary: () => ({ distance: 1200, timeMs: 200000, inputSource: 'gamepad' }) };
    g.contributionTracker = { getSummary: () => ({ mode: 'multiplayer', captain: { overallPct: 55 }, stoker: { overallPct: 45 } }) };
    g.lobby.selectedLevel = g.lobby.selectedLevel || { id: 'grandma' };
    await g._submitScore();
    const partner = g._partnerKey();
    Object.assign(g, { mode: was.mode, raceManager: was.rm, contributionTracker: was.ct });
    auth.token = null; auth.user = null;
    return { scores: window.__api.scores, partner };
  });
  const body = sub.scores[0] && sub.scores[0].body;
  check(body && body.mode === 'local' && body.seats && body.seats[0].role === 'stoker' && body.seats[0].token.split('.').length === 3, "SS-03: the couch ride goes up as 'local' with P2's own sign-in", body && { mode: body.mode, seats: body.seats && body.seats.map((s) => ({ role: s.role, ach: s.newAchievements })) });
  check(body && body.contributions && body.contributions.stoker && body.contributions.stoker.userId === null, "SS-03: P1's game never names P2's account id", body && body.contributions);
  check(body && body.seats[0].newAchievements.includes('first_finish'), "SS-03: Sam's achievements from the ride ride along", body && body.seats[0].newAchievements);
  check(sub.partner === '42', "SS-03: the pair key is Sam's account, not 'local:p2'", sub.partner);

  // SS-06 · #609 a couch pair, both signed in
  const r6 = await couchRide(page, { p1SignedIn: true, pair: { rides: 3, distance: 2000 } });
  check(r6.prefetched && r6.pairCalls.length >= 1 && r6.pairCalls.every((c) => c.with === '42' && c.sub === 7), "SS-06: the pair record is asked by P1's session, about Sam's account", r6.pairCalls);
  check(r6.finish.pairRides === 4 && Math.abs(r6.finish.pairDistanceKm - 3.2) < 1e-9, 'SS-06: the finish counts this ride: 4 rides, 3.2 km', r6.finish);
  check(r6.regulars.progress && r6.regulars.progress[0] >= 4 && r6.regulars.progress[1] === 10, 'SS-06: Regulars progress counts the couch pair', r6.regulars);
  const b6 = r6.scores[0] && r6.scores[0].body;
  check(r6.scores.length === 1 && r6.scores[0].sub === 7 && b6.mode === 'local' && b6.seats[0].role === 'stoker' && b6.seats[0].token.split('.').length === 3 && b6.contributions.stoker.userId === null,
    "SS-06: the submit is P1's, with Sam's own token for the stoker seat", b6 && { mode: b6.mode, seats: b6.seats?.length, stoker: b6.contributions?.stoker?.userId });
  check(/You & Sam/.test(r6.panel || '') && /4 rides together/.test(r6.panel || ''), 'SS-06: the pair panel: You & Sam · 4 rides together (this ride included)', r6.panel);
  await h.shot(page, 'ss06-couch-pair-panel');

  // SS-07 · the 10th couch ride earns Regulars for both riders
  const r7 = await couchRide(page, { p1SignedIn: true, pair: { rides: 9, distance: 9000 } });
  check(r7.finish.pairRides === 10 && r7.p1Earned, 'SS-07: the 10th ride: Regulars for Player 1', { finish: r7.finish, p1: r7.p1Earned });
  check(r7.samEarned, 'SS-07: …and for Sam, on their own account', r7.samEarned);

  // SS-08 · Player 1 signed out: Sam posts the couch ride themselves
  const r8 = await couchRide(page, { p1SignedIn: false, pair: { rides: 1, distance: 1200 } });
  const guestKey = r8.couch && r8.couch.withKey;
  check(r8.couch && r8.couch.submitAs === 'p2' && /^guest:.+/.test(guestKey || ''), "SS-08: P1 signed out → Sam's session, P1 = this device's guest", r8.couch);
  check(r8.pairCalls.length >= 1 && r8.pairCalls.every((c) => c.with === guestKey && c.sub === 42), "SS-08: /pair asked by Sam's own session about the guest", r8.pairCalls);
  const b8 = r8.scores[0] && r8.scores[0].body;
  check(r8.scores.length === 1 && r8.scores[0].sub === 42 && b8.mode === 'stoker' && !b8.seats
    && b8.contributions.stoker.userId === 42 && b8.contributions.captain.userId === null && 'guest:' + b8.contributions.captain.guestDeviceId === guestKey,
    "SS-08: the ride goes up under Sam's token as the stoker, the captain a guest", b8 && { mode: b8.mode, c: b8.contributions });
  check(r8.finish.pairRides === 2 && /You & Sam/.test(r8.panel || '') && /2 rides together/.test(r8.panel || ''), 'SS-08: the panel: You & Sam · 2 rides together', { finish: r8.finish, panel: r8.panel });

  // SS-04 · Not me
  await page.evaluate(() => window._game.lobby._openDressingRoom(2));
  await until(page, () => !!document.querySelector('#dr-cards .dr-card[data-n="2"] [data-act="acc-signout"]'));
  await cardClick(page, 2, '[data-act="acc-signout"]');
  await until(page, () => document.querySelector('#dr-cards .dr-card[data-n="2"] .dr-account')?.dataset.state === 'signed-out');
  c2 = await card(page, 2);
  check(c2.state === 'signed-out' && !/Sam/.test(c2.who), 'SS-04: Not me → Sign in again, the card loses the name', c2);
  // Hide: P1 opens a code, then hides it; P2's Sign in waits meanwhile and is free after.
  await cardClick(page, 1, '[data-act="acc-signin"]');
  await until(page, () => document.querySelector('#dr-cards .dr-card[data-n="1"] .dr-account')?.dataset.state === 'pending');
  const waiting = await card(page, 2);
  check(waiting.disabled.includes('Sign in with Discord') && /Waiting for P1/.test(waiting.status), "SS-04: P1's code open → P2 waits", waiting);
  await h.shot(page, 'ss04-one-qr');
  await cardClick(page, 1, '[data-act="acc-cancel"]');
  await until(page, () => document.querySelector('#dr-cards .dr-card[data-n="1"] .dr-account')?.dataset.state === 'signed-out');
  const freed = await card(page, 2);
  check(freed.disabled.length === 0 && (await card(page, 1)).state === 'signed-out', 'SS-04: Hide closes the QR and frees Sign in for everyone', freed);

  // SS-09 · unsigned Player 2: the shared Guest partner, no server pair
  const r9 = await couchRide(page, { p1SignedIn: true, pair: { rides: 5, distance: 5000 } });
  check(r9.partner === 'local:p2' && !r9.couch, "SS-09: unsigned P2 is 'local:p2'", { partner: r9.partner, couch: r9.couch });
  check(r9.pairCalls.length === 0 && r9.panel === null && r9.finish.pairRides === null, 'SS-09: no /pair call, no panel, no pair numbers', r9);
  check(r9.scores.length === 1 && !r9.scores[0].body.seats, 'SS-09: the ride still posts for Player 1, with no seat', r9.scores.map((x) => x.body.seats));
  await page.evaluate(() => window._game.lobby._room.close('smoke'));
  check(await until(page, () => document.getElementById('host-seat-stoker')?.who !== 'Sam'), 'SS-04: the seat goes back to the pad', await page.evaluate(() => document.getElementById('host-seat-stoker')?.who));
  await page.close();
}

// ── SS-05 · Steam: Link Discord on P1's card, and the prompt after a ride ──
{
  const page = await h.gamePage({
    viewport: { width: 1920, height: 1080 },
    userAgent: ELECTRON_UA,
    storage: { tandemonium_tutorial_done: 'smoke' },
    before: async (p) => {
      await installFakeGamepads(p, { atBoot: ['xbox'] });
      await installFakeSteam(p, { subscribed: true });
      await p.evaluateOnNewDocument(() => {
        window.steam.getAuthTicket = () => Promise.resolve('tkt');
        window.__opened = [];
        window.electronApp.openSignIn = (u) => { window.__opened.push(u); return Promise.resolve(true); };
        try { localStorage.removeItem('tandemonium_link_discord_prompt_until'); } catch (e) {}
      });
      await p.evaluateOnNewDocument(fakeApi);
    },
  });
  await until(page, () => window._game && window._game.lobby && window._game.lobby.auth.isLoggedIn(), null, 15000);
  await page.evaluate(() => window._game.lobby._openDressingRoom(1));
  await until(page, () => !!document.querySelector('#dr-cards .dr-card[data-n="1"] .dr-account'));
  const c1 = await card(page, 1);
  check(c1.state === 'signed-in' && c1.pics.join() === 'steam' && c1.buttons.includes('Link Discord') && !c1.buttons.includes('Not me'), "SS-05: P1's card on Steam: Steam picture + Link Discord (no Not me)", c1);
  const drP1 = await person(page, '#dr-cards .dr-card[data-n="1"] .dr-who');
  const p1Name = await page.evaluate(() => window._game.lobby.auth.getUser().name);
  check(drP1 && drP1.name === p1Name && drP1.source === 'steam' && drP1.badge === 'Steam', "SS-05: P1's card title on Steam: the Steam picture and badge, under the account's name", { drP1, p1Name });
  // Steam + Discord both linked: the Steam app still leads with Steam; the web would lead with Discord.
  const lead = await page.evaluate(() => {
    const l = window._game.lobby; const u = l.auth.user; const was = u.identities;
    u.identities = { ...was, discord: { name: 'pete_dc', avatar: 'x' } };
    const steamApp = l.seatPerson(1).source; l._isSteam = false; const web = l.seatPerson(1).source; l._isSteam = true;
    u.identities = was; return { steamApp, web };
  });
  check(lead.steamApp === 'steam' && lead.web === 'discord', 'SS-05: P1 leads with Steam in the Steam app, Discord elsewhere', lead);
  await h.shot(page, 'ss05-p1-steam-card');
  await page.evaluate(() => window._game.lobby._room.close('smoke'));

  const shown = await page.evaluate(() => { const l = window._game.lobby; l._linkPromptDue = true; return l.maybePromptLinkDiscord(); });
  await new Promise((r) => setTimeout(r, 300));
  const pop = await page.evaluate(() => ({
    open: document.getElementById('profile-popup').classList.contains('visible'),
    prompt: !document.getElementById('profile-popup-prompt').hidden,
    back: document.getElementById('profile-popup-back').textContent,
    focus: document.querySelector('#profile-popup .gamepad-focus')?.id || null,
  }));
  check(shown && pop.open && pop.prompt && pop.back === 'NOT NOW' && pop.focus === 'profile-popup-link-discord', 'SS-05: after a ride, the Profile card asks once: reason, LINK DISCORD focused, NOT NOW', pop);
  await h.shot(page, 'ss05-link-prompt');
  await page.evaluate(() => document.getElementById('profile-popup-back').click());
  const again = await page.evaluate(() => { const l = window._game.lobby; l._linkPromptDue = true; return l.maybePromptLinkDiscord(); });
  check(!again, 'SS-05: not again for a week');
  const back2 = await page.evaluate(() => { window._game.lobby._toggleProfile(); const t = document.getElementById('profile-popup-back').textContent; window._game.lobby._toggleProfile(); return t; });
  check(back2 === 'CLOSE', 'SS-05: opened by hand, the card is the normal Profile', back2);
  await page.close();
}

await h.finish();
