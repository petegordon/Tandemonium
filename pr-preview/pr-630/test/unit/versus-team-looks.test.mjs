// Versus: the two teams' geese differ in outfit and in colour; Show Solo is on by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { versusTeamLooks, TEAM_COLOURWAYS } from '../../js/versus/team-looks.js';
import { GOOSE_OUTFITS } from '../../js/goose-outfits.js';
import { colourwaysFor } from '../../js/goose-colourways.js';

test('every outfit: the teams wear different outfits, each in a real colourway', () => {
  for (const saved of Object.keys(GOOSE_OUTFITS)) {
    const { A, B } = versusTeamLooks(saved);
    assert.equal(A.outfit, saved, 'Team Blue keeps the saved outfit');
    assert.notEqual(B.outfit, A.outfit);
    for (const l of [A, B]) assert.ok(colourwaysFor(l.outfit).some((w) => w.key === l.colourway), `${l.outfit}/${l.colourway}`);
  }
});

test('both teams have a colourway for every outfit', () => {
  for (const team of ['A', 'B']) for (const o of Object.keys(GOOSE_OUTFITS)) assert.ok(TEAM_COLOURWAYS[team][o], `${team} ${o}`);
});

test('an unknown saved outfit falls back to the default pair', () => {
  const { A, B } = versusTeamLooks('nope');
  assert.equal(A.outfit, 'victorian');
  assert.notEqual(B.outfit, 'victorian');
});

test('Show Solo: on with no saved choice, off only when turned off', async () => {
  const store = {};
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const { getShowSolo } = await import('../../js/config.js');
  assert.equal(getShowSolo(), true);
  store.tandemonium_show_solo = 'off';
  assert.equal(getShowSolo(), false);
  store.tandemonium_show_solo = 'on';
  assert.equal(getShowSolo(), true);
});
