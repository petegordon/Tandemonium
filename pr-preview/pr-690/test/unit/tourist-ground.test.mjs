// #402 · Map Tourist keeps the bike at street level: a synthetic fused mesh
// (ground plane + box "building" + sphere "tree") stands in for the Google
// tiles, raycast by a fake `tiles` object the same way TouristWorld does it.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TouristGround } from '../../js/tourist-ground.js';
import { TOURIST_TUNE } from '../../js/tourist-config.js';

const WHEEL = TOURIST_TUNE.wheelOffset;
const DT = 1 / 60;

/** `tiles` stand-in: a real Raycaster intersect against plain meshes. */
function fakeTiles(meshes) {
  return {
    meshes,   // tests swap this to "stream" tiles in and out
    raycast(raycaster, hits) {
      for (const m of this.meshes) { m.updateMatrixWorld(true); raycaster.intersectObject(m, false, hits); }
    },
  };
}

/** Flat ground at `y`, with an optional square hole (buildings have no floor). */
function ground(y, hole = null, size = 400) {
  const s = new THREE.Shape();
  s.moveTo(-size / 2, -size / 2); s.lineTo(size / 2, -size / 2);
  s.lineTo(size / 2, size / 2); s.lineTo(-size / 2, size / 2); s.closePath();
  if (hole) {
    const h = new THREE.Path();
    h.moveTo(hole.x0, hole.z0); h.lineTo(hole.x1, hole.z0);
    h.lineTo(hole.x1, hole.z1); h.lineTo(hole.x0, hole.z1); h.closePath();
    s.holes.push(h);
  }
  const geo = new THREE.ShapeGeometry(s);
  // ShapeGeometry faces +Z; rotate so it faces +Y with world z = -shape y.
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  mesh.position.y = y;
  return mesh;
}

/** Closed box "building": footprint x∈[x0,x1], z∈[-5,5], roof at y+height. */
function building(x0, x1, height, y = 0) {
  const w = x1 - x0;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, height, 10), new THREE.MeshBasicMaterial());
  mesh.position.set((x0 + x1) / 2, y + height / 2, 0);
  return mesh;
}

/** Sphere "tree crown" of radius r whose bottom is `clear` metres above y. */
function tree(x, r, clear, y = 0) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), new THREE.MeshBasicMaterial());
  mesh.position.set(x, y + clear + r, 0);
  return mesh;
}

/** `probe` is TOURIST_TUNE itself (anchored) or TOURIST_TUNE.customProbe (blind anchor). */
function follower(tiles, probe = TOURIST_TUNE) {
  return new TouristGround({ tiles, tune: TOURIST_TUNE, probeUp: probe.spawnProbeHeight, probeRay: probe.rayLength });
}

/** Tree trunk: a closed cylinder of radius r, `h` tall, standing on y. */
function trunk(x, r, h, y = 0) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 12), new THREE.MeshBasicMaterial());
  mesh.position.set(x, y + h / 2, 0);
  return mesh;
}

/** Bike yaw for travel along +x (bike-model: x += sin(heading), z += cos(heading)). */
const EAST = Math.PI / 2;

/**
 * Ride along +x at `speed` m/s for `metres`, applying groundY like the world
 * does. `heading` turns the forward probe on (undefined = the probe is off, as
 * before the bike has a heading to give).
 */
function ride(g, pos, metres, speed = 6, onStep = null, heading = undefined) {
  const steps = Math.ceil(metres / (speed * DT));
  for (let i = 0; i < steps; i++) {
    pos.x += speed * DT;
    const r = g.step(pos, DT, true, heading);
    pos.y = g.groundY;
    if (onStep) onStep(r, pos);
  }
}

test('spawn snaps to the ground in one step from a probe far above', () => {
  const g = follower(fakeTiles([ground(-150)]));
  const pos = new THREE.Vector3(0, WHEEL, 0);   // the anchor plane, 150 m up
  const r = g.step(pos, DT);
  assert.ok(r.hit, 'first probe hits');
  assert.equal(g.hasGround, true);
  assert.ok(Math.abs(g.groundY - (-150 + WHEEL)) < 1e-6, `snapped, not eased: ${g.groundY}`);
});

test('spawn under a tree lands on the street, not the crown', () => {
  const g = follower(fakeTiles([ground(0), tree(0, 3, 2)]));
  const pos = new THREE.Vector3(0, WHEEL, 0);
  g.step(pos, DT);
  assert.ok(Math.abs(g.groundY - WHEEL) < 1e-6, `street level, got ${g.groundY}`);
});

