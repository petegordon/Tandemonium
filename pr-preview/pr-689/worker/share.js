// ============================================================
// SHARE A RESULT (#657 parts 2 + 3)
// ============================================================
//
//   GET  /share/config        → { discord }  (is the #daily-ride post set up?)
//   POST /share               { image (base64 JPEG/PNG), contentType, caption, link, dayKey?, deviceId? }
//                             → { id, url, imageUrl, expiresAt }   (no account needed; rate limited)
//   GET  /share/:id           → { id, caption, link, imageUrl, dayKey, expiresAt }
//   GET  /share/:id/image     → the card image
//   POST /share/discord       { id }  (signed in, with Discord linked) → posts the card to the
//                             House Tandem Discord's #daily-ride through the DISCORD_SHARE_WEBHOOK
//                             secret, under the player's Discord name and picture. Daily Ride only,
//                             one post per player per day. 503 when the secret is not set.
//
// The TV shows a QR for SITE_URL/share/?id=…; that page (share/index.html)
// reads the metadata and offers the phone's share sheet.

export const SHARE_TTL_MS = 7 * 24 * 3600 * 1000;
export const SHARE_MAX_BYTES = 1_000_000;
export const SHARES_PER_IP_DAY = 30;
export const SHARES_PER_DEVICE_DAY = 20;
export const SITE_URL = 'https://tandemonium.housetandem.com';
const LINK_ORIGINS = ['https://tandemonium.housetandem.com', 'https://tandemonium.jimandi.love'];
const ID_RE = /^[A-Za-z0-9]{12}$/;
const DAY_RE = /^\d{4}-\d\d-\d\d$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** A 12-character share id (≈70 bits). */
export function newShareId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

