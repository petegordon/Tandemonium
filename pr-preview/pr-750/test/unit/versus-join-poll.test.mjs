// #581 · which press joins a seat. (One card per physical controller, polling
// all its sources, is controller-core's units since 0.7: lab tests.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isJoinPress } from '../../js/lobby/join-poll.js';
const btns = (n, pressed = []) => Array.from({ length: n }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 }));

// TV playtest 2026-11-06: B stood the second Steam Controller up, and B also
// sat it back down. On a standard pad, any button joins except B.
const std = (pressed) => ({ mapping: 'standard', buttons: btns(17, pressed) });

test('standard pad: A joins, B alone never does', () => {
  assert.equal(isJoinPress(std([0])), true);
  assert.equal(isJoinPress(std([1])), false);
  assert.equal(isJoinPress(std([])), false);
});

test('standard pad: other buttons still join (X, Y, Start, triggers)', () => {
  for (const i of [2, 3, 7, 9]) assert.equal(isJoinPress(std([i])), true, 'button ' + i);
  assert.equal(isJoinPress(std([1, 9])), true, 'B held with Start');
});

test('Nintendo-order pad (swapAB): B sits at index 0 and never joins', () => {
  assert.equal(isJoinPress(std([0]), true), false);
  assert.equal(isJoinPress(std([1]), true), true);
});

test('a pad Chromium does not map: every button joins (✕ can be index 1)', () => {
  assert.equal(isJoinPress({ mapping: '', buttons: btns(12, [1]) }), true);
  assert.equal(isJoinPress(null), false);
});

