#!/usr/bin/env node
// smoke-share-card.mjs — #657 SHARE RESULT.
//
// Part 1 · the Steam build saves a clean result card to the Steam screenshot library:
//   1. Steam (fake bridge): finish a Daily Ride → SHARE RESULT sends a
//      1920×1080 PNG + its RGB pixels + the caption to steam.saveScreenshot,
//      and the button says where it went. A second press does not save twice.
//      Part 2: the share sheet opens too, with the QR to the phone page.
//   2. Steam refuses the save → the clipboard, and the button says so.
//   3. No Steam (a desktop browser), a guest → the clipboard, unchanged; no
//      share sheet, no Discord option.
// Part 2 · TV → phone:
//   4. A TV (?tv=1): SHARE RESULT uploads the card (POST /share, a JPEG) and
//      the share sheet shows the QR for SITE_URL/share/?id=…; nothing copied.
//   5. The phone page (share/index.html, 390×844) shows the card and the
//      road link; Share hands the card file to navigator.share.
// Part 3 · the House Tandem Discord:
//   6. Signed in with Discord: SHARE RESULT offers POST TO DISCORD once; it
//      calls POST /share/discord with the session; then says POSTED.
//   7. The Settings option on: the Daily Ride finish posts by itself.
//   8. The Worker without the webhook (/share/config discord:false): no
//      Discord button, and Settings says it is not available.
//
// The Worker is faked in the page (window.fetch). Headless renders slowly, so
// the ride's distance is set directly (as shot-end-sheets.mjs does). Polls,
// never fixed sleeps. SMOKE_SHARE_OUT=<dir> keeps screenshots (share2-*.png).
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, clickId, waitState } from './lib/smoke-harness.mjs';
import { installFakeSteam, fakeSteam, ELECTRON_UA } from './lib/fake-steam.mjs';

const h = await startHarness({ port: 8979 });
const STORAGE = { tandemonium_tutorial_done: 'smoke' };
const OUT = process.env.SMOKE_SHARE_OUT || null;
const SAVED = /^Saved to your Steam screenshots · (Shift\+Tab|Steam button) to share$/;
const SHARE_ID = 'Ab3dEf6hJk9m';
const SHARE_URL = 'https://tandemonium.housetandem.com/share/?id=' + SHARE_ID;

