// #428 · 13: the stopped-bike pedal hint names the buttons printed on P1's pad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pedalHint } from '../../js/hud.js';
import { UfControllerGlyph } from '../../shared/ui/elements/uf-controller-glyph.js';

test('pedal hint uses each family\'s shoulder labels', () => {
  assert.equal(pedalHint('playstation'), 'Pedal! Alternate L1/R1 or L2/R2');
  assert.equal(pedalHint('nintendo'), 'Pedal! Alternate L/R or ZL/ZR');
  assert.equal(pedalHint('xbox'), 'Pedal! Alternate LB/RB or LT/RT');
  assert.equal(pedalHint('keyboard'), 'Pedal! Alternate LB/RB or LT/RT');
});

test('pedal hint follows the page-wide glyph default', () => {
  const before = UfControllerGlyph.getDefault();
  try {
    UfControllerGlyph.setDefault({ family: 'playstation' });
    assert.equal(pedalHint(), 'Pedal! Alternate L1/R1 or L2/R2');
  } finally {
    UfControllerGlyph.setDefault(before);
  }
});
