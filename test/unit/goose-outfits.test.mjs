// The Goose Outfits option: each choice maps to a captain + stoker rider GLB that exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GOOSE_OUTFITS, DEFAULT_GOOSE_OUTFIT, normalizeGooseOutfit, gooseOutfitPaths }
  from '../../js/goose-outfits.js';

test('three outfits: original, cyclist, fancy; original is the default', () => {
  assert.deepEqual(Object.keys(GOOSE_OUTFITS), ['original', 'cyclist', 'fancy']);
  assert.equal(DEFAULT_GOOSE_OUTFIT, 'original');
});

test('pairings: cyclist pairs both cyclists; fancy = the Victorian male + the original female', () => {
  assert.deepEqual(gooseOutfitPaths('original'),
    { Captain: 'tandem-3d/goose/goose_captain.glb', Stoker: 'tandem-3d/goose/goose_stoker.glb' });
  assert.deepEqual(gooseOutfitPaths('cyclist'),
    { Captain: 'tandem-3d/goose/goose_captain_cyclist.glb', Stoker: 'tandem-3d/goose/goose_stoker_cyclist.glb' });
  assert.deepEqual(gooseOutfitPaths('fancy'),
    { Captain: 'tandem-3d/goose/goose_captain_fancy.glb', Stoker: 'tandem-3d/goose/goose_stoker.glb' });
});

test('unknown or missing keys fall back to the original pair', () => {
  for (const k of [undefined, null, '', 'tuxedo', 'toString', '__proto__']) {
    assert.equal(normalizeGooseOutfit(k), 'original', String(k));
    assert.deepEqual(gooseOutfitPaths(k), gooseOutfitPaths('original'));
  }
});

test('every rider GLB is shipped', () => {
  for (const o of Object.values(GOOSE_OUTFITS)) {
    for (const p of [o.Captain, o.Stoker]) assert.ok(fs.existsSync(p), p);
  }
});
