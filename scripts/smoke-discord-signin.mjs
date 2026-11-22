// smoke-discord-signin.mjs — #612 House Tandem account: Discord + Steam.
//
//   node scripts/smoke-discord-signin.mjs
//
// The API is faked in the page (window.fetch), so no network:
//   A. TV browser, signed out: Profile shows the QR steps + a 4-letter code (the
//      device code, /auth/poll); when the phone side finishes, the Profile pill
//      shows the Discord picture on the left.
//   B. Steam build: signed in by Steam ticket (Steam picture on the right of the
//      pill). LINK DISCORD shows a QR for the account page (housetandem.com/account)
//      with its own steps and no code, asks the API for nothing, and re-reads the
//      account; OPEN ON THIS COMPUTER opens that page in the system browser. Once
//      the account has Discord, the toast shows, Discord is on the left and Steam
//      on the right. Then: signed out in the same popup, the device-code steps
//      (with the code) are back.
//   C. Phone browser: the Discord button goes to Discord and back (a redirect);
//      coming back with #ht_result=<id>.<code>, the page swaps the code and the
//      value this tab kept for the session (/auth/exchange), and the code leaves
//      the URL. A session token in the address (#ht_auth) signs nobody in and is
//      taken off the address.
//   D. #612 · Steam build: a "combined" notice on the Profile card separates the
//      accounts and signs in with Steam again.
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeSteam, ELECTRON_UA } from './lib/fake-steam.mjs';

const h = await startHarness({ port: 8973, outDir: 'smoke-discord-signin' });
const { check } = h;

