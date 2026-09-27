// A-0 · first real unit test: the level table is sane and lookups are total.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, getLevelById } from '../../js/race-config.js';

test('getLevelById returns the tutorial for an unknown id', () => {
  assert.equal(getLevelById('nope').id, 'tutorial');
  assert.equal(getLevelById(undefined).id, 'tutorial');
});

test('getLevelById returns the requested level', () => {
  for (const level of LEVELS) {
    assert.equal(getLevelById(level.id).id, level.id);
  }
});

test('every level has the fields the race manager needs', () => {
  for (const level of LEVELS) {
    assert.equal(typeof level.id, 'string', `${level.id}: id`);
    assert.equal(typeof level.name, 'string', `${level.id}: name`);
    assert.ok(level.distance > 0, `${level.id}: distance`);
    assert.ok(level.checkpointInterval > 0, `${level.id}: checkpointInterval`);
  }
});

test('level ids are unique', () => {
  const ids = LEVELS.map(l => l.id);
  assert.equal(new Set(ids).size, ids.length);
});
