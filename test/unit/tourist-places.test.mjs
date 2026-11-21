// Map Tourist's places and the weekly limit on new ones (js/tourist-places.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENIC_PLACES, scenicPlace, rideKind, planForPlace, NEW_PLACE_LIMIT, MAX_YOUR_PLACES,
  emptyStore, readStore, periodStart, periodEnd, newPlaceGate, countNewPlaces, limitText, resetDayName,
  knownPoint, rememberPlace, placeLabel,
} from '../../js/tourist-places.js';
import { isValidPoint, MAX_RIDE_M } from '../../js/tourist-route.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const columbus = { lat: 39.9612, lon: -82.9988, label: 'Columbus, OH, USA', typed: 'columbus ohio' };
const paris = { lat: 48.8566, lon: 2.3522, label: 'Paris, France', typed: 'paris' };

test('the scenic rides: about a dozen, each a valid place with a stored height, none needing a skip', () => {
  assert.ok(SCENIC_PLACES.length >= 10 && SCENIC_PLACES.length <= 14, `a dozen or so (${SCENIC_PLACES.length})`);
  const ids = new Set();
  for (const p of SCENIC_PLACES) {
    assert.ok(p.id && p.name && p.where && p.icon, p.id);
    assert.ok(!ids.has(p.id), 'ids are unique: ' + p.id);
    ids.add(p.id);
    assert.ok(isValidPoint(p.from) && p.from.label, p.id + ' has a start');
    assert.ok(Number.isFinite(p.height) && p.height > -500 && p.height < 9500, p.id + ' has an anchor height');
    if (p.to) {
      assert.ok(isValidPoint(p.to) && p.to.label, p.id + ' has an end');
      const plan = planForPlace(p);
      assert.ok(!plan.route.capped && plan.route.ridableM <= MAX_RIDE_M && plan.route.ridableM > 300, p.id + ' is ridden whole');
    }
    assert.equal(scenicPlace(p.id), p);
  }
  assert.equal(scenicPlace('nowhere'), null);
});

test('a scenic place becomes a plan with its anchor, so nothing is looked up', () => {
  const ride = SCENIC_PLACES.find((p) => p.to);
  const open = SCENIC_PLACES.find((p) => !p.to);
  const plan = planForPlace(ride);
  assert.deepEqual(plan.anchor, { height: ride.height, anchored: true });
  assert.equal(plan.kind, 'scenic');
  assert.equal(plan.title, ride.name);
  assert.ok(plan.headline.startsWith(ride.name + ' · '));
  assert.match(rideKind(ride), /^[\d.,]+ (m|km) ride$/);
  if (open) {
    const p2 = planForPlace(open);
    assert.equal(p2.explore, true);
    assert.equal(p2.headline, open.name);
    assert.equal(rideKind(open), 'Open ride');
  }
  // one of the player's own keeps the ordinary wording
  const yours = planForPlace({ from: columbus, to: paris, height: 400, toHeight: 230 }, 'yours');
  assert.equal(yours.kind, 'yours');
  assert.deepEqual(yours.toAnchor, { height: 230, anchored: true });
  assert.ok(yours.route.capped);
  assert.match(yours.headline, /of real streets$/);
});

test('the limit: 5 new places a week, counted from Monday on the player\'s own calendar', () => {
  assert.deepEqual({ ...NEW_PLACE_LIMIT }, { count: 5, days: 7 });
  // 2026-11-17 is a Tuesday
  assert.equal(periodStart(at(2026, 11, 17)), '2026-11-16');
  assert.equal(periodStart(at(2026, 11, 16, 0)), '2026-11-16', 'Monday itself');
  assert.equal(periodStart(at(2026, 11, 22, 23)), '2026-11-16', 'Sunday night is still that week');
  assert.equal(periodStart(at(2026, 11, 23, 0)), '2026-11-23');
  assert.equal(periodEnd(at(2026, 11, 17)), new Date(2026, 10, 23).getTime());

  let store = emptyStore();
  const tue = at(2026, 11, 17);
  assert.deepEqual(newPlaceGate(store, tue), { limit: 5, used: 0, left: 5, allowed: true, resetsAt: new Date(2026, 10, 23).getTime() });
  store = countNewPlaces(store, 2, tue);
  store = countNewPlaces(store, 1, tue);
  assert.equal(newPlaceGate(store, tue).left, 2);
  store = countNewPlaces(store, 5, tue);
  assert.deepEqual([newPlaceGate(store, tue).left, newPlaceGate(store, tue).allowed, store.used], [0, false, 5], 'never past the limit');
  // next Monday it is a new week
  const mon = at(2026, 11, 23, 8);
  assert.equal(newPlaceGate(store, mon).left, 5);
  store = countNewPlaces(store, 1, mon);
  assert.deepEqual([store.week, store.used], ['2026-11-23', 1]);
});

