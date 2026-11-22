// The web build publishes pages and game assets only, staging talks to staging only, and media
// answers the byte ranges iPhones need.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPublished, toStaging, STAGING_HOSTS, headersFile, pagePolicy, pagePaths, inlineScriptHashes } from '../../scripts/build-site.mjs';
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

// ── content policy ──

const PAGE = '<html><head><script>var a = 1;</script><script type="importmap">{"imports":{}}</script><script src="js/x.js"></script></head></html>';
const directive = (policy, name) => policy.split('; ').find((d) => d.startsWith(name + ' ')) || '';

test('a page’s policy runs its own inline scripts by hash, and no others', () => {
  const hashes = inlineScriptHashes(PAGE);
  assert.equal(hashes.length, 2, 'the inline script and the import map; not the one with a src');
  assert.deepEqual(inlineScriptHashes(PAGE.replace(/\n/g, '\r\n')), hashes, 'the same on a Windows checkout');
  const script = directive(pagePolicy(PAGE, 'production'), 'script-src');
  for (const h of hashes) assert.ok(script.includes(h));
  assert.ok(!script.includes("'unsafe-inline'") && !script.includes("'unsafe-eval'"));
  assert.ok(!script.includes(inlineScriptHashes('<script>other()</script>')[0]));
  for (const cdn of ['https://cdn.jsdelivr.net', 'https://esm.sh', 'https://unpkg.com']) assert.ok(script.includes(cdn), cdn);
});

test('the policy connects to our servers and the services the game uses; staging names its own', () => {
  const prod = directive(pagePolicy(PAGE, 'production'), 'connect-src');
  for (const h of ['https://tandemonium-api.pete-872.workers.dev', 'wss://tandemonium-relay.pete-872.workers.dev', 'wss://tandemonium-remote.housetandem.com', 'https://*.googleapis.com', 'wss://0.peerjs.com']) {
    assert.ok(prod.split(' ').includes(h), h);
  }
  assert.ok(!prod.includes('*.workers.dev') && !/ https:( |$)/.test(prod), 'named hosts, not everything');
  const staging = directive(pagePolicy(PAGE, 'staging'), 'connect-src');
  assert.ok(staging.includes('https://api-staging.housetandem.com') && staging.includes('wss://relay-staging.housetandem.com'));
  for (const [from] of STAGING_HOSTS) assert.ok(!staging.split(' ').some((h) => h.endsWith('//' + from)), from);
});

test('only the Tourist lookup page may be framed by another site; plugins and foreign form targets are off', () => {
  const p = pagePolicy(PAGE, 'production');
  for (const d of ["frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) assert.ok(p.includes(d), d);
  assert.ok(!pagePolicy(PAGE, 'production', { framed: true }).includes('frame-ancestors'));
});

test('every address a page is served at carries its policy, within the host’s limits', () => {
  assert.deepEqual(pagePaths('index.html'), ['/', '/index.html']);
  assert.deepEqual(pagePaths('remote/index.html'), ['/remote/', '/remote', '/remote/index.html']);
  assert.deepEqual(pagePaths('tourist-lookup.html'), ['/tourist-lookup', '/tourist-lookup.html']);
  const pages = [{ file: 'index.html', html: PAGE }, { file: 'remote/index.html', html: '<script>r()</script>' }, { file: 'tourist-lookup.html', html: PAGE }];
  const h = headersFile('production', pages);
  const rules = h.split('\n').filter((l) => l.startsWith('/'));
  for (const p of ['/', '/index.html', '/remote/', '/remote', '/remote/index.html', '/tourist-lookup', '/tourist-lookup.html']) assert.ok(rules.includes(p), p);
  const after = (rule) => h.split('\n')[h.split('\n').indexOf(rule) + 1];
  assert.ok(after('/remote/').includes(inlineScriptHashes('<script>r()</script>')[0]), 'its own scripts');
  assert.ok(!after('/remote/').includes(inlineScriptHashes(PAGE)[0]), 'not another page’s');
  assert.ok(after('/').includes("frame-ancestors 'self'") && !after('/tourist-lookup').includes('frame-ancestors'));
  assert.ok(!/^\/\*\n(?: {2}.*\n)* {2}Content-Security-Policy/m.test(h), 'no one policy for every path: it would be joined to each page’s own');
});

test('the published pages: every one has a policy, none has an inline event handler, and the header file fits the host’s limits', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const files = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 1 << 26 }).split(/\r?\n/).filter(Boolean)
    .filter((f) => isPublished(f) && f.endsWith('.html')).sort();
  assert.ok(files.length > 10);
  const pages = files.map((file) => ({ file, html: fs.readFileSync(path.join(root, file), 'utf8') }));
  const lines = headersFile('production', pages).split('\n');
  assert.ok(lines.every((l) => l.length <= 2000), 'no line over 2000 characters');
  assert.ok(lines.filter((l) => l.startsWith('/')).length <= 100, 'no more than 100 rules');
  for (const { file, html } of pages) {
    const outside = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    assert.ok(!/\son[a-z]+\s*=\s*["']/.test(outside), file + ': no inline event handlers (the policy would not run them)');
    for (const p of pagePaths(file)) {
      const i = lines.indexOf(p);
      assert.ok(i >= 0, p);
      for (const hash of inlineScriptHashes(html)) assert.ok(lines[i + 1].includes(hash), p + ' ' + hash);
    }
  }
});
