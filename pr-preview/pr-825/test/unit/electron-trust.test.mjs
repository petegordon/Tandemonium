// The desktop build's rules for what is ours (electron/trust.js): the game's own page and
// House Tandem's servers. Everything else is an ordinary web page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../../electron/trust.js');

test('the API is matched by host name, not by a word somewhere in the address', () => {
  assert.equal(T.isApiUrl('https://tandemonium-api.pete-872.workers.dev/me'), true);
  assert.equal(T.isApiUrl('https://tandemonium-relay.pete-872.workers.dev/turn-credentials'), true);
  assert.equal(T.isApiUrl('https://api.housetandem.com/me'), true);
  for (const url of [
    'https://example.com/?next=workers.dev',
    'https://example.com/pete-872.workers.dev/x',
    'https://someone-else.workers.dev/me',
    'https://pete-872.workers.dev.example.com/me',
    'https://api.housetandem.com.example.com/me',
    'https://xjimandi.love/', 'not a url', '',
  ]) assert.equal(T.isApiUrl(url), false, url);
});

test('map servers are Google\'s own hosts', () => {
  assert.equal(T.isTilesUrl('https://tile.googleapis.com/v1/3dtiles/root.json?key=k'), true);
  assert.equal(T.isTilesUrl('https://maps.googleapis.com/maps/api/js'), true);
  assert.equal(T.isTilesUrl('https://example.com/tile.googleapis.com'), false);
  assert.equal(T.isTilesUrl('https://tile.googleapis.com.example.com/'), false);
});

test('the game\'s own page, and web pages', () => {
  assert.equal(T.isGameUrl('tandemonium://app/index.html?demo=1'), true);
  assert.equal(T.isGameUrl('tandemonium://app'), true);
  assert.equal(T.isGameUrl('tandemonium://application/index.html'), false);
  assert.equal(T.isGameUrl('https://store.steampowered.com/app/4482940/'), false);
  assert.equal(T.isGameUrl(undefined), false);

  assert.equal(T.isWebOrigin('https://store.steampowered.com'), true);
  assert.equal(T.isWebOrigin('http://creativecommons.org/'), true);
  assert.equal(T.isWebOrigin('tandemonium://app'), false, 'the game keeps its permissions');
  assert.equal(T.isWebOrigin(''), false);
});

test('a new window is for a web address only', () => {
  assert.equal(T.isWebLink('https://store.steampowered.com/app/4482940/Tandemonium/'), true);
  assert.equal(T.isWebLink('http://creativecommons.org/licenses/by/4.0/'), true);
  for (const url of ['file:///C:/Windows/system.ini', 'tandemonium://app/index.html', 'javascript:alert(1)', 'ms-settings:', 'nonsense']) {
    assert.equal(T.isWebLink(url), false, url);
  }
});

test('the system browser is opened only for our own sign-in pages', () => {
  assert.equal(T.isSignInUrl('https://tandemonium-api.pete-872.workers.dev/auth/discord/go?r=abc'), true);
  assert.equal(T.isSignInUrl('https://api.housetandem.com/auth/discord/go?r=abc'), true);
  for (const url of [
    'https://someone-else.workers.dev/auth/discord/go',
    'https://api.housetandem.com/share/x',
    'http://api.housetandem.com/auth/discord/go',
    'https://api.housetandem.com.example.com/auth/x',
    'file:///auth/x', 42, null,
  ]) assert.equal(T.isSignInUrl(url), false, String(url));
});
