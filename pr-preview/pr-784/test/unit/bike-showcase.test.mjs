// #736 · the "New bike!" pictures: standing geese for one or two bikes, riders for more; shuffled greetings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { showcaseMode, greetingOrder, studioGooseFor, shuffled } from '../../js/bike-showcase.js';
import { GOOSE_OUTFITS } from '../../js/goose-outfits.js';

test('one or two bikes: the geese stand beside them; three or more: they ride', () => {
  assert.equal(showcaseMode(1), 'standing');
  assert.equal(showcaseMode(2), 'standing');
  assert.equal(showcaseMode(3), 'riding');
  assert.equal(showcaseMode(5), 'riding');
});

test('greetings: every move once, a gander tips his hat, a lady curtsies, never the same opener', () => {
  for (let seed = 1; seed < 200; seed++) {
    let a = seed;
    const random = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
    const [m, f] = greetingOrder(['m', 'f'], random);
    assert.deepEqual([...m].sort(), ['admire', 'bow', 'celebrate', 'hat_tip', 'twirl', 'wave']);
    assert.deepEqual([...f].sort(), ['admire', 'bow', 'celebrate', 'curtsy', 'twirl', 'wave']);
    const [x, y] = greetingOrder(['f', 'f'], random);
    assert.notEqual(x[0], y[0], 'seed ' + seed);
  }
});

test('greetings change between showings', () => {
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add(greetingOrder(['m'])[0].join());
  assert.ok(seen.size > 5);
  assert.deepEqual(shuffled([1, 2, 3], () => 0.999).sort(), [1, 2, 3]);
});

test('the studio goose for a look: its outfit, in its body', () => {
  assert.equal(studioGooseFor({ outfit: 'victorian', body: 'm' }), 'goose_captain');
  assert.equal(studioGooseFor({ outfit: 'victorian', body: 'f' }), 'goose_stoker_victorian');
  assert.equal(studioGooseFor({ outfit: 'fancy', body: 'f' }), 'goose_stoker');
  assert.equal(studioGooseFor({ outfit: 'robot', body: 'm' }), 'goose_captain_robot_m');
});

test('every outfit has its icon', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(GOOSE_OUTFITS).map(([k, o]) => [k, o.icon])),
    { victorian: '\u{1F3A9}', cyclists: '\u{1F6B4}', fancy: '\u{1F48E}', georgian: '\u{1F451}', robot: '\u{1F916}' });
});

test('the bike rolls in from the left or the right, straight across at first, then into its three-quarter stop', async () => {
  const { rollPath, pathAt } = await import('../../js/bike-showcase.js');
  for (const side of [-1, 1]) {   // -1: in from the left (heading +x), 1: from the right
    const hEnd = -side * (Math.PI / 2 - 0.8), hSide = -side * Math.PI / 2;
    const pts = rollPath(hEnd, hSide);
    const start = pathAt(pts, 10), stop = pathAt(pts, 0);
    assert.equal(Math.sign(start.x), side, 'starts on its own side');
    assert.equal(stop.x, 0); assert.equal(stop.h, hEnd);
    assert.ok(Math.abs(start.h - hSide) < 1e-9, 'straight across the screen out there');
    assert.ok(Math.abs(pathAt(pts, 10).z - pathAt(pts, 5).z) < 1e-9, 'no deeper as it comes (in from the side)');
    assert.ok(start.z < 0 && start.z > -1.2, 'just behind the geese line, close to you');
  }
});
