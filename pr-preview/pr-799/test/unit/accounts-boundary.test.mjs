// #783 · the account system (worker/accounts/) is shared by every House Tandem game, and is
// meant to move out of this repo one day. So it imports nothing from outside its folder, and
// names no game's tables: games register theirs (registerAccountTables).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../worker/accounts');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));

test('worker/accounts imports only from its own folder', () => {
  assert.ok(files.includes('identity.js') && files.includes('combine.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
      assert.match(m[1], /^\.\/[\w-]+\.js$/, `${f} imports ${m[1]}`);
    }
    assert.ok(!/\bimport\s*\(/.test(src), `${f} has a dynamic import`);
  }
});

test('combine and separate name no game table: games register theirs', async () => {
  const src = fs.readFileSync(path.join(DIR, 'combine.js'), 'utf8');
  for (const table of ['scores', 'score_contributions', 'user_achievements', 'daily_results', 'pairs', 'friends',
    'ride_seats', 'game_achievements', 'game_stats', 'game_playtime', 'discord_posts', 'sessions']) {
    assert.ok(!new RegExp('\\b(FROM|INTO|UPDATE|JOIN)\\s+' + table + '\\b', 'i').test(src), `combine.js names ${table}`);
  }
  const { accountTables, registerAccountTables } = await import('../../worker/accounts/combine.js');
  await import('../../worker/leaderboard.js');   // Tandemonium and the games module register here
  const names = new Set(accountTables().map((t) => t.table));
  for (const t of ['scores', 'user_achievements', 'daily_results', 'pairs', 'game_stats', 'game_playtime', 'sessions']) assert.ok(names.has(t), t);
  assert.throws(() => registerAccountTables([{ table: 'x; DROP TABLE users', user: 'user_id', login: 'login_id' }]));
});
