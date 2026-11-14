// Steamworks achievement CSV sync (scripts/lib/steam-achievement-csv.cjs): parse, plan, write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCsv, toCsv, readSteam, planSync } = require('../../scripts/lib/steam-achievement-csv.cjs');

const DEFS = '﻿"api_name (required)",setid,"permission (one of Client, GameServer)",spoiler (true or false),archived (true or false),progress_stat_name,"progress_stat_min (number)","progress_stat_max (number)"\r\n'
  + 'FIRST_500M,,Client,false,false,,0,0\r\n'
  + 'SO_CLOSE,,Client,true,false,,0,0\r\n'
  + 'OLD_ONE,,Client,false,false,,0,0\r\n';
const LOC = '﻿api_name (required),field (name or description),english\r\n'
  + 'FIRST_500M,name,First 500m\r\n'
  + 'FIRST_500M,description,"Ride 500 meters total "\r\n'
  + 'SO_CLOSE,name,So Close\r\n'
  + 'SO_CLOSE,description,"Crash within 10 m of the finish"\r\n'
  + 'OLD_ONE,name,Old\r\n'
  + 'OLD_ONE,description,"Gone, now"\r\n';

const code = [
  { apiName: 'FIRST_500M', displayName: 'First 500m', description: 'Ride 500 meters total', hidden: false },
  { apiName: 'SO_CLOSE', displayName: 'So Close', description: 'Crash after the last checkpoint', hidden: true },
  { apiName: 'NEW_ONE', displayName: 'Brand "New"', description: 'Do a thing, twice', hidden: true },
];

test('parseCsv: BOM, quotes, commas, trailing spaces, CRLF', () => {
  const rows = parseCsv(LOC);
  assert.equal(rows[0][0], 'api_name (required)');
  assert.deepEqual(rows[2], ['FIRST_500M', 'description', 'Ride 500 meters total ']);
  assert.deepEqual(rows[6], ['OLD_ONE', 'description', 'Gone, now']);
  assert.equal(rows.length, 7);
});

test('toCsv round-trips through parseCsv', () => {
  const rows = [['a', 'b, c', 'say "hi"', ' lead', ''], ['x', 'line\nbreak', 'z', 'y', 'w']];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('readSteam joins definitions and localization', () => {
  const s = readSteam(parseCsv(DEFS), parseCsv(LOC));
  assert.deepEqual(s.get('SO_CLOSE'), { apiName: 'SO_CLOSE', displayName: 'So Close', description: 'Crash within 10 m of the finish', hidden: true, archived: false });
});

test('planSync: updates text, adds new, lists (never drops) removed, ignores trailing spaces', () => {
  const p = planSync(code, parseCsv(DEFS), parseCsv(LOC));
  assert.deepEqual(p.update.map(u => u.apiName), ['SO_CLOSE']);          // FIRST_500M's trailing space is not a change
  assert.deepEqual(p.add.map(a => a.apiName), ['NEW_ONE']);
  assert.deepEqual(p.remove.map(a => a.apiName), ['OLD_ONE']);
  assert.ok(p.defsChanged && p.locChanged);
  const steam = readSteam(p.defRows, p.locRows);
  assert.equal(steam.get('SO_CLOSE').description, 'Crash after the last checkpoint');
  assert.deepEqual(steam.get('NEW_ONE'), { apiName: 'NEW_ONE', displayName: 'Brand "New"', description: 'Do a thing, twice', hidden: true, archived: false });
  assert.equal(steam.get('OLD_ONE').displayName, 'Old');                  // left exactly as it was
  assert.deepEqual(p.defRows.at(-1), ['NEW_ONE', '', 'Client', 'true', 'false', '', '0', '0']);
});

test('planSync: hidden flips only touch definitions', () => {
  const flipped = code.slice(0, 2).map(a => a.apiName === 'FIRST_500M' ? { ...a, hidden: true } : { ...a, description: 'Crash within 10 m of the finish' });
  const p = planSync(flipped, parseCsv(DEFS), parseCsv(LOC));
  assert.deepEqual(p.update.map(u => u.parts), [['hidden false -> true']]);
  assert.ok(p.defsChanged);
  assert.equal(p.locChanged, false);
  assert.equal(p.defRows[1][3], 'true');
});

test('planSync: nothing to do once Steamworks matches', () => {
  const p = planSync(code, parseCsv(DEFS), parseCsv(LOC));
  const again = planSync(code, p.defRows, p.locRows);
  assert.equal(again.update.length + again.add.length, 0);
  assert.equal(again.defsChanged || again.locChanged, false);
});

test('planSync: a pending API rename is reported, not imported', () => {
  const p = planSync([{ apiName: 'NEW_NAME', displayName: 'n', description: 'd', hidden: false }],
    parseCsv(DEFS), parseCsv(LOC), { renames: { OLD_ONE: 'NEW_NAME' } });
  assert.deepEqual(p.renamed, [{ from: 'OLD_ONE', to: 'NEW_NAME' }]);
});
