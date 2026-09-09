// ============================================================
// PAYMENTS — Record keeping for transactions
// ============================================================

/**
 * Create a pending payment record when checkout starts.
 */
export async function createPayment(db, { userId, productId, stripeSessionId, amountCents, currency }) {
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO payments (id, user_id, product_id, stripe_checkout_session_id, amount_cents, currency, status)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')
  `).bind(id, userId, productId, stripeSessionId, amountCents, currency).run();
  return id;
}

/**
 * Mark a payment as succeeded and link it to a license.
 */
export async function completePayment(db, stripeSessionId, licenseId, paymentIntentId) {
  await db.prepare(`
    UPDATE payments
    SET status = 'succeeded', license_id = ?1, stripe_payment_intent_id = ?2
    WHERE stripe_checkout_session_id = ?3
  `).bind(licenseId, paymentIntentId, stripeSessionId).run();
}

/**
 * Mark a payment as refunded.
 */
export async function refundPayment(db, paymentIntentId) {
  await db.prepare(`
    UPDATE payments SET status = 'refunded'
    WHERE stripe_payment_intent_id = ?1
  `).bind(paymentIntentId).run();
}

/**
 * Look up a payment by Stripe session ID.
 */
export async function getPaymentBySession(db, stripeSessionId) {
  return db.prepare(`
    SELECT * FROM payments WHERE stripe_checkout_session_id = ?1
  `).bind(stripeSessionId).first();
}
