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

// #543 · the tutorial had a stale 158 m gold gate (from the old 225 m layout)
// just past its 150 m finish, so riders saw two strips at the end.
test('tutorial phase gates stand only between the start and the finish', async () => {
  const { TUTORIAL_PHASES, tutorialPhaseGates } = await import('../../js/race-config.js');
  const tut = LEVELS.find(l => l.isTutorial);
  const gates = tutorialPhaseGates(tut.distance);
  assert.deepEqual(gates, [TUTORIAL_PHASES[2].runwayStart]);
  for (const d of gates) assert.ok(d > 0 && d < tut.distance, `gate ${d} m inside the ${tut.distance} m ride`);
  for (const p of Object.values(TUTORIAL_PHASES)) assert.ok(p.contentEnd <= tut.distance, 'every phase ends by the finish');
  assert.deepEqual(tutorialPhaseGates(100, { 1: { runwayStart: 0 }, 2: { runwayStart: 80 }, 3: { runwayStart: 158 } }), [80]);
});
