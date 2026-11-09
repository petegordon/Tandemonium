// ============================================================
// PRODUCTS — Catalog lookups
// ============================================================

/**
 * Get an active product by ID.
 */
export async function getProduct(db, productId) {
  return db.prepare(`
    SELECT * FROM products WHERE id = ?1 AND active = 1
  `).bind(productId).first();
}

/**
 * Get all active products for a game.
 */
export async function getGameProducts(db, gameId) {
  const { results } = await db.prepare(`
    SELECT p.*, g.name as game_name
    FROM products p
    JOIN games g ON g.id = p.game_id
    WHERE p.game_id = ?1 AND p.active = 1
    ORDER BY p.price_cents ASC
  `).bind(gameId).all();
  return results;
}

/**
 * Get all active products across all games (storefront).
 */
export async function getAllProducts(db) {
  const { results } = await db.prepare(`
    SELECT p.*, g.name as game_name
    FROM products p
    JOIN games g ON g.id = p.game_id
    WHERE p.active = 1
    ORDER BY g.name, p.price_cents ASC
  `).all();
  return results;
}
