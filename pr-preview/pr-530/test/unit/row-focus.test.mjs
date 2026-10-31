// #517 · up / down on a TV screen go to the nearest row first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestRowIndex } from '../../js/row-focus.js';

const box = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h });

// The level step at 1080p (measured): four cards, the difficulty row,
// START RIDE, and the system bar along the bottom.
const tutorial = box(48, 268, 437, 317), grandma = box(511, 268, 437, 317), road = box(973, 268, 437, 317), sling = box(1435, 268, 437, 317);
const chill = box(543, 643, 267, 95), adv = box(826, 643, 267, 95), dare = box(1110, 643, 267, 95);
const start = box(748, 779, 425, 61);
const help = box(167, 1009, 189, 57), profile = box(602, 1009, 151, 57), music = box(1572, 1009, 142, 57), settings = box(1722, 1009, 174, 57);
const all = [tutorial, grandma, road, sling, chill, adv, dare, start, help, profile, music, settings];
const go = (from, dir) => { const others = all.filter((b) => b !== from); return others[nearestRowIndex(from, dir, others)]; };

test('Chill Ride goes down to START RIDE, not the Profile pill under it', () => {
  assert.equal(go(chill, 'down'), start);
});

test('the far-left and far-right cards go down to the difficulty row, not the bar', () => {
  assert.equal(go(tutorial, 'down'), chill);
  assert.equal(go(sling, 'down'), dare);
  assert.equal(go(grandma, 'down'), chill);
});

test('START RIDE goes down to the bar, and the bar comes back up to START RIDE', () => {
  assert.ok([help, profile, music, settings].includes(go(start, 'down')));
  assert.equal(go(help, 'up'), start);
  assert.equal(go(settings, 'up'), start);
});

test('up from the difficulty row lands on the card above it', () => {
  assert.equal(go(chill, 'up'), grandma);
  assert.equal(go(dare, 'up'), road);
});

test('nothing in that direction → -1', () => {
  assert.equal(nearestRowIndex(tutorial, 'up', all.filter((b) => b !== tutorial)), -1);
  assert.equal(nearestRowIndex(help, 'down', all.filter((b) => b !== help)), -1);
});