const dot = (c) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="${c}"/></svg>`);
const DISCORD_PIC = dot('#5865f2');
const STEAM_PIC = dot('#66c0f4');
const ACCOUNT_PAGE = 'https://housetandem.com/account';   // where a login is added to an account (js/auth.js)

/** Installed before navigation: answers the Tandemonium API from fixtures. */
function fakeApi({ discordPic, steamPic, origin, scenario = '' }) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = (sub) => b64({ alg: 'HS256' }) + '.' + b64({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';
  const state = (window.__api = JSON.parse(sessionStorage.getItem('__api') || '{"polls":0,"linked":false,"discordLinked":false,"begins":[],"exchanges":[],"me":0}'));
  const save = () => sessionStorage.setItem('__api', JSON.stringify(state));
  if (scenario && !state.scenario) { state.scenario = scenario; state.steamLogins = 0; state.undos = []; state.seen = []; save(); }
  const sha256 = async (text) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    if (!/tandemonium-api|workers\.dev|housetandem/.test(url)) return realFetch(input, init);
    const p = new URL(url).pathname;
    const authed = !!(init.headers && (init.headers.Authorization || init.headers.authorization));
    if (p === '/auth/discord/begin') {
      const body = JSON.parse(init.body || '{}');
      state.begins.push({ mode: body.mode, authed, return_to: body.return_to || null, nonce_hash: body.nonce_hash || null });
      save();
      // A redirect: the provider comes back to return_to with a short single-use code. (The
      // real one leaves the site and loads the page again; ?back=1 makes this one a page load.)
      if (body.mode === 'redirect') return json({ id: 'r1', code: null, url: origin + '/index.html?back=1#ht_result=r1.c0de', expires_in: 600 });
      return json({ id: 'd1', secret: 's', code: 'K7QF', url: 'https://tandemonium-api.example.workers.dev/auth/discord/go?r=d1', expires_in: 600 });
    }
    if (p === '/auth/exchange') {
      // The code is swapped for the session only with the value the beginning tab kept.
      const body = JSON.parse(init.body || '{}');
      const began = state.begins.find((b) => b.mode === 'redirect' && b.nonce_hash);
      const match = !!(began && body.nonce && (await sha256(body.nonce)) === began.nonce_hash);
      state.exchanges.push({ id: body.id, code: body.code, nonce: !!body.nonce, match, authed });
      save();
      if (body.id !== 'r1' || body.code !== 'c0de' || !match) return json({ error: 'This sign-in was started in another browser or tab. Start it again here.', code: 'signin_mismatch' }, 403);
      return json({ token: jwt(7), user: { id: 7, name: 'Pete', avatar: discordPic, identities: { discord: { name: 'Pete', avatar: discordPic } } } });
    }
    if (p === '/auth/poll') {
      state.polls++;
      save();
      if (state.polls < 2) return json({ status: 'pending' });
      if (state.polls < 3) return json({ status: 'confirming' });
      return json({ status: 'done', token: jwt(7), linked: false, merged: false, user: { id: 7, name: 'Pete', avatar: discordPic, identities: { discord: { name: 'Pete', avatar: discordPic } } } });
    }
    if (p === '/auth/steam') {
      state.linked = true;
      state.steamLogins = (state.steamLogins || 0) + 1;
      save();
      return json({ token: jwt(7), user: { id: 7, name: 'pete_steam', avatar: steamPic, identities: { steam: { name: 'pete_steam', avatar: steamPic } } } });
    }
    if (p === '/me') {
      // state.linked: the Steam build signed in. state.discordLinked: Discord was added on the account page.
      state.me++;
      save();
      const ids = {};
      if (!state.linked || state.discordLinked) ids.discord = { name: 'Pete', avatar: discordPic };
      if (state.linked) ids.steam = { name: 'pete_steam', avatar: steamPic };
      return json({ user: { id: 7, display_name: state.linked ? 'pete_steam' : 'Pete', avatar_url: state.linked ? steamPic : discordPic, identities: ids }, achievements: [], bestScores: [] });
    }
    if (p === '/me/notices') {
      const list = /notice/.test(state.scenario || '') && !(state.undos || []).length
        ? [{ id: 5, kind: 'combine', provider: 'steam', login_name: 'pete_steam', from_name: 'Old Steam Pete', created_at: Math.floor(Date.now() / 1000) - 60, undo_until: Math.floor(Date.now() / 1000) + 6 * 86400, seen: (state.seen || []).includes(5) }]
        : [];
      return json({ notices: list });
    }
    if (p === '/me/notices/undo') {
      state.undos = [...(state.undos || []), JSON.parse(init.body || '{}').id];
      save();
      return json({ undone: true, kind: 'combine', signed_out: true });
    }
    if (p === '/me/notices/seen') {
      state.seen = [...(state.seen || []), JSON.parse(init.body || '{}').id];
      save();
      return json({ ok: true });
    }
    return json({ error: 'not faked' }, 404);
  };
}

const pill = (page) => page.evaluate(() => {
  const b = document.getElementById('bar-profile');
  if (!b) return null;
  return Array.from(b.children).map((c) => c.tagName === 'IMG' ? 'img:' + c.dataset.provider : c.tagName.toLowerCase());
});
const popupState = (page) => page.evaluate(() => {
  const visEl = (e) => !!e && e.offsetParent !== null && getComputedStyle(e).display !== "none";
  const vis = (id) => visEl(document.getElementById(id));
  const text = (e) => (visEl(e) ? e.textContent.trim() : '');
  // lab #146 · the sign-in buttons, the login lines, Link and Sign out are the shared elements'
  const signin = document.querySelector('#profile-popup-providers [data-provider="discord"]'), link = document.querySelector('#profile-popup-card button[data-act="link"][data-provider="discord"]');
  const steam = document.querySelector('#profile-popup-providers [data-provider="steam"]');
  const out = document.querySelector('#profile-popup-card button[data-act="signout"]');
  const focus = document.querySelector('#profile-popup .gamepad-focus');
  return {
    open: document.getElementById('profile-popup').classList.contains('visible'),
    discordBtn: visEl(signin), discordText: text(signin), steamText: text(steam),
    linkBtn: visEl(link), linkText: text(link), signOut: text(out),
    lines: Array.from(document.querySelectorAll('#profile-popup-card li[data-linked="true"]')).map((li) => li.dataset.provider + ':' + li.querySelector('.uf-id-login-name').textContent + ':' + (li.querySelector('img.uf-id-login-pic') ? 'pic' : 'nopic')),
    pad: window._game.lobby._profileItems().map((e) => window._game.lobby._profileItemName(e)),
    focus: focus ? window._game.lobby._profileItemName(focus) : null,
    qr: !!document.querySelector('#profile-popup-qr svg') && vis('profile-popup-device'),
    code: (document.getElementById('profile-popup-code') || { textContent: null }).textContent,   // null: the steps have no code
    steps: vis('profile-popup-device') ? Array.from(document.querySelectorAll('#profile-popup-device .profile-popup-steps li')).map((li) => li.textContent.trim().replace(/\s+/g, ' ')) : [],
    status: document.getElementById('profile-popup-device-status').textContent,
  };
});

// ── A. TV browser, signed out ──
{
  const page = await h.gamePage({
    viewport: { width: 1920, height: 1080 },
    storage: { tandemonium_tutorial_done: 'smoke' },
    before: (pg) => pg.evaluateOnNewDocument(fakeApi, { discordPic: DISCORD_PIC, steamPic: STEAM_PIC, origin: h.origin }),
  });
  await sleep(1500);
  check(JSON.stringify(await pill(page)) === JSON.stringify(['svg']), 'A: signed out, the pill shows the plain icon', await pill(page));
  await page.evaluate(() => document.getElementById('bar-profile').click());
  await page.waitForFunction(() => (document.getElementById('profile-popup-code') || {}).textContent === 'K7QF', { timeout: 10000 }).catch(() => {});
  let s = await popupState(page);
  check(s.open && s.qr && !s.discordBtn && !s.linkBtn, 'A: on a TV the QR stands in for SIGN IN WITH DISCORD (no Google, no duplicate button)', s);
  check(s.qr && s.code === 'K7QF', 'A: the QR steps and the code show on a TV', s);
  check(s.steps.length === 3 && s.steps[1] === 'Sign in with Discord' && s.steps[2] === 'Type this code on your phone K7QF', 'A: the steps say to sign in with Discord and type the code on the phone', s.steps);
  const beginsA = await page.evaluate(() => window.__api.begins);
  check(beginsA.length === 1 && beginsA[0].mode === 'device' && !beginsA[0].authed, 'A: signed out, the sign-in begins as a device code', beginsA);
  check(await page.evaluate(() => !document.querySelector('script[src*="accounts.google.com"]') && !document.getElementById('gsi-button-container')), 'A: no Google sign-in left on the page');
  await h.shot(page, 'A1-tv-signin');
  await page.waitForFunction(() => document.getElementById('bar-profile').querySelector('img[data-provider="discord"]'), { timeout: 15000 }).catch(() => {});
  check(JSON.stringify(await pill(page)) === JSON.stringify(['img:discord']), 'A: after the phone signs in, Discord\'s picture is on the pill', await pill(page));
  s = await popupState(page);
  check(!s.open, 'A: the popup closes on sign-in', s);
  await h.shot(page, 'A2-tv-signed-in');
  // lab #146 · the signed-in card in a TV browser: the Discord line, Sign out (pad starts there), CLOSE
  await page.evaluate(() => document.getElementById('bar-profile').click());
  await sleep(300);
  s = await popupState(page);
  check(s.open && JSON.stringify(s.lines) === JSON.stringify(['discord:Pete:pic']) && !s.linkBtn && s.signOut === 'Sign out', 'A: signed in on a TV browser, the card shows the Discord login and Sign out', s);
  check(JSON.stringify(s.pad) === JSON.stringify(['signout', 'profile-popup-back']) && s.focus === 'signout', 'A: the pad reaches Sign out and CLOSE, and starts on Sign out', s);
  await h.shot(page, 'A3-tv-profile');
  await page.close();
}

// ── B. Steam build: Steam ticket, then link Discord ──
{
  const page = await h.gamePage({
    viewport: { width: 1920, height: 1080 },
    userAgent: ELECTRON_UA,
    storage: { tandemonium_tutorial_done: 'smoke' },
    before: async (pg) => {
      await installFakeSteam(pg, { subscribed: true });
      await pg.evaluateOnNewDocument(() => {
        window.steam.getAuthTicket = () => Promise.resolve('tkt');
        window.__opened = [];
        window.electronApp.openSignIn = (u) => { window.__opened.push(u); return Promise.resolve(true); };
      });
      await pg.evaluateOnNewDocument(fakeApi, { discordPic: DISCORD_PIC, steamPic: STEAM_PIC, origin: h.origin });
    },
  });
  await page.waitForFunction(() => document.getElementById('bar-profile').querySelector('img[data-provider="steam"]'), { timeout: 15000 }).catch(() => {});
  check(JSON.stringify(await pill(page)) === JSON.stringify(['svg', 'span', 'img:steam']) || JSON.stringify(await pill(page)) === JSON.stringify(['svg', 'img:steam']),
    'B: Steam sign-in puts the Steam picture on the right of the pill', await pill(page));
  await page.evaluate(() => document.getElementById('bar-profile').click());
  await sleep(300);
  let s = await popupState(page);
  check(s.open && s.linkBtn && s.linkText === 'Link Discord' && !s.qr, 'B: Profile offers Link Discord to a Steam player', s);
  check(JSON.stringify(s.lines) === JSON.stringify(['steam:pete_steam:pic']) && !s.signOut, 'B: the card has a line for the Steam login (name and picture), and no Sign out on Steam', s);
  check(JSON.stringify(s.pad) === JSON.stringify(['link:discord', 'profile-popup-back']) && s.focus === 'link:discord', 'B: the pad reaches Link Discord and CLOSE, and starts on Link Discord', s);
  await h.shot(page, 'B1-steam-profile');
  await page.evaluate(() => document.querySelector('#profile-popup-card button[data-act="link"][data-provider="discord"]').click());
  await page.waitForFunction(() => /updates when Discord is linked/.test(document.getElementById('profile-popup-device-status').textContent), { timeout: 10000 }).catch(() => {});
  s = await popupState(page);
  check(s.open && s.qr && !s.linkBtn, 'B: linking shows a QR, and LINK DISCORD steps aside', s);
  const linkUrl = await page.evaluate(() => window._game.lobby._profileDevUrl);
  check(linkUrl === ACCOUNT_PAGE, 'B: the QR is for the account page', linkUrl);
  check(JSON.stringify(s.steps) === JSON.stringify(['Scan with your phone’s camera', 'Sign in with Steam', 'Choose Link Discord']) && !s.code, 'B: the steps are the account page\'s (Steam, then Link Discord), with no code', s);
  check(s.status === 'This screen updates when Discord is linked.', 'B: the status line says the screen updates when Discord is linked', s.status);
  let opened = await page.evaluate(() => window.__opened.slice());
  check(opened.length === 0, 'B: the browser does not open by itself (QR first, for the couch)', opened);
  const openBtn = await page.evaluate(() => {
    const b = document.getElementById('profile-popup-open-browser');
    const r = b && b.getBoundingClientRect();
    return { shown: !!(b && b.style.display !== 'none' && r.width > 0), text: b && b.textContent.trim() };
  });
  check(openBtn.shown && openBtn.text === 'OPEN ON THIS COMPUTER', 'B: OPEN ON THIS COMPUTER sits under the QR', openBtn);
  await page.evaluate(() => document.getElementById('profile-popup-open-browser').click());
  opened = await page.evaluate(() => window.__opened.slice());
  check(opened.length === 1 && opened[0] === ACCOUNT_PAGE, 'B: OPEN ON THIS COMPUTER opens the system browser on the account page', opened);
  await sleep(5000);   // one re-read of the account (every 4 s) with Discord not there yet
  const waiting = await page.evaluate(() => ({ begins: window.__api.begins, polls: window.__api.polls, me: window.__api.me }));
  check(waiting.begins.length === 0 && waiting.polls === 0, 'B: adding Discord asks the API for no sign-in and no device code', waiting);
  s = await popupState(page);
  check(s.open && s.qr && JSON.stringify(await pill(page)).indexOf('img:discord') < 0, 'B: until the account has Discord, the QR stays and the pill is unchanged', s);
  await h.shot(page, 'B2-steam-link-qr');
  // The phone finished on the account page: the account now has both logins.
  await page.evaluate(() => { window.__api.discordLinked = true; sessionStorage.setItem('__api', JSON.stringify(window.__api)); });
  await page.waitForFunction(() => document.getElementById('bar-profile').querySelector('img[data-provider="discord"]'), { timeout: 8000 }).catch(() => {});
  const linkedApi = await page.evaluate(() => ({ me: window.__api.me, begins: window.__api.begins.length }));
  check(linkedApi.me > waiting.me && linkedApi.begins === 0, 'B: the game re-read the account to see the new login', linkedApi);
  const toast = await page.evaluate(() => [...document.querySelectorAll('.info-toast')].map((t) => t.textContent).join(' | '));
  check(/Discord linked/.test(toast) && /Discord and Steam are one House Tandem account/.test(toast), 'B: the Discord linked toast shows', toast);
  const p = await pill(page);
  const imgs = p ? p.filter((x) => x.startsWith('img:')) : [];
  check(JSON.stringify(imgs) === JSON.stringify(['img:discord', 'img:steam']) && p[0] === 'img:discord' && p[p.length - 1] === 'img:steam',
    'B: once linked, Discord is on the left of the pill and Steam on the right', p);
  s = await popupState(page);
  check(s.open && !s.qr && !s.linkBtn, 'B: the card stays open, and the QR and LINK DISCORD are gone once Discord is linked', s);
  check(JSON.stringify(s.lines) === JSON.stringify(['discord:Pete:pic', 'steam:pete_steam:pic']), 'B: the card shows both logins, Discord first, each with its name and picture', s.lines);
  check(JSON.stringify(s.pad) === JSON.stringify(['profile-popup-back']), 'B: once linked the pad has CLOSE only (no Sign out on Steam)', s.pad);
  await h.shot(page, 'B3-steam-linked');
  // Signed out, then the same popup again: a device-code sign-in, so the code step is back.
  await page.evaluate(() => { window.__api.polls = 0; return window._game.lobby._signOut({ sync: false }); });
  await page.waitForFunction(() => !localStorage.getItem('tandemonium_auth_token'), { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => document.getElementById('bar-profile').click());
  await page.waitForFunction(() => (document.getElementById('profile-popup-code') || {}).textContent === 'K7QF', { timeout: 10000 }).catch(() => {});
  s = await popupState(page);
  check(s.open && s.qr && JSON.stringify(s.steps) === JSON.stringify(['Scan with your phone’s camera', 'Sign in with Discord', 'Type this code on your phone K7QF']),
    'B: signed out, the same popup shows the device-code steps again, with the code', s);
  check(s.status === 'Waiting for Discord…', 'B: and its status line is the sign-in one', s.status);
  const beginsB = await page.evaluate(() => window.__api.begins);
  check(beginsB.length === 1 && beginsB[0].mode === 'device' && !beginsB[0].authed, 'B: that sign-in is a device code begun signed out', beginsB);
  await h.shot(page, 'B4-steam-signed-out-code');
  await page.close();
}

// ── C. Phone browser: redirect to Discord and back ──
{
  const page = await h.gamePage({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    storage: { tandemonium_tutorial_done: 'smoke' },
    before: async (pg) => {
      // Signed out to start (B left a Steam session in this origin's storage);
      // only on the first load, so the redirect back keeps its sign-in.
      await pg.evaluateOnNewDocument(() => {
        if (sessionStorage.getItem('__c_cleared')) return;
        sessionStorage.setItem('__c_cleared', '1');
        sessionStorage.removeItem('__api');
        localStorage.removeItem('tandemonium_auth_user');
        localStorage.removeItem('tandemonium_auth_token');
      });
      await pg.evaluateOnNewDocument(fakeApi, { discordPic: DISCORD_PIC, steamPic: STEAM_PIC, origin: h.origin });
    },
  });
  await sleep(1200);
  await page.evaluate(() => document.getElementById('toggle-profile').click());
  await sleep(300);
  const s = await popupState(page);
  check(s.open && s.discordBtn && s.discordText === 'Sign in with Discord' && !s.steamText && !s.qr, 'C: a phone gets the Sign in with Discord button, no Steam button, no QR', s);
  const fits = await page.evaluate(() => {
    const p = document.getElementById('profile-popup').getBoundingClientRect(), b = document.querySelector('#profile-popup-providers [data-provider="discord"]').getBoundingClientRect();
    return { popup: [Math.round(p.left), Math.round(p.right)], button: [Math.round(b.left), Math.round(b.right)], height: Math.round(b.height), vw: innerWidth };
  });
  check(fits.popup[0] >= 0 && fits.popup[1] <= fits.vw && fits.button[0] >= fits.popup[0] && fits.button[1] <= fits.popup[1] && fits.height >= 32, 'C: the button sits inside the popup, the popup inside the screen, and it is tall enough to tap', fits);
  await h.shot(page, 'C1-phone-signin');
  const nav = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
  await page.evaluate(() => document.querySelector('#profile-popup-providers [data-provider="discord"]').click());
  await nav;
  await page.waitForFunction(() => !!window._game && !!window._game.lobby, { timeout: 90000 });
  await page.waitForFunction(() => { try { return !!localStorage.getItem('tandemonium_auth_token') && !!JSON.parse(localStorage.getItem('tandemonium_auth_user')).identities.discord; } catch { return false; } }, { timeout: 15000 }).catch(() => {});
  const after = await page.evaluate(() => ({
    hash: location.hash, search: location.search,
    user: JSON.parse(localStorage.getItem('tandemonium_auth_user') || 'null'),
    toggleImg: !!document.querySelector('#toggle-profile img'),
  }));
  check(after.user && after.user.identities && after.user.identities.discord && after.user.provider === 'discord', 'C: back from Discord, signed in with Discord', after.user);
  check(after.search === '?back=1' && !after.hash.includes('ht_result'), 'C: the code is taken off the URL', after);
  const apiC = await page.evaluate(() => ({ begins: window.__api.begins, exchanges: window.__api.exchanges }));
  check(apiC.begins.length === 1 && apiC.begins[0].mode === 'redirect' && !apiC.begins[0].authed && /\/index\.html$/.test(apiC.begins[0].return_to || '') && !!apiC.begins[0].nonce_hash,
    'C: the sign-in begins as a redirect back to this page, with the hash of a value the tab keeps', apiC.begins);
  check(apiC.exchanges.length === 1 && apiC.exchanges[0].id === 'r1' && apiC.exchanges[0].code === 'c0de' && apiC.exchanges[0].match && !apiC.exchanges[0].authed,
    'C: the code is swapped for the session once, with the value that matches the hash', apiC.exchanges);
  check(await page.evaluate(() => !sessionStorage.getItem('ht_signin_pending')), 'C: the tab\'s value is used once and not kept');
  check(after.toggleImg, 'C: the round Profile toggle shows the picture');
  await h.shot(page, 'C2-phone-signed-in');
  // lab #146 · the signed-in card on a phone: the Discord line, Sign out, CLOSE
  await page.evaluate(() => document.getElementById('toggle-profile').click());
  await sleep(300);
  const c = await popupState(page);
  check(c.open && JSON.stringify(c.lines) === JSON.stringify(['discord:Pete:pic']) && !c.linkBtn && c.signOut === 'Sign out', 'C: signed in, the card shows the Discord login (name and picture) and Sign out', c);
  await h.shot(page, 'C3-phone-profile');
  await page.evaluate(() => document.querySelector('#profile-popup-card button[data-act="signout"]').click());
  await page.waitForFunction(() => !localStorage.getItem('tandemonium_auth_token'), { timeout: 10000 }).catch(() => {});
  const out = await page.evaluate(() => ({ token: !!localStorage.getItem('tandemonium_auth_token'), open: document.getElementById('profile-popup').classList.contains('visible'), toggleImg: !!document.querySelector('#toggle-profile img') }));
  check(!out.token && !out.open && !out.toggleImg, 'C: Sign out signs out and closes the card', out);
  // A session token in the address (what servers before 0.5 sent back) signs nobody in.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const oldToken = b64({ alg: 'HS256' }) + '.' + b64({ sub: 7, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';
  await page.goto(h.origin + '/index.html?old=1#ht_auth=' + oldToken, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window._game && !!window._game.lobby, { timeout: 90000 });
  await sleep(1500);
  const old = await page.evaluate(() => ({
    hash: location.hash, search: location.search,
    token: localStorage.getItem('tandemonium_auth_token'), user: localStorage.getItem('tandemonium_auth_user'),
    signedIn: window._game.lobby.auth.isLoggedIn(), toggleImg: !!document.querySelector('#toggle-profile img'),
    exchanges: window.__api.exchanges.length, begins: window.__api.begins.length,
  }));
  check(!old.signedIn && !old.token && !old.user && !old.toggleImg, 'C: an address with #ht_auth=<token> does not sign in', old);
  check(old.hash === '' && old.search === '?old=1', 'C: and the token is taken off the address', old);
  check(old.exchanges === 1 && old.begins === 1, 'C: with nothing asked of the API for it', old);
  await page.close();
}

// ── D. #612 · Steam build: the combined notice + undo ──
const steamPage = (scenario) => h.gamePage({
  viewport: { width: 1920, height: 1080 },
  userAgent: ELECTRON_UA,
  storage: { tandemonium_tutorial_done: 'smoke' },
  before: async (pg) => {
    await installFakeSteam(pg, { subscribed: true });
    await pg.evaluateOnNewDocument(() => {
      window.steam.getAuthTicket = () => Promise.resolve('tkt');
      if (sessionStorage.getItem('__d_cleared')) return;
      sessionStorage.setItem('__d_cleared', '1');
      localStorage.removeItem('tandemonium_auth_user');
      localStorage.removeItem('tandemonium_auth_token');
    });
    await pg.evaluateOnNewDocument(fakeApi, { discordPic: DISCORD_PIC, steamPic: STEAM_PIC, origin: h.origin, scenario });
  },
});
{
  const page = await steamPage('notice');
  await page.waitForFunction(() => { const b = document.getElementById('profile-popup-notice'); return b && !b.hidden; }, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => document.getElementById('bar-profile').click());
  await sleep(300);
  const n = await page.evaluate(() => ({
    shown: !document.getElementById('profile-popup-notice').hidden,
    text: document.getElementById('profile-popup-notice-text').textContent,
    undo: document.getElementById('profile-popup-notice-undo').textContent,
    focusables: window._game.lobby._profileItems().map((e) => e.id),
  }));
  check(n.shown && /“Old Steam Pete” was combined into this one/.test(n.text) && n.text.includes('Not you? You can undo it until') && n.undo === 'SEPARATE THEM',
    'D: the Profile card says an account was combined in, with SEPARATE THEM', n);
  check(n.focusables[0] === 'profile-popup-notice-undo' && n.focusables[1] === 'profile-popup-notice-ok', 'D: a controller reaches SEPARATE THEM and OK first', n.focusables);
  await h.shot(page, 'D2-combined-notice');
  const loginsBefore = await page.evaluate(() => window.__api.steamLogins);
  await page.evaluate(() => document.getElementById('profile-popup-notice-undo').click());
  await page.waitForFunction((b) => window.__api.steamLogins > b, { timeout: 10000 }, loginsBefore).catch(() => {});
  const after = await page.evaluate(() => ({ undos: window.__api.undos, logins: window.__api.steamLogins, notice: !document.getElementById('profile-popup-notice').hidden }));
  check(after.undos.length === 1 && after.undos[0] === 5, 'D: SEPARATE THEM asks the server to undo that notice', after);
  check(after.logins > loginsBefore, 'D: the Steam session ended and the game signed in with Steam again (its own account)', after);
  await page.waitForFunction(() => document.getElementById('profile-popup-notice').hidden, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => document.getElementById('profile-popup-notice').hidden), 'D: no notice once separated');
  await page.close();
}

await h.finish();
