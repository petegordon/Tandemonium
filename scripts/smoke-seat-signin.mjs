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
//   SS-05  Steam: P1's card offers Link Discord; after a ride the Profile card opens once
//          with the reason, LINK DISCORD focused and NOT NOW; not again for a week
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
  window.__api = { begins: [], scores: [], polls: 0, linked: false };
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
    if (p === '/score') { window.__api.scores.push({ body: JSON.parse(init.body), auth: !!auth }); return json({ scoreId: 1 }); }
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
  };
}, n);
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

  await cardClick(page, 2, '[data-act="acc-signin"]');
  await until(page, () => document.querySelector('#dr-cards .dr-card[data-n="2"] .dr-acc-code')?.textContent === 'Q4MZ');
  c1 = await card(page, 1); c2 = await card(page, 2);
  check(c2.state === 'pending' && c2.qr && c2.code === 'Q4MZ', "SS-02: P2's card shows its own QR + code", c2);
  check(c1.state === 'signed-out' && !c1.qr, "SS-02: P1's card is untouched", c1);
  const begins = await page.evaluate(() => window.__api.begins);
  check(begins.length === 1 && !begins[0].authed, 'SS-02: the seat sign-in carries no session (it can never link into Player 1)', begins);
  await h.shot(page, 'ss02-p2-qr');
  await until(page, () => document.querySelector('#dr-cards .dr-card[data-n="2"] .dr-account')?.dataset.state === 'signed-in', null, 15000);
  c2 = await card(page, 2);
  check(c2.state === 'signed-in' && c2.pics.join() === 'discord' && c2.buttons.includes('Not me') && /Sam/.test(c2.who), "SS-02: P2's card: Sam's picture, name and Not me", c2);
  check(!(await page.evaluate(() => window._game.lobby.auth.isLoggedIn())), 'SS-02: Player 1 is still signed out');
  await h.shot(page, 'ss02-p2-signed-in');
  await page.evaluate(() => window._game.lobby._room.close('smoke'));
  check(await until(page, () => document.getElementById('host-seat-stoker')?.who === 'Sam'), 'SS-02: the stoker seat card says Sam', await page.evaluate(() => document.getElementById('host-seat-stoker')?.who));

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

  // SS-04 · Not me
  await page.evaluate(() => window._game.lobby._openDressingRoom(2));
  await until(page, () => !!document.querySelector('#dr-cards .dr-card[data-n="2"] [data-act="acc-signout"]'));
  await cardClick(page, 2, '[data-act="acc-signout"]');
  await until(page, () => document.querySelector('#dr-cards .dr-card[data-n="2"] .dr-account')?.dataset.state === 'signed-out');
  c2 = await card(page, 2);
  check(c2.state === 'signed-out' && !/Sam/.test(c2.who), 'SS-04: Not me → Sign in again, the card loses the name', c2);
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
  check(back2 === 'RETURN TO LOBBY', 'SS-05: opened by hand, the card is the normal Profile', back2);
  await page.close();
}

await h.finish();