test('riding under a tree keeps the bike on the ground', () => {
  const g = follower(fakeTiles([ground(0), tree(-20, 3, 2)]));
  const pos = new THREE.Vector3(-40, WHEEL, 0);
  g.step(pos, DT);
  let maxY = -Infinity, hitsUnder = 0;
  ride(g, pos, 40, 6, (r, p) => {
    maxY = Math.max(maxY, p.y);
    if (Math.abs(p.x + 20) < 2.5 && r.hits > 1) hitsUnder++;
  });
  assert.ok(hitsUnder > 0, 'the probe did see the crown above the road');
  assert.ok(maxY < WHEEL + 0.05, `Y never left the road (max ${maxY.toFixed(2)})`);
  assert.ok(g.breadcrumbs.length >= 10, `breadcrumbs recorded (${g.breadcrumbs.length})`);
});

test('inside a building (forward probe off) the bike never climbs onto the roof; it resnaps to the street', () => {
  // The safety net under the wall bump: with no heading the forward probe is
  // off and the bike ends up inside. Long enough that it is still inside when
  // the resnap timer fires.
  const hole = { x0: 15, x1: 115, z0: -5, z1: 5 };
  const tiles = fakeTiles([ground(0, hole), building(15, 115, 12)]);
  const g = follower(tiles);
  const pos = new THREE.Vector3(0, WHEEL, 0);
  g.step(pos, DT);
  let maxY = -Infinity, resnaps = 0, blockedFrames = 0, sawRoof = false;
  // Keep pushing toward the building for a while: into the footprint the probe
  // only sees the roof (there is no floor under a photogrammetry building).
  const seconds = TOURIST_TUNE.ground.resnapAfter * 3;
  for (let t = 0; t < seconds; t += DT) {
    pos.x += 6 * DT;
    const r = g.step(pos, DT);
    pos.y = g.groundY;
    maxY = Math.max(maxY, pos.y);
    if (r.blocked) blockedFrames++;
    if (r.hits && !r.hit) sawRoof = true;
    if (r.resnapped) { resnaps++; assert.equal(r.resnapped, 'crumb'); assert.ok(pos.x < 15, `pulled back outside the footprint (x=${pos.x.toFixed(1)})`); }
  }
  assert.ok(sawRoof, 'the roof was probed and rejected');
  assert.ok(blockedFrames > 0, 'frames reported as blocked');
  assert.ok(maxY < 1, `never on the roof (max Y ${maxY.toFixed(2)})`);
  assert.ok(resnaps >= 1, `resnapped to a breadcrumb (${resnaps})`);
});

test('a roof the bike has already been placed on can still be ridden off', () => {
  // Spawn ON the roof (single hit at the spawn x/z: the roof), ride off the edge.
  const hole = { x0: -5, x1: 5, z0: -5, z1: 5 };
  const g = follower(fakeTiles([ground(0, hole), building(-5, 5, 8)]));
  const pos = new THREE.Vector3(0, WHEEL, 0);
  g.step(pos, DT);
  assert.ok(Math.abs(g.groundY - (8 + WHEEL)) < 1e-6, 'spawned on the roof (only surface there)');
  ride(g, pos, 30);
  assert.ok(Math.abs(g.groundY - WHEEL) < 0.05, `back on the street (${g.groundY.toFixed(2)})`);
});

test('a hit far below the anchor plane is not taken when the real ground is in range', () => {
  // Coarse "root tile" 1.3 km below the street, inside the probe's reach.
  const g = follower(fakeTiles([ground(-150), ground(-1500, null, 20000)]));
  const pos = new THREE.Vector3(0, WHEEL, 0);
  const r = g.step(pos, DT);
  // (≥ rather than ===: the ray down the shape's centre runs along a shared
  // triangle edge and both triangles report it — real tiles do this too.)
  assert.ok(r.hits >= 2, `both surfaces are in reach (${r.hits})`);
  assert.ok(Math.abs(g.groundY - (-150 + WHEEL)) < 1e-6, `snapped to the street (${g.groundY})`);
  let minY = Infinity;
  ride(g, pos, 60, 6, (_, p) => { minY = Math.min(minY, p.y); });
  assert.ok(minY > -151, `never dropped toward the root tile (min ${minY.toFixed(1)})`);
});

test('wall faces are ignored even when they are the only thing in the window', () => {
  // A steep ramp face (normal.y ≈ 0.3) sits just above the street; the street stays chosen.
  const slab = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  slab.rotateX(-Math.PI / 2 + Math.atan2(1, 0.3)); // tilt ~73° from horizontal
  slab.position.set(10, 0.3, 0);
  const g = follower(fakeTiles([ground(0), slab]));
  const pos = new THREE.Vector3(0, WHEEL, 0);
  g.step(pos, DT);
  let rejected = 0;
  ride(g, pos, 20, 6, (r) => { rejected += r.rejected; });
  assert.ok(rejected > 0, 'steep faces were probed and rejected');
  assert.ok(Math.abs(g.groundY - WHEEL) < 0.05, `stayed on the street (${g.groundY.toFixed(2)})`);
});

