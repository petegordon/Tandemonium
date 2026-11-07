// ============================================================
// GOOSE OUTFITS — which dressed geese ride the goose tandem (pure, no three.js)
// ============================================================
//
// The "Goose Outfits" option picks a captain + stoker pair. Every rider GLB carries the same clip
// contract (goose-rider-clips.js), baked on the same goose-fit tandem in
// petegordon/tandemonium-claude-3d (ride_fit.py --clips):
//   victorian  the original male (brown tweed jacket, red waistcoat, bowler) + his partner, a lady in a
//              brown tweed walking dress cut in his style
//   cyclists   1920s male cyclist (argyle vest, plus-fours) + 1920s lady cyclist (cardigan, pleated skirt)
//   fancy      Victorian gent (swallowtail coat, top hat) + the lady in the red bustle dress
//   georgian   1770s gentleman (navy frock coat, tricorne) + a lady in a blue damask robe a l'anglaise
//   robot      the Canada Goose bot's suit (chrome, white plates, blue lights, visor helmet) -- a REWARD outfit:
//              unlocked with player bots (#611, js/rewards.js); gander body only so far (`bodies: ['m']`)

const DIR = 'tandem-3d/goose/';

export const GOOSE_OUTFITS = {
  victorian: { label: 'Victorian', Captain: DIR + 'goose_captain.glb', Stoker: DIR + 'goose_stoker_victorian.glb' },
  cyclists: { label: 'Cyclists', Captain: DIR + 'goose_captain_cyclist.glb', Stoker: DIR + 'goose_stoker_cyclist.glb' },
  fancy: { label: 'Fancy', Captain: DIR + 'goose_captain_fancy.glb', Stoker: DIR + 'goose_stoker.glb' },
  georgian: { label: 'Georgian', Captain: DIR + 'goose_captain_georgian.glb', Stoker: DIR + 'goose_stoker_georgian.glb' },
  robot: { label: 'Robot', Captain: DIR + 'goose_captain_robot_m.glb', Stoker: DIR + 'goose_stoker_robot_m.glb',
    bodies: ['m'], reward: 'playerBots' },
};

/** The everyday outfits (no reward to unlock): versus team looks cycle through these. */
export const BASE_OUTFITS = Object.keys(GOOSE_OUTFITS).filter(k => !GOOSE_OUTFITS[k].reward);

export const DEFAULT_GOOSE_OUTFIT = 'victorian';

// choices saved under the first names of the option (PR #406 preview)
const RENAMED = { original: 'victorian', cyclist: 'cyclists' };

/** A known outfit key (an old saved name maps to its new one; anything else -> the default). */
export function normalizeGooseOutfit(key) {
  if (Object.prototype.hasOwnProperty.call(RENAMED, key)) key = RENAMED[key];
  return Object.prototype.hasOwnProperty.call(GOOSE_OUTFITS, key) ? key : DEFAULT_GOOSE_OUTFIT;
}

/** The {Captain, Stoker} GLB paths of an outfit. */
export function gooseOutfitPaths(key) {
  const o = GOOSE_OUTFITS[normalizeGooseOutfit(key)];
  return { Captain: o.Captain, Stoker: o.Stoker };
}

// ============================================================
// RIDERS PER SEAT (#548) — one goose per seat, in the player's outfit AND body
// ============================================================
//
// Today every outfit ships two files and the seat decides the body: the Captain file is the
// gander (m), the Stoker file the goose (f). Wardrobe lets each player pick their body, so each
// outfit needs both bodies fitted to both seats. NEW rider files follow this naming contract
// (the 3D side, petegordon/tandemonium-claude-3d ride_fit.py, builds to it):
//
//   tandem-3d/goose/goose_<captain|stoker>_<outfit>_<m|f>.glb      outfit ∈ victorian, cyclists, fancy, georgian
//
// e.g. goose_captain_victorian_f.glb (the Victorian lady riding up front), goose_stoker_fancy_m.glb.
// The 8 combos that exist today keep their current file names (see GOOSE_OUTFITS). When a combo's
// file has not landed yet, the seat falls back to its existing body for that outfit (the captain
// stays the gander, the stoker the goose) and logs once. Add a new file's path to RIDER_FILES when
// it ships; the unit test checks every listed file is on disk.

