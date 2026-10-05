// E-2 · the wind you can see. The gust used to move the bike and nothing else,
// which on a phone meant it may as well not have happened. These check the
// streaks actually exist and actually blow the way the bike is being pushed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GustVisual } from '../../js/gust-visual.js';

const fakeScene = () => ({ children: [], add(o) { this.children.push(o); }, remove(o) {
  const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1);
} });

const fakeBike = () => ({ position: { x: 0, y: 0, z: 0 }, heading: 0 });

/** Mean lateral (x) position of every live streak head. */
function meanHeadX(gv) {
  const pos = gv.geometry.attributes.position.array;
  const col = gv.geometry.attributes.color.array;
  let sum = 0, n = 0;
  for (let i = 0; i < pos.length / 6; i++) {
    const b = i * 6;
    if (col[b] === 0 && col[b + 1] === 0 && col[b + 2] === 0) continue;  // dead
    sum += pos[b]; n++;
  }
  return n ? sum / n : null;
}

test('nothing is drawn until the wind blows', () => {
  const gv = new GustVisual(fakeScene());
  assert.equal(gv.lines.visible, false);
  gv.update(fakeBike(), 1 / 60);
  assert.equal(gv.lines.visible, false, 'a still day draws nothing');
});

test('a gust spawns streaks and shows them', () => {
  const gv = new GustVisual(fakeScene());
  gv.setWind(1, 1);
  gv.update(fakeBike(), 1 / 60);
  assert.equal(gv.lines.visible, true);
  assert.ok(meanHeadX(gv) !== null, 'at least one live streak');
});

test('the streaks blow the way the bike is pushed', () => {
  // heading 0 means forward is +z, so the lateral axis is x. A gust with
  // dir=+1 must carry dust in the opposite x sense to dir=-1.
  // Seeded: streaks spawn at random spots, and an unlucky batch of new spawns
  // could swamp the drift of the mean — a rare flake that failed a CI run.
  const drift = (dir) => {
    const realRandom = Math.random;
    let s = 12345;
    Math.random = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    try {
      const gv = new GustVisual(fakeScene());
      gv.setWind(dir, 1);
      gv.update(fakeBike(), 1 / 60);
      const start = meanHeadX(gv);
      gv.setWind(dir, 1);
      for (let i = 0; i < 12; i++) gv.update(fakeBike(), 1 / 60);
      return meanHeadX(gv) - start;
    } finally {
      Math.random = realRandom;
    }
  };
  const right = drift(1);
  const left = drift(-1);
  assert.ok(Math.sign(right) !== Math.sign(left), `both drifted the same way: ${right} vs ${left}`);
});

// #395.1 · not just "opposite for opposite dirs" — the SAME side as the push.
// BikeModel: leanVelocity += dir·GUST_FORCE·…; lean += leanVelocity·dt;
// heading += -lean·speed·turnRate·dt; position += (sin h, cos h)·speed·dt.
// So a positive push moves the bike toward the sign of d/dt sin(h) for h
// decreasing, i.e. along (-cos h, sin h): the rider's right.
function pushSide(heading, dir) {
  const lean = dir * 0.1;                 // the push has leaned the bike
  const h2 = heading - lean * 10 * 0.5 * 0.1;   // speed 10, turnRate 0.5, dt 0.1
  return { x: Math.sin(h2) - Math.sin(heading), z: Math.cos(h2) - Math.cos(heading) };
}

function meanHead(gv, axis) {
  const pos = gv.geometry.attributes.position.array;
  const col = gv.geometry.attributes.color.array;
  let sum = 0, n = 0;
  for (let i = 0; i < pos.length / 6; i++) {
    const b = i * 6;
    if (col[b] === 0 && col[b + 1] === 0 && col[b + 2] === 0) continue;
    sum += pos[b + (axis === 'z' ? 2 : 0)]; n++;
  }
  return n ? sum / n : null;
}

test('the streaks travel to the same side the gust pushes the bike (#395.1)', () => {
  for (const heading of [0, Math.PI / 2, -Math.PI / 3]) {
    for (const dir of [1, -1]) {
      const gv = new GustVisual(fakeScene());
      gv.setWind(dir, 1);
      const bike = { position: { x: 0, y: 0, z: 0 }, heading };
      gv.update(bike, 1 / 60);
      // every streak's own velocity, not the noisy mean of fresh spawns
      const side = pushSide(heading, dir);
      let checked = 0;
      for (let i = 0; i < gv.vx.length; i++) {
        if (gv.life[i] <= 0) continue;
        const dot = gv.vx[i] * side.x + gv.vz[i] * side.z;
        assert.ok(dot > 0, `heading ${heading.toFixed(2)} dir ${dir}: streak blows against the push`);
        checked++;
      }
      assert.ok(checked > 0);
      // and they start upwind: on an axis-aligned heading the mean head sits on
      // the side away from the push (the along-road scatter is on the other axis)
      if (heading === 0 || heading === Math.PI / 2) {
        const axis = heading === 0 ? 'x' : 'z';
        const s = Math.sign(axis === 'x' ? side.x : side.z);
        assert.equal(Math.sign(meanHead(gv, axis)), -s, 'streaks should be born upwind');
      }
    }
  }
});

test('a streak has a tail behind its head, not a zero-length point', () => {
  const gv = new GustVisual(fakeScene());
  gv.setWind(1, 1);
  gv.update(fakeBike(), 1 / 60);
  const pos = gv.geometry.attributes.position.array;
  const col = gv.geometry.attributes.color.array;
  let checked = 0;
  for (let i = 0; i < pos.length / 6 && checked < 5; i++) {
    const b = i * 6;
    if (col[b] === 0 && col[b + 1] === 0 && col[b + 2] === 0) continue;
    const dx = pos[b] - pos[b + 3], dz = pos[b + 2] - pos[b + 5];
    assert.ok(Math.hypot(dx, dz) > 0.01, 'streak has length');
    checked++;
  }
  assert.ok(checked > 0, 'found live streaks to check');
});

test('the storm dies down and clears', () => {
  const gv = new GustVisual(fakeScene());
  gv.setWind(1, 1);
  for (let i = 0; i < 5; i++) gv.update(fakeBike(), 1 / 60);
  assert.equal(gv.lines.visible, true);

  // Wind drops; every streak should age out rather than hang in the air.
  gv.setWind(1, 0);
  for (let i = 0; i < 120; i++) gv.update(fakeBike(), 1 / 60);
  assert.equal(gv.lines.visible, false, 'streaks outlive the gust but not for ever');
});

test('clear() empties it immediately, for a mid-ride reset', () => {
  const gv = new GustVisual(fakeScene());
  gv.setWind(-1, 1);
  gv.update(fakeBike(), 1 / 60);
  gv.clear();
  assert.equal(gv.lines.visible, false);
  gv.update(fakeBike(), 1 / 60);
  assert.equal(gv.lines.visible, false, 'and it stays empty with no wind');
});

test('it survives nonsense without throwing', () => {
  const gv = new GustVisual(fakeScene());
  assert.doesNotThrow(() => {
    gv.update(null, 1 / 60);
    gv.setWind(0, NaN);
    gv.update(fakeBike(), 1 / 60);
    gv.setWind(1, 99);
    gv.update(fakeBike(), 0);
  });
});
