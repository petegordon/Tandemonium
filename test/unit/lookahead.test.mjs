// E-1 · what the stoker can see and the captain cannot.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLookahead, laneOf, warningSeconds, seatSeesLookahead,
  LOOKAHEAD_M, LANE_EDGE, CAPTAIN_VIEW_M
} from '../../js/lookahead.js';

const obstacle = (d, lat = 0) => ({ absoluteD: d, lateralOffset: lat });

test('lanes split the road into left, centre and right', () => {
  assert.equal(laneOf(-2), 0);
  assert.equal(laneOf(0), 1);
  assert.equal(laneOf(2), 2);
  assert.equal(laneOf(-LANE_EDGE), 1, 'the boundary belongs to the centre');
  assert.equal(laneOf(LANE_EDGE + 0.01), 2);
});

test('only items in the window past the captain appear', () => {
  // Window is [100, 140]: the marker at 50 is behind the rider, 141 is past
  // the end of the panel, and 20 is a lap behind.
  const strip = buildLookahead({
    obstacles: [obstacle(50), obstacle(100), obstacle(130), obstacle(141), obstacle(20)]
  }, 100, 40);
  assert.deepEqual(strip.map(s => s.distance), [0, 30]);
});

test('the far edge of the window is inclusive', () => {
  assert.equal(buildLookahead({ obstacles: [obstacle(140)] }, 100, 40).length, 1);
  assert.equal(buildLookahead({ obstacles: [obstacle(140.1)] }, 100, 40).length, 0);
});

test('the strip is sorted nearest first', () => {
  const strip = buildLookahead({
    obstacles: [obstacle(135), obstacle(110), obstacle(125)]
  }, 100);
  assert.deepEqual(strip.map(s => s.distance), [10, 25, 35]);
});

test('every kind of thing on the road is reported, with its lane', () => {
  const strip = buildLookahead({
    obstacles: [obstacle(110, -2)],
    collectibles: [{ absoluteD: 120, lateralOffset: 0 }],
    geese: [{ absoluteD: 130, lateralOffset: 2 }]
  }, 100);
  assert.deepEqual(strip.map(s => [s.kind, s.lane]),
    [['obstacle', 0], ['present', 1], ['goose', 2]]);
});

test('collected presents and scattered geese are not called out', () => {
  const strip = buildLookahead({
    collectibles: [{ absoluteD: 110, lateralOffset: 0, collected: true }],
    geese: [{ absoluteD: 120, lateralOffset: 0, disrupted: true }]
  }, 100);
  assert.equal(strip.length, 0);
});

test('urgency rises as a hazard approaches the captain', () => {
  const strip = buildLookahead({ obstacles: [obstacle(101), obstacle(139)] }, 100, 40);
  assert.ok(strip[0].urgency > 0.9, 'about to enter the captain view');
  assert.ok(strip[1].urgency < 0.1, 'still far off');
});

test('the panel buys a real call, not a yelp', () => {
  // At 12 m/s — a fast Adventurous ride — 40 m has to be more than 2.5 s of
  // warning, or the stoker is describing something the captain can already see.
  assert.ok(warningSeconds(LOOKAHEAD_M, 12) > 2.5,
    `${warningSeconds(LOOKAHEAD_M, 12).toFixed(2)} s of warning at 12 m/s`);
  assert.ok(warningSeconds(LOOKAHEAD_M, 19) > 2.0, 'still useful at top speed');
});

test('the look-ahead genuinely starts past the captain', () => {
  assert.ok(CAPTAIN_VIEW_M > 0);
  const strip = buildLookahead({ obstacles: [obstacle(CAPTAIN_VIEW_M + 10)] }, CAPTAIN_VIEW_M);
  assert.equal(strip.length, 1, 'items beyond the captain view are the stoker\'s to call');
});

test('only the online stoker gets the panel', () => {
  assert.equal(seatSeesLookahead('stoker'), true);
  assert.equal(seatSeesLookahead('captain'), false);
  assert.equal(seatSeesLookahead('solo'), false);
  // One screen and one camera: showing it in local co-op shows the captain too.
  assert.equal(seatSeesLookahead('local'), false);
  assert.equal(seatSeesLookahead('versus'), false);
});

test('an empty road is an empty strip, not a crash', () => {
  assert.deepEqual(buildLookahead({}, 100), []);
  assert.deepEqual(buildLookahead({ obstacles: null, geese: undefined }, 100), []);
});

test('items with no distance are skipped rather than trusted', () => {
  const strip = buildLookahead({ obstacles: [{ lateralOffset: 0 }, obstacle(110)] }, 100);
  assert.equal(strip.length, 1);
});
