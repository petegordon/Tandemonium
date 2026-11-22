// ============================================================
// STRIPE — Checkout session creation & webhook handling
// ============================================================

const STRIPE_API = 'https://api.stripe.com/v1';

/**
 * Create a Stripe Checkout Session for a product purchase.
 * Returns { url } for redirect.
 */
export async function createCheckoutSession(env, userId, product, successUrl, cancelUrl) {
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('line_items[0][price]', product.stripe_price_id);
  params.set('line_items[0][quantity]', '1');
  params.set('metadata[user_id]', String(userId));
  params.set('metadata[product_id]', product.id);
  params.set('metadata[game_id]', product.game_id);
  params.set('success_url', successUrl);
  params.set('cancel_url', cancelUrl);

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Stripe error: ${err.error?.message || res.status}`);
  }

  return res.json();
}

/**
 * Verify a Stripe webhook signature (v1 scheme).
 * Returns the parsed event object or throws on invalid signature.
 */
export async function verifyWebhookSignature(rawBody, sigHeader, webhookSecret) {
  if (!sigHeader) throw new Error('Missing Stripe-Signature header');

  // Stripe sends one v1 per active signing secret (two while a secret is being rolled).
  let timestamp = null;
  const signatures = [];
  for (const part of sigHeader.split(',')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const val = part.slice(at + 1).trim();
    if (name === 't') timestamp = val;
    else if (name === 'v1') signatures.push(val);
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signatures.length) throw new Error('Invalid signature format');

  // Reject timestamps older than 5 minutes
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (Math.abs(age) > 300) throw new Error('Webhook timestamp too old');

  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  // crypto.subtle.verify compares in constant time. Every value is checked.
  const data = new TextEncoder().encode(signedPayload);
  let valid = false;
  for (const candidate of signatures.slice(0, 8)) {
    if (!/^[0-9a-fA-F]{64}$/.test(candidate)) continue;
    const bytes = Uint8Array.from(candidate.match(/../g), (h) => parseInt(h, 16));
    const match = await crypto.subtle.verify('HMAC', key, bytes, data);
    valid = match || valid;
  }
  if (!valid) throw new Error('Invalid webhook signature');

  return JSON.parse(rawBody);
}

/**
 * Retrieve a Checkout Session from Stripe (for success page verification).
 */
export async function retrieveCheckoutSession(env, sessionId) {
  const res = await fetch(`${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`Stripe retrieve error: ${res.status}`);
  return res.json();
}
