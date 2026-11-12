// #daily-ride-clips · the client side of POST GIF TO DISCORD: the GIF's size
// and frame plan (js/clip-gif.js) and the Worker calls (js/share-result.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { GIF_SECONDS, GIF_MAX_BYTES, GIF_STEPS, gifSize, frameTimes } from '../../js/clip-gif.js';
import { clipDiscordLabel, discordMemberState, postClipGifToDiscord, HOUSE_TANDEM_DISCORD_URL } from '../../js/share-result.js';
import { CLIP_GIF_MAX_BYTES } from '../../worker/share.js';

test('the GIF: 8 s, under the Worker limit, steps getting smaller', () => {
  assert.equal(GIF_SECONDS, 8);
  assert.ok(GIF_MAX_BYTES < CLIP_GIF_MAX_BYTES && CLIP_GIF_MAX_BYTES < 10_000_000);
  for (let i = 1; i < GIF_STEPS.length; i++) {
    const a = GIF_STEPS[i - 1], b = GIF_STEPS[i];
    assert.ok(b.long * b.long * b.fps * b.seconds < a.long * a.long * a.fps * a.seconds);
  }
});

test('gifSize: the long side, landscape or portrait, even, never bigger than the clip', () => {
  assert.deepEqual(gifSize(1280, 720, 480), { w: 480, h: 270 });
  assert.deepEqual(gifSize(720, 1280, 480), { w: 270, h: 480 });
  assert.deepEqual(gifSize(300, 200, 480), { w: 300, h: 200 });
  const s = gifSize(1179, 2556, 400);
  assert.equal(s.w % 2, 0); assert.equal(s.h % 2, 0);
});

test('frameTimes: the last 8 s at 12 fps; a short clip gives all it has', () => {
  const t = frameTimes(20, 8, 12);
  assert.equal(t.length, 96);
  assert.equal(t[0], 12);
  assert.ok(t[t.length - 1] < 20);
  const short = frameTimes(5, 8, 12);
  assert.equal(short[0], 0);
  assert.equal(short.length, 60);
});

test('the button words', () => {
  assert.equal(clipDiscordLabel('idle'), 'POST GIF TO DISCORD');
  assert.equal(clipDiscordLabel('making', 0.5), 'MAKING GIF… 50%');
  assert.equal(clipDiscordLabel('join'), 'JOIN THE HOUSE TANDEM DISCORD');
  assert.equal(clipDiscordLabel('signin'), 'SIGN IN WITH DISCORD TO POST');
  assert.equal(HOUSE_TANDEM_DISCORD_URL, 'https://housetandem.com/discord');
});

test('discordMemberState reads GET /me/discord', async () => {
  const answer = (body, status = 200) => async () => Response.json(body, { status });
  assert.equal(await discordMemberState(null), 'signin');
  assert.equal(await discordMemberState('t', { fetchFn: answer({ linked: true, member: true }) }), 'member');
  assert.equal(await discordMemberState('t', { fetchFn: answer({ linked: true, member: false }) }), 'join');
  assert.equal(await discordMemberState('t', { fetchFn: answer({ linked: false, member: null }) }), 'signin');
  assert.equal(await discordMemberState('t', { fetchFn: answer({ linked: true, member: null }) }), 'unknown');
  assert.equal(await discordMemberState('t', { fetchFn: answer({}, 401) }), 'signin');
  assert.equal(await discordMemberState('t', { fetchFn: async () => { throw new Error('offline'); } }), 'unknown');
});

test('postClipGifToDiscord sends the GIF and maps the answer to the button', async () => {
  const seen = [];
  const answer = (status, body = {}) => async (url, init) => { seen.push({ url, init }); return Response.json(body, { status }); };
  const blob = new Blob([new Uint8Array([0x47, 0x49, 0x46])], { type: 'image/gif' });
  let r = await postClipGifToDiscord({ blob, token: 't', caption: 'Tandemonium · Victoria Park' }, { apiBase: 'https://api.test', fetchFn: answer(200) });
  assert.deepEqual(r, { ok: true, state: 'posted', status: 200 });
  assert.equal(seen[0].url, 'https://api.test/share/discord/clip?caption=Tandemonium%20%C2%B7%20Victoria%20Park');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer t');
  assert.equal(seen[0].init.headers['Content-Type'], 'image/gif');
  assert.equal(seen[0].init.body, blob);
  assert.equal((await postClipGifToDiscord({ blob, token: 't' }, { fetchFn: answer(403, { code: 'not_member' }) })).state, 'join');
  assert.equal((await postClipGifToDiscord({ blob, token: 't' }, { fetchFn: answer(429, { code: 'clip_cap' }) })).state, 'cap');
  assert.equal((await postClipGifToDiscord({ blob, token: 't' }, { fetchFn: answer(403, { code: 'no_discord' }) })).state, 'signin');
  assert.equal((await postClipGifToDiscord({ blob, token: 't' }, { fetchFn: answer(502, { code: 'discord_failed' }) })).state, 'error');
});
