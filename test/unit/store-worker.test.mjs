// The store: redirects stay on its own sites, a promo code is used at most as often as it
// allows, webhooks are signature-checked, and a refund takes back only what was refunded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import store from '../../worker/store.js';
import { checkoutRedirect } from '../../worker/store/redirects.js';
import { verifyWebhookSignature } from '../../worker/store/stripe.js';
import { redeemPromoCode, RedeemError } from '../../worker/store/promo.js';
import { grantLicense } from '../../worker/store/licenses.js';
import { signToken } from '../../worker/room-proof.js';

const JWT = 'store-jwt-secret';
const HOOK = 'whsec_test';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(new URL('../../worker/store/schema.sql', import.meta.url), 'utf8'));
  db.exec("UPDATE products SET stripe_price_id = 'price_1' WHERE id = 'tandemonium-web-early'");
  db.exec("INSERT INTO promo_keys (code, game_id, product_id, max_uses) VALUES ('ONE', 'tandemonium', 'tandemonium-web-early', 1), ('TWO', 'tandemonium', 'tandemonium-web-early', 2)");
  db.exec("INSERT INTO promo_keys (code, game_id, product_id, max_uses, expires_at) VALUES ('OLD', 'tandemonium', 'tandemonium-web-early', 5, '2020-01-01T00:00:00.000Z')");
  return db;
}
// numbered parameters (?1) are bound positionally here, as D1 does
function d1(db) {
  const bound = (sql, args) => ({
    _sql: sql, _args: args,
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => ({ bind: (...args) => bound(sql, args.map((a) => (a === undefined ? null : a))), ...bound(sql, []) }),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => ({ success: true, meta: { changes: Number(db.prepare(s._sql).run(...s._args).changes) } }));
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
const ENV = (db, extra = {}) => ({
  DB: d1(db), JWT_SECRET: JWT, STRIPE_WEBHOOK_SECRET: HOOK, STRIPE_SECRET_KEY: 'sk_test',
  CORS_ORIGINS: 'https://tandemonium.housetandem.com,https://games.usersfirst.com',
  STORE_URL: 'https://games.usersfirst.com', ...extra,
});
const call = async (env, p, { method = 'POST', body, user, headers = {} } = {}) => store.fetch(new Request('https://store.test' + p, {
  method,
  headers: {
    'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4',
    ...(user ? { Authorization: 'Bearer ' + await signToken({ sub: user }, JWT, 3600) } : {}), ...headers,
  },
  body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body),
}), env);

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}
const now = () => Math.floor(Date.now() / 1000);
async function signed(event, secret = HOOK, at = now()) {
  const raw = JSON.stringify(event);
  return { raw, header: `t=${at},v1=${await hmacHex(secret, `${at}.${raw}`)}` };
}
const hook = async (env, event) => {
  const { raw, header } = await signed(event);
  return call(env, '/webhook', { body: raw, headers: { 'stripe-signature': header } });
};

// ── Redirects ──
test('checkout redirects stay on the store\'s own sites', () => {
  const env = ENV(freshDb());
  const fallback = 'https://games.usersfirst.com/store.html';
  const own = 'https://tandemonium.housetandem.com/done?session_id={CHECKOUT_SESSION_ID}';
  assert.equal(checkoutRedirect(own, env, fallback), own, 'kept exactly, placeholder included');
  for (const bad of [
    'https://elsewhere.example/x', 'http://games.usersfirst.com/x', 'javascript:alert(1)', '//elsewhere.example',
    'https://games.usersfirst.com@elsewhere.example/', 'https://user:pw@games.usersfirst.com/',
    'https://games.usersfirst.com.elsewhere.example/', 'https:\\\\elsewhere.example', ' https://games.usersfirst.com/',
    '', null, 7, {}, 'https://games.usersfirst.com/' + 'x'.repeat(3000),
  ]) assert.equal(checkoutRedirect(bad, env, fallback), fallback, String(bad));
});