/** A signed-in player with Discord linked (js/auth.js storage). */
function signedIn({ discord = true } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const token = b64({ alg: 'HS256' }) + '.' + b64({ sub: 7, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';
  const identities = discord ? { discord: { name: 'Pete', avatar: null } } : { steam: { name: 'pete_steam', avatar: null } };
  return {
    tandemonium_auth_token: token,
    tandemonium_auth_user: JSON.stringify({ id: 7, serverId: 7, name: 'Pete', avatar: null, provider: discord ? 'discord' : 'steam', identities }),
  };
}

/** Installed before navigation: answers the API Worker from fixtures; window.__api records the calls. */
function installFakeApi(page, { discord = true } = {}) {
  return page.evaluateOnNewDocument((opts) => {
    const api = (window.__api = { shares: [], discordPosts: [], configAsks: 0 });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = String(input && input.url ? input.url : input);
      if (!/tandemonium-api|workers\.dev/.test(url)) return realFetch(input, init);
      const p = new URL(url).pathname;
      if (p === '/share/config') { api.configAsks++; return json({ discord: opts.discord }); }
      if (p === '/share' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        api.shares.push({ bytes: atob(body.image).length, head: body.image.slice(0, 8), contentType: body.contentType, caption: body.caption, link: body.link, dayKey: body.dayKey, deviceId: !!body.deviceId });
        return json({ id: opts.id, url: opts.url, imageUrl: 'https://tandemonium-api.pete-872.workers.dev/share/' + opts.id + '/image' }, 201);
      }
      if (p === '/share/discord') {
        const h = init.headers || {};
        api.discordPosts.push({ auth: h.Authorization || h.authorization || null, body: JSON.parse(init.body || '{}') });
        return api.discordPosts.length > 1 ? json({ code: 'already_posted' }, 409) : json({ ok: true });
      }
      if (p === '/me') return json({ user: { id: 7, display_name: 'Pete', avatar_url: null, identities: { discord: { name: 'Pete', avatar: null } } }, achievements: [], bestScores: [] });
      return json({});
    };
  }, { discord, id: SHARE_ID, url: SHARE_URL });
}

/** Daily Ride → START RIDE → the finish; resolves when SHARE RESULT is on the victory sheet. */
async function finishDaily(page) {
  await page.waitForFunction(() => !!document.getElementById('btn-solo'), { timeout: 30000, polling: 100 });
  await page.evaluate(() => document.getElementById('btn-solo').click());
  await page.waitForFunction(() => !!document.querySelector('#level-cards .level-card[data-level-id="daily"]'), { timeout: 30000, polling: 100 });
  await page.evaluate(() => document.querySelector('#level-cards .level-card[data-level-id="daily"]').click());
  await page.waitForFunction(() => window._game.lobby.selectedLevel && window._game.lobby.selectedLevel.id === 'daily', { timeout: 10000, polling: 100 });
  await clickId(page, 'btn-start-ride');
  await waitState(page, 'playing');
  await page.evaluate(() => {
    const g = window._game;
    // Take a few presents so the card has a presents line.
    const m = g.collectibleManager;
    if (m) for (const it of m._items.slice(0, 3)) if (!it.collected) { it.collected = true; m.collected++; }
    if (g.raceManager && m) g.raceManager.collectiblesCount = m.collected;
    g.bike.distanceTraveled = g.lobby.selectedLevel.distance - 0.5; g.bike.speed = 10;
  });
  await waitState(page, 'victory', 240000);
  await page.waitForFunction(() => {
    const b = document.getElementById('btn-daily-share-victory');
    return b && b.style.display !== 'none' && !!window._game._dailyStripText;
  }, { timeout: 20000, polling: 100 });
}

/** Record clipboard writes instead of needing the permission headless. */
const stubClipboard = (page) => page.evaluate(() => {
  window.__copied = [];
  const clip = navigator.clipboard || {};
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { ...clip, writeText: async (t) => { window.__copied.push(t); } } });
});
const shareLabel = (page) => page.evaluate(() => document.getElementById('btn-daily-share-victory').textContent.trim());
const pressShare = (page) => page.evaluate(() => document.getElementById('btn-daily-share-victory').click());
const sheetOpen = (page) => page.evaluate(() => !!document.getElementById('share-sheet').open);
const waitSheet = (page) => page.waitForFunction(() => !!document.getElementById('share-sheet').open, { timeout: 30000, polling: 100 });
const waitQr = (page) => page.waitForFunction(() => (document.getElementById('share-qr').value || '').includes('/share/?id='), { timeout: 60000, polling: 100 });
const sheetState = (page) => page.evaluate(() => {
  const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.style.display !== 'none' && e.getClientRects().length > 0; };
  return {
    qr: document.getElementById('share-qr').value,
    phone: vis('share-phone'),
    status: vis('share-status') ? document.getElementById('share-status').textContent : null,
    discord: vis('btn-share-discord') ? document.getElementById('btn-share-discord').textContent.trim() : null,
    qrSvg: !!document.querySelector('#share-qr svg'),
  };
});
const closeSheet = (page) => page.evaluate(() => document.getElementById('btn-share-done').click());

