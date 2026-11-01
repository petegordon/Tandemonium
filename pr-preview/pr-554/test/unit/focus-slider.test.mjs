// #544 · in spatial focus, a registered slider takes ←/→ only while it is focused;
// elsewhere ←/→ move between the buttons, and ↑/↓ always move focus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusController } from '../../shared/ui/focus-controller.js';

const NONE = { up: false, down: false, left: false, right: false, a: false, b: false, axisX: 0 };

function rig() {
  const fc = new FocusController({ input: {} });
  const slider = { min: '0', max: '100', value: '50', events: 0, dispatchEvent() { this.events++; }, classList: { add() {}, remove() {} } };
  const button = { classList: { add() {}, remove() {} } };
  const moves = [];
  fc._moveDir = (d) => moves.push(d);
  fc._spatial = true;
  fc.items = [slider, button];
  fc.setSlider(slider);
  let edges = { ...NONE };
  fc._readEdges = () => edges;
  const press = (k) => { fc._edge = { ...NONE }; edges = { ...NONE, [k]: true }; fc.poll(); edges = { ...NONE }; fc.poll(); };
  return { fc, slider, button, moves, press };
}

test('on the slider, ← / → move it and not the focus', () => {
  const { fc, slider, moves, press } = rig();
  fc.focusedEl = slider;
  press('right');
  assert.equal(slider.value, '53');
  press('left'); press('left');
  assert.equal(slider.value, '47');
  assert.deepEqual(moves, []);
  assert.ok(slider.events >= 3);
});

test('on a button, ← / → move along the buttons and leave the slider alone', () => {
  const { fc, slider, button, moves, press } = rig();
  fc.focusedEl = button;
  press('left'); press('right');
  assert.deepEqual(moves, ['left', 'right']);
  assert.equal(slider.value, '50');
});

test('↑ / ↓ move focus from either', () => {
  const { fc, slider, button, moves, press } = rig();
  fc.focusedEl = slider; press('down');
  fc.focusedEl = button; press('up');
  assert.deepEqual(moves, ['down', 'up']);
});
