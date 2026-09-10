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
  const drift = (dir) => {
    const gv = new GustVisual(fakeScene());
    gv.setWind(dir, 1);
    gv.update(fakeBike(), 1 / 60);
    const start = meanHeadX(gv);
    gv.setWind(dir, 1);
    for (let i = 0; i < 12; i++) gv.update(fakeBike(), 1 / 60);
    return meanHeadX(gv) - start;
  };
  const right = drift(1);
  const left = drift(-1);
  assert.ok(Math.sign(right) !== Math.sign(left), `both drifted the same way: ${right} vs ${left}`);
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