test('a checkout with outside addresses goes to Stripe with the store\'s own', async () => {
  const db = freshDb();
  const real = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (u, init) => { sent = new URLSearchParams(init.body); return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.test/1' })); };
  try {
    const res = await call(ENV(db), '/checkout', { user: 5, body: { productId: 'tandemonium-web-early', successUrl: 'https://elsewhere.example/a', cancelUrl: 'https://elsewhere.example/b' } });
    assert.equal(res.status, 200);
    assert.equal(sent.get('success_url'), 'https://games.usersfirst.com/success.html?session_id={CHECKOUT_SESSION_ID}');
    assert.equal(sent.get('cancel_url'), 'https://games.usersfirst.com/store.html');
  } finally { globalThis.fetch = real; }
});

// ── Promo codes ──
test('a one-use code redeemed by many at once is granted once', async () => {
  const db = freshDb();
  const env = ENV(db);
  const out = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((u) => redeemPromoCode(env.DB, u, 'ONE')));
  assert.equal(out.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of out.filter((x) => x.status === 'rejected')) {
    assert.ok(r.reason instanceof RedeemError);
    assert.equal(r.reason.status, 410);
  }
  assert.equal(db.prepare("SELECT times_used n FROM promo_keys WHERE code = 'ONE'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM promo_redemptions WHERE code = 'ONE'").get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM licenses').get().n, 1);
});

test('one user cannot use a code twice, and a refused try changes nothing', async () => {
  const db = freshDb();
  const env = ENV(db);
  const first = await redeemPromoCode(env.DB, 9, 'TWO');
  assert.equal(first.tier, 'early_access');
  assert.equal(db.prepare('SELECT license_id FROM promo_redemptions WHERE user_id = 9').get().license_id, first.licenseId);
  assert.equal(db.prepare('SELECT id FROM licenses WHERE user_id = 9').get().id, first.licenseId);
  await assert.rejects(redeemPromoCode(env.DB, 9, 'TWO'), (e) => e.status === 409);
  assert.equal(db.prepare("SELECT times_used n FROM promo_keys WHERE code = 'TWO'").get().n, 1);
  await assert.rejects(redeemPromoCode(env.DB, 1, 'OLD'), (e) => e.status === 410);
  await assert.rejects(redeemPromoCode(env.DB, 1, 'NOPE'), (e) => e.status === 404);
  await assert.rejects(redeemPromoCode(env.DB, 1, 'x'.repeat(65)), (e) => e.status === 404);
  await assert.rejects(redeemPromoCode(env.DB, 1, { a: 1 }), (e) => e.status === 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM licenses WHERE user_id = 1').get().n, 0);
});

test('redeeming is rate limited by account and by IP', async () => {
  const db = freshDb();
  const keys = [];
  const env = ENV(db, { CHECKOUT_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: !key.startsWith('redeem:user:66') }; } } });
  const blocked = await call(env, '/redeem', { user: 66, body: { code: 'TWO' } });
  assert.equal(blocked.status, 429);
  assert.equal(db.prepare("SELECT times_used n FROM promo_keys WHERE code = 'TWO'").get().n, 0);
  const ok = await call(env, '/redeem', { user: 67, body: { code: 'TWO' } });
  assert.equal(ok.status, 200);
  assert.ok(keys.includes('redeem:user:67') && keys.includes('redeem:ip:1.2.3.4'));
});

// ── Errors ──
test('a failure answers with a plain message, not the internal one', async () => {
  const env = ENV(freshDb());
  env.DB = { prepare() { throw new Error('D1_ERROR: no such table: internal_detail'); } };
  const quiet = console.error;
  console.error = () => {};
  try {
    const res = await call(env, '/products', { method: 'GET' });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'Something went wrong' });
  } finally { console.error = quiet; }
});

test('a body that is not JSON is a 400', async () => {
  const env = ENV(freshDb());
  assert.equal((await call(env, '/redeem', { user: 3, body: 'not json' })).status, 400);
  assert.equal((await call(env, '/checkout', { user: 3, body: 'null' })).status, 400);
});

// ── Webhook signatures ──
test('a correct signature is accepted, including among several v1 values', async () => {
  const { raw, header } = await signed({ id: 'evt_1' });
  assert.equal((await verifyWebhookSignature(raw, header, HOOK)).id, 'evt_1');
  const v1 = header.split('v1=')[1];
  const t = header.split(',')[0];
  const other = 'ab'.repeat(32);
  assert.equal((await verifyWebhookSignature(raw, `${t},v1=${v1},v1=${other}`, HOOK)).id, 'evt_1', 'first of two');
  assert.equal((await verifyWebhookSignature(raw, `${t},v1=${other},v1=${v1}`, HOOK)).id, 'evt_1', 'last of two');
  assert.equal((await verifyWebhookSignature(raw, `${t},v0=zz,v1=${v1}`, HOOK)).id, 'evt_1', 'other schemes are ignored');
});

