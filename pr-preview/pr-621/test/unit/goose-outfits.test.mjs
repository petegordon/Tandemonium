// The Goose Outfits option: each choice maps to a captain + stoker rider GLB that exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GOOSE_OUTFITS, DEFAULT_GOOSE_OUTFIT, normalizeGooseOutfit, gooseOutfitPaths }
  from '../../js/goose-outfits.js';

test('four outfits: victorian, cyclists, fancy, georgian; victorian is the default', () => {
  assert.deepEqual(Object.keys(GOOSE_OUTFITS), ['victorian', 'cyclists', 'fancy', 'georgian']);
  assert.deepEqual(Object.values(GOOSE_OUTFITS).map(o => o.label), ['Victorian', 'Cyclists', 'Fancy', 'Georgian']);
  assert.equal(DEFAULT_GOOSE_OUTFIT, 'victorian');
});

test('pairings: original male + Victorian lady; both cyclists; Victorian gent + the red-dress lady', () => {
  assert.deepEqual(gooseOutfitPaths('victorian'),
    { Captain: 'tandem-3d/goose/goose_captain.glb', Stoker: 'tandem-3d/goose/goose_stoker_victorian.glb' });
  assert.deepEqual(gooseOutfitPaths('cyclists'),
    { Captain: 'tandem-3d/goose/goose_captain_cyclist.glb', Stoker: 'tandem-3d/goose/goose_stoker_cyclist.glb' });
  assert.deepEqual(gooseOutfitPaths('fancy'),
    { Captain: 'tandem-3d/goose/goose_captain_fancy.glb', Stoker: 'tandem-3d/goose/goose_stoker.glb' });
  assert.deepEqual(gooseOutfitPaths('georgian'),
    { Captain: 'tandem-3d/goose/goose_captain_georgian.glb', Stoker: 'tandem-3d/goose/goose_stoker_georgian.glb' });
});

test('names saved by the first preview map to the renamed outfits', () => {
  assert.equal(normalizeGooseOutfit('original'), 'victorian');
  assert.equal(normalizeGooseOutfit('cyclist'), 'cyclists');
});

test('unknown or missing keys fall back to the default pair', () => {
  for (const k of [undefined, null, '', 'tuxedo', 'toString', '__proto__']) {
    assert.equal(normalizeGooseOutfit(k), 'victorian', String(k));
    assert.deepEqual(gooseOutfitPaths(k), gooseOutfitPaths('victorian'));
  }
});

test('every rider GLB is shipped', () => {
  for (const o of Object.values(GOOSE_OUTFITS)) {
    for (const p of [o.Captain, o.Stoker]) assert.ok(fs.existsSync(p), p);
  }
});
