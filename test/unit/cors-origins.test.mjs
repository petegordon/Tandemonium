import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCorsOrigin } from '../../worker/leaderboard.js';

const LIST = 'https://tandemonium.housetandem.com,https://tandemonium.jimandi.love';

test('API worker accepts the new and old game addresses during the move', () => {
  assert.equal(pickCorsOrigin('https://tandemonium.housetandem.com', LIST), 'https://tandemonium.housetandem.com');
  assert.equal(pickCorsOrigin('https://tandemonium.jimandi.love', LIST), 'https://tandemonium.jimandi.love');
  assert.equal(pickCorsOrigin('http://localhost:8080', LIST), 'https://tandemonium.housetandem.com', 'not on the list');
  assert.equal(pickCorsOrigin('http://localhost:8080', LIST + ',http://localhost:8080'), 'http://localhost:8080');
});

test('a numbered preview entry matches a PR number and nothing else', () => {
  const list = 'https://staging.example,https://pr-*-site-staging.acct.workers.dev';
  assert.equal(pickCorsOrigin('https://pr-861-site-staging.acct.workers.dev', list), 'https://pr-861-site-staging.acct.workers.dev');
  for (const bad of [
    'https://pr-x-site-staging.acct.workers.dev',
    'https://pr--site-staging.acct.workers.dev',
    'https://pr-1.evil.example-site-staging.acct.workers.dev',
    'https://pr-1-site-staging.acct.workers.dev.evil.example',
    'http://pr-1-site-staging.acct.workers.dev',
    'https://pr-1234567-site-staging.acct.workers.dev',
  ]) assert.equal(pickCorsOrigin(bad, list), 'https://staging.example', bad);
});

test('other sites get the primary address, which does not match them', () => {
  assert.equal(pickCorsOrigin('https://evil.example', LIST), 'https://tandemonium.housetandem.com');
  assert.equal(pickCorsOrigin('', LIST), 'https://tandemonium.housetandem.com');
});

test("'*' or no setting allows any origin", () => {
  assert.equal(pickCorsOrigin('https://x.example', '*'), 'https://x.example');
  assert.equal(pickCorsOrigin('https://x.example', undefined), 'https://x.example');
});
