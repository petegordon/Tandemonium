// ============================================================
// USERSFIRST STORE — Cloudflare Worker
// Centralized licensing & payments for all games
// ============================================================

import { getUserFromRequest } from './store/auth.js';
import { createCheckoutSession, verifyWebhookSignature, retrieveCheckoutSession } from './store/stripe.js';
import { grantLicense, checkLicense, getUserLicenses, revokeLicense } from './store/licenses.js';
import { createPayment, completePayment, refundPayment } from './store/payments.js';
import { getProduct, getGameProducts, getAllProducts } from './store/products.js';
import { redeemPromoCode, RedeemError } from './store/promo.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestOrigin = request.headers.get('Origin') || '';
    const allowedOrigins = (env.CORS_ORIGINS || '').split(',').map(s => s.trim());
    const corsOrigin = (allowedOrigins.includes(requestOrigin) || /^https?:\/\/localhost(:\d+)?$/.test(requestOrigin))
      ? requestOrigin
      : allowedOrigins[0] || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(corsOrigin) });
    }

    try {
      const path = url.pathname;
      const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

      // ── Public routes ──────────────────────────────────
      if (path === '/products' && request.method === 'GET') {
        const gameId = url.searchParams.get('game');
        const products = gameId ? await getGameProducts(env.DB, gameId) : await getAllProducts(env.DB);
        return jsonResponse({ products }, 200, corsOrigin);
      }

      // ── Stripe webhook (no auth — verified by signature) ──
      if (path === '/webhook' && request.method === 'POST') {
        return handleWebhook(request, env, corsOrigin);
      }

      // ── Checkout session status (for success page) ──
      if (path === '/checkout/status' && request.method === 'GET') {
        const sessionId = url.searchParams.get('session_id');
        if (!sessionId) return jsonResponse({ error: 'Missing session_id' }, 400, corsOrigin);
        const session = await retrieveCheckoutSession(env, sessionId);
        return jsonResponse({
          status: session.payment_status,
          game_id: session.metadata?.game_id,
        }, 200, corsOrigin);
      }

      // ── Auth-required routes ───────────────────────────
      const userId = await getUserFromRequest(request, env);

      // License check — allow both authed users and service-to-service calls
      if (path.match(/^\/license\/\d+\/[\w-]+$/) && request.method === 'GET') {
        return handleLicenseCheck(request, env, url, corsOrigin, userId);
      }

      if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401, corsOrigin);

      if (path === '/checkout' && request.method === 'POST') {
        const limited = await checkRateLimit(env.CHECKOUT_LIMITER, clientIP, corsOrigin);
        if (limited) return limited;
        return handleCheckout(request, env, corsOrigin, userId);
      }

      if (path === '/licenses' && request.method === 'GET') {
        const licenses = await getUserLicenses(env.DB, userId);
        return jsonResponse({ licenses }, 200, corsOrigin);
      }

      if (path === '/redeem' && request.method === 'POST') {
        return handleRedeem(request, env, corsOrigin, userId);
      }

      return jsonResponse({ error: 'Not found' }, 404, corsOrigin);
    } catch (e) {
      writeMetric(env, 'error', e.message);
      return jsonResponse({ error: e.message }, 500, corsOrigin);
    }
  }
};

// ============================================================
// ROUTE HANDLERS
// ============================================================

async function handleCheckout(request, env, corsOrigin, userId) {
  const { productId, successUrl, cancelUrl } = await request.json();
  if (!productId) return jsonResponse({ error: 'Missing productId' }, 400, corsOrigin);

  const product = await getProduct(env.DB, productId);
  if (!product) return jsonResponse({ error: 'Product not found or inactive' }, 404, corsOrigin);
  if (!product.stripe_price_id) return jsonResponse({ error: 'Product not configured for purchase' }, 400, corsOrigin);

  // Check if user already has an active license for this game+platform
  const existing = await checkLicense(env.DB, userId, product.game_id);
  if (existing && existing.product_platform === product.platform) {
    return jsonResponse({ error: 'Already licensed', license: existing }, 409, corsOrigin);
  }

  const defaultSuccess = `${env.STORE_URL || 'https://games.usersfirst.com'}/success.html?session_id={CHECKOUT_SESSION_ID}`;
  const defaultCancel = `${env.STORE_URL || 'https://games.usersfirst.com'}/store.html`;

  const session = await createCheckoutSession(env, userId, product,
    successUrl || defaultSuccess,
    cancelUrl || defaultCancel
  );

  // Record the pending payment
  await createPayment(env.DB, {
    userId,
    productId,
    stripeSessionId: session.id,
    amountCents: product.price_cents,
    currency: product.currency,
  });

  writeMetric(env, 'checkout_created', product.game_id);
  return jsonResponse({ url: session.url, sessionId: session.id }, 200, corsOrigin);
}

