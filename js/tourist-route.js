// ============================================================
// TOURIST ROUTE (pure) — the distance between two people
// ============================================================
//
// E-6. The pitch is "ride the distance between you": two people who live apart
// enter their addresses, and the game builds a ride from one to the other over
// real photogrammetry. It is the only feature in this plan that is *about*
// the thing the persona actually feels — the distance is the point, and the
// number on the HUD is the story.
//
// The route is a straight great-circle line, deliberately:
//   - real roads do not matter, because the bike flies over photogrammetry;
//   - a straight line keeps tile usage predictable, and tiles are metered.
//
// Nothing here touches the network, the DOM or three, so all of it is tested.

const EARTH_R = 6371008.8;      // mean Earth radius, metres (WGS84)

/** Full real distance rideable before the middle gets skipped. */
export const MAX_RIDE_M = 5000;

/** When a route is capped, how much is ridden at each end. */
export const CAP_HALF_M = 2500;

const rad = (deg) => deg * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;

/**
 * Great-circle distance between two { lat, lon } points, in metres.
 * Haversine — accurate to well under a metre at city scale and to ~0.5% at
 * antipodal distances, which is far better than this feature needs.
 */
export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b, in degrees. */
export function bearing(a, b) {
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** The point `fraction` of the way along the great circle from a to b. */
export function interpolate(a, b, fraction) {
  const d = distanceM(a, b) / EARTH_R;
  if (d === 0) return { ...a };
  const A = Math.sin((1 - fraction) * d) / Math.sin(d);
  const B = Math.sin(fraction * d) / Math.sin(d);
  const x = A * Math.cos(rad(a.lat)) * Math.cos(rad(a.lon)) + B * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon));
  const y = A * Math.cos(rad(a.lat)) * Math.sin(rad(a.lon)) + B * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon));
  const z = A * Math.sin(rad(a.lat)) + B * Math.sin(rad(b.lat));
  return {
    lat: deg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lon: deg(Math.atan2(y, x))
  };
}

/**
 * Waypoints along the great circle from a to b, `stepM` apart.
 * Always includes both ends.
 */
export function greatCirclePoints(a, b, stepM = 500) {
  const total = distanceM(a, b);
  if (!(total > 0)) return [{ ...a, d: 0 }];
  const steps = Math.max(1, Math.ceil(total / stepM));
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    points.push({ ...interpolate(a, b, f), d: total * f });
  }
  return points;
}

/**
 * Turn the real distance into something rideable.
 *
 * Under the cap, the whole thing is the ride. Over it, the ride is the first
 * 2.5 km and the last 2.5 km with the middle skipped — you leave your street
 * and you arrive at theirs, which is the part that means anything. The real
 * distance is still what the HUD says, because that number IS the feature.
 *
 * @returns {{ segments, ridableM, realM, skippedM, capped }}
 *   `segments` is [{ fromFraction, toFraction, lengthM }] — one when short,
 *   two with a jump between them when long.
 */
export function capRoute(realM, { maxM = MAX_RIDE_M, halfM = CAP_HALF_M } = {}) {
  if (!(realM > 0)) {
    return { segments: [], ridableM: 0, realM: 0, skippedM: 0, capped: false };
  }
  if (realM <= maxM) {
    return {
      segments: [{ fromFraction: 0, toFraction: 1, lengthM: realM }],
      ridableM: realM, realM, skippedM: 0, capped: false
    };
  }
  const f = halfM / realM;
  return {
    segments: [
      { fromFraction: 0, toFraction: f, lengthM: halfM },
      { fromFraction: 1 - f, toFraction: 1, lengthM: halfM }
    ],
    ridableM: halfM * 2,
    realM,
    skippedM: realM - halfM * 2,
    capped: true
  };
}

/**
 * Everything the ride needs, from two geocoded points.
 * @returns {{ from, to, realM, route, waypoints, headline }}
 */
export function planRoute(from, to, { stepM = 500 } = {}) {
  const realM = distanceM(from, to);
  const route = capRoute(realM);
  return {
    from, to, realM, route,
    waypoints: greatCirclePoints(from, to, stepM),
    bearing: bearing(from, to),
    headline: headlineFor(realM)
  };
}

/** "Ride the distance between you: 1,209 km" — the sentence this is all for. */
export function headlineFor(realM) {
  return `Ride the distance between you: ${formatDistance(realM)}`;
}

/** Metres as a human number: 850 m, 2.4 km, 1,209 km. */
export function formatDistance(m) {
  if (!(m > 0)) return '0 m';
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}

/** "✂️ 1,204 km skipped" for the jump in the middle of a capped ride. */
export function skipLabel(route) {
  return route && route.capped ? `✂️ ${formatDistance(route.skippedM)} skipped` : '';
}

/** Basic sanity on a geocoder result before it is ridden. */
export function isValidPoint(p) {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}
