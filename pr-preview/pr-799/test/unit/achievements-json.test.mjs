// achievements.json is what other House Tandem sites read to show Tandemonium's badges
// (housetandem.com's account page). It must match js/achievement-defs.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { achievementsJson, FILE } from '../../scripts/gen-achievements-json.mjs';

test('achievements.json matches the definitions (npm run gen:achievements)', () => {
  const committed = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, achievementsJson());
});

test('achievements.json: 100 achievements, each in a listed section, hidden ones marked', () => {
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(data.achievements.length, 100);
  const sections = new Set(data.sections.map((s) => s.id));
  for (const a of data.achievements) {
    assert.ok(a.id && a.name && a.description && a.icon, a.id);
    assert.ok(sections.has(a.group), `${a.id} is in a listed section`);
  }
  assert.equal(new Set(data.achievements.map((a) => a.id)).size, 100, 'ids are unique');
  assert.ok(data.achievements.some((a) => a.hidden), 'the hidden ones say so');
  assert.equal(data.renamed.todays_launch, 'daily_launch');
});
