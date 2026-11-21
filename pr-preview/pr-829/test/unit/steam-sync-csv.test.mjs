// #775: the Steam achievement sync reads and writes Steamworks' Bulk
// Import/Export CSVs. These pin the format (BOM, CRLF, quoting, no final
// newline) and what the comparison decides to upload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseCsv, writeCsv, plan, readDefinitions, readLocalization } = require('../../scripts/sync-steam-achievements.js');

const DEF_HEADER = '﻿"api_name (required, unique; the name your game passes to the API)",setid (optional; the id of a set that already exists),"permission (one of Client, GameServer, OfficialGameServer)",spoiler (true or false),archived (true or false),"progress_stat_name (optional; the name of a stat that already exists, blank for no progress bar)","progress_stat_min (number, no lower than the stat\'s own min)","progress_stat_max (number, above min and no higher than the stat\'s own max)"';
const LOC_HEADER = '﻿api_name (required; must match an api_name from the definitions CSV),field (name or description),english';

function tmpFile(name, text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'steam-csv-')), name);
  fs.writeFileSync(file, text);
  return file;
}

test('a Steam export round-trips byte for byte', () => {
  const text = [
    LOC_HEADER,
    'FIRST_500M,name,First 500m',
    'FIRST_500M,description,"Ride 500 meters total "',
    'FIRST_KM,description,"Ride 1,000 meters total"',
    `GRANDMA_GOLD,description,"Reach Grandma's inside the gold time (the fastest; ""quoted"")"`,
  ].join('\r\n');
  assert.equal(writeCsv(parseCsv(text)), text);
});

test('parseCsv handles commas, doubled quotes and the BOM', () => {
  const rows = parseCsv('﻿a,"b, c","say ""hi"""\r\nd,,f');
  assert.deepEqual(rows, [['a', 'b, c', 'say "hi"'], ['d', '', 'f']]);
});

test('plan: text changes, adds, spoiler changes, renames and stale rows', () => {
  const defs = readDefinitions(tmpFile('d.csv', [DEF_HEADER,
    'SO_CLOSE,,Client,true,false,,0,0',
    'FIRST_500M,,Client,false,false,,0,0',
    'TODAYS_LAUNCH,,Client,false,false,,0,0',
    'OLD_ONE,,Client,false,false,,0,0',
    'CRASHES_10,,Client,false,false,,0,0'].join('\r\n')));
  const loc = readLocalization(tmpFile('l.csv', [LOC_HEADER,
    'SO_CLOSE,name,So Close', 'SO_CLOSE,description,Crash within 10 m of the finish',
    'FIRST_500M,name,First 500m', 'FIRST_500M,description,"Ride 500 meters total "',
    'TODAYS_LAUNCH,name,Daily Launch', 'TODAYS_LAUNCH,description,Fly it',
    'OLD_ONE,name,Old', 'OLD_ONE,description,Gone',
    'CRASHES_10,name,Frequent Faller', 'CRASHES_10,description,Crash 10 times in total'].join('\r\n')));
  const code = [
    { apiName: 'SO_CLOSE', displayName: 'So Close', description: 'Crash after the last checkpoint', hidden: true },
    { apiName: 'FIRST_500M', displayName: 'First 500m', description: 'Ride 500 meters total', hidden: false },
    { apiName: 'DAILY_LAUNCH', displayName: 'Daily Launch', description: 'Fly it', hidden: false },
    { apiName: 'CRASHES_10', displayName: 'Frequent Faller', description: 'Crash 10 times in total', hidden: true },
    { apiName: 'NEW_ONE', displayName: 'New', description: 'Brand new', hidden: false },
  ];
  const p = plan(code, defs, loc);
  assert.deepEqual(p.toRename, [{ from: 'TODAYS_LAUNCH', to: 'DAILY_LAUNCH' }]);
  assert.deepEqual(p.toAdd.map(a => a.apiName), ['NEW_ONE']);
  assert.deepEqual(p.stale, ['OLD_ONE']);
  assert.deepEqual(p.spoilerChanges.map(a => a.apiName), ['CRASHES_10']);
  // Stray trailing spaces on Steam don't count; the rename carries its text over.
  assert.deepEqual(p.textChanges.map(a => a.apiName), ['SO_CLOSE', 'NEW_ONE']);
});
