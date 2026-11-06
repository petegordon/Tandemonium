// #484: crash slow-mo schedule, the rag doll spec and the crash throw (pure parts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SLOWMO, crashTimeScale, simSecondsFor, clockHeld } from '../../js/crash-slowmo.js';
import { SEGMENTS, LITE, segmentsFor, throwFor, hatThrow, GOOSE_MASS, segmentMass, rodInertia, toneRate, frictionFraction,
  MAX_RATE, LIMIT_RATE, RESTITUTION, LINEAR_DAMPING } from '../../js/physics/ragdoll-spec.js';

const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

test('slow-mo: slow from impact, eases back, then real time', () => {
  assert.equal(crashTimeScale(0), SLOWMO.scale);
  assert.equal(crashTimeScale(SLOWMO.hold - 0.01), SLOWMO.scale);
  const mid = crashTimeScale(SLOWMO.hold + SLOWMO.ramp / 2);
  assert.ok(mid > SLOWMO.scale && mid < 1);
  assert.equal(crashTimeScale(SLOWMO.hold + SLOWMO.ramp), 1);
  assert.equal(crashTimeScale(5), 1);
  assert.equal(crashTimeScale(-1), 1);
  assert.equal(crashTimeScale(NaN), 1);
});

test('slow-mo: simSecondsFor integrates the schedule', () => {
  // numeric integral at 240 Hz
  let sim = 0;
  const h = 1 / 2400;
  for (let t = 0; t < SLOWMO.downReal; t += h) sim += crashTimeScale(t + h / 2) * h;
  assert.ok(near(simSecondsFor(SLOWMO.downReal), sim, 1e-3), `${simSecondsFor(SLOWMO.downReal)} vs ${sim}`);
  assert.ok(near(simSecondsFor(SLOWMO.hold), SLOWMO.hold * SLOWMO.scale));
  assert.equal(simSecondsFor(0), 0);
  // the down time in simulated seconds is shorter than the old 1.2 s fall would need to fill 2 real seconds
  assert.ok(simSecondsFor(SLOWMO.downReal) > 1.2 && simSecondsFor(SLOWMO.downReal) < SLOWMO.downReal);
});

test('slow-mo: the race clock is held exactly while the view is slowed', () => {
  assert.equal(clockHeld(0), true);
  assert.equal(clockHeld(SLOWMO.hold + SLOWMO.ramp - 0.001), true);
  assert.equal(clockHeld(SLOWMO.hold + SLOWMO.ramp), false);
  assert.equal(clockHeld(NaN), false);
});

test('rag doll: one tree rooted at the pelvis, parents before children', () => {
  const seen = new Set();
  for (const s of SEGMENTS) {
    if (s.parent === null) assert.equal(s.id, 'pelvis');
    else assert.ok(seen.has(s.parent), `${s.id} hangs off ${s.parent} before it exists`);
    seen.add(s.id);
  }
  assert.equal(SEGMENTS.length, 13);
  assert.equal(new Set(SEGMENTS.map(s => s.bone)).size, 13, 'each segment drives its own bone');
  // never the beak: Jaw / Tongue are left to the face
  assert.ok(!SEGMENTS.some(s => /Jaw|Tongue/.test(s.bone + s.end)));
});

test('rag doll: the lite budget keeps the body and the long neck', () => {
  const lite = segmentsFor('lite');
  assert.deepEqual(lite.map(s => s.id), [...LITE]);
  for (const s of lite) assert.ok(s.parent === null || LITE.includes(s.parent));
  assert.equal(segmentsFor('full').length, 13);
  // the neck is the loosest part
  const neck = SEGMENTS.filter(s => s.id.startsWith('neck'));
  assert.ok(neck.every(n => n.damp < Math.min(...SEGMENTS.filter(s => !s.id.startsWith('neck') && s.id !== 'head').map(s => s.damp))));
});

const fixed = () => 0.5;   // no jitter
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

for (const heading of [0, 1.1, -2.4]) {
  const f = { x: Math.sin(heading), y: 0, z: Math.cos(heading) };
  const right = { x: -Math.cos(heading), y: 0, z: Math.sin(heading) };

  test(`throw (heading ${heading}): head-on, the captain goes over the bars`, () => {
    const t = throwFor({ seat: 'Captain', cause: 'obstacle', speed: 9, heading, lean: 0.1, rand: fixed });
    assert.ok(dot(t.linvel, f) > 7, 'forward');
    assert.ok(t.linvel.y > 3, 'up');
    assert.ok(Math.abs(dot(t.linvel, right)) < 0.01, 'straight over');
    // pitching forward: the head (up) moves forward, w x up . f > 0
    const w = t.angvel, wxUp = { x: -w.z, y: 0, z: w.x };
    assert.ok(dot(wxUp, f) > 4, 'pitches forward');
  });

  test(`throw (heading ${heading}): head-on, the stoker goes off to a side`, () => {
    const t = throwFor({ seat: 'Stoker', cause: 'tree', speed: 9, heading, lean: 0, rand: fixed });
    assert.ok(Math.abs(dot(t.linvel, right)) > 2, 'sideways');
    const c = throwFor({ seat: 'Captain', cause: 'tree', speed: 9, heading, lean: 0, rand: fixed });
    assert.ok(dot(t.linvel, f) < dot(c.linvel, f), 'less far forward than the captain');
  });

  test(`throw (heading ${heading}): a lean-out throws both to the side it fell`, () => {
    for (const lean of [1.4, -1.4]) {
      for (const seat of ['Captain', 'Stoker']) {
        const t = throwFor({ seat, cause: 'balance', speed: 7, heading, lean, rand: fixed });
        assert.ok(Math.sign(dot(t.linvel, right)) === Math.sign(lean), `${seat} lean ${lean}`);
        assert.ok(t.linvel.y > 0);
        // a cartwheel toward the fall side (spin -side about f), not a roll into the road
        assert.ok(Math.sign(dot(t.angvel, f)) === -Math.sign(lean), `${seat} cartwheels`);
      }
    }
  });
}

