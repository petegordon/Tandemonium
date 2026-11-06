// #521 · the bike chooser camera keeps the same width of view as its box gets taller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewFov, PREVIEW_FOV, PREVIEW_ASPECT } from '../../js/lobby/preview-fit.js';

const hWidth = (fov, aspect) => 2 * Math.tan((fov / 2) * Math.PI / 180) * aspect;   // view width per metre away

test('wide boxes (phone 5:3, 1080p today) keep the tuned 28°', () => {
  assert.equal(previewFov(5 / 3), PREVIEW_FOV);
  assert.equal(previewFov(PREVIEW_ASPECT), PREVIEW_FOV);
  assert.equal(previewFov(3), PREVIEW_FOV);
});

test('taller boxes widen the vertical view so the horizontal view is unchanged', () => {
  const tuned = hWidth(PREVIEW_FOV, PREVIEW_ASPECT);
  for (const aspect of [1.4, 1.13, 1.0, 0.8]) {
    const fov = previewFov(aspect);
    assert.ok(fov > PREVIEW_FOV, `aspect ${aspect}: ${fov}`);
    assert.ok(Math.abs(hWidth(fov, aspect) - tuned) < 1e-9, `aspect ${aspect}`);
  }
});

test('bad sizes fall back to the tuned view', () => {
  for (const a of [0, -1, NaN, undefined]) assert.equal(previewFov(a), PREVIEW_FOV);
});