test('sustained no-hit resnaps to the last breadcrumb, then snaps fresh if the trail is stale', () => {
  const tiles = fakeTiles([ground(0)]);
  const g = follower(tiles);
  const pos = new THREE.Vector3(0, WHEEL, 0);
  g.step(pos, DT);
  ride(g, pos, 30);
  const crumbs = g.breadcrumbs.length;
  assert.ok(crumbs >= 8, `trail recorded (${crumbs})`);
  const last = { ...g.breadcrumbs[crumbs - 1] };

  // Tiles vanish: no hits at all. The bike holds, then is pulled back to the crumb.
  tiles.meshes = [];
  let resnapAt = null;
  for (let t = 0; t < TOURIST_TUNE.ground.resnapAfter + 1; t += DT) {
    pos.x += 6 * DT;
    const r = g.step(pos, DT);
    if (r.resnapped) { resnapAt = t; assert.equal(r.resnapped, 'crumb'); break; }
  }
  assert.ok(resnapAt !== null && resnapAt > TOURIST_TUNE.ground.resnapAfter - 0.1, `resnapped after ${resnapAt}s`);
  assert.ok(Math.abs(pos.x - last.x) < 1e-9 && Math.abs(pos.z - last.z) < 1e-9, 'bike sits on the last crumb');
  assert.ok(g.hasGround, 'ground still considered known');

  // The ground has moved far beyond the step window (a whole-tile LOD shift):
  // every breadcrumb is stale, so after resnapMaxTries the follower snaps fresh.
  tiles.meshes = [ground(40)];
  let fresh = false;
  for (let t = 0; t < TOURIST_TUNE.ground.resnapAfter * (TOURIST_TUNE.ground.resnapMaxTries + 2); t += DT) {
    const r = g.step(pos, DT);
    pos.y = g.groundY;
    if (r.resnapped === 'fresh') fresh = true;
    if (fresh && r.hit) break;
  }
  assert.ok(fresh, 'gave up on the stale trail');
  assert.ok(Math.abs(g.groundY - (40 + WHEEL)) < 1e-6, `fresh snap onto the new surface (${g.groundY})`);
});

test('a root-tile-only first hit recovers once the real surface streams in', () => {
  // The custom (blind-anchor) probe reaches 14 km: only the sagging root tile
  // has streamed on the first frame, so it is accepted (today's behaviour)…
  const tiles = fakeTiles([ground(-1500, null, 20000)]);
  const g = follower(tiles, TOURIST_TUNE.customProbe);
  const pos = new THREE.Vector3(0, WHEEL, 0);
  g.step(pos, DT);
  pos.y = g.groundY;
  assert.ok(g.groundY < -1000, 'started on the root tile');
  // …then the street arrives 1.35 km above the bike and REPLACES the root tile
  // (refinement swaps the coarse tile out). The probe origin clamps to the
  // anchor plane + probeUp, so the street is still in reach even from down
  // here, and the resnap → fresh-snap path brings the bike back up within a
  // few resnap periods.
  tiles.meshes = [ground(-150)];
  const budget = TOURIST_TUNE.ground.resnapAfter * (TOURIST_TUNE.ground.resnapMaxTries + 2);
  let t = 0;
  for (; t < budget; t += DT) {
    g.step(pos, DT);
    pos.y = g.groundY;
    if (Math.abs(g.groundY - (-150 + WHEEL)) < 1e-6) break;
  }
  assert.ok(Math.abs(g.groundY - (-150 + WHEEL)) < 1e-6, `climbed out after ${t.toFixed(1)}s (groundY ${g.groundY.toFixed(1)})`);
});

test('a low ceiling overhead with no ground under it resnaps immediately', () => {
  const hole = { x0: 10, x1: 30, z0: -5, z1: 5 };
  const tiles = fakeTiles([ground(0, hole), building(10, 30, 2.5)]);   // a carport
  const g = follower(tiles);
  const pos = new THREE.Vector3(0, WHEEL, 0);
  g.step(pos, DT);
  ride(g, pos, 9.5);
  const before = g.noGroundElapsed;
  let resnapped = null, frames = 0;
  while (!resnapped && frames < 60) {
    pos.x += 6 * DT; frames++;
    const r = g.step(pos, DT);
    resnapped = r.resnapped;
  }
  assert.equal(resnapped, 'crumb');
  assert.ok(frames * DT < TOURIST_TUNE.ground.resnapAfter / 2, `did not wait for the timer (${frames} frames, was ${before})`);
  assert.ok(pos.x < 10, `back outside (${pos.x.toFixed(1)})`);
});

