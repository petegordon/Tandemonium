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

const DIR = 'tandem-3d/goose/';

export const GOOSE_OUTFITS = {
  victorian: { label: 'Victorian', Captain: DIR + 'goose_captain.glb', Stoker: DIR + 'goose_stoker_victorian.glb' },
  cyclists: { label: 'Cyclists', Captain: DIR + 'goose_captain_cyclist.glb', Stoker: DIR + 'goose_stoker_cyclist.glb' },
  fancy: { label: 'Fancy', Captain: DIR + 'goose_captain_fancy.glb', Stoker: DIR + 'goose_stoker.glb' },
};

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
