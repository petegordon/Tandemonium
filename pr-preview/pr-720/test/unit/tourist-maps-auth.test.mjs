// #366 · a Maps JS auth failure must fail fast, not wait out the 6 s timeout.
import test from 'node:test';
import assert from 'node:assert/strict';

// Just enough browser for tourist-config.js. Google's requests never settle,
// which is what Maps JS does when the key is not authorised.
let priorHandlerCalls = 0;
const hang = () => new Promise(() => {});
globalThis.window = {
  location: { search: '' },
  __TOURIST_MAPS_KEY__: 'test-key',
  gm_authFailure: () => { priorHandlerCalls++; },
};
globalThis.location = window.location;
globalThis.document = {
  createElement: () => ({}),
  head: {
    // The script "loads" and its callback fires, as it does with a bad key.
    appendChild: () => setTimeout(() => window.__touristMapsReady(), 5),
  },
};
globalThis.google = {
  maps: {
    importLibrary: async () => ({
      ElevationService: class { getElevationForLocations() { return hang(); } },
      Geocoder: class { geocode() { return hang(); } },
    }),
  },
};
globalThis.fetch = async () => ({ ok: true, json: async () => ({ elevation: [250] }) });
// Silence the expected fallback warnings.
console.warn = () => {};

const { resolveOriginAt, geocodeAddress, ANCHOR_MARGIN } =
  await import('../../js/tourist-config.js');

test('auth failure drops elevation to the open-meteo fallback right away', async () => {
  const start = Date.now();
  const pending = resolveOriginAt({ lat: 39.9, lon: -83.0, label: 'Somewhere' });
  setTimeout(() => window.gm_authFailure(), 50);
  const origin = await pending;
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 1000, `took ${elapsed} ms, expected well under 6000`);
  assert.equal(origin.source, 'open-meteo fallback');
  assert.equal(origin.height, 250 + ANCHOR_MARGIN);
  assert.equal(origin.anchored, true);
  assert.equal(priorHandlerCalls, 1, 'an existing gm_authFailure is still called');
});

test('geocoding rejects immediately once auth has failed', async () => {
  const start = Date.now();
  await assert.rejects(geocodeAddress('1 Main St'), /auth failed/);
  assert.ok(Date.now() - start < 1000);
});
