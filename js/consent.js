// ============================================================
// ANALYTICS CONSENT — asked in the EEA, the UK and Switzerland
// ============================================================
//
// Gameplay analytics need a yes from players in those countries; everywhere else they run
// as before. The account and the play that belongs to it (sign-in, rides, achievements,
// rooms) are not part of the question: the game cannot work without them.
//
//   const ok = await resolveConsent({ ask })   // true: analytics may run
//
// `ask()` shows the prompt and resolves 'accept' or 'decline' (js/lobby.js). The answer is
// kept on this device (the choice itself is needed to honour it) and sent to the server
// (worker/accounts/consent.js), which records a yes with the time, the country, the IP
// address and, when signed in, the account. A browser that sends Global Privacy Control is
// a no without being asked, in every country.
//
// The server tells us where the player is. If it cannot be reached, a European time zone
// is treated as "ask", so nothing is collected on a guess.

import { API_BASE } from './config.js';

/** The wording's version. A new one asks again. (The server's copy: worker/accounts/consent.js.) */
export const CONSENT_VERSION = '2026-11-22';
const KEY = 'tandemonium_consent';
const REGION_TIMEOUT_MS = 4000;

function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

/** The answer kept on this device: { id, choice, version, at } or null. */
export function storedConsent(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage.getItem(KEY) || 'null');
    return v && (v.choice === 'accept' || v.choice === 'decline') && typeof v.id === 'string' ? v : null;
  } catch (e) { return null; }
}

function store(answer, storage = globalThis.localStorage) {
  try { storage.setItem(KEY, JSON.stringify(answer)); } catch (e) { /* asked again next launch */ }
}

/** Does this browser ask not to be tracked (Global Privacy Control)? */
export function privacySignal(nav = globalThis.navigator) {
  return !!(nav && nav.globalPrivacyControl === true);
}

/** A time zone in Europe (used only when the server cannot say where the player is). */
export function europeanTimeZone(tz) {
  if (typeof tz !== 'string') return false;
  return tz.startsWith('Europe/') || ['Atlantic/Reykjavik', 'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores', 'Atlantic/Faroe', 'Arctic/Longyearbyen'].includes(tz);
}

/** Must this player be asked? → { required, country } */
export async function consentRegion({ fetchImpl = globalThis.fetch, apiBase = API_BASE, timeZone } = {}) {
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), REGION_TIMEOUT_MS) : null;
    const res = await fetchImpl(`${apiBase}/consent/region`, { credentials: 'omit', signal: ctl ? ctl.signal : undefined });
    if (timer) clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      return { required: !!data.required, country: data.country || null };
    }
  } catch (e) { /* the guess below */ }
  let tz = timeZone;
  if (tz === undefined) { try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { tz = ''; } }
  return { required: europeanTimeZone(tz), country: null };
}

/** Send an answer to be recorded. Fire and forget: the choice on this device is what the game goes by. */
export function recordConsent(answer, { token = null, fetchImpl = globalThis.fetch, apiBase = API_BASE } = {}) {
  if (!answer) return;
  try {
    fetchImpl(`${apiBase}/consent`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, credentials: 'omit', keepalive: true,
      body: JSON.stringify({ id: answer.id, choice: answer.choice, version: answer.version, ...(token && answer.choice === 'accept' ? { account_token: token } : {}) }),
    }).catch(() => { /* the answer still stands here */ });
  } catch (e) { /* no network API here */ }
}

/** A new answer: kept here, sent to the server. → the stored answer */
export function saveConsent(choice, { token = null, storage, fetchImpl, apiBase, now = Date.now() } = {}) {
  const answer = { id: uuid(), choice: choice === 'accept' ? 'accept' : 'decline', version: CONSENT_VERSION, at: new Date(now).toISOString() };
  store(answer, storage);
  recordConsent(answer, { token, fetchImpl, apiBase });
  return answer;
}

/**
 * May analytics run for this player? Asks when it has to.
 * → { allowed, required, mark } where `mark` is the consent version to send with analytics
 *   (only after a yes in a country that asks).
 * @param {{ ask: () => Promise<'accept'|'decline'>, getToken?: () => string|null }} o
 */
export async function resolveConsent({ ask, getToken = () => null, storage, fetchImpl, apiBase, nav, timeZone, force = false } = {}) {
  if (privacySignal(nav)) return { allowed: false, required: false, mark: null, signal: true };
  // `force` (the address has ?ask-consent): treat this player as one who is asked, to see the question anywhere.
  const region = force ? { required: true, country: null } : await consentRegion({ fetchImpl, apiBase, timeZone });
  if (!region.required) return { allowed: true, required: false, mark: null };
  let answer = storedConsent(storage);
  if (!answer || answer.version !== CONSENT_VERSION) {
    const choice = await ask();
    answer = saveConsent(choice, { token: getToken(), storage, fetchImpl, apiBase });
  }
  const allowed = answer.choice === 'accept';
  return { allowed, required: true, mark: allowed ? answer.version : null };
}
