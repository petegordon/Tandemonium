// The web build publishes pages and game assets only, staging talks to staging only, and media
// answers the byte ranges iPhones need.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublished, toStaging, STAGING_HOSTS, headersFile } from '../../scripts/build-site.mjs';
import { parseRange, serveMedia } from '../../worker/site-worker.js';

test('pages and game assets are published; source, docs and secrets are not', () => {
  for (const f of ['index.html', 'tourist-lookup.html', 'achievements.json', 'js/game.js', 'js/remote/pad-protocol.js',
    'assets/a.png', 'tandem-3d/goose/g.glb', 'shared/ui/x.js', 'remote/index.html', 'share/index.html', 'dashboard/index.html', 'test/index.html']) {
    assert.equal(isPublished(f), true, f);
  }
  for (const f of ['package.json', 'package-lock.json', 'README.md', 'CNAME', 'wrangler-site.jsonc', 'docs/plan.md', 'worker/leaderboard.js', 'worker/site-worker.js',
    'worker/wrangler.toml', 'electron/main.js', 'scripts/build-site.mjs', 'steam/a.js', 'steamworks_sdk/b.h', 'tandy-agent/x.js', 'backup-game/index.html',
    '.github/workflows/deploy.yml', '.claude/x', 'test/unit/a.test.mjs', 'shared/ui/README.md', 'js/.env', 'js/x.js.map']) {
    assert.equal(isPublished(f), false, f);
  }
});

test('every production address becomes its staging address', () => {
  for (const [from, to] of STAGING_HOSTS) {
    assert.equal(toStaging(`x https://${from}/y`), `x https://${to}/y`);
  }
  const out = toStaging('https://tandemonium-api.pete-872.workers.dev https://api.housetandem.com wss://tandemonium-relay.pete-872.workers.dev wss://tandemonium-remote.housetandem.com https://usersfirst-store.pete-872.workers.dev https://tandemonium.housetandem.com');
  for (const [from] of STAGING_HOSTS) assert.ok(!out.includes(from), from);
  assert.equal(toStaging(toStaging('https://tandemonium.housetandem.com')), 'https://tandemonium-staging.housetandem.com', 'stable if applied twice');
});

test('headers: readable by other sites, only the Tourist lookup page can be framed, staging not indexed', () => {
  for (const env of ['staging', 'production']) {
    const h = headersFile(env);
    assert.ok(h.includes('Access-Control-Allow-Origin: *'));
    assert.ok(h.includes('X-Frame-Options: SAMEORIGIN'));
    assert.ok(/\/tourist-lookup\*\n {2}! X-Frame-Options/.test(h));
  }
  assert.ok(headersFile('staging').includes('X-Robots-Tag: noindex'));
  assert.ok(!headersFile('production').includes('X-Robots-Tag'));
});

test('byte ranges', () => {
  assert.deepEqual(parseRange('bytes=0-1', 10), { start: 0, end: 1 });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=8-99', 10), { start: 8, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), 'bad');
  assert.equal(parseRange('bytes=5-2', 10), 'bad');
  assert.equal(parseRange('bytes=-0', 10), 'bad');
  for (const h of [null, '', 'items=0-1', 'bytes=0-1,3-4', 'bytes=-']) assert.equal(parseRange(h, 10), null, String(h));
});

test('media answers a range with exactly those bytes', async () => {
  const data = Uint8Array.from({ length: 10 }, (_, i) => i);
  const assets = { fetch: async () => new Response(data, { status: 200, headers: { 'Content-Type': 'video/mp4', ETag: '"a"', 'Access-Control-Allow-Origin': '*' } }) };
  const ask = (headers, method = 'GET') => serveMedia(new Request('https://x.test/v.mp4', { method, headers }), assets);
  const r = await ask({ Range: 'bytes=2-4' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), 'bytes 2-4/10');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [2, 3, 4]);
  assert.equal((await ask({ Range: 'bytes=20-' })).status, 416);
  const whole = await ask({});
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('Accept-Ranges'), 'bytes');
  assert.equal((await whole.arrayBuffer()).byteLength, 10);
  assert.equal((await ask({ Range: 'bytes=0-1', 'If-Range': '"old"' })).status, 200);
});
