// ============================================================
// ANALYTICS CONSENT — asked in the EEA, the UK and Switzerland
// ============================================================
//
// Gameplay analytics need a yes from players in those countries; everywhere else they run
// as before. The account and the play that belongs to it (sign-in, rides, achievements,
// rooms) are not part of the question: the games cannot work without them.
//
// The answer belongs to the HOUSE TANDEM ACCOUNT. It is kept in one place, the account
// service (worker/accounts/consent.js), and every House Tandem game and device reads it
// there, so a signed-in player is asked once, whichever game asks first.
//
//   const r = await resolveConsent({ ask, getToken })   // r.allowed: analytics may run
//   const r = await syncConsent({ getToken })           // after a sign-in: the account's answer
//
// `ask()` shows the prompt and resolves 'accept' or 'decline' (js/lobby.js). A player who is
// not signed in is asked on this device; that answer waits here (the choice itself is needed
// to honour it) and joins the account when they sign in. If the account already has an
// answer, the account's stands. A browser that sends Global Privacy Control is a no without
// being asked, in every country.
//
// The server tells us where the player is. If it cannot be reached, a European time zone
// is treated as "ask", so nothing is collected on a guess.

import { API_BASE } from './config.js';

/** The wording's version. A new one asks again. (The server's copy: worker/accounts/consent.js.) */
export const CONSENT_VERSION = '2026-11-22';
const KEY = 'tandemonium_consent';
const TIMEOUT_MS = 4000;

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

const isChoice = (c) => c === 'accept' || c === 'decline';

/** What this device knows of the answer: { id?, choice, version, at, account? } or null. */
export function storedConsent(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage.getItem(KEY) || 'null');
    return v && isChoice(v.choice) ? v : null;
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

async function getJson(fetchImpl, url, headers) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(url, { credentials: 'omit', headers, signal: ctl ? ctl.signal : undefined });
    return res.ok ? await res.json() : null;
  } catch (e) { return null; } finally { if (timer) clearTimeout(timer); }
}

function guessRegion(timeZone) {
  let tz = timeZone;
  if (tz === undefined) { try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { tz = ''; } }
  return europeanTimeZone(tz);
}

/** Must this player be asked? → { required } */
export async function consentRegion({ fetchImpl = globalThis.fetch, apiBase = API_BASE, timeZone } = {}) {
  const data = await getJson(fetchImpl, `${apiBase}/consent/region`);
  return { required: data ? !!data.required : guessRegion(timeZone) };
}

/** The account's answer, and whether this player is asked. → { consent, required } or null (not reachable, or not signed in). */
export async function accountConsent(token, { fetchImpl = globalThis.fetch, apiBase = API_BASE } = {}) {
  if (!token) return null;
  const data = await getJson(fetchImpl, `${apiBase}/me/consent`, { Authorization: 'Bearer ' + token });
  if (!data) return null;
  return { consent: data.consent && isChoice(data.consent.choice) ? data.consent : null, required: !!data.required };
}

/**
 * Send an answer to the account service. → the account's answer now ({ choice, version, at }),
 * or null (signed out, or not reachable: the answer on this device stands until it is).
 */
export async function recordConsent(answer, { token = null, fetchImpl = globalThis.fetch, apiBase = API_BASE } = {}) {
  if (!answer || !answer.id) return null;
  try {
    const res = await fetchImpl(`${apiBase}/consent`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, credentials: 'omit', keepalive: true,
      body: JSON.stringify({ id: answer.id, choice: answer.choice, version: answer.version, ...(token ? { account_token: token } : {}) }),
    });
    const data = res && res.ok && typeof res.json === 'function' ? await res.json() : null;
    return data && data.consent && isChoice(data.consent.choice) ? data.consent : null;
  } catch (e) { return null; }
}

/** A new answer (the prompt, or the switch in Settings): kept here and sent to the account. → the stored answer */
export function saveConsent(choice, { token = null, storage, fetchImpl, apiBase, now = Date.now() } = {}) {
  const answer = { id: uuid(), choice: choice === 'accept' ? 'accept' : 'decline', version: CONSENT_VERSION, at: new Date(now).toISOString(), ...(token ? { account: true } : {}) };
  store(answer, storage);
  recordConsent(answer, { token, fetchImpl, apiBase });
  return answer;
}

const result = (answer, required) => {
  const allowed = answer.choice === 'accept';
  return { allowed, required, mark: allowed ? answer.version : null, answered: true };
};

/** The account's answer becomes what this device goes by. */
function adopt(consent, storage) {
  const answer = { choice: consent.choice, version: consent.version, at: consent.at, account: true };
  store(answer, storage);
  return answer;
}

/**
 * May analytics run for this player? Asks when it has to.
 * → { allowed, required, mark, answered } where `mark` is the consent version to send with
 *   analytics after a yes, and `answered` says there is an answer to show in Settings.
 * @param {{ ask: () => Promise<'accept'|'decline'>, getToken?: () => string|null, force?: boolean }} o
 *   `force` (the address has ?ask-consent): treat this player as one who is asked.
 */
export async function resolveConsent({ ask, getToken = () => null, storage, fetchImpl, apiBase, nav, timeZone, force = false } = {}) {
  if (privacySignal(nav)) return { allowed: false, required: false, mark: null, answered: false, signal: true };
  const token = getToken();
  const acct = await accountConsent(token, { fetchImpl, apiBase });
  // Signed in, with an answer on the account: that is the answer, here and in every game.
  if (acct && acct.consent && acct.consent.version === CONSENT_VERSION) return result(adopt(acct.consent, storage), true);
  const required = force || (acct ? acct.required : (await consentRegion({ fetchImpl, apiBase, timeZone })).required);
  if (!required) return { allowed: true, required: false, mark: null, answered: false };
  let answer = storedConsent(storage);
  if (answer && answer.version === CONSENT_VERSION && answer.id) {
    // Answered on this device before signing in: it joins the account now (the account's own answer would win).
    if (token && !answer.account) {
      const theirs = await recordConsent(answer, { token, fetchImpl, apiBase });
      answer = theirs ? adopt(theirs, storage) : answer;
    }
    return result(answer, true);
  }
  // An answer copied from an account that is no longer signed in here still stands on this device.
  if (answer && answer.version === CONSENT_VERSION && !token) return result(answer, true);
  const choice = await ask();
  return result(saveConsent(choice, { token, storage, fetchImpl, apiBase }), true);
}

/**
 * After a sign-in: the account's answer is the answer. An answer given on this device before
 * signing in joins the account if it has none. → the same shape as resolveConsent, or null
 * when there is nothing to change (no answer anywhere).
 */
export async function syncConsent({ getToken = () => null, storage, fetchImpl, apiBase } = {}) {
  const token = getToken();
  if (!token) return null;
  const mine = storedConsent(storage);
  if (mine && mine.id && !mine.account && mine.version === CONSENT_VERSION) {
    const theirs = await recordConsent(mine, { token, fetchImpl, apiBase });
    if (theirs) return result(adopt(theirs, storage), true);
  }
  const acct = await accountConsent(token, { fetchImpl, apiBase });
  if (acct && acct.consent && acct.consent.version === CONSENT_VERSION) return result(adopt(acct.consent, storage), true);
  // This account has no answer, and the one here was another account's: it is not theirs to
  // inherit. It is forgotten here, and this player is asked at the next launch if they must be.
  if (acct && mine && mine.account) { try { (storage || globalThis.localStorage).removeItem(KEY); } catch (e) { /* asked next launch */ } }
  return null;
}