test('the limit is said plainly, with what never counts and when more come', () => {
  const tue = at(2026, 11, 17);
  const some = limitText(newPlaceGate(countNewPlaces(emptyStore(), 2, tue), tue), tue, 'en-US');
  assert.equal(some.headline, 'New places this week: 3 of 5 left');
  assert.equal(some.detail, 'Scenic rides and places you have ridden before never count.');
  const none = limitText(newPlaceGate(countNewPlaces(emptyStore(), 5, tue), tue), tue, 'en-US');
  assert.equal(none.headline, 'You have looked up this week’s 5 new places');
  assert.equal(none.detail, 'More on Monday. Scenic rides and your own places are still open.');
  const sun = at(2026, 11, 22);
  assert.equal(limitText(newPlaceGate(countNewPlaces(emptyStore(), 5, sun), sun), sun, 'en-US').detail,
    'More tomorrow. Scenic rides and your own places are still open.');
  assert.equal(resetDayName(new Date(2026, 10, 23).getTime(), tue, 'en-US'), 'Monday');
});

test('your places: newest first, no doubles, a ceiling, and a typed place that is already known costs nothing', () => {
  let store = emptyStore();
  store = rememberPlace(store, { from: columbus, height: 380 });
  store = rememberPlace(store, { from: columbus, to: paris, height: 380, toHeight: 230 });
  store = rememberPlace(store, { from: { ...columbus, lat: columbus.lat + 0.0001 }, height: 381 });   // the same spot again
  assert.equal(store.places.length, 2);
  assert.equal(store.places[0].to, null, 'the place just ridden is first');
  assert.equal(store.places[0].height, 381);
  assert.equal(placeLabel(store.places[0]), 'Columbus');
  assert.equal(placeLabel(store.places[1]), 'Columbus → Paris');

  assert.equal(knownPoint(store, '  COLUMBUS   Ohio ').lat, columbus.lat + 0.0001, 'what they typed last time');
  assert.equal(knownPoint(store, 'Paris, France').lon, paris.lon, 'or its full address');
  assert.equal(knownPoint(store, 'Rome'), null);
  assert.equal(knownPoint(store, ''), null);

  for (let i = 0; i < 12; i++) store = rememberPlace(store, { from: { lat: 10 + i, lon: 20, label: 'Place ' + i } });
  assert.equal(store.places.length, MAX_YOUR_PLACES);
  assert.equal(store.places[0].from.label, 'Place 11');
  assert.equal(rememberPlace(store, { from: { lat: 999, lon: 0 } }).places.length, MAX_YOUR_PLACES, 'a bad point is not kept');
});

test('what is stored is read back in shape, whatever was written', () => {
  assert.deepEqual(readStore(null), emptyStore());
  assert.deepEqual(readStore('not json'), emptyStore());
  assert.deepEqual(readStore('{"places":"x","used":-3,"week":7}'), emptyStore());
  const good = { places: [{ from: columbus, to: null, height: 380 }, { from: { lat: 200, lon: 0 } }, null], week: '2026-11-16', used: 2.9 };
  const s = readStore(JSON.stringify(good));
  assert.equal(s.places.length, 1);
  assert.deepEqual([s.week, s.used], ['2026-11-16', 2]);
});
