// ============================================================
// AUTH — Shared JWT verification (same secret as tandemonium-api)
// ============================================================

/**
 * Verify an HS256 JWT and return the payload.
 * Compatible with tokens issued by tandemonium-api.
 */
export async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );

  const data = `${parts[0]}.${parts[1]}`;
  const sig = Uint8Array.from(
    atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0)
  );
  const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
  if (!valid) throw new Error('Invalid signature');

  const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');

  return payload;
}

/**
 * Extract user ID from Authorization header. Returns null if invalid.
 */
export async function getUserFromRequest(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try {
    const payload = await verifyJWT(auth.slice(7), env.JWT_SECRET);
    return payload.sub;
  } catch {
    return null;
  }
}
