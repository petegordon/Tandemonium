// ============================================================
// GOOSE OUTFITS — which dressed geese ride the goose tandem (pure, no three.js)
// ============================================================
//
// The "Goose Outfits" option picks a captain + stoker pair. Every rider GLB carries the same clip
// contract (goose-rider-clips.js), baked on the same goose-fit tandem in
// petegordon/tandemonium-claude-3d (ride_fit.py --clips):
//   original  the P5 geese: male (brown jacket) + female (red bustle dress)
//   cyclist   1920s male cyclist (argyle vest, plus-fours) + 1920s lady cyclist (cardigan, pleated skirt)
//   fancy     Victorian male (swallowtail coat, top hat) + the original female

const DIR = 'tandem-3d/goose/';

export const GOOSE_OUTFITS = {
  original: { label: 'Original', Captain: DIR + 'goose_captain.glb', Stoker: DIR + 'goose_stoker.glb' },
  cyclist: { label: 'Cyclist', Captain: DIR + 'goose_captain_cyclist.glb', Stoker: DIR + 'goose_stoker_cyclist.glb' },
  fancy: { label: 'Fancy', Captain: DIR + 'goose_captain_fancy.glb', Stoker: DIR + 'goose_stoker.glb' },
};

export const DEFAULT_GOOSE_OUTFIT = 'original';

/** A known outfit key (anything else -> the default). */
export function normalizeGooseOutfit(key) {
  return Object.prototype.hasOwnProperty.call(GOOSE_OUTFITS, key) ? key : DEFAULT_GOOSE_OUTFIT;
}

/** The {Captain, Stoker} GLB paths of an outfit. */
export function gooseOutfitPaths(key) {
  const o = GOOSE_OUTFITS[normalizeGooseOutfit(key)];
  return { Captain: o.Captain, Stoker: o.Stoker };
}
