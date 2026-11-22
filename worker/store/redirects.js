// ============================================================
// REDIRECTS — where Stripe may send a buyer back to
// ============================================================

/** The sites of this store: CORS_ORIGINS plus STORE_URL. */
function storeOrigins(env) {
  const list = String((env && env.CORS_ORIGINS) || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env && env.STORE_URL) list.push(env.STORE_URL);
  const origins = new Set();
  for (const u of list) {
    try { origins.add(new URL(u).origin); } catch { /* not an address */ }
  }
  return origins;
}

/**
 * `wanted` when it is an https page on one of the store's own sites, else `fallback`.
 * The text is returned as sent: Stripe fills in {CHECKOUT_SESSION_ID} itself.
 */
export function checkoutRedirect(wanted, env, fallback) {
  if (typeof wanted !== 'string' || !wanted || wanted.length > 2048) return fallback;
  // Characters that URL parsers disagree about.
  if (/[\\\s\u0000-\u001f\u007f]/.test(wanted)) return fallback;
  let u;
  try { u = new URL(wanted); } catch { return fallback; }
  if (u.protocol !== 'https:' || u.username || u.password) return fallback;
  return storeOrigins(env).has(u.origin) ? wanted : fallback;
}
