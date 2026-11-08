// PR #397 M1 / m16 / m17 / m18 — rooms that mix editions (demo ↔ full) or
// versions (this build ↔ the deployed one): the room profile's { edition,
// caps }, the "most restrictive" merge, and what the stoker does with a
// levelSync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL_RULES, DEMO_RULES, ROOM_CAPS, roomProfileFields, partnerFromProfile,
  mergeRoomRules, levelSyncVerdict, roomBadge
} from '../../js/edition.js';
import { RoomProtocol, ROOM_MSG } from '../../js/lobby/room-protocol.js';
import { LEVELS } from '../../js/race-config.js';

const lvl = id => LEVELS.find(l => l.id === id);
const FULL_NEW = { edition: 'full', caps: [...ROOM_CAPS] };
const DEMO_NEW = { edition: 'demo', caps: [...ROOM_CAPS] };
// The build before #666: no guestPass, and a demo did not advertise tourist.
const FULL_PRE = { edition: 'full', caps: ['tourist', 'helpingHand', 'weeklyRoad', 'v2LevelSync'] };
const DEMO_PRE = { edition: 'demo', caps: ['helpingHand', 'weeklyRoad', 'v2LevelSync'] };

test('room profile fields: edition + caps; every edition understands the Tourist barrier (#666)', () => {
  assert.deepEqual(roomProfileFields(FULL_RULES), { edition: 'full', caps: [...ROOM_CAPS] });
  const demo = roomProfileFields(DEMO_RULES);
  assert.equal(demo.edition, 'demo');
  assert.ok(demo.caps.includes('tourist') && demo.caps.includes('guestPass'));
  assert.ok(demo.caps.includes('v2LevelSync') && demo.caps.includes('helpingHand'));
});

test('a profile without caps is an OLD client', () => {
  assert.deepEqual(partnerFromProfile({ name: 'x', achievements: [] }), { edition: 'full', caps: null });
  assert.deepEqual(partnerFromProfile({ edition: 'demo', caps: ['tourist', 7] }), { edition: 'demo', caps: ['tourist'] });
  assert.equal(partnerFromProfile(null), null);
});

// #666 (Pete, 2026-11-07): the HOST's edition sets the room; the host is the captain.
// Both sides of each pair must agree, so each row is checked from both seats.
const isFull = r => !r.isDemo && r.levels === null && r.dailyRideCap === null && r.versus === true;
const isDemoRoom = r => r.isDemo && r.dailyRideCap === 3 && r.versus === false &&
  JSON.stringify([...r.levels]) === JSON.stringify([...DEMO_RULES.levels]);

test('#666 host full + guest demo: a full-game room (the guest rides on a guest pass)', () => {
  const host = mergeRoomRules(FULL_RULES, DEMO_NEW, 'captain');
  const guest = mergeRoomRules(DEMO_RULES, FULL_NEW, 'stoker');
  for (const r of [host, guest]) {
    assert.ok(isFull(r), JSON.stringify(r));
    assert.equal(r.hostEdition, 'full');
    assert.equal(r.tourist, true, 'Map Tourists: any level');
    assert.deepEqual([...r.dailyNeeds], []);
    assert.equal(r.achievements, null);
  }
  assert.equal(host.guestPass, false);
  assert.equal(guest.guestPass, true, 'the demo side knows its full-game achievements are held');
  assert.equal(roomBadge(host), 'Full game room');
  assert.equal(roomBadge(guest), 'Full game room');
});

test('#666 host full + guest full: full; nobody is on a guest pass', () => {
  const host = mergeRoomRules(FULL_RULES, FULL_NEW, 'captain');
  const guest = mergeRoomRules(FULL_RULES, FULL_NEW, 'stoker');
  for (const r of [host, guest]) {
    assert.ok(isFull(r)); assert.equal(r.tourist, true); assert.equal(r.helpingHand, true);
    assert.equal(r.guestPass, false); assert.equal(roomBadge(r), 'Full game room');
  }
});

test('#666 host demo + guest full: a demo room (demo levels, co-op, Daily 3/day)', () => {
  const host = mergeRoomRules(DEMO_RULES, FULL_NEW, 'captain');
  const guest = mergeRoomRules(FULL_RULES, DEMO_NEW, 'stoker');
  for (const r of [host, guest]) {
    assert.ok(isDemoRoom(r), JSON.stringify(r));
    assert.equal(r.hostEdition, 'demo'); assert.equal(r.tourist, false);
    assert.equal(r.guestPass, false, 'a full guest in a demo room holds nothing back');
    assert.equal(roomBadge(r), 'Demo room');
  }
});

