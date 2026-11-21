// The partner shown on Regulars and 5K Together, and a back-seat bot counting toward them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyStats, foldBests, migrateStats } from '../../js/achievement-defs.js';
import { toAccountDelta, fromAccount, emptyBase } from '../../js/account-stats.js';
import { isPhoneInput } from '../../js/controller-overlay-hud.js';

const storage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

test('a together best remembers its partner, through a save and the account', () => {
  const L = foldBests(emptyStats(), { finishedLevel: 'grandma', pairRides: 3, pairDistanceKm: 1, partnerLabel: 'Bolt' }, new Set(), 5000);
  assert.equal(L.bestsAt.pair_10_rides.partner, 'Bolt');
  assert.equal(L.bestsAt.pair_100km.partner, 'Bolt');
  assert.equal(migrateStats(L).bestsAt.pair_10_rides.partner, 'Bolt');
  const d = toAccountDelta(L, emptyBase());
  assert.equal(d.maxmap.bests.pair_10_rides[3], 'Bolt');
  assert.equal(fromAccount({ bests: d.maxmap.bests }).bestsAt.pair_10_rides.partner, 'Bolt');
});

test('a best from before partners were kept simply has none', () => {
  const L = migrateStats({ ...emptyStats(), bests: { pair_10_rides: 7 }, bestsAt: { pair_10_rides: { level: 'grandma', at: 1 } } });
  assert.equal(L.bestsAt.pair_10_rides.partner, undefined);
});

test('rides with a back-seat bot count toward Regulars and 5K Together, per bot', async () => {
  globalThis.localStorage = storage();
  const { AchievementManager } = await import('../../js/achievements.js');
  const m = new AchievementManager();
  m.demo = false;
  m.botPartner('bot:bolt', { rides: 9, distance: 4900 }, 'Bolt');
  assert.equal(m.getStats().bests.pair_10_rides, 9);
  assert.equal(m.getStats().bestsAt.pair_100km.partner, 'Bolt');
  const got = m.botPartner('bot:bolt', { rides: 10, distance: 5150 }, 'Bolt').map((a) => a.id);
  assert.ok(got.includes('pair_10_rides') && got.includes('pair_100km'), got.join());
});

test('a phone seat is a phone; a plain controller seat is not', () => {
  assert.ok(isPhoneInput({ remoteOnly: true }));
  assert.ok(isPhoneInput({ _remoteTilt: true }));
  assert.ok(!isPhoneInput({ gamepadConnected: true }));
  assert.ok(!isPhoneInput(null));
});
