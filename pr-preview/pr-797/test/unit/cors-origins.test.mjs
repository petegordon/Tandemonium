import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCorsOrigin } from '../../worker/leaderboard.js';

const LIST = 'https://tandemonium.housetandem.com,https://tandemonium.jimandi.love';

test('API worker accepts the new and old game addresses during the move', () => {
  assert.equal(pickCorsOrigin('https://tandemonium.housetandem.com', LIST), 'https://tandemonium.housetandem.com');
  assert.equal(pickCorsOrigin('https://tandemonium.jimandi.love', LIST), 'https://tandemonium.jimandi.love');
  assert.equal(pickCorsOrigin('http://localhost:8080', LIST), 'http://localhost:8080');
});

test('other sites get the primary address, which does not match them', () => {
  assert.equal(pickCorsOrigin('https://evil.example', LIST), 'https://tandemonium.housetandem.com');
  assert.equal(pickCorsOrigin('', LIST), 'https://tandemonium.housetandem.com');
});

test("'*' or no setting allows any origin", () => {
  assert.equal(pickCorsOrigin('https://x.example', '*'), 'https://x.example');
  assert.equal(pickCorsOrigin('https://x.example', undefined), 'https://x.example');
});
