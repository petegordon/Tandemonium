// ============================================================
// LICENSES — CRUD for entitlements
// ============================================================

/**
 * Grant a license to a user after successful payment.
 * Uses INSERT OR REPLACE so re-purchasing on same platform upgrades the tier.
 */
export async function grantLicense(db, { userId, gameId, productId, platform }) {
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO licenses (id, user_id, game_id, product_id, platform, status, granted_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 'active', datetime('now'))
    ON CONFLICT(user_id, game_id, platform)
    DO UPDATE SET product_id = ?4, status = 'active', granted_at = datetime('now')
  `).bind(id, userId, gameId, productId, platform).run();
  return id;
}

/**
 * Check if a user has an active license for a specific game.
 * Returns the license row or null.
 */
export async function checkLicense(db, userId, gameId) {
  const result = await db.prepare(`
    SELECT l.*, p.tier, p.platform as product_platform
    FROM licenses l
    JOIN products p ON p.id = l.product_id
    WHERE l.user_id = ?1 AND l.game_id = ?2 AND l.status = 'active'
      AND (l.expires_at IS NULL OR l.expires_at > datetime('now'))
    ORDER BY l.granted_at DESC
    LIMIT 1
  `).bind(userId, gameId).first();
  return result || null;
}

/**
 * Get all active licenses for a user.
 */
export async function getUserLicenses(db, userId) {
  const { results } = await db.prepare(`
    SELECT l.*, p.tier, p.platform as product_platform, g.name as game_name
    FROM licenses l
    JOIN products p ON p.id = l.product_id
    JOIN games g ON g.id = l.game_id
    WHERE l.user_id = ?1 AND l.status = 'active'
      AND (l.expires_at IS NULL OR l.expires_at > datetime('now'))
    ORDER BY l.granted_at DESC
  `).bind(userId).all();
  return results;
}

/**
 * Revoke a license (for refunds).
 */
export async function revokeLicense(db, userId, gameId, platform) {
  await db.prepare(`
    UPDATE licenses SET status = 'refunded'
    WHERE user_id = ?1 AND game_id = ?2 AND platform = ?3 AND status = 'active'
  `).bind(userId, gameId, platform).run();
}
