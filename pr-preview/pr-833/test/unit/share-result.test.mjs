// #657 parts 2 + 3 · the client side of sharing a result (js/share-result.js):
// what SHARE RESULT does on each device, who may post to the House Tandem
// Discord, the Settings option, and the Worker calls (faked fetch).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHARE_API_BASE, SHARE_SITE_URL, DISCORD_AUTOPOST_KEY,
  shareSurface, discordPostable, getDiscordAutoPost, setDiscordAutoPost, sharePageUrl,
  discordButtonLabel, bytesToBase64, uploadCard, postCardToDiscord, fetchShareConfig, _resetShareConfig,
} from '../../js/share-result.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the API and site match js/config.js', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
  assert.equal(cfg.match(/export const API_BASE = '([^']+)'/)[1], SHARE_API_BASE);
  assert.equal(cfg.match(/export const SITE_URL = '([^']+)'/)[1], SHARE_SITE_URL);
});

test('shareSurface: TV → sheet with QR; Steam → screenshot + sheet with QR; desktop → copy; phone → its share sheet', () => {
  const tv = shareSurface({ tv: true, clipboard: false });
  assert.deepEqual({ sheet: tv.sheet, qr: tv.qr, copy: tv.copy, native: tv.nativeShare }, { sheet: true, qr: true, copy: false, native: false });
  const tvWithClip = shareSurface({ tv: true, clipboard: true });
  assert.ok(tvWithClip.sheet && !tvWithClip.copy, 'a TV never copies: nowhere to paste');

  const steam = shareSurface({ steam: true });
  assert.deepEqual({ sheet: steam.sheet, qr: steam.qr, steam: steam.steam, copy: steam.copy }, { sheet: true, qr: true, steam: true, copy: false });

  const desk = shareSurface({ clipboard: true });
  assert.deepEqual({ sheet: desk.sheet, copy: desk.copy }, { sheet: false, copy: true }, 'desktop browser: copy, as before');
  const deskNoClip = shareSurface({ clipboard: false });
  assert.ok(deskNoClip.sheet && deskNoClip.qr && !deskNoClip.copy);

  const phone = shareSurface({ mobile: true });
  assert.deepEqual({ sheet: phone.sheet, native: phone.nativeShare, qr: phone.qr }, { sheet: false, native: true, qr: false });

  // The Discord post on offer opens the sheet everywhere; a phone gets no QR in it.
  assert.ok(shareSurface({ clipboard: true, discord: true }).sheet);
  const phoneDiscord = shareSurface({ mobile: true, discord: true });
  assert.ok(phoneDiscord.sheet && phoneDiscord.discord && !phoneDiscord.qr && phoneDiscord.nativeShare);
});

test('discordPostable: Daily Ride, signed in with Discord linked, Worker set up', () => {
  const auth = (loggedIn, discord) => ({ isLoggedIn: () => loggedIn, hasIdentity: (p) => p === 'discord' && discord });
  assert.equal(discordPostable({ isDaily: true, auth: auth(true, true), configured: true }), true);
  assert.equal(discordPostable({ isDaily: false, auth: auth(true, true), configured: true }), false, 'Daily Ride only');
  assert.equal(discordPostable({ isDaily: true, auth: auth(false, false), configured: true }), false, 'guests cannot');
  assert.equal(discordPostable({ isDaily: true, auth: auth(true, false), configured: true }), false, 'Steam-only sign-in cannot');
  assert.equal(discordPostable({ isDaily: true, auth: auth(true, true), configured: false }), false, 'no webhook, no button');
  assert.equal(discordPostable({ isDaily: true, auth: null, configured: true }), false);
});

