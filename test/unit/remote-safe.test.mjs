// Partner data and Daily fields can't carry markup into the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRemote, cleanString } from '../../js/remote-safe.js';
import { dailyNumbers } from '../../worker/leaderboard.js';

test('cleanRemote: a hostile finishStats loses its markup, keeps the numbers', () => {
  const evil = {
    type: 'finishStats',
    raceSummary: {
      timeFormatted: '"><img src=x onerror=alert(1)>',
      distance: 250, checkpointsPassed: '<b>5</b>', checkpointsTotal: 5, collectibles: NaN,
      inputSource: 'gamepad-gyro', crashes: Infinity,
    },
    contribSummary: { mode: 'multiplayer', captain: { overallPct: 60, totalTaps: '9<script>' }, stoker: { overallPct: 40 } },
  };
  const c = cleanRemote(evil);
  assert.equal(c.type, 'finishStats');
  assert.equal(c.raceSummary.timeFormatted, 'img src=x onerror=alert(1)');
  assert.ok(!/[<>"]/.test(JSON.stringify(c).replace(/\\"/g, '').replace(/"/g, '')));
  assert.equal(c.raceSummary.distance, 250);
  assert.equal(c.raceSummary.collectibles, 0);
  assert.equal(c.raceSummary.crashes, 0);
  assert.equal(c.raceSummary.checkpointsPassed, 'b5/b');
  assert.equal(c.raceSummary.inputSource, 'gamepad-gyro');
  assert.equal(c.contribSummary.captain.totalTaps, '9script');
});

test('cleanRemote: an honest summary passes unchanged', () => {
  const ok = { type: 'finishStats', raceSummary: { timeFormatted: '1:23.4', distance: 1200, checkpointsPassed: 4, checkpointsTotal: 4, collectibles: 7, tokens: 3, tokensTotal: 10 }, contribSummary: { mode: 'solo', solo: { totalTaps: 80, correctTaps: 70, safePct: 91 } } };
  assert.deepEqual(cleanRemote(ok), ok);
});

test('cleanRemote: drops prototype keys, functions, deep nesting; caps sizes', () => {
  const c = cleanRemote(JSON.parse('{"__proto__":{"polluted":true},"a":1}'));
  assert.equal(c.a, 1);
  assert.equal(({}).polluted, undefined);
  assert.equal(cleanRemote({ f: () => 1 }).f, undefined);
  let deep = {}; const root = deep; for (let i = 0; i < 20; i++) { deep.x = {}; deep = deep.x; }
  assert.ok(JSON.stringify(cleanRemote(root)).length < 60);
  assert.equal(cleanString('x'.repeat(1000)).length, 200);
  assert.equal(cleanRemote(new Array(2000).fill(1)).length, 500);
});

test('dailyNumbers: strings and junk become 0 / null; real numbers are rounded and capped', () => {
  assert.deepEqual(dailyNumbers({ distance: 250.6, collectibles: 7, crashes: 2, syncPct: 88.4, partnerUserId: 42 }),
    { distance: 251, collectibles: 7, crashes: 2, syncPct: 88, partnerUserId: 42 });
  assert.deepEqual(dailyNumbers({ distance: '9', collectibles: '<img src=x onerror=alert(1)>', crashes: -3, syncPct: 'x', partnerUserId: '<b>' }),
    { distance: 0, collectibles: 0, crashes: 0, syncPct: null, partnerUserId: null });
  assert.equal(dailyNumbers({ collectibles: 1e9 }).collectibles, 10000);
  assert.equal(dailyNumbers({ syncPct: 140 }).syncPct, 100);
  assert.equal(dailyNumbers({ partnerUserId: '17' }).partnerUserId, 17);
  assert.equal(dailyNumbers({ partnerUserId: 0 }).partnerUserId, null);
  assert.deepEqual(dailyNumbers(), { distance: 0, collectibles: 0, crashes: 0, syncPct: null, partnerUserId: null });
});