async function handleWebhook(request, env, corsOrigin) {
  const rawBody = await request.text();
  const sigHeader = request.headers.get('stripe-signature');

  let event;
  try {
    event = await verifyWebhookSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    writeMetric(env, 'webhook_sig_fail', e.message);
    return jsonResponse({ error: 'Invalid signature' }, 400, corsOrigin);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') {
      return jsonResponse({ received: true }, 200, corsOrigin);
    }

    const { user_id, product_id, game_id } = session.metadata || {};
    if (!user_id || !product_id || !game_id) {
      writeMetric(env, 'webhook_missing_meta', session.id);
      return jsonResponse({ error: 'Missing metadata' }, 400, corsOrigin);
    }

    const product = await getProduct(env.DB, product_id);
    if (!product) {
      writeMetric(env, 'webhook_bad_product', product_id);
      return jsonResponse({ error: 'Unknown product' }, 400, corsOrigin);
    }

    // Grant the license
    const licenseId = await grantLicense(env.DB, {
      userId: parseInt(user_id, 10),
      gameId: game_id,
      productId: product_id,
      platform: product.platform,
    });

    // Update payment record
    await completePayment(env.DB, session.id, licenseId, session.payment_intent);

    writeMetric(env, 'license_granted', `${game_id}:${user_id}`);
  }

  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const paymentIntentId = charge.payment_intent;
    if (paymentIntentId) {
      await refundPayment(env.DB, paymentIntentId);

      // Find and revoke the associated license
      const refundedPayment = await env.DB.prepare(`
        SELECT p.*, pr.game_id, pr.platform
        FROM payments p
        JOIN products pr ON pr.id = p.product_id
        WHERE p.stripe_payment_intent_id = ?1
      `).bind(paymentIntentId).first();

      if (refundedPayment) {
        await revokeLicense(env.DB, refundedPayment.user_id, refundedPayment.game_id, refundedPayment.platform);
        writeMetric(env, 'license_revoked_refund', `${refundedPayment.game_id}:${refundedPayment.user_id}`);
      }
    }
  }

  return jsonResponse({ received: true }, 200, corsOrigin);
}

async function handleLicenseCheck(request, env, url, corsOrigin, userId) {
  const parts = url.pathname.split('/');
  const checkUserId = parseInt(parts[2], 10);
  const gameId = parts[3];

  // Users can only check their own license (or we could add service tokens later)
  if (userId && userId !== checkUserId) {
    return jsonResponse({ error: 'Forbidden' }, 403, corsOrigin);
  }
  if (!userId) {
    // Require auth for license checks
    return jsonResponse({ error: 'Unauthorized' }, 401, corsOrigin);
  }

  const license = await checkLicense(env.DB, checkUserId, gameId);
  if (!license) {
    return jsonResponse({ licensed: false }, 200, corsOrigin);
  }

  return jsonResponse({
    licensed: true,
    tier: license.tier,
    platform: license.product_platform,
    granted_at: license.granted_at,
  }, 200, corsOrigin);
}

async function handleRedeem(request, env, corsOrigin, userId) {
  const { code } = await request.json();
  if (!code) return jsonResponse({ error: 'Missing code' }, 400, corsOrigin);

  try {
    const result = await redeemPromoCode(env.DB, userId, code);
    writeMetric(env, 'promo_redeemed', `${result.gameId}:${userId}`);
    return jsonResponse({ success: true, ...result }, 200, corsOrigin);
  } catch (e) {
    if (e instanceof RedeemError) {
      return jsonResponse({ error: e.message }, e.status, corsOrigin);
    }
    throw e;
  }
}

// ============================================================
// HELPERS
// ============================================================

async function checkRateLimit(limiter, key, corsOrigin) {
  if (!limiter) return null;
  const { success } = await limiter.limit({ key });
  if (!success) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '60', ...corsHeaders(corsOrigin) },
    });
  }
  return null;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status, corsOrigin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(corsOrigin || '*') },
  });
}

function writeMetric(env, event, extra) {
  if (!env.ANALYTICS) return;
  env.ANALYTICS.writeDataPoint({
    blobs: [event, ...(extra ? [extra] : [])],
    doubles: [1],
    indexes: [event],
  });
}
