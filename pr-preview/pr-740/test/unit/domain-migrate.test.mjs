import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isGameKey, safeTarget, resolveTarget, encodePayload, decodePayload, readGameKeys, buildMigrateUrl,
  applyEntries, cameFromOldSite, MAX_ENCODED,
} from '../../js/domain-migrate.js';

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    dump: () => Object.fromEntries(m),
  };
}

test('only the game keys travel', () => {
  assert.ok(isGameKey('tandemonium_records'));
  assert.ok(isGameKey('tandemonium-rooms'));
  assert.ok(isGameKey('tndm-fast'));
  assert.ok(!isGameKey('tourist_maps_key'));
  assert.ok(!isGameKey('ht_internal'));
  const ls = readGameKeys(fakeStorage({ tandemonium_device_id: 'abc', other: 'x' }));
  assert.deepEqual(ls, { tandemonium_device_id: 'abc' });
});

test('continue target must stay on this site', () => {
  assert.equal(safeTarget('/?room=TNDM-K9NE#k=1'), '/?room=TNDM-K9NE#k=1');
  assert.equal(safeTarget('//evil.example/'), '/');
  assert.equal(safeTarget('/\\evil.example'), '/');
  assert.equal(safeTarget('https://evil.example/'), '/');
  assert.equal(safeTarget(undefined), '/');
});

test('resolved target never leaves the site, even with parser tricks', () => {
  const o = 'https://tandemonium.housetandem.com';
  assert.equal(resolveTarget('/?daily=2026-10-25', o), o + '/?daily=2026-10-25');
  assert.equal(resolveTarget('/remote/?pad=AB#k=x', o), o + '/remote/?pad=AB#k=x');
  for (const evil of ['/\t/evil.example/', '/\n/evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
    assert.equal(resolveTarget(evil, o), o + '/', JSON.stringify(evil));
  }
});

test('payload round-trips, including unicode and big JSON', async () => {
  const data = { v: 1, to: '/remote/?pad=AB#k=xyz', ls: { tandemonium_records: JSON.stringify({ name: 'Lady Victoria 🦢', t: Array(5000).fill(1.25) }) } };
  const enc = await encodePayload(data);
  assert.match(enc, /^z[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodePayload(enc), data);
});

test('migrate URL: none when empty; drops the biggest values when too large', async () => {
  assert.equal(await buildMigrateUrl({}, '/'), null);
  const url = await buildMigrateUrl({ tandemonium_device_id: 'abc' }, '/?daily=2026-10-25');
  assert.match(url, /^https:\/\/tandemonium\.housetandem\.com\/migrate\/#d=z/);
  const d = await decodePayload(new URLSearchParams(url.split('#')[1]).get('d'));
  assert.deepEqual(d, { v: 1, to: '/?daily=2026-10-25', ls: { tandemonium_device_id: 'abc' } });

  // Random (incompressible) data far over the limit gets dropped; the small keys survive.
  const noise = Array.from({ length: MAX_ENCODED * 1.2 }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join('');
  const big = await buildMigrateUrl({ tandemonium_records: noise, tandemonium_device_id: 'abc' }, '/');
  const kept = await decodePayload(new URLSearchParams(big.split('#')[1]).get('d'));
  assert.deepEqual(Object.keys(kept.ls), ['tandemonium_device_id']);
});

test('apply only fills missing keys; data already here wins', () => {
  const s = fakeStorage({ tandemonium_music: 'off' });
  const added = applyEntries(s, { tandemonium_music: 'on', tandemonium_records: '{}', evil_key: 'x', tandemonium_n: 5 });
  assert.equal(added, 1);
  assert.deepEqual(s.dump(), { tandemonium_music: 'off', tandemonium_records: '{}' });
});

test('data is accepted only when handed over by the old site', () => {
  assert.ok(cameFromOldSite('https://tandemonium.jimandi.love/'));
  assert.ok(cameFromOldSite('https://tandemonium.jimandi.love/pr-preview/pr-1/'));
  assert.ok(!cameFromOldSite(''));
  assert.ok(!cameFromOldSite('https://evil.example/'));
  assert.ok(!cameFromOldSite('https://tandemonium.jimandi.love.evil.example/'));
});
