#!/usr/bin/env node
// ragdoll-sim.mjs — the crash rag doll in Node (#507): CrashScene + Rapier on a synthetic seated goose
// skeleton, no browser. Prints how heavy and how rubbery a crash reads:
//   settle   seconds until every rag doll body is nearly at rest (speed < 0.25 m/s, spin < 1 rad/s)
//   bounces  times the pelvis left the ground again after first landing
//   gap      the widest a ball joint pulled apart (m)
//   fold     the widest a knee / elbow bent away from its seated angle (deg; rubber = big, both ways)
//   neck     peak head spin (rad/s) — the long neck is the joke, it may stay loose
//   land     seconds to the pelvis's first ground contact vs a ballistic drop (> 1 = floaty, damped)
//   node scripts/ragdoll-sim.mjs [--scene js/physics/crash-scene.js] [--speed 9] [--cause balance|obstacle] [--seed 1] [--json]
// Needs vendor/rapier.mjs (npm run download-vendors).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const SCENE = opt('--scene', 'js/physics/crash-scene.js');
const SPEEDS = opt('--speed', '5,9,13').split(',').map(Number);
const CAUSES = opt('--cause', 'balance,obstacle').split(',');
const SEEDS = Number(opt('--seeds', 3));
const JSON_OUT = args.includes('--json');

const { CrashScene } = await import(pathToFileURL(path.resolve(SCENE)).href);
if (args.includes('--notone') && CrashScene.prototype._tone) CrashScene.prototype._tone = function () {};   // the tone off, for comparison
const R = await import(pathToFileURL(path.resolve('vendor/rapier.mjs')).href);
await R.init();