export const SEATS = ['Captain', 'Stoker'];

/** The body each seat's existing rider file has. */
export const SEAT_BODY = { Captain: 'm', Stoker: 'f' };

/**
 * New-contract rider files that have shipped (relative paths): the lady on the front seat and the
 * gent on the back seat of every outfit (claude-3d ride_fit.py, 2026-11-04). With these, all 16
 * (seat, outfit, body) combos exist; the fallback below only matters for outfits added later.
 */
export const RIDER_FILES = new Set([
  DIR + 'goose_captain_victorian_f.glb', DIR + 'goose_stoker_victorian_m.glb',
  DIR + 'goose_captain_cyclists_f.glb', DIR + 'goose_stoker_cyclists_m.glb',
  DIR + 'goose_captain_fancy_f.glb', DIR + 'goose_stoker_fancy_m.glb',
  DIR + 'goose_captain_georgian_f.glb', DIR + 'goose_stoker_georgian_m.glb',
  DIR + 'goose_captain_robot_m.glb', DIR + 'goose_stoker_robot_m.glb',
]);

/** The contract file name for a (seat, outfit, body). Pure; does not say whether the file exists. */
export function riderFileName(seat, outfit, body) {
  const o = normalizeGooseOutfit(outfit);
  const b = body === 'f' ? 'f' : 'm';
  return `${DIR}goose_${seat === 'Stoker' ? 'stoker' : 'captain'}_${o}_${b}.glb`;
}

const _warned = new Set();

/**
 * Which GLB seats a goose of `body` in `outfit` on `seat`, and whether that is a fallback.
 * @param {'Captain'|'Stoker'} seat
 * @param {string} outfit
 * @param {'m'|'f'} body
 * @param {(msg: string) => void} [log] called once per missing combo (default console.info)
 * @returns {{path: string, body: 'm'|'f', wanted: string|null, fallback: boolean}}
 *   body = the body the returned file actually has
 */
export function resolveRider(seat, outfit, body, log = undefined) {
  const s = seat === 'Stoker' ? 'Stoker' : 'Captain';
  const o = normalizeGooseOutfit(outfit);
  let b = body === 'f' ? 'f' : 'm';
  const bodies = GOOSE_OUTFITS[o].bodies;
  if (bodies && !bodies.includes(b)) b = bodies[0];           // (robot: one body so far, both seats wear it)
  const own = bodies && bodies.length === 1 ? bodies[0] : SEAT_BODY[s];
  if (b === own) return { path: GOOSE_OUTFITS[o][s], body: b, wanted: null, fallback: false };
  const wanted = riderFileName(s, o, b);
  if (RIDER_FILES.has(wanted)) return { path: wanted, body: b, wanted, fallback: false };
  if (!_warned.has(wanted)) {
    _warned.add(wanted);
    const say = log || ((m) => { if (typeof console !== 'undefined') console.info(m); });
    say(`[wardrobe] no ${wanted} yet; the ${s.toLowerCase()} rides as the outfit's ${own === 'm' ? 'gander' : 'goose'} (${GOOSE_OUTFITS[o][s]})`);
  }
  return { path: GOOSE_OUTFITS[o][s], body: own, wanted, fallback: true };
}

/** The rider GLB for a seat in a player's outfit and body (falls back per resolveRider). */
export function riderPath(seat, outfit, body) {
  return resolveRider(seat, outfit, body).path;
}

/** Reset the once-only fallback log (tests). */
export function _resetRiderWarnings() { _warned.clear(); }
