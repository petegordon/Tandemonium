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
});// The insecure-context regression: over plain http, crypto.randomUUID is not
// merely unreliable, it is undefined, and an unguarded call took the whole boot
// down on iOS. The id still has to come out, and it still has to be a v4 UUID.
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// globalThis.crypto is getter-only, so swapping it takes defineProperty.
function withCrypto(fake, fn) {
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: fake, configurable: true });
  try { fn(); } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
}

// A secure-context-stripped crypto: getRandomValues survives, randomUUID does not.
// Built while the real crypto is still installed, so it can borrow its entropy.
const insecureCrypto = () => {
  const real = globalThis.crypto;
  return { getRandomValues: (a) => real.getRandomValues(a) };
};

test('an insecure context still yields a well-formed v4 id', () => {
  withCrypto(insecureCrypto(), () => {
    store.clear();
    const id = getDeviceId();
    assert.match(id, V4);
    assert.equal(getDeviceId(), id, 'and it is still stable across calls');
  });
});

test('an id is produced even with no crypto at all', () => {
  withCrypto(undefined, () => {
    store.clear();
    assert.match(getDeviceId(), V4);
  });
});

test('ids do not collide when generated from the fallback', () => {
  withCrypto(insecureCrypto(), () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      store.clear();
      seen.add(getDeviceId());
    }
    assert.equal(seen.size, 500);
  });
});