// ── 1. Steam: the card goes to the screenshot library ──────────────────────
{
  const page = await h.gamePage({ storage: STORAGE, userAgent: ELECTRON_UA, before: async (p) => { await installFakeSteam(p); await installFakeApi(p); } });
  const steam = fakeSteam(page);
  await finishDaily(page);
  await stubClipboard(page);
  const strip = await page.evaluate(() => window._game._dailyStripText);
  const model = await page.evaluate(() => { const m = window._game._resultCardModel(); return m && { caption: m.caption, badges: m.badges.length, stats: m.stats.map(s => s.kind), link: m.link }; });
  h.check(model && /^Tandemonium · Daily Ride · [A-Z][a-z]{2} \d{1,2} · \d+:\d\d/.test(model.caption), 'card model: caption is the strip headline', model);
  h.check(model && model.badges >= 1, 'card model: the badges this ride unlocked', model && model.badges);
  h.check(model && model.stats.includes('presents') && model.stats.includes('tokens'), 'card model: presents and Tandem Tokens', model && model.stats);
  h.check(model && /^https?:\/\/.+\?daily=\d{4}-\d\d-\d\d$/.test(model.link || ''), 'card model: the road link', model && model.link);

  await pressShare(page);
  await page.waitForFunction(() => window.__fakeSteam.state.screenshots.length >= 1, { timeout: 30000, polling: 100 });
  const shots = await steam.screenshots();
  const s = shots[0] || {};
  h.check(shots.length === 1, 'one saveScreenshot call', shots.length);
  h.check(s.isPng && s.pngWidth === 1920 && s.pngHeight === 1080 && s.width === 1920 && s.height === 1080, 'a 1920×1080 PNG', { w: s.pngWidth, h: s.pngHeight });
  h.check(s.pngBytes > 50000, 'the PNG is not empty', s.pngBytes);
  h.check(s.rgbBytes === 1920 * 1080 * 3, 'RGB pixels for WriteScreenshot (3 bytes a pixel)', s.rgbBytes);
  h.check(model && s.caption === model.caption, 'captioned with the strip headline', s.caption);
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('btn-daily-share-victory').textContent.trim()), { timeout: 10000, polling: 100 }, SAVED.source);
  h.check(SAVED.test(await shareLabel(page)), 'button says it is in the Steam screenshots', await shareLabel(page));
  if (OUT) {   // SMOKE_SHARE_OUT=<dir>: keep the card to look at
    const b64 = await page.evaluate(async () => {
      const { renderResultCard } = await import('./js/result-card.js');
      return (await renderResultCard(window._game._resultCardModel())).canvas.toDataURL('image/png').split(',')[1];
    });
    fs.writeFileSync(path.join(OUT, 'share-card-ingame.png'), Buffer.from(b64, 'base64'));
  }
  const copied1 = await page.evaluate(() => window.__copied.length);
  h.check(copied1 === 0, 'nothing copied to the clipboard on a Steam save', copied1);

  // Part 2 in Steam: the share sheet, beside the screenshot: the status line + the QR.
  await waitSheet(page);
  await waitQr(page);
  const st = await sheetState(page);
  h.check(st.qr === SHARE_URL && st.qrSvg && st.phone, 'Steam: the share sheet shows the QR to the phone page', st);
  h.check(st.status && SAVED.test(st.status), 'Steam: the sheet says the screenshot is saved', st.status);
  h.check(st.discord === null, 'Steam, not signed in: no Discord button', st.discord);
  await closeSheet(page);
  await page.waitForFunction(() => !document.getElementById('share-sheet').open, { timeout: 10000, polling: 100 });

  // A second press: says where it went again, no second screenshot, no second upload.
  await page.evaluate(() => { document.getElementById('btn-daily-share-victory').textContent = 'x'; });
  await pressShare(page);
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('btn-daily-share-victory').textContent.trim()), { timeout: 10000, polling: 100 }, SAVED.source);
  h.check((await steam.screenshots()).length === 1, 'a second press does not save twice', (await steam.screenshots()).length);
  await waitSheet(page);
  h.check(await page.evaluate(() => window.__api.shares.length) === 1, 'the card is uploaded once a ride', await page.evaluate(() => window.__api.shares.length));
  await closeSheet(page);
  await page.waitForFunction(() => !document.getElementById('share-sheet').open, { timeout: 10000, polling: 100 });

  // ── 2. Steam refuses: the clipboard, and the button says so ──────────────
  await steam.setScreenshotMode('fail');
  await page.evaluate(() => { window._game._shareSavedToSteam = false; });
  await pressShare(page);
  await page.waitForFunction(() => window.__copied.length >= 1, { timeout: 30000, polling: 100 });
  const copied = await page.evaluate(() => window.__copied.slice());
  h.check(copied[0] === strip, 'failed save: the strip is copied instead', copied[0] && copied[0].split('\n')[0]);
  await page.waitForFunction(() => /COPIED INSTEAD/.test(document.getElementById('btn-daily-share-victory').textContent), { timeout: 10000, polling: 100 });
  h.check(/COULDN'T SAVE TO STEAM · COPIED INSTEAD/.test(await shareLabel(page)), 'failed save: the button says so', await shareLabel(page));
  await page.close();
}

