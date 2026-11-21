// #824 · Tourist's limits, the session hooks and the cost estimate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TILE_SESSION_LIMIT, emptyUsage, readUsage, mergeUsage, sessionGate, countSession, noteAddresses, storeWithUsage, sessionText,
} from '../../js/tourist-limits.js';
import { NEW_PLACE_LIMIT, emptyStore, periodStart } from '../../js/tourist-places.js';
import { TilesSessionPlugin, setTilesSessionHooks, forgetTilesSession, hasLiveTilesSession, watchTileRefusals } from '../../js/tourist-tiles-session.js';
import { TOURIST_PRICES, pricesOn, serviceCost, monthCost } from '../../js/tourist-costs.js';
import { emptyStats, migrateStats } from '../../js/achievement-defs.js';
import { toAccountDelta, fromAccount, mergeAfterSync, emptyBase } from '../../js/account-stats.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json?key=k';
const TILE = 'https://tile.googleapis.com/v1/3dtiles/datasets/x/files/y.glb?session=s';

test('the limits: 5 new addresses a week, 5 sessions a day', () => {
  assert.deepEqual({ ...NEW_PLACE_LIMIT }, { count: 5, days: 7 });
  assert.deepEqual({ ...TILE_SESSION_LIMIT }, { count: 5, days: 1 });
});

test('the 5th session is allowed, the 6th is not, and local midnight resets it', () => {
  const now = at(2026, 11, 21);
  let u = emptyUsage();
  for (let i = 0; i < 4; i++) u = countSession(u, now);
  assert.deepEqual([sessionGate(u, now).left, sessionGate(u, now).allowed], [1, true]);
  u = countSession(u, now);
  assert.deepEqual([sessionGate(u, now).left, sessionGate(u, now).allowed], [0, false]);
  assert.equal(sessionGate(u, now).resetsAt, new Date(2026, 10, 22).getTime());
  assert.match(sessionText(sessionGate(u, now), now), /used today’s 5 map sessions\. More tomorrow/);
  assert.equal(sessionGate(u, at(2026, 11, 21, 23)).allowed, false);
  assert.equal(sessionGate(u, at(2026, 11, 22, 0)).left, 5);
  assert.deepEqual([countSession(u, at(2026, 11, 22, 0)).sessions], [1]);
});

test('a live session always rides, with no sessions left', () => {
  const now = at(2026, 11, 21);
  let u = emptyUsage();
  for (let i = 0; i < 5; i++) u = countSession(u, now);
  const g = sessionGate(u, now, true);
  assert.deepEqual([g.left, g.allowed], [0, true]);
});

test('device and account: the newer period, the higher count, so sign-in cannot refill it', () => {
  const a = { day: '2026-11-21', sessions: 2, week: '2026-11-16', addresses: 4 };
  const b = { day: '2026-11-21', sessions: 5, week: '2026-11-09', addresses: 5 };
  assert.deepEqual(mergeUsage(a, b), { day: '2026-11-21', sessions: 5, week: '2026-11-16', addresses: 4 });
  assert.deepEqual(mergeUsage(b, a), mergeUsage(a, b));
  assert.deepEqual(readUsage('junk'), emptyUsage());
  const now = at(2026, 11, 21);
  const week = periodStart(now);
  assert.equal(storeWithUsage({ ...emptyStore(), week, used: 1 }, { week, addresses: 4 }, now).used, 4);
  assert.equal(storeWithUsage({ ...emptyStore(), week, used: 3 }, { week, addresses: 2 }, now).used, 3);
  assert.equal(noteAddresses(emptyUsage(), week, 2).addresses, 2);
});

test('the counts travel on the account stats and merge the same way', () => {
  const L = { ...emptyStats(), touristSessions: ['2026-11-21', 3], touristAddresses: ['2026-11-16', 2] };
  assert.deepEqual(migrateStats(L).touristSessions, ['2026-11-21', 3]);
  const d = toAccountDelta(L, emptyBase());
  assert.deepEqual(d.latest.touristSessions, ['2026-11-21', 3]);
  assert.deepEqual(fromAccount({ touristSessions: ['2026-11-21', 4] }).touristSessions, ['2026-11-21', 4]);
  const merged = mergeAfterSync({ touristSessions: ['2026-11-21', 2], touristAddresses: ['2026-11-16', 5] }, L, L);
  assert.deepEqual(merged.touristSessions, ['2026-11-21', 3]);
  assert.deepEqual(merged.touristAddresses, ['2026-11-16', 5]);
});

test('only a real answered root counts: a reused one does not, nor a refused or failed one', async () => {
  forgetTilesSession();
  const roots = [], refused = [];
  let reused = 0;
  setTilesSessionHooks({ onRoot: (r) => roots.push(r), onReused: () => { reused++; }, onRefused: (s) => refused.push(s) });
  const now = () => 1000;
  await new TilesSessionPlugin({ now, fetchImpl: async () => new Response('{}', { status: 403 }) }).fetchData(ROOT, {});
  assert.deepEqual(roots, [{ ok: false, status: 403 }]);
  assert.deepEqual(refused, [403]);
  assert.equal(hasLiveTilesSession(1000), false);
  await assert.rejects(new TilesSessionPlugin({ now, fetchImpl: async () => { throw new Error('offline'); } }).fetchData(ROOT, {}));
  assert.deepEqual(roots[1], { ok: false, status: 0 });
  await new TilesSessionPlugin({ now, fetchImpl: async () => new Response('{"root":1}') }).fetchData(ROOT, {});
  assert.deepEqual(roots[2], { ok: true, status: 200 });
  assert.equal(hasLiveTilesSession(1000), true);
  await new TilesSessionPlugin({ now, fetchImpl: async () => { throw new Error('no second request'); } }).fetchData(ROOT, {});
  assert.equal(roots.length, 3);
  assert.equal(reused, 1);
  setTilesSessionHooks(null);
  forgetTilesSession();
});

test('tiles: 429 is refused at once; one 403 is an expired token, three in a row are refused', async () => {
  const refused = [];
  setTilesSessionHooks({ onRefused: (s) => refused.push(s) });
  const real = globalThis.fetch;
  let status = 403;
  globalThis.fetch = async () => new Response('', { status });
  const stop = watchTileRefusals(() => 5000);
  await fetch(TILE);
  assert.deepEqual(refused, []);
  await fetch(TILE); await fetch(TILE);
  assert.deepEqual(refused, [403]);
  status = 429;
  await fetch(TILE);
  assert.deepEqual(refused, [403, 429]);
  stop();
  globalThis.fetch = real;
  setTilesSessionHooks(null);
});

test('cost comes from the dated price table, after the free tier', () => {
  const p = pricesOn('2026-11', TOURIST_PRICES);
  assert.equal(serviceCost(1000, p.tiles), 0);
  assert.ok(Math.abs(serviceCost(1500, p.tiles) - 3) < 1e-9);
  const m = monthCost('2026-11', { tiles: 2000, geocode: 10500, elevation: 5200 });
  assert.ok(Math.abs(m.total - (6 + 2.5 + 1)) < 1e-9);
  const later = [...TOURIST_PRICES, { ...TOURIST_PRICES[0], from: '2027-01-01', tiles: { free: 0, tiers: [{ upTo: null, per1000: 10 }] } }];
  assert.equal(pricesOn('2026-12', later).from, '2026-10-16');
  assert.equal(pricesOn('2027-01', later).from, '2027-01-01');
});
