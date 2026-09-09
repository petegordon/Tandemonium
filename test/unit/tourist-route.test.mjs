// E-6 · the distance between two people, made rideable.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceM, bearing, interpolate, greatCirclePoints, capRoute, planRoute,
  headlineFor, formatDistance, skipLabel, isValidPoint,
  MAX_RIDE_M, CAP_HALF_M
} from '../../js/tourist-route.js';

const COLUMBUS = { lat: 39.9612, lon: -82.9988 };
const DENVER   = { lat: 39.7392, lon: -104.9903 };
const CINCY    = { lat: 39.1031, lon: -84.5120 };
// Two points about 2 km apart in Columbus: downtown and the Short North.
const SHORT_NORTH = { lat: 39.9784, lon: -83.0043 };

const within = (actual, expected, pct, label) =>
  assert.ok(Math.abs(actual - expected) / expected < pct / 100,
    `${label}: ${Math.round(actual)} vs ${expected} (${((actual - expected) / expected * 100).toFixed(2)}%)`);

test('great-circle distance matches known real-world distances', () => {
  // The plan quoted 1,745 km for Columbus-Denver; that figure is wrong. The true
  // great circle is ~1,870 km (about 1,160 statute miles), which is what
  // haversine gives here and what references agree on. Corrected in the test
  // rather than fudged in the maths.
  within(distanceM(COLUMBUS, DENVER), 1870000, 1, 'Columbus to Denver');
  within(distanceM(COLUMBUS, CINCY), 161000, 2, 'Columbus to Cincinnati');
  within(distanceM(COLUMBUS, SHORT_NORTH), 1920, 5, 'downtown to the Short North');
});

test('distance is symmetric and zero to itself', () => {
  assert.equal(Math.round(distanceM(COLUMBUS, DENVER)), Math.round(distanceM(DENVER, COLUMBUS)));
  assert.equal(distanceM(COLUMBUS, COLUMBUS), 0);
});

test('the bearing points the right way', () => {
  const west = bearing(COLUMBUS, DENVER);
  assert.ok(west > 250 && west < 300, `Denver is west of Columbus, got ${west.toFixed(1)}°`);
  const south = bearing(COLUMBUS, CINCY);
  assert.ok(south > 180 && south < 260, `Cincinnati is south-west, got ${south.toFixed(1)}°`);
});

test('interpolation walks the line and hits both ends', () => {
  assert.deepEqual(interpolate(COLUMBUS, DENVER, 0).lat.toFixed(4), COLUMBUS.lat.toFixed(4));
  const end = interpolate(COLUMBUS, DENVER, 1);
  assert.equal(end.lat.toFixed(3), DENVER.lat.toFixed(3));
  assert.equal(end.lon.toFixed(3), DENVER.lon.toFixed(3));
  const mid = interpolate(COLUMBUS, DENVER, 0.5);
  within(distanceM(COLUMBUS, mid), distanceM(COLUMBUS, DENVER) / 2, 1, 'halfway is half the distance');
});

test('waypoints are evenly spaced and include both ends', () => {
  const pts = greatCirclePoints(COLUMBUS, SHORT_NORTH, 500);
  assert.ok(pts.length >= 4, `only ${pts.length} waypoints over ~2 km at 500 m`);
  assert.equal(pts[0].d, 0);
  within(pts[pts.length - 1].d, distanceM(COLUMBUS, SHORT_NORTH), 0.001, 'last waypoint is the end');
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i].d - pts[i - 1].d;
    assert.ok(gap > 0 && gap <= 501, `gap of ${gap.toFixed(1)} m`);
  }
});

test('a short ride is ridden whole', () => {
  const r = capRoute(2000);
  assert.equal(r.capped, false);
  assert.equal(r.ridableM, 2000);
  assert.equal(r.skippedM, 0);
  assert.equal(r.segments.length, 1);
  assert.deepEqual([r.segments[0].fromFraction, r.segments[0].toFraction], [0, 1]);
});

test('a long ride becomes both ends with the middle skipped', () => {
  const real = 1870000;                       // Columbus to Denver
  const r = capRoute(real);
  assert.equal(r.capped, true);
  assert.equal(r.ridableM, CAP_HALF_M * 2);
  assert.equal(r.segments.length, 2, 'you leave your street and arrive at theirs');
  assert.equal(r.realM, real, 'the real distance is never lost — it IS the feature');
  assert.equal(r.skippedM, real - CAP_HALF_M * 2);
  // The two segments are at the two ends.
  assert.equal(r.segments[0].fromFraction, 0);
  assert.equal(r.segments[1].toFraction, 1);
  assert.ok(r.segments[0].toFraction < r.segments[1].fromFraction, 'and they do not overlap');
});

test('exactly at the cap is still one ride', () => {
  assert.equal(capRoute(MAX_RIDE_M).capped, false);
  assert.equal(capRoute(MAX_RIDE_M + 1).capped, true);
});

test('nonsense distances produce nothing to ride, not a crash', () => {
  for (const bad of [0, -5, NaN, undefined]) {
    const r = capRoute(bad);
    assert.equal(r.segments.length, 0);
    assert.equal(r.ridableM, 0);
  }
});

test('planning a route gives the ride and the sentence', () => {
  const plan = planRoute(COLUMBUS, DENVER);
  within(plan.realM, 1870000, 1, 'real distance');
  assert.equal(plan.route.capped, true);
  assert.ok(plan.waypoints.length > 100, 'a long route still gets waypoints for elevation');
  assert.match(plan.headline, /Ride the distance between you: 1,8\d\d km/);
});

test('a two-kilometre plan is ridden end to end', () => {
  const plan = planRoute(COLUMBUS, SHORT_NORTH);
  assert.equal(plan.route.capped, false);
  within(plan.route.ridableM, 1920, 5, 'the whole thing is the ride');
});

test('distances read the way a person would say them', () => {
  assert.equal(formatDistance(850), '850 m');
  assert.equal(formatDistance(2400), '2.4 km');
  assert.equal(formatDistance(1209000), '1,209 km');
  assert.equal(formatDistance(0), '0 m');
});

test('the skip label only appears when something was skipped', () => {
  assert.equal(skipLabel(capRoute(2000)), '');
  assert.match(skipLabel(capRoute(1870000)), /✂️ 1,865 km skipped/);
});

test('a bad geocode is rejected before it is ridden', () => {
  assert.equal(isValidPoint(COLUMBUS), true);
  assert.equal(isValidPoint(null), false);
  assert.equal(isValidPoint({ lat: 91, lon: 0 }), false);
  assert.equal(isValidPoint({ lat: 0, lon: 181 }), false);
  assert.equal(isValidPoint({ lat: 'x', lon: 0 }), false);
});

test('the headline is the whole pitch, in one line', () => {
  assert.equal(headlineFor(1209000), 'Ride the distance between you: 1,209 km');
  assert.equal(headlineFor(1920), 'Ride the distance between you: 1.9 km');
});
