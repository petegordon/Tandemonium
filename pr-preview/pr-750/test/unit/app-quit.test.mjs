import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canQuitApp, requestAppQuit } from '../../js/app-quit.js';

test('quit is offered only where the Electron bridge exposes quit()', () => {
  assert.equal(canQuitApp({ electronApp: { quit() {} } }), true);
  assert.equal(canQuitApp({ electronApp: { toggleDevTools() {} } }), false, 'older preload without quit');
  assert.equal(canQuitApp({}), false, 'web build: no bridge');
  assert.equal(canQuitApp(undefined), false);
  assert.equal(canQuitApp({ electronApp: null }), false);
  // A phone UA never has the bridge either; the predicate looks only at the bridge.
  assert.equal(canQuitApp({ navigator: { userAgent: 'iPhone' } }), false);
});

test('requestAppQuit calls the bridge once and reports whether it could', () => {
  let calls = 0;
  const win = { electronApp: { quit() { calls++; } } };
  assert.equal(requestAppQuit(win), true);
  assert.equal(calls, 1);
  assert.equal(requestAppQuit({}), false, 'nothing to call on the web');
  assert.equal(requestAppQuit({ electronApp: { quit() { throw new Error('ipc down'); } } }), false, 'a throwing bridge is reported, not thrown');
});
