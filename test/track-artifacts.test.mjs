// Node smoke test for pure-logic track-artifact pieces.
// Run with:  node test/track-artifacts.test.mjs
//
// Doesn't load Three.js — only tests the manifest validator + road-frame
// math + the JSON manifests for tutorial / grandma / castle.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const { validateManifest } = await import(join(root, 'js/artifacts/track-manifest.js'));
const { pointInRoadRect, roadFrame, inVisibilityWindow } =
  await import(join(root, 'js/artifacts/artifact-base.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.log(`  FAIL  ${name}`, extra || ''); }
};

// ---------- validator ----------
console.log('# validator');
{
  const m = { schemaVersion: 1, artifacts: [
    { type: 'boost', d: 50 },
    { type: 'mud',   d: 100 },
    { type: 'ramp',  d: 150, angle: 50 }, // angle clamped to 35
    { type: 'choke', d: 200, gap: 0.5 },  // gap clamped to 1.2
    { type: 'sync',  d: 250 },
    { type: 'drawbridge', d: 300, downRatio: 0.1 } // clamped to 0.4
  ] };
  const r = validateManifest(m, 350, [88, 176, 264]);
  ok('validates a manifest', r.ok, r.errors);
  ok('ramp angle clamped',       m.artifacts[2].angle === 35);
  ok('choke gap clamped',        m.artifacts[3].gap === 1.2);
  ok('drawbridge downRatio clamped', m.artifacts[5].downRatio === 0.4);
}
{
  const r = validateManifest({ schemaVersion: 1, artifacts: [{ type: 'unknown', d: 10 }] }, 100, []);
  ok('rejects unknown type', !r.ok);
}
{
  const r = validateManifest({ schemaVersion: 2, artifacts: [] }, 100, []);
  ok('rejects wrong schema version', !r.ok);
}
{
  const r = validateManifest({ schemaVersion: 1, artifacts: [{ type: 'boost', d: 200 }] }, 100, []);
  ok('rejects d > distance-5', !r.ok);
}
{
  const m = { schemaVersion: 1, artifacts: [{ type: 'boost', d: 80 }] };
  const r = validateManifest(m, 100, [80]);
  ok('warns on checkpoint clearance', r.ok && r.warnings.length > 0);
}

// ---------- road-frame math ----------
console.log('# road-frame math');
// Fake straight road along +Z, y=0
const roadPath = {
  loopLength: 1200,
  getPointAtDistance(d) { return { x: 0, y: 0, z: d, heading: 0 }; }
};
{
  const f = roadFrame(roadPath, 100, 1.5);
  ok('straight road lateral offset', Math.abs(f.x - 1.5) < 1e-6 && Math.abs(f.z - 100) < 1e-6);
  ok('straight road forward = +Z', Math.abs(f.forwardZ - 1) < 1e-6 && Math.abs(f.forwardX) < 1e-6);
}

// Heading = π/2 (east-pointing): forward = +X, right = -Z (since right is heading - 90deg)
const eastRoad = {
  loopLength: 1200,
  getPointAtDistance(d) { return { x: d, y: 0, z: 0, heading: Math.PI / 2 }; }
};
{
  const f = roadFrame(eastRoad, 50, 0);
  ok('east road forward = +X', Math.abs(f.forwardX - 1) < 1e-6 && Math.abs(f.forwardZ) < 1e-6);
}

// ---------- pointInRoadRect ----------
console.log('# pointInRoadRect');
{
  // 2x4 rect at d=100, offset 0 on straight road
  const inside = pointInRoadRect(roadPath, 100, 0, 2, 4, { x: 0, z: 100 });
  ok('center hit',         inside !== null);
  const justInside = pointInRoadRect(roadPath, 100, 0, 2, 4, { x: 0.9, z: 101.9 });
  ok('near corner hit',    justInside !== null);
  const tooFarX = pointInRoadRect(roadPath, 100, 0, 2, 4, { x: 1.5, z: 100 });
  ok('outside wide miss',  tooFarX === null);
  const tooFarZ = pointInRoadRect(roadPath, 100, 0, 2, 4, { x: 0, z: 103 });
  ok('outside long miss',  tooFarZ === null);
  const offset = pointInRoadRect(roadPath, 100, 1.0, 2, 4, { x: 1.0, z: 100 });
  ok('lateral offset hit', offset !== null);
}

// ---------- visibility window ----------
console.log('# visibility window');
{
  ok('right ahead', inVisibilityWindow(150, 100, 1200) === true);
  ok('just behind', inVisibilityWindow(95,  100, 1200) === true);
  ok('too far ahead', inVisibilityWindow(400, 100, 1200) === false);
  ok('too far behind', inVisibilityWindow(40,  100, 1200) === false);
}

// ---------- built-in manifests ----------
console.log('# built-in manifests');
async function loadAndCheck(file, dist, cps) {
  const raw = await readFile(join(root, file), 'utf8');
  const m = JSON.parse(raw);
  const r = validateManifest(m, dist, cps);
  ok(`${file}: valid`, r.ok, r.errors);
  if (r.warnings.length) console.log(`         warnings:`, r.warnings);
}
const grandmaCps = [88, 176, 264];
const castleCps = [175, 350, 525];
await loadAndCheck('assets/tracks/tutorial.json', 225, [225]);
await loadAndCheck('assets/tracks/grandma.json', 350, grandmaCps);
await loadAndCheck('assets/tracks/castle.json',  700, castleCps);

// ---------- summary ----------
console.log('');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
