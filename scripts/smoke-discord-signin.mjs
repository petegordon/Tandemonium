// smoke-discord-signin.mjs — #612 House Tandem account: Discord + Steam.
//
//   node scripts/smoke-discord-signin.mjs
//
// The API is faked in the page (window.fetch), so no network:
//   A. TV browser, signed out: Profile shows the Discord button + QR steps + a
//      4-letter code; when the phone side finishes, the Profile pill shows the
//      Discord picture on the left.
//   B. Steam build: signed in by Steam ticket (Steam picture on the right of the
//      pill). LINK DISCORD opens the system browser on the device page and shows
//      the QR; once linked, Discord is on the left and Steam on the right.
//   C. Phone browser: the Discord button goes to Discord and back (a redirect);
//      coming back with #ht_auth signs in, and the token leaves the URL.
//   D. #612 · Steam build: an old session links after a quiet Steam re-sign-in;
//      a Discord with its own account is refused with the website steps; a
//      "combined" notice on the Profile card separates the accounts and signs in again.
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeSteam, ELECTRON_UA } from './lib/fake-steam.mjs';

const h = await startHarness({ port: 8973, outDir: 'smoke-discord-signin' });
const { check } = h;

const dot = (c) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="${c}"/></svg>`);
const DISCORD_PIC = dot('#5865f2');
const STEAM_PIC = dot('#66c0f4');

/** Installed before navigation: answers the Tandemonium API from fixtures. */
function fakeApi({ discordPic, steamPic, origin, scenario = '' }) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = (sub) => b64({ alg: 'HS256' }) + '.' + b64({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';
  const state = (window.__api = JSON.parse(sessionStorage.getItem('__api') || '{"polls":0,"linked":false,"begins":[],"opened":[]}'));
  const save = () => sessionStorage.setItem('__api', JSON.stringify(state));
  if (scenario && !state.scenario) { state.scenario = scenario; state.steamLogins = 0; state.undos = []; state.seen = []; save(); }
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    if (!/tandemonium-api|workers\.dev|housetandem/.test(url)) return realFetch(input, init);
    const p = new URL(url).pathname;
    const authed = !!(init.headers && (init.headers.Authorization || init.headers.authorization));
    if (p === '/auth/discord/begin') {
      const body = JSON.parse(init.body || '{}');
      state.begins.push({ mode: body.mode, authed });
      save();
      if (/fresh/.test(state.scenario || '') && authed && !state.freshDone) {
        state.freshDone = true;
        save();
        return json({ error: 'For your safety, sign in again before linking another account.', code: 'fresh_signin' }, 401);
      }
      if (body.mode === 'redirect') return json({ id: 'r1', secret: 's', code: null, url: origin + '/index.html?back=1#ht_auth=' + jwt(7), expires_in: 600 });
      return json({ id: 'd1', secret: 's', code: 'K7QF', url: 'https://tandemonium-api.example.workers.dev/auth/discord/go?r=d1', expires_in: 600 });
    }
    if (p === '/auth/poll') {
      state.polls++;
      save();
      if (state.polls < 2) return json({ status: 'pending' });
      if (state.polls < 3) return json({ status: 'confirming' });
      if (/has_account/.test(state.scenario || '')) return json({ status: 'error', error: 'has_account' });
      const ids = { discord: { name: 'Pete', avatar: discordPic } };
      if (state.linked) ids.steam = { name: 'pete_steam', avatar: steamPic };
      return json({ status: 'done', token: jwt(7), linked: state.linked, merged: false, user: { id: 7, name: state.linked ? 'pete_steam' : 'Pete', avatar: discordPic, identities: ids } });
    }
    if (p === '/auth/steam') {
      state.linked = true;
      state.steamLogins = (state.steamLogins || 0) + 1;
      save();
      return json({ token: jwt(7), user: { id: 7, name: 'pete_steam', avatar: steamPic, identities: { steam: { name: 'pete_steam', avatar: steamPic } } } });
    }
    if (p === '/me') {
      const ids = state.linked ? { steam: { name: 'pete_steam', avatar: steamPic } } : { discord: { name: 'Pete', avatar: discordPic } };
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
  const vis = (id) => { const e = document.getElementById(id); return !!e && e.offsetParent !== null && getComputedStyle(e).display !== "none"; };
  return {
    open: document.getElementById('profile-popup').classList.contains('visible'),
    discordBtn: vis('profile-popup-discord'),
    linkBtn: vis('profile-popup-link-discord'),
    qr: !!document.querySelector('#profile-popup-qr svg') && vis('profile-popup-device'),
    code: document.getElementById('profile-popup-code').textContent,
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
  await page.waitForFunction(() => document.getElementById('profile-popup-code').textContent === 'K7QF', { timeout: 10000 }).catch(() => {});
  let s = await popupState(page);
  check(s.open && s.qr && !s.discordBtn && !s.linkBtn, 'A: on a TV the QR stands in for SIGN IN WITH DISCORD (no Google, no duplicate button)', s);
  check(s.qr && s.code === 'K7QF', 'A: the QR steps and the code show on a TV', s);
  check(await page.evaluate(() => !document.querySelector('script[src*="accounts.google.com"]') && !document.getElementById('gsi-button-container')), 'A: no Google sign-in left on the page');
  await h.shot(page, 'A1-tv-signin');
  await page.waitForFunction(() => document.getElementById('bar-profile').querySelector('img[data-provider="discord"]'), { timeout: 15000 }).catch(() => {});
  check(JSON.stringify(await pill(page)) === JSON.stringify(['img:discord']), 'A: after the phone signs in, Discord\'s picture is on the pill', await pill(page));
  s = await popupState(page);
  check(!s.open, 'A: the popup closes on sign-in', s);
  await h.shot(page, 'A2-tv-signed-in');
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
  check(s.open && s.linkBtn && !s.qr, 'B: Profile offers LINK DISCORD to a Steam player', s);
  await h.shot(page, 'B1-steam-profile');
  await page.evaluate(() => document.getElementById('profile-popup-link-discord').click());
  await page.waitForFunction(() => document.getElementById('profile-popup-code').textContent === 'K7QF', { timeout: 10000 }).catch(() => {});
  s = await popupState(page);
  check(s.qr && s.code === 'K7QF' && !s.linkBtn, 'B: linking shows the QR steps and the code, and LINK DISCORD steps aside', s);
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
  check(opened.length === 1 && /\/auth\/discord\/go\?r=d1$/.test(opened[0]), 'B: OPEN ON THIS COMPUTER opens the system browser on the device page', opened);
  const begins = await page.evaluate(() => window.__api.begins);
  check(begins.length === 1 && begins[0].authed && begins[0].mode === 'device', 'B: the link request carries the Steam session (so it links, not a new account)', begins);
  await h.shot(page, 'B2-steam-link-qr');
  await page.waitForFunction(() => document.getElementById('bar-profile').querySelector('img[data-provider="discord"]'), { timeout: 15000 }).catch(() => {});
  const p = await pill(page);
  const imgs = p ? p.filter((x) => x.startsWith('img:')) : [];
  check(JSON.stringify(imgs) === JSON.stringify(['img:discord', 'img:steam']) && p[0] === 'img:discord' && p[p.length - 1] === 'img:steam',
    'B: once linked, Discord is on the left of the pill and Steam on the right', p);
  await page.evaluate(() => document.getElementById('bar-profile').click());
  await sleep(300);
  s = await popupState(page);
  check(s.open && !s.linkBtn, 'B: LINK DISCORD is gone once Discord is linked', s);
  const avatars = await page.evaluate(() => Array.from(document.querySelectorAll('#profile-popup-avatars img')).map((i) => i.dataset.provider));
  check(JSON.stringify(avatars) === JSON.stringify(['discord', 'steam']), 'B: the popup shows both pictures', avatars);
  await h.shot(page, 'B3-steam-linked');
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
  check(s.open && s.discordBtn && !s.qr, 'C: a phone gets the Discord button, no QR', s);
  await h.shot(page, 'C1-phone-signin');
  const nav = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
  await page.evaluate(() => document.getElementById('profile-popup-discord').click());
  await nav;
  await page.waitForFunction(() => !!window._game && !!window._game.lobby, { timeout: 90000 });
  await page.waitForFunction(() => { try { return !!localStorage.getItem('tandemonium_auth_token') && !!JSON.parse(localStorage.getItem('tandemonium_auth_user')).identities.discord; } catch { return false; } }, { timeout: 15000 }).catch(() => {});
  const after = await page.evaluate(() => ({
    hash: location.hash, search: location.search,
    user: JSON.parse(localStorage.getItem('tandemonium_auth_user') || 'null'),
    toggleImg: !!document.querySelector('#toggle-profile img'),
  }));
  check(after.user && after.user.identities && after.user.identities.discord && after.user.provider === 'discord', 'C: back from Discord, signed in with Discord', after.user);
  check(!after.hash.includes('ht_auth'), 'C: the token is taken off the URL', after.hash);
  check(after.toggleImg, 'C: the round Profile toggle shows the picture');
  await h.shot(page, 'C2-phone-signed-in');
  await page.close();
}

// ── D. #612 · Steam build: fresh sign-in for a link, a Discord with its own account, the notice + undo ──
const steamPage = (scenario) => h.gamePage({
  viewport: { width: 1920, height: 1080 },
  userAgent: ELECTRON_UA,
  storage: { tandemonium_tutorial_done: 'smoke' },
  before: async (pg) => {
    await installFakeSteam(pg, { subscribed: true });
    await pg.evaluateOnNewDocument(() => {
      window.steam.getAuthTicket = () => Promise.resolve('tkt');
      window.__opened = [];
      window.electronApp.openSignIn = (u) => { window.__opened.push(u); return Promise.resolve(true); };
      if (sessionStorage.getItem('__d_cleared')) return;
      sessionStorage.setItem('__d_cleared', '1');
      localStorage.removeItem('tandemonium_auth_user');
      localStorage.removeItem('tandemonium_auth_token');
    });
    await pg.evaluateOnNewDocument(fakeApi, { discordPic: DISCORD_PIC, steamPic: STEAM_PIC, origin: h.origin, scenario });
  },
});
{
  const page = await steamPage('fresh has_account');
  await page.waitForFunction(() => document.getElementById('bar-profile').querySelector('img[data-provider="steam"]'), { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => document.getElementById('bar-profile').click());
  await sleep(300);
  await page.evaluate(() => document.getElementById('profile-popup-link-discord').click());
  await page.waitForFunction(() => document.getElementById('profile-popup-code').textContent === 'K7QF', { timeout: 10000 }).catch(() => {});
  const api = await page.evaluate(() => window.__api);
  check(api.begins.length === 2 && api.begins.every((b) => b.authed) && api.steamLogins >= 2,
    'D: an old session is refused once; the game signs in again with Steam (quietly) and the link begins', api);
  let s = await popupState(page);
  check(s.open && s.qr && s.code === 'K7QF', 'D: the Profile card stays open on the QR after the quiet Steam sign-in', s);
  const step = await page.evaluate(() => document.querySelector('.profile-popup-steps li:last-child').textContent.trim());
  check(/^Type this code on your phone/.test(step), 'D: the steps say to type the code on the phone', step);
  await page.waitForFunction(() => { const e = document.getElementById('profile-popup-error'); return e && !e.hidden && e.textContent; }, { timeout: 15000 }).catch(() => {});
  const err = await page.evaluate(() => { const e = document.getElementById('profile-popup-error'); return e && !e.hidden ? e.textContent : null; });
  check(err && /already has its own account/.test(err) && err.includes('housetandem.com/account.html') && /Link Steam/.test(err),
    'D: a Discord with its own account is refused with the website steps', err);
  s = await popupState(page);
  check(!s.qr && s.linkBtn, 'D: the QR steps aside and LINK DISCORD is back', s);
  await h.shot(page, 'D1-has-account');
  await page.close();
}
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