// ── 3. No Steam, a guest: the clipboard, as before; no sheet ──────────────
{
  const page = await h.gamePage({ storage: STORAGE, before: (p) => installFakeApi(p) });
  await finishDaily(page);
  await stubClipboard(page);
  const strip = await page.evaluate(() => window._game._dailyStripText);
  h.check(await page.evaluate(() => !window.steam), 'browser: no Steam bridge');
  await pressShare(page);
  await page.waitForFunction(() => window.__copied.length >= 1, { timeout: 30000, polling: 100 });
  const copied = await page.evaluate(() => window.__copied.slice());
  h.check(copied.length === 1 && copied[0] === strip, 'browser: the strip is copied', copied[0] && copied[0].split('\n')[0]);
  await page.waitForFunction(() => document.getElementById('btn-daily-share-victory').textContent.trim() === 'COPIED', { timeout: 10000, polling: 100 });
  h.check(true, 'browser: the button says COPIED');
  h.check(!(await sheetOpen(page)), 'browser guest: no share sheet (no Discord option)');
  h.check(await page.evaluate(() => window.__api.shares.length === 0 && window.__api.discordPosts.length === 0), 'browser guest: nothing uploaded or posted');
  await page.close();
}

// ── 4. TV: the QR to the phone ────────────────────────────────────────────
let uploadedHead = null;
{
  const page = await h.gamePage({ storage: STORAGE, query: '?tv=1', viewport: { width: 1920, height: 1080 }, before: (p) => installFakeApi(p) });
  h.check(await page.evaluate(() => window.__tandemoniumTV === true), 'TV mode');
  await finishDaily(page);
  await stubClipboard(page);
  await pressShare(page);
  await waitSheet(page);
  await waitQr(page);
  const st = await sheetState(page);
  h.check(st.qr === SHARE_URL && st.qrSvg && st.phone, 'TV: the share sheet shows the QR for the share URL', st.qr);
  h.check(st.status === null, 'TV: nothing done before the sheet (no copy line)', st.status);
  const up = await page.evaluate(() => window.__api.shares[0]);
  uploadedHead = up && up.head;
  h.check(up && up.contentType === 'image/jpeg' && up.head.startsWith('/9j/') && up.bytes > 20000 && up.bytes < 1000000, 'TV: the card is uploaded as a JPEG under 1 MB', up && { type: up.contentType, bytes: up.bytes });
  h.check(up && /^Tandemonium · Daily Ride/.test(up.caption) && /\?daily=\d{4}-\d\d-\d\d$/.test(up.link || '') && /^\d{4}-\d\d-\d\d$/.test(up.dayKey || '') && up.deviceId, 'TV: with its caption, road link, day and device', up && { caption: up.caption, link: up.link, dayKey: up.dayKey });
  h.check(await page.evaluate(() => window.__copied.length) === 0, 'TV: nothing copied');
  const focused = await page.evaluate(() => { const f = window._game._overlayFocus; const it = f.focusedEl || f.items[f.index]; return it ? it.id : null; });
  h.check(focused === 'btn-share-done', 'TV: the pad is on the sheet (DONE)', focused);
  if (OUT) await page.screenshot({ path: path.join(OUT, 'share2-tv-qr.png') });
  await closeSheet(page);
  await page.waitForFunction(() => !document.getElementById('share-sheet').open, { timeout: 10000, polling: 100 });
  const back = await page.evaluate(() => { const f = window._game._overlayFocus; const it = f.focusedEl || f.items[f.index]; return it ? it.id : null; });
  h.check(back === 'btn-daily-share-victory', 'TV: closing the sheet puts the pad back on SHARE RESULT', back);
  await page.close();
}

