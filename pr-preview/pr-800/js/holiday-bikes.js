// ============================================================
// HOLIDAY BIKES — finish Grandma's on certain colour bikes to earn one (pure, no imports)
// ============================================================
//
// Shared by the bike ladder (js/bike-unlocks.js) and the outfits that come with these bikes
// (js/goose-outfits.js `unlock`, read by js/rewards.js), so neither imports the other.
// Pete, 2026-11-09 (#736): Christmas Cruiser brings the Cyclists, New Year Rider the Fancy pair,
// Birthday Express the Georgians.

/** Each paint bike's "finish Grandma's on it" achievement. */
export const BIKE_ACHIEVEMENT_MAP = Object.freeze({
  default: 'grandma_default',
  bike_red: 'grandma_red',
  bike_blue: 'grandma_blue',
  bike_green: 'grandma_green',
  bike_yellow: 'grandma_yellow',
  bike_orange: 'grandma_orange',
  bike_magenta: 'grandma_magenta',
});

/** Holiday bikes: finish Grandma's on each of these bikes. `needs` names them for a hint. */
export const HOLIDAY_BIKES = Object.freeze({
  bike_christmas: Object.freeze({ name: 'Christmas Cruiser', requires: Object.freeze(['bike_green', 'bike_red']),
    needs: 'Jungle Cruiser and Cherry Bomb' }),
  bike_newyears: Object.freeze({ name: 'New Year Rider', requires: Object.freeze(['bike_yellow', 'default']),
    needs: "Banana Delivery and Grandma's Classic" }),
  bike_birthday: Object.freeze({ name: 'Birthday Express', requires: Object.freeze(['bike_red', 'bike_blue', 'bike_yellow', 'bike_green', 'default']),
    needs: "Cherry Bomb, Ocean Breeze, Banana Delivery, Jungle Cruiser and Grandma's Classic" }),
});

/** Is holiday bike `key` unlocked (every bike it needs finished at Grandma's)? true for any other bike. */
export function holidayUnlocked(key, earnedIds) {
  const def = HOLIDAY_BIKES[key];
  if (!def) return true;
  const earned = new Set(earnedIds || []);
  return def.requires.every(k => earned.has(BIKE_ACHIEVEMENT_MAP[k]));
}
