// A-9 · the device id must be stable, and must never throw.
import test from 'node:test';
import assert from 'node:assert/strict';

// analytics.js reaches for browser globals at import time and on use; give it
// the minimum it needs before importing.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
globalThis.sessionStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

const { getDeviceId } = await import('../../js/analytics.js');

test('the same browser gets the same id twice', () => {
  const first = getDeviceId();
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(getDeviceId(), first);
  assert.equal(store.get('tandemonium_device_id'), first);
});

test('a cleared profile gets a new id', () => {
  const first = getDeviceId();
  store.clear();
  const second = getDeviceId();
  assert.notEqual(second, first);
});

test('a localStorage that throws does not take the session down', () => {
  const good = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error('SecurityError: site data blocked'); },
    setItem() { throw new Error('SecurityError: site data blocked'); }
  };
  assert.doesNotThrow(() => getDeviceId());
  globalThis.localStorage = good;
});