// ── 5. The phone page ─────────────────────────────────────────────────────
{
  const page = await h.browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // The card the TV uploaded is not kept here; any JPEG does: draw one.
  const jpeg = await (async () => {
    const p2 = await h.browser.newPage();
    await p2.goto(h.origin + '/share/index.html?id=none', { waitUntil: 'domcontentloaded' });
    const b64 = await p2.evaluate(async () => {
      const { buildResultCard, renderResultCard } = await import('/js/result-card.js');
      const m = buildResultCard({ levelName: 'Daily Ride', levelIcon: '📅', isDaily: true, dayKey: '2026-11-07', mode: 'solo', timeMs: 108000, medal: 'bronze', collectibles: 3, collectiblesTotal: 8, tokensEarned: 42, badges: [{ icon: '🏁', name: 'First Finish' }], link: 'https://tandemonium.housetandem.com/?daily=2026-11-07' });
      const card = await renderResultCard(m);
      return card.canvas.toDataURL('image/jpeg', 0.86).split(',')[1];
    });
    await p2.close();
    return Buffer.from(b64, 'base64');
  })();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (u.includes('/share/' + SHARE_ID + '/image')) return req.respond({ status: 200, contentType: 'image/jpeg', headers: cors, body: jpeg });
    if (u.endsWith('/share/' + SHARE_ID)) return req.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ id: SHARE_ID, caption: 'Tandemonium · Daily Ride · Nov 7 · 1:48 · 🥉', link: 'https://tandemonium.housetandem.com/?daily=2026-11-07', dayKey: '2026-11-07', imageUrl: 'https://tandemonium-api.pete-872.workers.dev/share/' + SHARE_ID + '/image' }) });
    if (u.startsWith(h.origin)) return req.continue();
    return req.abort();
  });
  await page.evaluateOnNewDocument(() => {
    window.__shared = [];
    navigator.canShare = (d) => !!(d && d.files && d.files.length);
    navigator.share = async (d) => { window.__shared.push({ files: (d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })), text: d.text || null }); };
  });
  await page.goto(h.origin + '/share/index.html?id=' + SHARE_ID, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const i = document.querySelector('#card img'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 20000, polling: 100 });
  const ph = await page.evaluate(() => ({ title: document.getElementById('title').textContent, road: document.getElementById('btn-road').href, roadShown: !document.getElementById('btn-road').hidden, w: document.querySelector('#card img').naturalWidth }));
  h.check(ph.title === 'Daily Ride · Nov 7 · 1:48 · 🥉' && ph.w === 1920, 'phone page: the card and its headline', ph);
  h.check(ph.roadShown && ph.road === 'https://tandemonium.housetandem.com/?daily=2026-11-07', 'phone page: the road link', ph.road);
  await page.waitForFunction(() => document.getElementById('btn-save').href.startsWith('blob:'), { timeout: 20000, polling: 100 });
  if (OUT) await page.screenshot({ path: path.join(OUT, 'share2-phone-page.png'), fullPage: true });
  await page.evaluate(() => document.getElementById('btn-share').click());
  await page.waitForFunction(() => window.__shared.length >= 1, { timeout: 10000, polling: 100 });
  const sh = await page.evaluate(() => window.__shared[0]);
  h.check(sh.files.length === 1 && sh.files[0].type === 'image/jpeg' && sh.files[0].size === jpeg.length, 'phone page: Share hands the card file to the share sheet', sh.files);
  h.check(/Daily Ride/.test(sh.text) && /\?daily=2026-11-07/.test(sh.text), 'phone page: with the caption and road link', sh.text);

  // An expired / unknown share: the friendly page.
  await page.goto(h.origin + '/share/index.html?id=ZZZZZZZZZZZZ', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('gone').hidden, { timeout: 10000, polling: 100 });
  h.check(true, 'phone page: an expired share says so');
  await page.close();
}

