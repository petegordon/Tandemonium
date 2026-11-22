// The staging build publishes pages and game assets only, and talks to staging only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublished, toStaging, STAGING_HOSTS } from '../../scripts/build-site.mjs';

test('pages and game assets are published; source, docs and secrets are not', () => {
  for (const f of ['index.html', 'tourist-lookup.html', 'achievements.json', 'js/game.js', 'js/remote/pad-protocol.js',
    'assets/a.png', 'tandem-3d/goose/g.glb', 'shared/ui/x.js', 'remote/index.html', 'share/index.html', 'dashboard/index.html', 'test/index.html']) {
    assert.equal(isPublished(f), true, f);
  }
  for (const f of ['package.json', 'package-lock.json', 'README.md', 'CNAME', 'wrangler-site.jsonc', 'docs/plan.md', 'worker/leaderboard.js',
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
