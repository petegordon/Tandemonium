// ============================================================
// PROMO — Promo/beta key redemption
// ============================================================

import { grantLicense } from './licenses.js';

/**
 * Redeem a promo code for a user. Returns the license ID or throws.
 */
export async function redeemPromoCode(db, userId, code) {
  const key = await db.prepare(`
    SELECT * FROM promo_keys WHERE code = ?1
  `).bind(code).first();

  if (!key) throw new RedeemError('Invalid promo code', 404);
  if (key.times_used >= key.max_uses) throw new RedeemError('Promo code fully redeemed', 410);
  if (key.expires_at && key.expires_at < new Date().toISOString()) throw new RedeemError('Promo code expired', 410);

  // Check if user already redeemed this code
  const existing = await db.prepare(`
    SELECT id FROM promo_redemptions WHERE code = ?1 AND user_id = ?2
  `).bind(code, userId).first();
  if (existing) throw new RedeemError('Already redeemed', 409);

  // Get the product to determine platform
  const product = await db.prepare(`
    SELECT * FROM products WHERE id = ?1
  `).bind(key.product_id).first();
  if (!product) throw new RedeemError('Product not found', 500);

  // Grant the license
  const licenseId = await grantLicense(db, {
    userId,
    gameId: key.game_id,
    productId: key.product_id,
    platform: product.platform,
  });

  // Record the redemption and increment usage
  const redemptionId = crypto.randomUUID();
  await db.batch([
    db.prepare(`
      INSERT INTO promo_redemptions (id, code, user_id, license_id) VALUES (?1, ?2, ?3, ?4)
    `).bind(redemptionId, code, userId, licenseId),
    db.prepare(`
      UPDATE promo_keys SET times_used = times_used + 1 WHERE code = ?1
    `).bind(code),
  ]);

  return { licenseId, gameId: key.game_id, tier: product.tier };
}

export class RedeemError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