/** What the bytes are: 'image/png' | 'image/jpeg' | null. */
export function sniffImage(bytes) {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

/** One line of plain text, at most `max` characters. */
export function cleanText(s, max = 200) {
  if (typeof s !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return t || null;
}

/** The road link, only when it points at the game's own site. */
export function cleanLink(s) {
  if (typeof s !== 'string' || s.length > 300) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  return LINK_ORIGINS.includes(u.origin) ? u.toString() : null;
}

/** A Discord webhook username: Discord refuses names with "discord" or "clyde" in them. */
export function webhookName(name) {
  const n = (cleanText(name, 80) || 'A rider').replace(/discord/gi, 'D-cord').replace(/clyde/gi, 'Cl-de');
  return n.length >= 1 ? n : 'A rider';
}

/** A day key within a day of the server's UTC date (the Daily Ride rolls over by time zone). */
export function dayKeyIsCurrent(key, now = Date.now()) {
  if (!DAY_RE.test(key || '')) return false;
  const t = Date.parse(key + 'T12:00:00Z');
  return Number.isFinite(t) && Math.abs(t - now) <= 36 * 3600 * 1000;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hashIp(ip, salt) {
  const data = new TextEncoder().encode('share:' + (salt || '') + ':' + ip);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(d.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Route a /share request; null when the path is not one of ours.
 * deps: { jsonResponse, corsHeaders, getUserFromRequest, checkRateLimit, listIdentities, writeMetric }
 */
export async function handleShareRoute(request, env, { path, url, clientIP, corsOrigin }, deps) {
  const { jsonResponse } = deps;
  if (path === '/share/config' && request.method === 'GET') {
    return jsonResponse({ discord: !!env.DISCORD_SHARE_WEBHOOK }, 200, corsOrigin);
  }
  if (path === '/share' && request.method === 'POST') {
    const limited = await deps.checkRateLimit(env.SHARE_LIMITER, 'ip:' + clientIP, corsOrigin, env);
    if (limited) return limited;
    return createShare(request, env, clientIP, corsOrigin, deps);
  }
  if (path === '/share/discord' && request.method === 'POST') {
    return postToDiscord(request, env, clientIP, corsOrigin, deps);
  }
  const m = path.match(/^\/share\/([A-Za-z0-9]+)(\/image)?$/);
  if (m && request.method === 'GET') {
    const limited = await deps.checkRateLimit(env.READ_LIMITER, clientIP, corsOrigin, env);
    if (limited) return limited;
    return m[2] ? getShareImage(env, m[1], corsOrigin, deps) : getShareMeta(env, m[1], url, corsOrigin, deps);
  }
  return null;
}

async function createShare(request, env, clientIP, corsOrigin, deps) {
  const { jsonResponse } = deps;
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > SHARE_MAX_BYTES * 1.4 + 4096) return jsonResponse({ error: 'Image too large', code: 'too_large' }, 413, corsOrigin);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad JSON' }, 400, corsOrigin); }
  if (!body || typeof body.image !== 'string') return jsonResponse({ error: 'No image' }, 400, corsOrigin);
  const b64 = body.image.replace(/^data:image\/[a-z]+;base64,/, '');
  if (b64.length > Math.ceil(SHARE_MAX_BYTES / 3) * 4 + 4) return jsonResponse({ error: 'Image too large', code: 'too_large' }, 413, corsOrigin);
  let bytes;
  try { bytes = b64ToBytes(b64); } catch { return jsonResponse({ error: 'Bad image' }, 400, corsOrigin); }
  const type = sniffImage(bytes);
  if (!type) return jsonResponse({ error: 'Not a PNG or JPEG' }, 415, corsOrigin);
  if (bytes.length > SHARE_MAX_BYTES) return jsonResponse({ error: 'Image too large', code: 'too_large' }, 413, corsOrigin);

  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;
  const ipHash = await hashIp(clientIP, env.JWT_SECRET);
  const deviceId = typeof body.deviceId === 'string' && /^[0-9a-f-]{8,64}$/i.test(body.deviceId) ? body.deviceId : null;
  // Drop what has expired first, so the counts below are of live shares.
  await env.DB.prepare('DELETE FROM shares WHERE expires_at < ?').bind(now).run();
  const byIp = await env.DB.prepare('SELECT COUNT(*) AS n FROM shares WHERE ip_hash = ? AND created_at > ?').bind(ipHash, dayAgo).first();
  if (byIp && byIp.n >= SHARES_PER_IP_DAY) return jsonResponse({ error: 'Too many shares today', code: 'daily_cap' }, 429, corsOrigin);
  if (deviceId) {
    const byDev = await env.DB.prepare('SELECT COUNT(*) AS n FROM shares WHERE device_id = ? AND created_at > ?').bind(deviceId, dayAgo).first();
    if (byDev && byDev.n >= SHARES_PER_DEVICE_DAY) return jsonResponse({ error: 'Too many shares today', code: 'daily_cap' }, 429, corsOrigin);
  }

  const id = newShareId();
  const expiresAt = now + SHARE_TTL_MS;
  const dayKey = DAY_RE.test(body.dayKey || '') ? body.dayKey : null;
  await env.DB.prepare(
    'INSERT INTO shares (id, image_b64, content_type, bytes, caption, link, day_key, ip_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, b64, type, bytes.length, cleanText(body.caption), cleanLink(body.link), dayKey, ipHash, deviceId, now, expiresAt).run();
  if (deps.writeMetric) deps.writeMetric(env, 'share_created', dayKey ? 'daily' : 'other');
  const origin = new URL(request.url).origin;
  return jsonResponse({
    id,
    url: `${SITE_URL}/share/?id=${id}`,
    imageUrl: `${origin}/share/${id}/image`,
    expiresAt: new Date(expiresAt).toISOString(),
  }, 201, corsOrigin);
}

async function liveShare(env, id) {
  if (!ID_RE.test(id)) return null;
  const row = await env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(id).first();
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}

async function getShareMeta(env, id, url, corsOrigin, { jsonResponse }) {
  const row = await liveShare(env, id);
  if (!row) return jsonResponse({ error: 'Not found or expired', code: 'gone' }, 404, corsOrigin);
  return jsonResponse({
    id: row.id,
    caption: row.caption,
    link: row.link,
    dayKey: row.day_key,
    imageUrl: `${url.origin}/share/${row.id}/image`,
    contentType: row.content_type,
    expiresAt: new Date(row.expires_at).toISOString(),
  }, 200, corsOrigin);
}

async function getShareImage(env, id, corsOrigin, { jsonResponse, corsHeaders }) {
  const row = await liveShare(env, id);
  if (!row) return jsonResponse({ error: 'Not found or expired', code: 'gone' }, 404, corsOrigin);
  return new Response(b64ToBytes(row.image_b64), {
    status: 200,
    headers: {
      'Content-Type': row.content_type,
      'Cache-Control': 'public, max-age=86400',
      ...corsHeaders(corsOrigin || '*'),
    },
  });
}

async function postToDiscord(request, env, clientIP, corsOrigin, deps) {
  const { jsonResponse } = deps;
  const hook = env.DISCORD_SHARE_WEBHOOK;
  if (!hook || !/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//.test(hook)) {
    return jsonResponse({ error: 'Discord posting is not set up', code: 'discord_off' }, 503, corsOrigin);
  }
  const userId = await deps.getUserFromRequest(request, env);
  if (!userId) return jsonResponse({ error: 'Sign in with Discord to post', code: 'signin' }, 401, corsOrigin);
  const limited = await deps.checkRateLimit(env.SHARE_LIMITER, 'user:' + userId, corsOrigin, env);
  if (limited) return limited;
  const user = await env.DB.prepare('SELECT id, display_name FROM users WHERE id = ?').bind(userId).first();
  if (!user) return jsonResponse({ error: 'Account not found', code: 'account_gone' }, 401, corsOrigin);
  const ids = await deps.listIdentities(env, user.id);
  const discord = ids.discord;
  if (!discord) return jsonResponse({ error: 'Link Discord to post', code: 'no_discord' }, 403, corsOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad JSON' }, 400, corsOrigin); }
  const share = await liveShare(env, String((body && body.id) || ''));
  if (!share) return jsonResponse({ error: 'Not found or expired', code: 'gone' }, 404, corsOrigin);
  if (!share.day_key) return jsonResponse({ error: 'Only the Daily Ride posts to Discord', code: 'not_daily' }, 400, corsOrigin);
  if (!dayKeyIsCurrent(share.day_key)) return jsonResponse({ error: 'That Daily Ride is over', code: 'old_day' }, 400, corsOrigin);

  const posted = await env.DB.prepare('SELECT 1 AS ok FROM discord_posts WHERE user_id = ? AND day_key = ?').bind(user.id, share.day_key).first();
  if (posted) return jsonResponse({ error: 'Already posted today', code: 'already_posted' }, 409, corsOrigin);
  try {
    await env.DB.prepare('INSERT INTO discord_posts (user_id, day_key, share_id, posted_at) VALUES (?, ?, ?, ?)')
      .bind(user.id, share.day_key, share.id, Date.now()).run();
  } catch {
    return jsonResponse({ error: 'Already posted today', code: 'already_posted' }, 409, corsOrigin);
  }

  const ext = share.content_type === 'image/png' ? 'png' : 'jpg';
  const lines = [share.caption || 'Tandemonium · Daily Ride'];
  if (share.link) lines.push('<' + share.link + '>');   // <…>: no preview card under the picture
  const payload = {
    username: webhookName(discord.name || user.display_name),
    content: lines.join('\n').slice(0, 1900),
    allowed_mentions: { parse: [] },
    attachments: [{ id: 0, filename: 'tandemonium-' + share.day_key + '.' + ext }],
  };
  if (typeof discord.avatar === 'string' && /^https:\/\//.test(discord.avatar)) payload.avatar_url = discord.avatar;
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  form.append('files[0]', new Blob([b64ToBytes(share.image_b64)], { type: share.content_type }), 'tandemonium-' + share.day_key + '.' + ext);

  let ok = false;
  try {
    const res = await fetch(hook + (hook.includes('?') ? '&' : '?') + 'wait=true', { method: 'POST', body: form });
    ok = res.ok;
  } catch { ok = false; }
  if (!ok) {
    // Let them try again: the post did not happen.
    await env.DB.prepare('DELETE FROM discord_posts WHERE user_id = ? AND day_key = ?').bind(user.id, share.day_key).run();
    return jsonResponse({ error: 'Discord did not take the post', code: 'discord_failed' }, 502, corsOrigin);
  }
  // Old one-a-day records are not needed past the day.
  await env.DB.prepare('DELETE FROM discord_posts WHERE posted_at < ?').bind(Date.now() - 3 * 24 * 3600 * 1000).run();
  if (deps.writeMetric) deps.writeMetric(env, 'share_discord');
  return jsonResponse({ ok: true, dayKey: share.day_key }, 200, corsOrigin);
}