function seeded(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** A seated goose, game units (the goose tandem is 4.4 m long; hip to head ≈ 0.95 m). sx mirrors a side. */
const SEATED = {
  Hips: [0, 0, 0], Spine: [0, 0.12, 0.02], Neck: [0, 0.42, 0.06], Neck2: [0, 0.62, 0.13], Head: [0, 0.85, 0.2], HatSocket: [0, 0.96, 0.22],
  LeftArm: [0.2, 0.36, 0.05], LeftForeArm: [0.22, 0.2, 0.3], LeftHand: [0.2, 0.05, 0.46],
  LeftUpLeg: [0.15, -0.02, 0.05], LeftLeg: [0.17, -0.05, 0.42], LeftFoot: [0.17, -0.45, 0.4], LeftToeBase: [0.17, -0.5, 0.55],
};
const TREE = { Spine: 'Hips', Neck: 'Spine', Neck2: 'Neck', Head: 'Neck2', HatSocket: 'Head',
  LeftArm: 'Spine', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm', LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot' };

function goose(at, heading) {
  const root = new THREE.Group();
  root.position.copy(at);
  root.rotation.y = heading;
  root.userData.hatOnSocket = true;
  const bones = {};
  const mk = (name, p) => { const b = new THREE.Bone(); b.name = name; b.position.set(...p); bones[name] = b; return b; };
  const world = {};
  for (const [n, p] of Object.entries(SEATED)) {
    world[n] = p;
    if (n.startsWith('Left')) world[n.replace('Left', 'Right')] = [-p[0], p[1], p[2]];
  }
  const parentOf = (n) => n.startsWith('Right') ? (TREE[n.replace('Right', 'Left')] || '').replace('Left', 'Right') : TREE[n];
  for (const n of Object.keys(world)) {
    const pn = parentOf(n), pw = pn ? world[pn] : [0, 0, 0];
    const local = pn ? [world[n][0] - pw[0], world[n][1] - pw[1], world[n][2] - pw[2]] : world[n];
    mk(n, local);
  }
  for (const n of Object.keys(world)) { const pn = parentOf(n); (pn ? bones[pn] : root).add(bones[n]); }
  root.updateMatrixWorld(true);
  return { root, bones };
}

function crash({ speed, cause, seed }) {
  const rand = seeded(seed);
  const heading = 0.4;
  const group = new THREE.Group();
  group.position.set(0, 0, 0);
  const model = new THREE.Group();      // no parts rig: the one-piece tumble
  group.add(model);
  new THREE.Group().add(group);         // a parent, as in the scene graph
  group.updateMatrixWorld(true);
  const riders = {};
  for (const [seat, dz] of [['Captain', 0.9], ['Stoker', -0.5]]) {
    const at = new THREE.Vector3(Math.sin(heading) * dz, 1.65, Math.cos(heading) * dz);
    const g = goose(at, heading);
    group.add(g.root);
    riders[seat] = { root: g.root };
  }
  group.updateMatrixWorld(true);
  const bike = { speed, heading, lean: cause === 'balance' ? 1.3 : 0.1, position: new THREE.Vector3(0, 0, 0), group, goose: { riders }, roadD: 0 };
  const scene = new CrashScene(R, { bike, groundAt: () => 0, cause, rand, slowMo: false, parts: false });
  const dt = 1 / 60, T = 4.0;
  const pelvis = scene.riders.map(rd => rd.segs[0].body);
  const bodies = scene.riders.flatMap(rd => rd.segs.map(s => s.body));
  let settle = null, gap = 0, bounces = 0, landed = null, neck = 0, fold = 0, tone = 0;
  const wasDown = pelvis.map(() => false), lastVy = pelvis.map(() => 0);
  const pairs = scene.riders.flatMap(rd => {
    const by = Object.fromEntries(rd.segs.map(s => [s.bone.name, s]));
    return [['LeftUpLeg', 'LeftLeg'], ['RightUpLeg', 'RightLeg'], ['LeftArm', 'LeftForeArm'], ['RightArm', 'RightForeArm']]
      .filter(([a, b]) => by[a] && by[b]).map(([a, b]) => [by[a], by[b]]);
  });
  const dir = (s) => { const r = s.body.rotation(); return new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)); };
  const rest = pairs.map(([a, b]) => dir(a).angleTo(dir(b)));
  const y0 = pelvis.map(b => b.translation().y), vy0 = pelvis.map(b => b.linvel().y);
  const ballistic = y0.map((y, i) => { const r = scene.riders[i].segs[0].rad; const a = -9.81 / 2, bq = vy0[i], c = y - r; return (-bq - Math.sqrt(Math.max(0, bq * bq - 4 * a * c))) / (2 * a); });
  const heads = scene.riders.map(rd => rd.segs.find(s => s.bone.name === 'Head')).filter(Boolean);
  const TRACE = args.includes('--trace');
  for (let t = 0; t < T; t += dt) {
    scene.step(dt);
    if (TRACE && Math.round(t * 60) % 15 === 0) {
      let fast = null;
      for (const rd of scene.riders) for (const sg of rd.segs) { const v = sg.body.linvel(), w = sg.body.angvel(); const sp = Math.hypot(v.x, v.y, v.z), wr = Math.hypot(w.x, w.y, w.z); if (!fast || sp + 0.1 * wr > fast.k) fast = { k: sp + 0.1 * wr, id: rd.seat[0] + ':' + sg.bone.name, v: sp.toFixed(2), w: wr.toFixed(1) }; }
      console.log(`  t=${t.toFixed(2)} fastest ${fast.id} v=${fast.v} w=${fast.w} tone=${(scene.maxToneAngle() * 180 / Math.PI).toFixed(0)} gap=${scene.maxJointGap().toFixed(3)} clear=${scene.minClearance().toFixed(3)}`);
    }
    gap = Math.max(gap, scene.maxJointGap());
    if (scene.maxToneAngle) tone = Math.max(tone, scene.maxToneAngle());
    pairs.forEach(([a, b], i) => { fold = Math.max(fold, Math.abs(dir(a).angleTo(dir(b)) - rest[i])); });
    for (const h of heads) { const w = h.body.angvel(); neck = Math.max(neck, Math.hypot(w.x, w.y, w.z)); }
    pelvis.forEach((b, i) => {
      const tr = b.translation(), vy = b.linvel().y, r = scene.riders[i].segs[0].rad;
      const down = tr.y - r < 0.03;
      if (down && landed === null) landed = t;
      if (down && !wasDown[i] && lastVy[i] < -0.5 && t > 0.2 && wasDown.some(Boolean) === false) { /* first landing */ }
      if (!down && wasDown[i] && vy > 0.4) bounces++;
      wasDown[i] = down; lastVy[i] = vy;
    });
    if (settle === null && t > 0.3) {
      const quiet = bodies.every(b => { const v = b.linvel(), w = b.angvel(); return Math.hypot(v.x, v.y, v.z) < 0.25 && Math.hypot(w.x, w.y, w.z) < 1.0; });
      if (quiet) settle = t;
    }
  }
  const landRatio = landed !== null ? landed / Math.max(0.05, Math.min(...ballistic)) : Infinity;
  scene.dispose();
  return { speed, cause, seed, settle: settle === null ? T : +settle.toFixed(2), bounces, gap: +gap.toFixed(3), fold: +(fold * 180 / Math.PI).toFixed(0), neck: +neck.toFixed(1), land: +landRatio.toFixed(2), tone: +(tone * 180 / Math.PI).toFixed(0) };
}

const rows = [];
for (const cause of CAUSES) for (const speed of SPEEDS) for (let s = 1; s <= SEEDS; s++) rows.push(crash({ speed, cause, seed: s }));
const avg = (k) => +(rows.reduce((a, r) => a + r[k], 0) / rows.length).toFixed(2);
const summary = { scene: SCENE, runs: rows.length, settle: avg('settle'), bounces: avg('bounces'), gap: avg('gap'), fold: avg('fold'), neck: avg('neck'), land: avg('land'), tone: avg('tone'),
  worst: { settle: Math.max(...rows.map(r => r.settle)), gap: Math.max(...rows.map(r => r.gap)), fold: Math.max(...rows.map(r => r.fold)), bounces: Math.max(...rows.map(r => r.bounces)) } };
if (JSON_OUT) console.log(JSON.stringify({ summary, rows }));
else {
  console.log(`scene ${SCENE}  (${rows.length} crashes)`);
  console.log('cause     speed seed  settle  bounces  gap    fold  neck   land');
  for (const r of rows) console.log(`${r.cause.padEnd(9)} ${String(r.speed).padStart(5)} ${String(r.seed).padStart(4)}  ${String(r.settle).padStart(6)}  ${String(r.bounces).padStart(7)}  ${String(r.gap).padStart(5)}  ${String(r.fold).padStart(4)}  ${String(r.neck).padStart(4)}  ${String(r.land).padStart(5)}`);
  console.log('mean:', JSON.stringify(summary));
}
