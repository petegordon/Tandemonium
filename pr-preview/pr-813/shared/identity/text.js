// @ts-check
// The account flow's words, in one place, so every House Tandem game says the same thing.
// Rules: always name the provider ("the Discord account …", never just "the account");
// plain words; a controller is "hooked up" and a phone is "paired", never "plugged in".

/** @type {Record<string, string>} */
export const PROVIDER_NAMES = { discord: 'Discord', steam: 'Steam', google: 'Google' };

export const providerName = (/** @type {string} */ p) => PROVIDER_NAMES[p] || 'sign-in';

/** A short day for a notice: "Nov 15". `at` is seconds. */
export function shortDay(at, locale) {
  return new Date(at * 1000).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/**
 * What a notice says, and its two buttons.
 * @param {import('./client.js').AccountNotice} n
 * @param {{ locale?: string }} [o]
 */
export function noticeText(n, { locale } = {}) {
  const who = providerName(n.provider);
  const combine = n.kind === 'combine';
  const what = combine
    ? `The ${who} account “${n.from_name || n.login_name || ''}” was combined into this one on ${shortDay(n.created_at, locale)}.`
    : `The ${who} account “${n.login_name || ''}” was linked to this account on ${shortDay(n.created_at, locale)}.`;
  return {
    text: `${what} Not you? You can undo it until ${shortDay(n.undo_until, locale)}.`,
    undo: combine ? 'Separate them' : 'Not me, remove it',
    ok: 'OK, that was me',
  };
}

/** An account's numbers for the combine screen: ["12 rides · 30 badges in Tandemonium", "Also: …"]. */
export function summaryLines(/** @type {import('./client.js').AccountSummary} */ acct) {
  const count = (/** @type {number} */ n, /** @type {string} */ one) => `${n || 0} ${one}${(n || 0) === 1 ? '' : 's'}`;
  const lines = [`${count(acct.rides, 'ride')} · ${count(acct.badges, 'badge')} in Tandemonium`];
  const games = (acct.games || []).map((g) => (g.badges ? `${g.title} (${count(g.badges, 'badge')})` : g.title));
  if (games.length) lines.push('Also: ' + games.join(', '));
  return lines;
}

export const TEXT = Object.freeze({
  signInWith: (/** @type {string} */ p) => `Sign in with ${providerName(p)}`,
  link: (/** @type {string} */ p) => `Link ${providerName(p)}`,
  signOut: 'Sign out',
  confirmItsYou: 'Confirm it’s you',
  signInAgainWith: (/** @type {string} */ p) => `Sign in again with ${providerName(p)}`,
  freshWhy: 'For your safety, sign in again before linking another account.',
  // device sign-in (TV, desktop build)
  deviceSteps: ['Scan with your phone', 'Sign in with Discord', 'Type this code on your phone'],
  deviceGetting: 'Getting a sign-in code…',
  deviceWaiting: 'Waiting for Discord…',
  deviceConfirming: 'Type the code on your phone…',
  deviceExpired: 'That code expired. Here is a new one.',
  deviceCancelled: 'Cancelled. Scan again to sign in.',
  openOnThisComputer: 'Open on this computer',
  // combine
  combineTitle: (/** @type {string} */ p) => `This ${providerName(p)} account already has its own House Tandem account`,
  combineAsk: (/** @type {string} */ into) => `Combine it into ${into}? Rides, achievements and progress in every House Tandem game are kept from both, and both sign-ins open the combined account. You can separate them again for 7 days.`,
  combineYes: 'Combine',
  combineNo: 'Cancel',
  combined: 'Combined. Both sign-ins now open this account.',
  nothingChanged: 'Nothing was changed.',
  linked: (/** @type {string} */ p) => `${providerName(p)} is linked.`,
  linkedToast: (/** @type {boolean} */ merged) => (merged ? 'Your Discord and Steam accounts are now one' : 'Discord and Steam are one House Tandem account'),
  hasAccount: 'That Discord already has its own account. To combine them, go to housetandem.com/account.html, sign in with Discord, then choose Link Steam.',
});