test('a wrong, old or malformed signature is refused', async () => {
  const { raw, header } = await signed({ id: 'evt_1' });
  const v1 = header.split('v1=')[1];
  const t = now();
  await assert.rejects(verifyWebhookSignature(raw + ' ', header, HOOK));
  await assert.rejects(verifyWebhookSignature(raw, header, 'whsec_other'));
  await assert.rejects(verifyWebhookSignature(raw, `t=${t}`, HOOK));
  await assert.rejects(verifyWebhookSignature(raw, `v1=${v1}`, HOOK));
  await assert.rejects(verifyWebhookSignature(raw, `t=abc,v1=${v1}`, HOOK), /format/);
  await assert.rejects(verifyWebhookSignature(raw, `t=${t},v1=zz`, HOOK));
  await assert.rejects(verifyWebhookSignature(raw, null, HOOK));
  const old = await signed({ id: 'evt_1' }, HOOK, now() - 1000);
  await assert.rejects(verifyWebhookSignature(old.raw, old.header, HOOK), /too old/);
});

// ── Refunds ──
function bought(db, { pi = 'pi_1', user = 5, product = 'tandemonium-web-early' } = {}) {
  db.prepare("INSERT OR IGNORE INTO licenses (id, user_id, game_id, product_id, platform, status) VALUES ('lic1', ?, 'tandemonium', ?, 'web', 'active')").run(user, product);
  db.prepare("INSERT INTO payments (id, license_id, user_id, product_id, stripe_payment_intent_id, amount_cents, status) VALUES (?, 'lic1', ?, ?, ?, 599, 'succeeded')").run('pay-' + pi, user, product, pi);
}
const refund = (pi, refunded, amountRefunded) => ({ type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: pi, refunded, amount: 599, amount_refunded: amountRefunded } } });
const licenseStatus = (db) => db.prepare("SELECT status FROM licenses WHERE id = 'lic1'").get().status;

test('a partial refund keeps the license', async () => {
  const db = freshDb();
  bought(db);
  assert.equal((await hook(ENV(db), refund('pi_1', false, 100))).status, 200);
  assert.equal(licenseStatus(db), 'active');
  assert.equal(db.prepare("SELECT status FROM payments WHERE id = 'pay-pi_1'").get().status, 'succeeded');
});

test('a full refund revokes it, including when partial refunds add up', async () => {
  const db = freshDb();
  bought(db);
  const env = ENV(db);
  await hook(env, refund('pi_1', false, 300));
  assert.equal(licenseStatus(db), 'active');
  await hook(env, refund('pi_1', true, 599));
  assert.equal(licenseStatus(db), 'refunded');
  assert.equal(db.prepare("SELECT status FROM payments WHERE id = 'pay-pi_1'").get().status, 'refunded');
});

test('refunding an earlier purchase leaves a later upgrade alone', async () => {
  const db = freshDb();
  bought(db, { pi: 'pi_old' });
  db.exec("UPDATE licenses SET product_id = 'tandemonium-web-general' WHERE id = 'lic1'");
  await hook(ENV(db), refund('pi_old', true, 599));
  assert.equal(licenseStatus(db), 'active');
});

test('buying again returns the id of the license row it updated', async () => {
  const db = freshDb();
  const env = ENV(db);
  const a = await grantLicense(env.DB, { userId: 8, gameId: 'tandemonium', productId: 'tandemonium-web-early', platform: 'web' });
  const b = await grantLicense(env.DB, { userId: 8, gameId: 'tandemonium', productId: 'tandemonium-web-general', platform: 'web' });
  assert.equal(a, b);
  assert.equal(db.prepare('SELECT id FROM licenses WHERE user_id = 8').get().id, a);
});

test('a completed checkout for a returning buyer links the payment to the license', async () => {
  const db = freshDb();
  const env = ENV(db);
  const a = await grantLicense(env.DB, { userId: 8, gameId: 'tandemonium', productId: 'tandemonium-web-early', platform: 'web' });
  db.exec("UPDATE licenses SET status = 'refunded' WHERE user_id = 8");
  db.exec("INSERT INTO payments (id, user_id, product_id, stripe_checkout_session_id, amount_cents, status) VALUES ('p2', 8, 'tandemonium-web-early', 'cs_test_2', 599, 'pending')");
  const res = await hook(env, { type: 'checkout.session.completed', data: { object: {
    id: 'cs_test_2', payment_status: 'paid', payment_intent: 'pi_2',
    metadata: { user_id: '8', product_id: 'tandemonium-web-early', game_id: 'tandemonium' },
  } } });
  assert.equal(res.status, 200);
  const pay = db.prepare("SELECT status, license_id FROM payments WHERE id = 'p2'").get();
  assert.equal(pay.status, 'succeeded');
  assert.equal(pay.license_id, a);
  assert.equal(db.prepare('SELECT status FROM licenses WHERE user_id = 8').get().status, 'active');
});
