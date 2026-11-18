// One paid Google tiles session per run of the game (js/tourist-tiles-session.js), and the odometer
// that ends a ride AT its destination (js/tourist-odometer.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TilesSessionPlugin, SESSION_REUSE_MS, rootRequestCount, forgetTilesSession } from '../../js/tourist-tiles-session.js';
import { TouristOdometer, ARRIVE_M } from '../../js/tourist-odometer.js';

const ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json?key=k';
const rootJson = (session) => JSON.stringify({ asset: { version: '1.0' }, root: { children: [{ content: { uri: `/v1/3dtiles/datasets/x/files/y.json?session=${session}` } }] } });

test('the root is asked for once and handed to every later ride; tiles are left to Google\'s plugin', async () => {
  forgetTilesSession();
  const asked = [];
  let now = 1000;
  const before = rootRequestCount();
  const fetchImpl = async (uri) => { asked.push(String(uri)); return new Response(rootJson('s' + asked.length), { status: 200 }); };
  const first = new TilesSessionPlugin({ now: () => now, fetchImpl });
  assert.ok(first.priority < 0, 'ahead of the library\'s other plugins');
  assert.equal(first.fetchData('https://tile.googleapis.com/v1/3dtiles/datasets/x/files/y.glb?session=s1&key=k'), null, 'not a root: the next plugin\'s');
  const a = await (await first.fetchData(ROOT, {})).json();
  assert.equal(first.reused, false);
  assert.equal(asked.length, 1);

  now += 60 * 60 * 1000;                               // an hour and another ride later
  const second = new TilesSessionPlugin({ now: () => now, fetchImpl });
  const res = await second.fetchData(ROOT, {});
  assert.equal(res.ok, true);
  const b = await res.json();
  assert.equal(second.reused, true);
  assert.equal(asked.length, 1, 'no second request');
  assert.deepEqual(b, a, 'the same root, so the same session token');
  assert.equal(rootRequestCount() - before, 1);

  now += SESSION_REUSE_MS;                             // past the reuse window: a new one
  const third = new TilesSessionPlugin({ now: () => now, fetchImpl });
  const c = await (await third.fetchData(ROOT, {})).json();
  assert.equal(third.reused, false);
  assert.equal(asked.length, 2);
  assert.notDeepEqual(c, a);
});

test('a refused root is passed on as it is, and not kept', async () => {
  forgetTilesSession();
  let n = 0;
  const fetchImpl = async () => { n++; return n === 1 ? new Response('denied', { status: 403 }) : new Response(rootJson('ok'), { status: 200 }); };
  const p = new TilesSessionPlugin({ fetchImpl });
  assert.equal((await p.fetchData(ROOT, {})).status, 403);
  const q = new TilesSessionPlugin({ fetchImpl });
  assert.equal((await q.fetchData(ROOT, {})).status, 200);
  assert.equal(q.reused, false, 'the refusal was not reused');
  assert.equal(n, 2);
});

test('a ride toward a point arrives at the point, not at a line across the map', () => {
  const target = { x: 0, z: 1000 };
  const odo = new TouristOdometer({ target, lengthM: 1000 });
  odo.rebase(0, 0, 0);
  const ride = (x, z) => { let d = odo.distance; const steps = 40; const lx = odo._last.x, lz = odo._last.z;
    for (let i = 1; i <= steps; i++) d = odo.update(lx + (x - lx) * i / steps, lz + (z - lz) * i / steps, d); return d; };
  assert.equal(odo.update(0, 0, 0), 0, 'nothing ridden, nothing counted');
  assert.ok(Math.abs(ride(0, 20) - 20) < 1, '20 m toward it is 20 m');
  assert.ok(Math.abs(ride(0, 500) - 1000 * (1 - (500 - ARRIVE_M) / (1000 - ARRIVE_M))) < 0.01, 'half way there (the leg is spread over what can be ridden)');
  // riding sideways gains nothing, and riding away loses nothing
  const half = odo.distance;
  assert.equal(ride(300, 500), half);
  assert.equal(ride(300, 200), half);
  // passing the destination 400 m to the side is not arriving
  assert.ok(ride(400, 1000) < 1000 - 300);
  // at the door it is
  assert.equal(ride(5, 995), 1000);
});

test('a ride\'s second leg carries on from what was already counted', () => {
  const odo = new TouristOdometer({ target: { x: 0, z: 2500 }, lengthM: 2500, startM: 2500 });
  odo.rebase(0, 0, 2500);
  assert.ok(Math.abs(odo.update(0, 1, 2500) - 2501) < 0.05, 'a metre into the second leg');
  let d = odo.distance;
  for (let z = 10; z <= 2500; z += 10) d = odo.update(0, z, d);
  assert.equal(d, 5000);
  // a reset to nothing (a restart) starts this leg again, never below where it began
  assert.equal(odo.update(0, 0, 0), 2500);
});
