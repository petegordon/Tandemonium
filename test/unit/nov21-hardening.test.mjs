// Text and paths that arrive from outside the game are kept plain:
//  - the desktop build serves only its own files (electron/trust.js appFilePath)
//  - words a room partner sends stay words (js/remote-safe.js cleanText / cleanPlace)
//  - the dashboard page shows API values as text
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanText, cleanPlace } from '../../js/remote-safe.js';
import { planExplore, planRoute, isValidPoint } from '../../js/tourist-route.js';

const require = createRequire(import.meta.url);
const T = require('../../electron/trust.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

test('the desktop build serves its own files and nothing outside them', () => {
  const p = (s) => T.appFilePath(root, new URL('tandemonium://app' + s).pathname);
  assert.equal(p('/'), path.join(root, 'index.html'));
  assert.equal(p('/js/game.js'), path.join(root, 'js', 'game.js'));
  assert.equal(p('/tandem-3d/a%20b.glb'), path.join(root, 'tandem-3d', 'a b.glb'), 'a space in a name is fine');
  for (const bad of [
    '/%252e%252e/%252e%252e/secret.txt',          // encoded twice
    '/%252e%252e%252f%252e%252e%252fsecret.txt',
    '/js/..%5c..%5c..%5csecret.txt',
    '/js/%5c..%5csecret.txt',
    '/C:/Windows/win.ini',
    '/js/a%00.js',
    '/%',
  ]) assert.equal(p(bad), null, bad);
  // (a URL's own ".." is resolved by the URL parser and stays inside the app)
  assert.equal(p('/%2e%2e/%2e%2e/index.html'), path.join(root, 'index.html'));
  // Raw pathnames too (not every caller parses a URL first).
  for (const bad of ['/../secret.txt', '/js/../../secret.txt', '..', '\\\\server\\share\\x', '/%2e%2e/x', 'C:\\x']) {
    const got = T.appFilePath(root, bad);
    assert.ok(got === null || got.startsWith(root + path.sep), bad + ' -> ' + got);
  }
  // What is served is addressed without a second decoding.
  const odd = path.join(root, 'js', 'a b.js');
  assert.equal(fileURLToPath(pathToFileURL(odd).href), odd);
});

test('the desktop build reads files through the checked path only', () => {
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  assert.ok(main.includes('appFilePath(rootDir, url.pathname)'));
  assert.ok(!/net\.fetch\('file:\/\/'/.test(main), 'no hand-built file:// address');
});

test('words from a partner stay words', () => {
  const mark = '<img src=x onerror="go()">';
  assert.equal(cleanText(mark), 'img src=x onerror=go()');
  assert.equal(cleanText('Grandma\u2019s & St. John\'s, Caf\u00e9'), 'Grandma\u2019s & St. John\'s, Caf\u00e9', 'apostrophes and accents stay');
  assert.equal(cleanText('x'.repeat(500)).length, 120);
  assert.equal(cleanText('a\u0000b\nc`d'), 'abcd');

  const from = cleanPlace({ lat: 40.1, lon: -83.2, label: mark + ', Ohio', extra: { deep: mark }, __proto__: { polluted: 1 } });
  assert.deepEqual(Object.keys(from).sort(), ['label', 'lat', 'lon']);
  assert.ok(isValidPoint(from));
  assert.equal(cleanPlace(null), null);
  assert.equal(cleanPlace(undefined), null);
  assert.equal(cleanPlace('text'), false);
  assert.equal(isValidPoint(cleanPlace('text')), false);

  for (const plan of [planExplore(from), planRoute(from, cleanPlace({ lat: 40.2, lon: -83.1, label: mark }))]) {
    assert.ok(!/[<>"]/.test(plan.headline), plan.headline);
  }
});

test('the ride strip and the room write partner words as text', () => {
  const game = read('js', 'game.js');
  const fn = game.slice(game.indexOf('  _updateTouristGoal() {'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.ok(body.includes('replaceChildren('), 'built from nodes');
  assert.ok(!body.includes('innerHTML'), 'no markup from the headline');

  const lobby = read('js', 'lobby.js');
  const at = lobby.indexOf('profile.type === ROOM_MSG.TOURIST_PLAN');
  const block = lobby.slice(at, lobby.indexOf('planRoute(profile.from', at));
  assert.ok(block.includes("this._roomRole === 'captain'"), 'a captain takes no plan');
  assert.ok(block.includes('cleanPlace(profile.from)') && block.includes('cleanPlace(profile.to)') && block.includes('cleanText(profile.title'));
});

test('a guest key is not a device id', async () => {
  const { cleanDeviceId } = await import('../../worker/accounts/identity.js');
  const { guestKey, isGuestKey } = await import('../../worker/room-proof.js');
  const key = await guestKey('secret', 'device-1234');
  assert.ok(isGuestKey(key));
  assert.equal(cleanDeviceId(key), null);
  assert.equal(cleanDeviceId('device-1234'), 'device-1234');
  assert.equal(cleanDeviceId('0b5c9c2e-7f4e-4f0a-9d53-1c2a3b4c5d6e'), '0b5c9c2e-7f4e-4f0a-9d53-1c2a3b4c5d6e');
});

test('the store asks Stripe only about a Checkout Session id', async () => {
  const store = (await import('../../worker/store.js')).default;
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => { asked.push(String(u)); return new Response(JSON.stringify({ payment_status: 'paid', metadata: { game_id: 'g' } }), { status: 200 }); };
  try {
    const get = (id) => store.fetch(new Request('https://store.test/checkout/status?session_id=' + encodeURIComponent(id)), { CORS_ORIGINS: 'https://tandemonium.housetandem.com', STRIPE_SECRET_KEY: 'k' });
    for (const bad of ['../../customers/cus_1', 'cs_test_a/../../customers/cus_1', 'cs_test_a?expand[]=customer', 'cs_live_', 'cus_123', 'cs_test_a%2f..']) {
      assert.equal((await get(bad)).status, 400, bad);
    }
    assert.equal(asked.length, 0, 'nothing was asked of Stripe');
    assert.equal((await get('cs_test_a1B2c3')).status, 200);
    assert.deepEqual(asked, ['https://api.stripe.com/v1/checkout/sessions/cs_test_a1B2c3']);
  } finally { globalThis.fetch = real; }
});

test('the board gives at most 200 rows, and a sign-in carries only a confirmed address', () => {
  const api = read('worker', 'leaderboard.js');
  assert.ok(api.includes('Number.isFinite(asked) ? Math.max(1, Math.min(asked, 200)) : 20'));
  assert.ok(!api.includes("Math.min(parseInt(url.searchParams.get('limit')"));
  assert.ok(/payload\.email_verified === true[^\n]*\? payload\.email : null/.test(api));
  for (const [asked, want] of [[-1, 1], [0, 1], [5, 5], [9999, 200], [NaN, 20]]) {
    assert.equal(Number.isFinite(asked) ? Math.max(1, Math.min(asked, 200)) : 20, want);
  }
});

test('the dashboard shows what the API returns as text', () => {
  const html = read('dashboard', 'dashboard.js');
  const src = html.slice(html.indexOf('function plain('));
  const plain = new Function(src.slice(0, src.indexOf('\n}\n') + 2) + '\nreturn plain;')();
  const out = plain({ controllers: [{ controller_name: '<img src=x onerror=alert(1)>', rides: 3 }], 'k"<': 'a\'b`c', n: null, ok: true });
  assert.equal(out.controllers[0].controller_name, 'img src=x onerror=alert(1)');
  assert.equal(out.controllers[0].rides, 3);
  assert.deepEqual(Object.keys(out), ['controllers', 'k', 'n', 'ok']);
  assert.equal(out.k, 'abc');
  // Every read of the API goes through it.
  const reads = [...html.matchAll(/await r\.json\(\)/g)].length;
  const cleaned = [...html.matchAll(/plain\(await r\.json\(\)\)/g)].length;
  assert.equal(reads - cleaned, 1, 'only the sign-in answer (a token, never drawn) is read as it is');
});
