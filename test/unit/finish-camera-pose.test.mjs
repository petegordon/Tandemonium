// Pete, 2026-11-18: "the SOLO FLIGHT bike is high and the camera at the end zooms in and cuts the heads of the
// riders off". The finish's end pose was set on the goose tandem on a landscape screen; it now allows for a taller
// bike, a captain sitting further forward, and a phone held upright.
import test from 'node:test';
import assert from 'node:assert/strict';
import { endPoseFor } from '../../js/finish-camera-animation.js';

const TANDEM = { riderViewScale: 1.02, frontViewAhead: 0 };
const SOLO_FLIGHT = { riderViewScale: 1.26, frontViewAhead: 1.252 };   // measured in the game, 2026-11-18

test('the goose tandem on a desk or a TV keeps the pose it was tuned with', () => {
  assert.deepEqual(endPoseFor(TANDEM, 1.5), { radius: 4.2, height: 2.0, lookFwd: 1.4, lookY: 1.55 });
  assert.deepEqual(endPoseFor(TANDEM, 1.78), endPoseFor(TANDEM, 1.5), 'wider than that changes nothing');
  assert.deepEqual(endPoseFor(null), endPoseFor(TANDEM), 'no bike: the tandem');
});

test('the Solo Flight is framed from higher and further off, looking higher', () => {
  const t = endPoseFor(TANDEM, 1.5), s = endPoseFor(SOLO_FLIGHT, 1.5);
  assert.ok(s.height > t.height * 1.2 && s.lookY > t.lookY * 1.2, 'higher, by about its riders\' extra height');
  assert.ok(s.radius >= t.radius * 1.2 + 1.25 - 1e-9, 'further off, and by its captain\'s 1.25 m forward too');
});

test('a phone held upright stands further back and aims nearer the middle of the bike', () => {
  for (const bike of [TANDEM, SOLO_FLIGHT]) {
    const wide = endPoseFor(bike, 1.5), tall = endPoseFor(bike, 390 / 844);
    assert.ok(tall.radius > wide.radius * 1.5, 'further back');
    assert.ok(tall.lookFwd < wide.lookFwd, 'aimed nearer the middle');
    assert.equal(tall.lookY, wide.lookY);
  }
  assert.ok(endPoseFor(TANDEM, 0.1).radius <= 4.2 * 2 + 1e-9, 'never more than twice as far');
  assert.deepEqual(endPoseFor(TANDEM, NaN), endPoseFor(TANDEM, 1.5));
});
