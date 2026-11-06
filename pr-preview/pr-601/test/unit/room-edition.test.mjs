// PR #397 M1 / m16 / m17 / m18 — rooms that mix editions (demo ↔ full) or
// versions (this build ↔ the deployed one): the room profile's { edition,
// caps }, the "most restrictive" merge, and what the stoker does with a
// levelSync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL_RULES, DEMO_RULES, ROOM_CAPS, roomProfileFields, partnerFromProfile,
  mergeRoomRules, levelSyncVerdict
} from '../../js/edition.js';
import { RoomProtocol, ROOM_MSG } from '../../js/lobby/room-protocol.js';
import { LEVELS } from '../../js/race-config.js';

const lvl = id => LEVELS.find(l => l.id === id);
const FULL_NEW = { edition: 'full', caps: [...ROOM_CAPS] };
const DEMO_NEW = { edition: 'demo', caps: ROOM_CAPS.filter(c => c !== 'tourist') };

test('room profile fields: edition + caps; tourist only from an edition that has it', () => {
  assert.deepEqual(roomProfileFields(FULL_RULES), { edition: 'full', caps: [...ROOM_CAPS] });
  const demo = roomProfileFields(DEMO_RULES);
  assert.equal(demo.edition, 'demo');
  assert.equal(demo.caps.includes('tourist'), false);
  assert.ok(demo.caps.includes('v2LevelSync') && demo.caps.includes('helpingHand'));
});

test('a profile without caps is an OLD client', () => {
  assert.deepEqual(partnerFromProfile({ name: 'x', achievements: [] }), { edition: 'full', caps: null });
  assert.deepEqual(partnerFromProfile({ edition: 'demo', caps: ['tourist', 7] }), { edition: 'demo', caps: ['tourist'] });
  assert.equal(partnerFromProfile(null), null);
});

test('the room rides the MOST RESTRICTIVE edition', () => {
  // full + full (both new): everything.
  const ff = mergeRoomRules(FULL_RULES, FULL_NEW);
  assert.equal(ff.isDemo, false); assert.equal(ff.ranked, true); assert.equal(ff.tourist, true);
  assert.equal(ff.helpingHand, true); assert.equal(ff.weeklyRoad, false);
  // full captain + demo partner: demo rules for both.
  const fd = mergeRoomRules(FULL_RULES, DEMO_NEW);
  assert.equal(fd.isDemo, true); assert.equal(fd.weeklyRoad, true); assert.equal(fd.ranked, false);
  assert.equal(fd.tourist, false); assert.deepEqual([...fd.levels], [...DEMO_RULES.levels]);
  // demo side + full partner: still demo.
  const df = mergeRoomRules(DEMO_RULES, FULL_NEW);
  assert.equal(df.isDemo, true); assert.equal(df.ranked, false); assert.equal(df.tourist, false);
  // partner without the tourist cap: no Map Tourists, the rest stays.
  const nt = mergeRoomRules(FULL_RULES, { edition: 'full', caps: ['helpingHand'] });
  assert.equal(nt.tourist, false); assert.equal(nt.ranked, true);
});

test('an OLD partner (or one not heard from yet): no ranked, no Map Tourists, no helping hand (m18)', () => {
  for (const partner of [{ edition: 'full', caps: null }, null]) {
    const r = mergeRoomRules(FULL_RULES, partner);
    assert.equal(r.ranked, false);
    assert.equal(r.tourist, false);
    assert.equal(r.helpingHand, false);
    assert.equal(r.partnerOld, true);
    assert.equal(r.isDemo, false);
  }
});

test('levelSync carries the effective road; old payload shape still readable', () => {
  const m = RoomProtocol.levelSync('daily', { difficulty: 'chill', key: '2026-09-28', seed: 42, roadKind: 'weekly' });
  assert.deepEqual(m, { type: ROOM_MSG.LEVEL_SYNC, levelId: 'daily', difficulty: 'chill', key: '2026-09-28', seed: 42, roadKind: 'weekly' });
  assert.deepEqual(RoomProtocol.levelSync('grandma'), { type: ROOM_MSG.LEVEL_SYNC, levelId: 'grandma' });
  assert.deepEqual(RoomProtocol.levelRefused('daily', 'demo'), { type: ROOM_MSG.LEVEL_REFUSED, levelId: 'daily', reason: 'demo' });
});

test('stoker verdict: adopts the captain road kind, refuses what its edition lacks (m17)', () => {
  // full stoker on a demo captain's weekly road: rides the weekly road.
  assert.deepEqual(levelSyncVerdict(FULL_RULES, lvl('daily'), { roadKind: 'weekly' }), { ok: true, roadKind: 'weekly' });
  assert.deepEqual(levelSyncVerdict(FULL_RULES, lvl('daily'), { roadKind: 'daily' }), { ok: true, roadKind: 'daily' });
  // demo stoker: weekly ok; Today's Road (or an old captain, who sends no roadKind) refused.
  assert.deepEqual(levelSyncVerdict(DEMO_RULES, lvl('daily'), { roadKind: 'weekly' }), { ok: true, roadKind: 'weekly' });
  assert.deepEqual(levelSyncVerdict(DEMO_RULES, lvl('daily'), { roadKind: 'daily' }), { ok: false, reason: 'demo' });
  assert.deepEqual(levelSyncVerdict(DEMO_RULES, lvl('daily'), { key: '2026-10-05', seed: 1 }), { ok: false, reason: 'demo' });
  assert.deepEqual(levelSyncVerdict(DEMO_RULES, lvl('grandma'), {}), { ok: true, roadKind: null });
  // a level this build doesn't know (a newer captain) is refused, never crashes.
  assert.equal(levelSyncVerdict(FULL_RULES, undefined, {}).ok, false);
  // a level the demo does not offer.
  assert.deepEqual(levelSyncVerdict(DEMO_RULES, { id: 'castle' }, {}), { ok: false, reason: 'demo' });
});

test('touristPlan carries the captain anchor only when it has one (m16)', () => {
  const from = { lat: 1, lon: 2, label: 'a' };
  assert.equal('anchor' in RoomProtocol.touristPlan(from, null), false);
  assert.deepEqual(RoomProtocol.touristPlan(from, null, { height: 231.5, anchored: 1, extra: 'x' }).anchor,
    { height: 231.5, anchored: true });
  assert.equal('anchor' in RoomProtocol.touristPlan(from, null, { height: NaN }), false);
});
