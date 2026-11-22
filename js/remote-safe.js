// ============================================================
// REMOTE-SAFE — clean data a partner's client sent before we use it
// ============================================================
//
// Anything that arrives over the relay or a peer connection was produced by
// someone else's copy of the game, which may be modified. Values from it end up
// in HTML (the victory screen builds markup from the captain's finish stats),
// so a string must never carry markup and a number must be a real number.
//
// cleanRemote() deep-copies plain data: finite numbers stay (anything else is
// 0), booleans stay, strings lose the characters that can open markup or an
// attribute and are capped in length, arrays and objects are capped in size
// and depth. Functions, prototypes and other exotic values are dropped.

const MAX_STRING = 200;
const MAX_KEYS = 200;
const MAX_ITEMS = 500;
const MAX_DEPTH = 6;
const UNSAFE = /[<>"'`&\\]/g;

export function cleanString(s) {
  return String(s).replace(UNSAFE, '').slice(0, MAX_STRING);
}

export function cleanRemote(value, depth = 0) {
  if (value == null) return value;
  switch (typeof value) {
    case 'number': return Number.isFinite(value) ? value : 0;
    case 'boolean': return value;
    case 'string': return cleanString(value);
    case 'object': break;
    default: return undefined;
  }
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map(v => cleanRemote(v, depth + 1));
  }
  const out = {};
  let n = 0;
  for (const key of Object.keys(value)) {
    if (n++ >= MAX_KEYS) break;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const v = cleanRemote(value[key], depth + 1);
    if (v !== undefined) out[cleanString(key)] = v;
  }
  return out;
}

const TEXT_UNSAFE = /[<>"`\u0000-\u001f\u007f]/g;

/**
 * Words a partner sent that are shown as they are (a place name, a ride's title): the
 * characters that can open markup or close an attribute go, apostrophes and accents stay.
 */
export function cleanText(s, max = 120) {
  return String(s == null ? '' : s).replace(TEXT_UNSAFE, '').slice(0, max);
}

/** A map point a partner sent: its numbers as they are, every word through cleanText. */
export function cleanPlace(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return p == null ? null : false;
  const out = {};
  let n = 0;
  for (const key of Object.keys(p)) {
    if (n++ >= 20) break;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const v = p[key];
    if (typeof v === 'string') out[key] = cleanText(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return out;
}