test('the Settings option is off by default and remembered', () => {
  const m = new Map();
  const store = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
  assert.equal(getDiscordAutoPost(store), false);
  setDiscordAutoPost(store, true);
  assert.equal(m.get(DISCORD_AUTOPOST_KEY), 'on');
  assert.equal(getDiscordAutoPost(store), true);
  setDiscordAutoPost(store, false);
  assert.equal(getDiscordAutoPost(store), false);
  assert.equal(getDiscordAutoPost({ getItem() { throw new Error('blocked'); } }), false);
  assert.equal(getDiscordAutoPost(null), false);
});

test('labels and links', () => {
  assert.equal(sharePageUrl('Ab3dEf6hJk9m'), 'https://tandemonium.housetandem.com/share/?id=Ab3dEf6hJk9m');
  assert.equal(discordButtonLabel('idle'), 'POST TO DISCORD');
  assert.equal(discordButtonLabel('posted'), 'POSTED TO #daily-ride ✓');
  assert.equal(discordButtonLabel('already'), 'ALREADY POSTED TODAY');
  assert.equal(bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 'iVBORw==');
  const big = new Uint8Array(100000).fill(7);
  assert.equal(Buffer.from(bytesToBase64(big), 'base64').length, 100000);
});

test('uploadCard posts base64 + metadata and returns the share; errors carry the code', async () => {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Response.json({ id: 'Ab3dEf6hJk9m', url: 'u' }, { status: 201 }); };
  const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });
  const out = await uploadCard({ blob, caption: 'c', link: 'l', dayKey: '2026-11-07', deviceId: 'd' }, { apiBase: 'https://api.test', fetchFn });
  assert.equal(out.id, 'Ab3dEf6hJk9m');
  assert.equal(calls[0].url, 'https://api.test/share');
  assert.deepEqual(calls[0].body, { image: '/9j/4A==', contentType: 'image/jpeg', caption: 'c', link: 'l', dayKey: '2026-11-07', deviceId: 'd' });

  const fail = async () => Response.json({ error: 'Too many', code: 'daily_cap' }, { status: 429 });
  await assert.rejects(uploadCard({ blob }, { fetchFn: fail }), (e) => e.status === 429 && e.code === 'daily_cap');
});

test('postCardToDiscord maps the Worker answer to the button state', async () => {
  const seen = [];
  const answer = (status) => async (url, init) => { seen.push({ url, auth: init.headers.Authorization, body: init.body }); return Response.json({}, { status }); };
  assert.deepEqual(await postCardToDiscord({ id: 'x', token: 't' }, { apiBase: 'https://api.test', fetchFn: answer(200) }), { ok: true, state: 'posted', status: 200 });
  assert.equal(seen[0].url, 'https://api.test/share/discord');
  assert.equal(seen[0].auth, 'Bearer t');
  assert.equal(JSON.parse(seen[0].body).id, 'x');
  assert.equal((await postCardToDiscord({ id: 'x', token: 't' }, { fetchFn: answer(409) })).state, 'already');
  assert.equal((await postCardToDiscord({ id: 'x', token: 't' }, { fetchFn: answer(403) })).state, 'signin');
  assert.equal((await postCardToDiscord({ id: 'x', token: 't' }, { fetchFn: answer(503) })).state, 'error');
  assert.equal((await postCardToDiscord({ id: 'x', token: 't' }, { fetchFn: async () => { throw new Error('offline'); } })).state, 'error');
});

test('fetchShareConfig: asked once a session; a failure reads as off and is asked again', async () => {
  _resetShareConfig();
  let n = 0;
  const on = async () => { n++; return Response.json({ discord: true }); };
  assert.deepEqual(await fetchShareConfig({ fetchFn: on }), { discord: true });
  assert.deepEqual(await fetchShareConfig({ fetchFn: on }), { discord: true });
  assert.equal(n, 1);
  _resetShareConfig();
  assert.deepEqual(await fetchShareConfig({ fetchFn: async () => { throw new Error('offline'); } }), { discord: false });
  assert.deepEqual(await fetchShareConfig({ fetchFn: on }), { discord: true }, 'retried after the failure');
  _resetShareConfig();
});
