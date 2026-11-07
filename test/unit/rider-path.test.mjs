// #548 · one rider GLB per (seat, outfit, body): the 8 existing combos keep today's files, new
// combos follow the naming contract, and a combo whose file has not landed falls back to the
// seat's existing body (logged once).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  GOOSE_OUTFITS, BASE_OUTFITS, SEATS, SEAT_BODY, RIDER_FILES, riderFileName, resolveRider, riderPath, _resetRiderWarnings,
} from '../../js/goose-outfits.js';
import { colourwayParams, colourwayParamsForBody } from '../../js/goose-colourways.js';

test('the seats\' existing bodies: captain = gander (m), stoker = goose (f)', () => {
  assert.deepEqual(SEATS, ['Captain', 'Stoker']);
  assert.deepEqual(SEAT_BODY, { Captain: 'm', Stoker: 'f' });
});

test('the 8 existing combos map to today\'s files', () => {
  assert.equal(riderPath('Captain', 'victorian', 'm'), 'tandem-3d/goose/goose_captain.glb');
  assert.equal(riderPath('Stoker', 'victorian', 'f'), 'tandem-3d/goose/goose_stoker_victorian.glb');
  assert.equal(riderPath('Captain', 'cyclists', 'm'), 'tandem-3d/goose/goose_captain_cyclist.glb');
  assert.equal(riderPath('Stoker', 'cyclists', 'f'), 'tandem-3d/goose/goose_stoker_cyclist.glb');
  assert.equal(riderPath('Captain', 'fancy', 'm'), 'tandem-3d/goose/goose_captain_fancy.glb');
  assert.equal(riderPath('Stoker', 'fancy', 'f'), 'tandem-3d/goose/goose_stoker.glb', 'the fancy stoker is the original goose_stoker.glb');
  assert.equal(riderPath('Captain', 'georgian', 'm'), 'tandem-3d/goose/goose_captain_georgian.glb');
  assert.equal(riderPath('Stoker', 'georgian', 'f'), 'tandem-3d/goose/goose_stoker_georgian.glb');
  for (const o of BASE_OUTFITS) for (const s of SEATS) {
    const r = resolveRider(s, o, SEAT_BODY[s]);
    assert.equal(r.fallback, false, `${s}/${o}`);
    assert.equal(r.body, SEAT_BODY[s]);
    assert.ok(fs.existsSync(r.path), r.path);
  }
});

test('naming contract for new files: tandem-3d/goose/goose_<captain|stoker>_<outfit>_<m|f>.glb', () => {
  assert.equal(riderFileName('Captain', 'victorian', 'f'), 'tandem-3d/goose/goose_captain_victorian_f.glb');
  assert.equal(riderFileName('Stoker', 'fancy', 'm'), 'tandem-3d/goose/goose_stoker_fancy_m.glb');
  assert.equal(riderFileName('Stoker', 'cyclists', 'm'), 'tandem-3d/goose/goose_stoker_cyclists_m.glb', 'the outfit KEY, not today\'s file stem');
  assert.equal(riderFileName('Captain', 'original', 'f'), 'tandem-3d/goose/goose_captain_victorian_f.glb', 'old outfit names normalise');
  const all = new Set();
  for (const o of BASE_OUTFITS) for (const s of SEATS) for (const b of ['m', 'f']) all.add(riderFileName(s, o, b));
  assert.equal(all.size, 16, 'four outfits × two seats × two bodies, all distinct');
});

test('a missing (seat, outfit, body) falls back to the seat\'s existing body and logs once per combo', () => {
  _resetRiderWarnings();
  const logs = [];
  const log = (m) => logs.push(m);
  const r = resolveRider('Captain', 'victorian', 'f', log);
  if (RIDER_FILES.has('tandem-3d/goose/goose_captain_victorian_f.glb')) {
    assert.equal(r.fallback, false);
    assert.equal(r.body, 'f');
    return;   // the file has landed; nothing to fall back from
  }
  assert.deepEqual(r, { path: 'tandem-3d/goose/goose_captain.glb', body: 'm', wanted: 'tandem-3d/goose/goose_captain_victorian_f.glb', fallback: true });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /goose_captain_victorian_f\.glb/);
  resolveRider('Captain', 'victorian', 'f', log);
  resolveRider('Captain', 'victorian', 'f', log);
  assert.equal(logs.length, 1, 'the same combo logs once');
  resolveRider('Stoker', 'fancy', 'm', log);
  assert.equal(logs.length, 2, 'another combo logs its own line');
  assert.equal(riderPath('Stoker', 'fancy', 'm'), 'tandem-3d/goose/goose_stoker.glb');
});

test('all 16 (seat, outfit, body) combos resolve to their own file, no fallback', () => {
  _resetRiderWarnings();
  for (const o of BASE_OUTFITS) for (const s of SEATS) for (const b of ['m', 'f']) {
    const r = resolveRider(s, o, b, () => assert.fail('no fallback expected'));
    assert.equal(r.fallback, false, `${s}/${o}/${b}`);
    assert.equal(r.body, b);
    assert.ok(fs.existsSync(r.path), r.path);
    if (b !== SEAT_BODY[s]) assert.equal(r.path, riderFileName(s, o, b));
  }
  assert.equal(RIDER_FILES.size, 10, 'swapped-body files: 4 everyday outfits + the robot');
});

test('every new-contract file listed as shipped is on disk and named by the contract', () => {
  for (const f of RIDER_FILES) {
    assert.match(f, /^tandem-3d\/goose\/goose_(captain|stoker)_(victorian|cyclists|fancy|georgian|robot)_(m|f)\.glb$/, f);
    assert.ok(fs.existsSync(f), f);
  }
});

test('garbage seat / body / outfit resolve to a real file', () => {
  const r = resolveRider('Sidecar', 'tuxedo', 'x');
  assert.equal(r.path, 'tandem-3d/goose/goose_captain.glb');
  assert.equal(r.fallback, false);
});

test('colourway params follow the body, not the seat', () => {
  const both = colourwayParams('victorian', 'v_navy');
  assert.deepEqual(colourwayParamsForBody('victorian', 'v_navy', 'm'), both.Captain);
  assert.deepEqual(colourwayParamsForBody('victorian', 'v_navy', 'f'), both.Stoker);
  assert.deepEqual(colourwayParamsForBody('victorian', 'default', 'f'), {});
});

test('#611 · the robot has both bodies: the gander robot and the lady robot ride either seat, no fallback', () => {
  _resetRiderWarnings();
  for (const s of SEATS) for (const b of ['m', 'f']) {
    const r = resolveRider(s, 'robot', b, () => assert.fail('no fallback expected'));
    assert.equal(r.fallback, false, s + '/' + b);
    assert.equal(r.body, b);
    assert.equal(r.path, b === SEAT_BODY[s] ? GOOSE_OUTFITS.robot[s] : riderFileName(s, 'robot', b));
    assert.equal(r.path, riderFileName(s, 'robot', b));
    assert.ok(fs.existsSync(r.path), r.path);
  }
});
