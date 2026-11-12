// @ts-check
// ============================================================
// COUCH PAIRS (#609) — local co-op with a signed-in Player 2 is a real pair
// ============================================================
//
// Decided (Pete, 2026-11-07): a couch Player 2 who signed in on their seat
// (the Wardrobe's Discord QR, js/seat-accounts.js) is that person: their own
// partner key and server pair stats, like an online pair. An unsigned Player 2
// stays the one shared Guest partner ('local:p2') with no server pair, so
// Social Goose can't be farmed with made-up names.
//
// Who asks the server, and about whom:
//   - Player 1 signed in  → Player 1's session submits ('local' + seats[] with
//     Player 2's own token; the server reads P2's id from that token) and asks
//     /pair?with=<P2 id>.
//   - Player 1 signed out → Player 2's own seat session submits, as the stoker,
//     with Player 1 as a guest of this device ('guest:<device_id>', the D-9 key
//     an online guest already uses), and asks /pair?with=guest:<device_id>.
//     Nobody's account is claimed by anyone else: the only account on the ride
//     is the one whose token signs the request.
//   - Player 2 signed out → null: unchanged, no server pair.

/**
 * @typedef {{ token: string, user: { id: number|string, name: string } }} SeatAccount
 * @typedef {{ submitAs: 'p1'|'p2', withKey: string, name: string, p2Id: string }} CouchPair
 */

/**
 * @param {{ mode: string, seatAccount: SeatAccount|null, p1ServerId?: number|string|null, deviceId?: string|null }} o
 * @returns {CouchPair|null}
 */
export function couchPair({ mode, seatAccount, p1ServerId = null, deviceId = null }) {
  if (mode !== 'local' || !seatAccount || !seatAccount.token || !seatAccount.user) return null;
  const p2Id = String(seatAccount.user.id);
  const name = seatAccount.user.name || 'your partner';
  if (p1ServerId != null && p1ServerId !== '') {
    if (String(p1ServerId) === p2Id) return null;          // the same account on both seats
    return { submitAs: 'p1', withKey: p2Id, name, p2Id };
  }
  if (!deviceId) return null;
  return { submitAs: 'p2', withKey: 'guest:' + deviceId, name, p2Id };
}

/**
 * The couch score submit sent under Player 2's own session when Player 1 is
 * signed out. Mode 'stoker' (a mode every deployed worker accepts): the ride
 * is Player 2's, Player 1 is this device's guest, so the server's existing
 * pair step records (P2, guest:<device>).
 * @param {Record<string, any>} data  the ride body _submitScore built
 * @param {{ captain?: any, stoker?: any }} contrib  captain = P1, stoker = P2
 * @param {CouchPair} pair
 * @param {string} deviceId
 * @param {string[]} seatAchievements  what the ride earned Player 2
 */
export function guestCaptainSubmit(data, contrib, pair, deviceId, seatAchievements) {
  /** @type {Record<string, any>} */
  const out = { ...data, mode: 'stoker', newAchievements: (seatAchievements || []).slice() };
  delete out.seats;
  const contributions = {};
  if (contrib.captain) contributions.captain = { ...contrib.captain, userId: null, guestDeviceId: deviceId };
  if (contrib.stoker) contributions.stoker = { ...contrib.stoker, userId: Number(pair.p2Id) || pair.p2Id };
  out.contributions = contributions;
  return out;
}

/**
 * The pair numbers the finish's achievements read (Regulars, 5K Together).
 * `pair` is the server record fetched when the ride started, so it does not
 * hold this ride yet; when this ride is being posted, count it.
 * @param {{ rides?: number, distance?: number }|null} pair
 * @param {{ willPost: boolean, distanceM: number }} ride
 * @returns {{ pairRides: number, pairDistanceKm: number }|null}
 */
export function pairStatsForFinish(pair, { willPost, distanceM }) {
  if (!pair) return null;
  const rides = (pair.rides || 0) + (willPost ? 1 : 0);
  const metres = (pair.distance || 0) + (willPost ? Math.max(0, distanceM || 0) : 0);
  return { pairRides: rides, pairDistanceKm: metres / 1000 };
}