// ── 6. Signed in with Discord: POST TO DISCORD, once ──────────────────────
{
  const page = await h.gamePage({ storage: { ...STORAGE, ...signedIn() }, before: (p) => installFakeApi(p) });
  await finishDaily(page);
  await stubClipboard(page);
  await pressShare(page);
  await page.waitForFunction(() => window.__copied.length >= 1, { timeout: 30000, polling: 100 });
  await waitSheet(page);
  await page.waitForFunction(() => document.getElementById('btn-share-discord').style.display !== 'none', { timeout: 10000, polling: 100 });
  let st = await sheetState(page);
  h.check(st.discord === 'POST TO DISCORD', 'Discord: the sheet offers POST TO DISCORD', st.discord);
  h.check(st.status === 'Copied the result · paste it anywhere', 'desktop: copied first, and the sheet says so', st.status);
  h.check(await page.evaluate(() => window.__api.discordPosts.length) === 0, 'Discord: nothing posted until pressed (Settings option off)');
  await page.evaluate(() => document.getElementById('btn-share-discord').click());
  await page.waitForFunction(() => /POSTED/.test(document.getElementById('btn-share-discord').textContent), { timeout: 60000, polling: 100 });
  const posts = await page.evaluate(() => window.__api.discordPosts);
  h.check(posts.length === 1 && /^Bearer .+\..+\./.test(posts[0].auth || '') && posts[0].body.id === SHARE_ID, 'Discord: POST /share/discord with the session and the share id', posts);
  st = await sheetState(page);
  h.check(st.discord === 'POSTED TO #daily-ride ✓' && await page.evaluate(() => document.getElementById('btn-share-discord').hasAttribute('disabled')), 'Discord: the button says POSTED and is done', st.discord);
  await page.evaluate(() => document.getElementById('btn-share-discord').click());
  h.check(await page.evaluate(() => window.__api.discordPosts.length) === 1, 'Discord: one post a ride');
  if (OUT) await page.screenshot({ path: path.join(OUT, 'share2-discord-sheet.png') });
  await page.close();
}

// ── 7. The Settings option: a Daily Ride finish posts by itself ───────────
{
  const page = await h.gamePage({ storage: { ...STORAGE, ...signedIn() }, before: (p) => installFakeApi(p) });
  // Settings: On (default Off), with the sign-in note gone.
  await page.evaluate(() => window._game._updateOptionsDiscordUI());
  await page.waitForFunction(() => !document.getElementById('opt-discord-on').hasAttribute('disabled'), { timeout: 10000, polling: 100 });
  h.check(await page.evaluate(() => document.getElementById('opt-discord-off').classList.contains('active')), 'Settings: Post to Discord is Off by default');
  await page.evaluate(() => document.getElementById('opt-discord-on').click());
  h.check(await page.evaluate(() => localStorage.getItem('tandemonium_share_discord') === 'on' && document.getElementById('opt-discord-on').classList.contains('active')), 'Settings: On is kept');
  await finishDaily(page);
  await page.waitForFunction(() => window.__api.discordPosts.length >= 1, { timeout: 60000, polling: 100 });
  h.check(true, 'auto-post: the finish posted to Discord without SHARE RESULT');
  h.check(await page.evaluate(() => window.__api.shares.length === 1 && window._game._discordPostState === 'posted'), 'auto-post: one upload, posted');
  await page.close();
}

// ── 8. No webhook on the Worker: no Discord anywhere ──────────────────────
{
  const page = await h.gamePage({ storage: { ...STORAGE, ...signedIn(), tandemonium_share_discord: 'on' }, query: '?tv=1', viewport: { width: 1920, height: 1080 }, before: (p) => installFakeApi(p, { discord: false }) });
  await page.evaluate(() => window._game._updateOptionsDiscordUI());
  await page.waitForFunction(() => /not available/.test(document.getElementById('opt-discord-note').textContent), { timeout: 10000, polling: 100 });
  h.check(await page.evaluate(() => document.getElementById('opt-discord-on').hasAttribute('disabled')), 'no webhook: Settings On is disabled and says not available');
  await finishDaily(page);
  await pressShare(page);
  await waitSheet(page);
  await waitQr(page);
  const st = await sheetState(page);
  h.check(st.discord === null && st.qr === SHARE_URL, 'no webhook: the sheet has the QR and no Discord button', st);
  h.check(await page.evaluate(() => window.__api.discordPosts.length) === 0, 'no webhook: nothing posted, even with the option saved on');
  await page.close();
}

await h.finish();
