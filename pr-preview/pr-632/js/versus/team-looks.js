// Versus: each team's geese wear their own outfit in their team's colour, so
// the two bikes read apart at a glance. Team Blue (A) wears the player's saved
// outfit; Team Red (B) the next outfit in the list. Each outfit's colourway is
// the one closest to the team's colour (js/goose-colourways-data.js).
import { GOOSE_OUTFITS, normalizeGooseOutfit } from '../goose-outfits.js';

export const TEAM_COLOURWAYS = {
  A: { victorian: 'v_navy', cyclists: 'c_blue', fancy: 'f_royal', georgian: 'default' },     // Georgian's own coat is navy
  B: { victorian: 'v_forest', cyclists: 'c_burgundy', fancy: 'default', georgian: 'g_claret' }, // Fancy's own dress is red
};

/**
 * @param {string} savedOutfit the player's Goose Outfits choice
 * @returns {{A: {outfit: string, colourway: string}, B: {outfit: string, colourway: string}}}
 */
export function versusTeamLooks(savedOutfit) {
  const order = Object.keys(GOOSE_OUTFITS);
  const a = normalizeGooseOutfit(savedOutfit);
  const b = order[(order.indexOf(a) + 1) % order.length];
  return {
    A: { outfit: a, colourway: TEAM_COLOURWAYS.A[a] || 'default' },
    B: { outfit: b, colourway: TEAM_COLOURWAYS.B[b] || 'default' },
  };
}