// --- #402 §3 · Pete: "bump off walls and trees, go over cars and smaller shorter meshes" ---

test('a 1 m car ahead is ridden over: Y rises onto it and comes back down', () => {
  const hole = { x0: 20, x1: 24, z0: -1, z1: 1 };
  const g = follower(fakeTiles([ground(0, hole), building(20, 24, 1.0)]));   // 4 m long, 1 m high
  const pos = new THREE.Vector3(0, WHEEL, 0);
  g.step(pos, DT, true, EAST);
  let maxY = -Infinity, bumps = 0;
  ride(g, pos, 40, 6, (_, p) => { maxY = Math.max(maxY, p.y); if (g.bump) bumps++; }, EAST);
  assert.equal(bumps, 0, 'a car is not a wall');
  assert.ok(maxY > 1.0 + WHEEL - 0.05, `rose onto the roof (max Y ${maxY.toFixed(2)})`);
  assert.ok(pos.x > 24, `rolled on past it (x=${pos.x.toFixed(1)})`);
  assert.ok(Math.abs(g.groundY - WHEEL) < 0.05, `back on the street (${g.groundY.toFixed(2)})`);
});

test('a 4 m wall ahead is a bump: the bike is held off it and Y stays on the street', () => {
  const G = TOURIST_TUNE.ground;
  const hole = { x0: 20, x1: 30, z0: -5, z1: 5 };
  const g = follower(fakeTiles([ground(0, hole), building(20, 30, 4)]));
  const pos = new THREE.Vector3(0, WHEEL, 0);
  g.step(pos, DT, true, EAST);
  let maxY = -Infinity, bumps = 0, firstBump = null, maxX = -Infinity;
  ride(g, pos, 40, 6, (_, p) => {
    maxY = Math.max(maxY, p.y); maxX = Math.max(maxX, p.x);
    if (g.bump) { bumps++; if (!firstBump) firstBump = { ...g.bump, x: p.x }; }
  }, EAST);
  assert.ok(bumps > 0, 'the wall bumped');
  assert.ok(firstBump.distance <= G.bumpDist, `bumped within bumpDist (${firstBump.distance.toFixed(2)})`);
  assert.ok(Math.abs(firstBump.x - (20 - G.bumpDist - G.bumpClearance)) < 0.05, `pushed back to clearance (x=${firstBump.x.toFixed(2)})`);
  assert.ok(maxX < 20, `never entered the wall (max x ${maxX.toFixed(2)})`);
  assert.ok(maxY < WHEEL + 0.05, `Y stayed on the street (max ${maxY.toFixed(2)})`);
});

test('a tree trunk bumps; its crown overhead does not', () => {
  const hole = { x0: -20.5, x1: -19.5, z0: -0.5, z1: 0.5 };
  const g = follower(fakeTiles([ground(0, hole), trunk(-20, 0.5, 2.5), tree(-20, 3, 2.5)]));
  const pos = new THREE.Vector3(-40, WHEEL, 0);
  g.step(pos, DT, true, EAST);
  let bumps = 0, maxY = -Infinity, maxX = -Infinity;
  ride(g, pos, 30, 6, (_, p) => { if (g.bump) bumps++; maxY = Math.max(maxY, p.y); maxX = Math.max(maxX, p.x); }, EAST);
  assert.ok(bumps > 0, 'the trunk bumped');
  assert.ok(maxX < -20.5, `held off the trunk (max x ${maxX.toFixed(2)})`);
  assert.ok(maxY < WHEEL + 0.05, `never lifted into the crown (max Y ${maxY.toFixed(2)})`);
});

test('the forward probe sees nothing on open street and does not fire on a kerb', () => {
  // A 0.15 m kerb: below forwardLift, so the forward ray passes over it and the
  // step window alone takes the bike up it.
  const hole = { x0: 10, x1: 60, z0: -5, z1: 5 };
  const g = follower(fakeTiles([ground(0, hole), building(10, 60, 0.15)]));
  const pos = new THREE.Vector3(0, WHEEL, 0);
  g.step(pos, DT, true, EAST);
  let bumps = 0;
  ride(g, pos, 30, 6, () => { if (g.bump) bumps++; }, EAST);
  assert.equal(bumps, 0);
  assert.ok(Math.abs(g.groundY - (0.15 + WHEEL)) < 0.05, `up the kerb (${g.groundY.toFixed(2)})`);
});
