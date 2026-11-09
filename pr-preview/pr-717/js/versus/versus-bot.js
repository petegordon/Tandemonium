// ============================================================
// VERSUS BOT — the ?versusbot=1 debug rider (m19)
// ============================================================
//
// A synthetic Team B rider for testing split-screen with one human. It is a
// developer tool: only on a local server (localhost / 127.0.0.1 / file:) or
// with ?dev=1, never on the deployed game, and a race with a bot team pays
// and counts nothing for that team (it would be AFK-farmable otherwise).
//
// Pure and DOM-free: callers pass location's parts.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * May ?versusbot=1 add a bot here?
 * @param {string} search    location.search
 * @param {string} hostname  location.hostname
 * @param {string} protocol  location.protocol
 */
export function versusBotAllowed(search, hostname, protocol) {
  let params;
  try { params = new URLSearchParams(search || ''); } catch { return false; }
  if (params.get('versusbot') !== '1') return false;
  if (protocol === 'file:') return true;
  if (LOCAL_HOSTS.has(String(hostname || '').toLowerCase())) return true;
  return params.get('dev') === '1';
}

/** A team with no human on it (every member is the debug bot). */
export function isBotTeam(rig) {
  const members = rig && rig.members;
  return Array.isArray(members) && members.length > 0 && members.every(m => m && m.type === 'bot');
}

/** The teams that pay and earn: everyone but bot teams. */
export function humanTeams(rigs) {
  return (rigs || []).filter(r => !isBotTeam(r));
}
