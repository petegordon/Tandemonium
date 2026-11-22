// The desktop package holds what the running game loads, and leaves out the rest
// (forge.config.js packagerConfig.ignore). Paths are from the app folder, starting with "/".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { packagerConfig } = require('../../forge.config.js');
const ignored = (p) => packagerConfig.ignore.some((rule) => rule.test(p));

test('local settings, the API source, docs and unit tests are left out of the desktop package', () => {
  for (const p of [
    '/.env', '/.env.local', '/.env.production', '/worker/.env', '/js/.env.local',
    '/worker', '/worker/leaderboard.js', '/worker/migrations/0024_public_ids.sql', '/worker/wrangler-api.toml',
    '/docs', '/docs/steam-input.md',
    '/test/unit', '/test/unit/economy.test.mjs',
    '/.github', '/.github/workflows/tests.yml', '/.claude/settings.local.json', '/.wrangler/state',
    '/scripts/smoke-lobby.mjs', '/steam/app_4482940.vdf', '/steam/builds/output/log.txt',
    '/tools/fit-viewer/index.html', '/tools/gamepad-test/main.js', '/renders/reel/a.mp4',
    '/README.md', '/ARCHITECTURE.md', '/tandemonium_controls_report_v2.docx',
    '/tandy-agent/main.js', '/test_multiplayer/test-multiplayer.js', '/peerjs-server/Dockerfile', '/backup-game/main.js', '/types/globals.d.ts',
  ]) assert.ok(ignored(p), p + ' should be left out');
});

test('what the game loads stays in the desktop package', () => {
  for (const p of [
    '/index.html', '/package.json',
    '/js', '/js/game.js', '/js/lobby/room-wait.js', '/js/environment.js', '/js/workers/gif.worker.js',
    '/shared', '/shared/ui/elements/uf-card.js', '/shared/identity/client.js',
    '/assets', '/assets/icon.png', '/css/shell.css', '/images/logo.png', '/tandem-3d/bike-presets.json',
    '/electron/main.js', '/electron/preload.js', '/electron/trust.js',
    '/remote/index.html', '/controller/index.html', '/share/index.html', '/migrate/index.html',
    '/test/index.html', '/test/input.html',
    '/node_modules/three/build/three.module.js', '/node_modules/steamworks-ffi-node/package.json',
    '/node_modules/koffi/README.md', '/node_modules/dotenv/lib/main.js',
  ]) assert.ok(!ignored(p), p + ' should be packaged');
});

test('every tracked top-level folder the rules leave out exists as named, and nothing the app loads sits in one', () => {
  // The folders named in the rules are real (a renamed folder would silently ship).
  for (const dir of ['worker', 'docs', 'test/unit', 'scripts', 'steam', '.github']) {
    assert.ok(fs.existsSync(path.join(ROOT, dir)), dir);
  }
  // The desktop app's own code names none of them as something to load.
  const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  for (const m of main.matchAll(/require\('(\.[^']+)'\)/g)) assert.ok(!ignored('/electron/' + m[1].replace(/^\.\//, '')), m[1]);
  for (const m of main.matchAll(/path\.join\(__dirname, '\.\.', '([^']+)'/g)) {
    // steam_appid.txt and steamworks_sdk are read from resources/ in a packaged app (extraResource).
    assert.ok(!ignored('/' + m[1]), m[1]);
  }
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const m of index.matchAll(/(?:src|href)="(?!https?:|data:|#|\/\/)([^"?#]+)/g)) assert.ok(!ignored('/' + m[1]), m[1]);
});
