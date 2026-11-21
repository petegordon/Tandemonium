// ============================================================
// TOURIST COSTS (pure) — our estimate of the Google bill (#824)
// ============================================================
//
// The analytics store COUNTS. Dollars are worked out here from a dated price table, so a price change never
// rewrites history. Analytics can lose an event when a page closes, so Google's bill stays the source of
// truth: compare this with the Google Cloud billing report each month.
//
// Add a new row when a price changes; do not edit an old one. `tiers` run in order, and `upTo` is the monthly
// count that tier ends at (null = no end). Only the first paid tier is recorded so far: check Google's price
// list before relying on an estimate above it.

export const TOURIST_PRICES = Object.freeze([
  Object.freeze({
    from: '2026-10-16',
    tiles: { free: 1000, tiers: [{ upTo: null, per1000: 6 }] },
    geocode: { free: 10000, tiers: [{ upTo: null, per1000: 5 }] },
    elevation: { free: 5000, tiers: [{ upTo: null, per1000: 5 }] },
  }),
]);

/** The daily caps set in Google Cloud (Pete, 2026-11-21). */
export const GOOGLE_DAILY_CAPS = Object.freeze({ tiles: 300, geocode: 100, elevation: 100 });

/** The price row in force on a 'YYYY-MM-DD' or 'YYYY-MM' date. */
export function pricesOn(date, table = TOURIST_PRICES) {
  const d = String(date).length === 7 ? `${date}-31` : String(date);
  let hit = table[0];
  for (const row of table) if (row.from <= d) hit = row;
  return hit;
}

/** Dollars for `n` requests in one month. */
export function serviceCost(n, price) {
  let left = Math.max(0, Math.floor(n || 0) - (price.free || 0));
  let done = price.free || 0, usd = 0;
  for (const t of price.tiers) {
    if (left <= 0) break;
    const room = t.upTo == null ? left : Math.max(0, t.upTo - done);
    const here = Math.min(left, room);
    usd += (here / 1000) * t.per1000;
    left -= here;
    done += here;
  }
  return usd;
}

/**
 * One month's estimate. Billed requests are the ones Google answered.
 * @param {string} month 'YYYY-MM' @param {{tiles?: number, geocode?: number, elevation?: number}} counts
 */
export function monthCost(month, counts, table = TOURIST_PRICES) {
  const p = pricesOn(month, table);
  const tiles = serviceCost(counts.tiles, p.tiles);
  const geocode = serviceCost(counts.geocode, p.geocode);
  const elevation = serviceCost(counts.elevation, p.elevation);
  return { tiles, geocode, elevation, total: tiles + geocode + elevation };
}
