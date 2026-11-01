// #459 · the result screen's action order: the primary (accent) first and focused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryIndex } from '../../js/ui-shell.js';

const btn = (id, variant = 'primary') => ({ id, getAttribute: (k) => (k === 'variant' ? variant : null) });

test('focus starts on the accent button wherever the row puts it', () => {
  const items = [btn('clip'), btn('restart', 'accent'), btn('lobby')];
  assert.equal(primaryIndex(items), 1);
});

test('an explicit primary wins over the accent button', () => {
  const next = btn('next');
  const items = [next, btn('again', 'accent'), btn('lobby')];
  assert.equal(primaryIndex(items, next), 0);
});

test('a primary that is not in the row falls back to the accent, then the first item', () => {
  const items = [btn('a'), btn('b', 'accent')];
  assert.equal(primaryIndex(items, btn('gone')), 1);
  assert.equal(primaryIndex([btn('x'), btn('y')]), 0);
  assert.equal(primaryIndex([]), 0);
});
