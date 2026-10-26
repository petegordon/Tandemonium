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

  const elements = Object.fromEntries(
    sigHeader.split(',').map(part => {
      const [key, val] = part.split('=');
      return [key, val];
    })
  );

  const timestamp = elements.t;
  const expectedSig = elements.v1;
  if (!timestamp || !expectedSig) throw new Error('Invalid signature format');

  // Reject timestamps older than 5 minutes
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (Math.abs(age) > 300) throw new Error('Webhook timestamp too old');

  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  if (computed !== expectedSig) throw new Error('Invalid webhook signature');

  return JSON.parse(rawBody);
}

/**
 * Retrieve a Checkout Session from Stripe (for success page verification).
 */
export async function retrieveCheckoutSession(env, sessionId) {
  const res = await fetch(`${STRIPE_API}/checkout/sessions/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`Stripe retrieve error: ${res.status}`);
  return res.json();
}