test('#666 host demo + guest demo: demo; only the 20 demo achievements', () => {
  const host = mergeRoomRules(DEMO_RULES, DEMO_NEW, 'captain');
  const guest = mergeRoomRules(DEMO_RULES, DEMO_NEW, 'stoker');
  for (const r of [host, guest]) {
    assert.ok(isDemoRoom(r)); assert.equal(r.guestPass, false);
    assert.equal(r.achievements.length, 20); assert.equal(roomBadge(r), 'Demo room');
  }
});

test('#666 a partner from before the guest pass keeps the old MOST RESTRICTIVE rule', () => {
  // An older full host still offers only the demo's levels to a demo guest (and an older
  // demo guest still refuses the rest), so both sides of such a room ride demo rules.
  assert.ok(isDemoRoom(mergeRoomRules(DEMO_RULES, FULL_PRE, 'stoker')));
  assert.ok(isDemoRoom(mergeRoomRules(FULL_RULES, DEMO_PRE, 'captain')));
  assert.equal(mergeRoomRules(FULL_RULES, DEMO_PRE, 'captain').tourist, false);
  assert.ok(isDemoRoom(mergeRoomRules(DEMO_RULES, FULL_PRE, 'captain')));
  assert.ok(isFull(mergeRoomRules(FULL_RULES, FULL_PRE, 'stoker')));
  // the host not heard from yet: a guest rides by its own edition meanwhile.
  assert.ok(isDemoRoom(mergeRoomRules(DEMO_RULES, null, 'stoker')));
  assert.equal(mergeRoomRules(DEMO_RULES, null, 'stoker').guestPass, false);
  // the role defaults to the host's seat.
  assert.ok(isFull(mergeRoomRules(FULL_RULES, DEMO_NEW)));
});

test('partner without the tourist cap: no Map Tourists, the rest stays', () => {
  const nt = mergeRoomRules(FULL_RULES, { edition: 'full', caps: ['helpingHand', 'guestPass'] });
  assert.equal(nt.tourist, false); assert.equal(nt.helpingHand, true);
});

test('an OLD partner (or one not heard from yet): no Map Tourists, no helping hand (m18)', () => {
  for (const partner of [{ edition: 'full', caps: null }, null]) {
    const r = mergeRoomRules(FULL_RULES, partner);
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

test('stoker verdict: one shared road for both editions (#641), refuses what its edition lacks (m17)', () => {
  // #641: the Daily Ride is the same road in the demo and the full game.
  assert.deepEqual(levelSyncVerdict(FULL_RULES, lvl('daily'), { roadKind: 'daily' }), { ok: true, roadKind: 'daily' });
  assert.deepEqual(levelSyncVerdict(DEMO_RULES, lvl('daily'), { roadKind: 'daily' }), { ok: true, roadKind: 'daily' });
  assert.deepEqual(levelSyncVerdict(DEMO_RULES, lvl('daily'), { key: '2026-10-05', seed: 1 }), { ok: true, roadKind: 'daily' });
  // an old #400 demo captain's Weekly Ride can't be built any more.
  assert.deepEqual(levelSyncVerdict(FULL_RULES, lvl('daily'), { roadKind: 'weekly' }), { ok: false, reason: 'level' });
  assert.deepEqual(levelSyncVerdict(DEMO_RULES, lvl('daily'), { roadKind: 'weekly' }), { ok: false, reason: 'level' });
  assert.deepEqual(levelSyncVerdict(DEMO_RULES, lvl('grandma'), {}), { ok: true, roadKind: null });
  // a level this build doesn't know (a newer captain) is refused, never crashes.
  assert.equal(levelSyncVerdict(FULL_RULES, undefined, {}).ok, false);
  // a level the demo does not offer.
  assert.deepEqual(levelSyncVerdict(DEMO_RULES, { id: 'castle' }, {}), { ok: false, reason: 'demo' });
  // #666: the stoker judges by the ROOM's rules: a demo guest in a full host's room rides it.
  const guestRoom = mergeRoomRules(DEMO_RULES, FULL_NEW, 'stoker');
  assert.deepEqual(levelSyncVerdict(guestRoom, { id: 'castle' }, {}), { ok: true, roadKind: null });
  const preRoom = mergeRoomRules(DEMO_RULES, FULL_PRE, 'stoker');
  assert.deepEqual(levelSyncVerdict(preRoom, { id: 'castle' }, {}), { ok: false, reason: 'demo' });
});

test('touristPlan carries the captain anchor only when it has one (m16)', () => {
  const from = { lat: 1, lon: 2, label: 'a' };
  assert.equal('anchor' in RoomProtocol.touristPlan(from, null), false);
  assert.deepEqual(RoomProtocol.touristPlan(from, null, { height: 231.5, anchored: 1, extra: 'x' }).anchor,
    { height: 231.5, anchored: true });
  assert.equal('anchor' in RoomProtocol.touristPlan(from, null, { height: NaN }), false);
});
