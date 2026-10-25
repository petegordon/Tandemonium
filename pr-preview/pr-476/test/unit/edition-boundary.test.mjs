// PR #397 B4a/B4b — the demo boundary: invite links and URL tidying keep the
// edition, and ?mode=tourist is ignored in the demo. Own file (own process) so
// the cached edition rules start from the stubbed location below.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = { search: '?demo=1&mode=tourist&room=TNDM-ABCD' };
globalThis.window = { location: globalThis.location };

const { carriedQuery, buildJoinUrl, CARRIED_PARAMS } = await import('../../js/edition.js');
const { isTouristMode } = await import('../../js/tourist-config.js');

test('URL tidy keeps demo and media, drops everything else', () => {
  assert.deepEqual([...CARRIED_PARAMS], ['demo', 'media']);
  assert.equal(carriedQuery('?room=TNDM-ABCD&demo=1'), '?demo=1');
  assert.equal(carriedQuery('?demo=1&media=1&room=X&daily=2026-10-05'), '?demo=1&media=1');
  assert.equal(carriedQuery('?room=X'), '');
  assert.equal(carriedQuery(''), '');
  assert.equal(carriedQuery(undefined), '');
});

test('join links carry demo / media only when on', () => {
  const base = 'https://tandemonium.jimandi.love/';
  assert.equal(buildJoinUrl(base, 'TNDM-ABCD'), base + '?room=TNDM-ABCD');
  assert.equal(buildJoinUrl(base, 'TNDM-ABCD', { demo: true }), base + '?room=TNDM-ABCD&demo=1');
  assert.equal(buildJoinUrl(base, 'TNDM-ABCD', { demo: true, media: true }), base + '?room=TNDM-ABCD&demo=1&media=1');
  assert.equal(new URL(buildJoinUrl(base, 'X', { demo: true })).searchParams.get('demo'), '1');
});

test('?mode=tourist is ignored in the demo', () => {
  assert.equal(isTouristMode(), false);
});
