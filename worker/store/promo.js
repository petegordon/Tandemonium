// ============================================================
// PROMO — Promo/beta key redemption
// ============================================================

/** Longest promo code accepted. */
const MAX_CODE = 64;

/**
 * Redeem a promo code for a user. Returns the license ID or throws.
 *
 * The use, its count and the license are one transaction, and the first statement is the
 * only gate: it records the redemption while the code still has a use left and this user
 * hasn't used it. Every later statement acts only if that row now exists, so a code can't
 * be used more times than it allows, however many requests arrive together.
 */
export async function redeemPromoCode(db, userId, code) {
  if (typeof code !== 'string' || !code || code.length > MAX_CODE) throw new RedeemError('Invalid promo code', 404);

  const key = await db.prepare(`
    SELECT * FROM promo_keys WHERE code = ?1
  `).bind(code).first();

  if (!key) throw new RedeemError('Invalid promo code', 404);
  const now = new Date().toISOString();
  if (key.expires_at && key.expires_at < now) throw new RedeemError('Promo code expired', 410);

  // Get the product to determine platform
  const product = await db.prepare(`
    SELECT * FROM products WHERE id = ?1
  `).bind(key.product_id).first();
  if (!product) throw new RedeemError('Product not found', 500);

  const redemptionId = crypto.randomUUID();
  const newLicenseId = crypto.randomUUID();
  const done = 'EXISTS (SELECT 1 FROM promo_redemptions WHERE id = ?1)';
  const results = await db.batch([
    db.prepare(`
      INSERT INTO promo_redemptions (id, code, user_id, license_id)
      SELECT ?1, ?2, ?3, NULL
      WHERE EXISTS (
        SELECT 1 FROM promo_keys
        WHERE code = ?2 AND times_used < max_uses AND (expires_at IS NULL OR expires_at >= ?4)
      )
      ON CONFLICT(code, user_id) DO NOTHING
    `).bind(redemptionId, code, userId, now),
    db.prepare(`
      UPDATE promo_keys SET times_used = times_used + 1 WHERE code = ?2 AND ${done}
    `).bind(redemptionId, code),
    db.prepare(`
      INSERT INTO licenses (id, user_id, game_id, product_id, platform, status, granted_at)
      SELECT ?2, ?3, ?4, ?5, ?6, 'active', datetime('now') WHERE ${done}
      ON CONFLICT(user_id, game_id, platform)
      DO UPDATE SET product_id = excluded.product_id, status = 'active', granted_at = datetime('now')
    `).bind(redemptionId, newLicenseId, userId, key.game_id, key.product_id, product.platform),
    db.prepare(`
      UPDATE promo_redemptions
      SET license_id = (SELECT id FROM licenses WHERE user_id = ?2 AND game_id = ?3 AND platform = ?4)
      WHERE id = ?1
    `).bind(redemptionId, userId, key.game_id, product.platform),
  ]);

  if (!results[0] || !results[0].meta || results[0].meta.changes !== 1) {
    const mine = await db.prepare(`
      SELECT id FROM promo_redemptions WHERE code = ?1 AND user_id = ?2
    `).bind(code, userId).first();
    if (mine) throw new RedeemError('Already redeemed', 409);
    throw new RedeemError('Promo code fully redeemed', 410);
  }

  const row = await db.prepare(`
    SELECT license_id FROM promo_redemptions WHERE id = ?1
  `).bind(redemptionId).first();
  return { licenseId: row && row.license_id, gameId: key.game_id, tier: product.tier };
}

export class RedeemError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