test('throw: faster crashes throw further, and a standstill still throws', () => {
  const slow = throwFor({ seat: 'Captain', cause: 'obstacle', speed: 3, heading: 0, lean: 0, rand: fixed });
  const fast = throwFor({ seat: 'Captain', cause: 'obstacle', speed: 12, heading: 0, lean: 0, rand: fixed });
  assert.ok(fast.linvel.z > slow.linvel.z && fast.linvel.y > slow.linvel.y);
  const still = throwFor({ seat: 'Stoker', cause: 'balance', speed: 0, heading: 0, lean: 1, rand: fixed });
  assert.ok(Math.hypot(still.linvel.x, still.linvel.z) > 1);
  for (const v of [still.linvel, still.angvel]) for (const k of 'xyz') assert.ok(Number.isFinite(v[k]));
});

test('hat: always hops up off the head, spinning', () => {
  for (const r of [0, 0.5, 0.999]) {
    const h = hatThrow({ x: 5, y: -2, z: 1 }, () => r);
    assert.ok(h.linvel.y >= 3.2);
    assert.ok(Number.isFinite(h.angvel.x + h.angvel.y + h.angvel.z));
  }
});

// #507 · more weight, less rubber: the mass budget, the joint tone and what it may never do.
test('#507 rag doll: the goose has a mass budget and the body carries most of it', () => {
  const total = SEGMENTS.reduce((a, s) => a + s.mass, 0);
  assert.ok(near(total, 1, 0.03), `mass fractions sum to ${total}`);
  const body = SEGMENTS.filter(s => s.id === 'pelvis' || s.id === 'chest').reduce((a, s) => a + s.mass, 0);
  assert.ok(body > 0.5, 'pelvis + chest are more than half the goose');
  for (const s of SEGMENTS) assert.ok(near(segmentMass(s), s.mass * GOOSE_MASS), s.id);
  assert.ok(segmentMass({ mass: 0 }) > 0, 'never a massless body');
  assert.equal(RESTITUTION, 0, 'a goose does not bounce');
  assert.ok(LINEAR_DAMPING < 0.1, 'it falls like a sack, not through water');
});

test('#507 rag doll: every joint but the pelvis has tone; limbs are damped harder than the neck', () => {
  for (const s of SEGMENTS) {
    if (s.id === 'pelvis') { assert.equal(s.tone, null); continue; }
    assert.ok(s.tone && s.tone.fr > 0 && s.tone.tc > 0 && s.tone.limit > 0, s.id);
  }
  const neck = SEGMENTS.filter(s => s.id.startsWith('neck'));
  const limbs = SEGMENTS.filter(s => /^(arm|fore|thigh|shin)/.test(s.id));
  for (const n of neck) for (const l of limbs) {
    assert.ok(n.tone.fr > l.tone.fr && n.tone.tc > l.tone.tc && n.damp < l.damp, `${n.id} looser than ${l.id}`);
  }
});

test('#507 tone: pulls back toward the seated angle, geometrically, never faster than a muscle', () => {
  const tone = { fr: 0.03, tc: 0.05, limit: 0.9 };
  const h = 1 / 120;
  assert.equal(toneRate(0, h, tone), 0);
  assert.equal(toneRate(0.3, h, null), 0);
  const r1 = toneRate(0.05, h, tone), r2 = toneRate(0.1, h, tone);
  assert.ok(r1 < 0 && r2 < r1, 'closing, and faster when further');
  // small angles close by the same fraction per step
  assert.ok(near(r2 / r1, 2, 1e-9));
  // a joint far from its pose comes back at MAX_RATE, past its limit at most LIMIT_RATE
  assert.ok(near(toneRate(0.8, h, tone), -MAX_RATE));
  assert.ok(toneRate(2.5, h, tone) < -MAX_RATE && toneRate(2.5, h, tone) >= -LIMIT_RATE);
  assert.ok(toneRate(3.1, h, tone) >= -LIMIT_RATE);
});

test('#507 joint friction: a fraction of the relative spin per substep, more for a shorter relaxation', () => {
  assert.equal(frictionFraction(1 / 120, 0), 0);
  const f1 = frictionFraction(1 / 120, 0.03), f2 = frictionFraction(1 / 120, 0.15);
  assert.ok(f1 > f2 && f1 < 1 && f2 > 0);
  assert.ok(near(frictionFraction(0.03, 0.03), 1 - Math.exp(-1)));
  assert.ok(rodInertia(1, 0.4, 0.05) > rodInertia(1, 0.2, 0.05));
});
