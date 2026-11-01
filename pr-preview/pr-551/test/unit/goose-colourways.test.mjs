// Goose colourways: every outfit pair has its original colours + three colourways, each carrying remap params
// for both seats, and an unknown choice falls back to the original colours.
import test from 'node:test';
import assert from 'node:assert/strict';
import DATA from '../../js/goose-colourways-data.js';
import { GOOSE_OUTFITS } from '../../js/goose-outfits.js';

test('each Goose Outfits pair has Original + 3 colourways', () => {
  for (const key of Object.keys(GOOSE_OUTFITS)) {
    const ways = DATA[key] && DATA[key].ways;
    assert.ok(ways, key);
    assert.equal(ways.length, 4, key);
    assert.equal(ways[0].key, 'default');
  }
});

test('every colourway recolours both geese with valid params', () => {
  for (const [pk, p] of Object.entries(DATA)) {
    for (const w of p.ways.slice(1)) {
      for (const seat of ['Captain', 'Stoker']) {
        const mats = Object.entries(w[seat] || {});
        assert.ok(mats.length >= 3, `${pk} ${w.key} ${seat}: ${mats.length} materials`);
        for (const [name, v] of mats) {
          const nums = v.hsv || v.color;
          assert.ok(Array.isArray(nums) && nums.length === 3 && nums.every(Number.isFinite), `${pk} ${w.key} ${name}`);
          if (v.hsv) assert.ok(v.hsv[0] >= 0 && v.hsv[0] <= 1 && v.hsv[1] >= 0 && v.hsv[2] >= 0, `${name} hsv range`);
        }
      }
    }
  }
});
