// ============================================================
// BOT PACE — how hard a VERSUS BOTS team pedals (Pete, 2026-11-21: "like couch versus, a real race")
// ============================================================
//
// The bot team rides a real bike: physics, auto-steer, pylons, crashes and remounts. Each frame it holds the speed
// that would still reach the line on the tier's medal time, so a crash costs it time it then tries to win back.
// Pure: no DOM, no three.js.

/** The hardest a bot pushes, in m/s per second. */
export const BOT_MAX_PUSH = 6;
const RESPONSE = 3;           // how quickly it closes on the speed it wants (1/s)
const FRICTION = 0.6;         // the bike's rolling friction at riding speed (js/bike-model.js)

/** The speed that reaches the line on time from here (m/s). Past it, a bot eases off: presents and hills don't rush it. */
export function botWantSpeed({ elapsedMs, targetMs, distance, raceDistance }) {
  const left = Math.max(0.5, (targetMs - elapsedMs) / 1000);
  return Math.max(3, (raceDistance + 3 - distance) / left);   // (aims past the line, so it never coasts to a stop on it)
}

/**
 * This frame's push (m/s added to the bike), the pedal result's `acceleration`.
 * @param {{ elapsedMs: number, targetMs: number, distance: number, raceDistance: number, speed: number, dt: number }} o
 */
export function botPush({ elapsedMs, targetMs, distance, raceDistance, speed, dt }) {
  const want = botWantSpeed({ elapsedMs, targetMs, distance, raceDistance });
  const push = (want - speed) * RESPONSE + FRICTION * speed;
  return Math.max(0, Math.min(BOT_MAX_PUSH, push)) * dt;
}

const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * This frame's lean input (-1..1): head for the road ahead, back toward its team's side, around the next pylon. A positive
 * lean turns the bike toward a smaller heading (js/bike-model.js), so the wanted turn is converted into a lean to hold.
 * @param {any} bike @param {{turnRate: number, leanForce: number, damping: number}} tune @param {any[]} [obstacles]
 * @param {number} [lane] the team's side of the road, as a lateral offset (#837)
 */
export function botLean(bike, tune, obstacles = [], lane = 0) {
  const speed = Math.max(2, bike.speed);
  const ahead = bike.roadPath.getPointAtDistance(bike.roadD + 2 + speed * 0.6);
  let want = angle(ahead.heading - bike.heading) + Math.max(-0.5, Math.min(0.5, -((bike._lateralOffset || 0) - lane) * 0.25));
  const rx = Math.cos(bike.heading), rz = -Math.sin(bike.heading);
  for (const o of obstacles) {
    if (o._worldX === undefined) continue;
    const d = o.absoluteD - bike.distanceTraveled;
    if (d < 0 || d > 20) continue;
    const side = (o._worldX - bike.position.x) * rx + (o._worldZ - bike.position.z) * rz;
    if (Math.abs(side) < 1.8) want -= (side >= 0 ? 1 : -1) * 0.45 * (1 - d / 20);
  }
  const holdLean = Math.max(-0.45, Math.min(0.45, -(want * 1.6) / (speed * (tune.turnRate || 0.5))));
  const force = (holdLean - bike.lean) * 14 - bike.leanVelocity * 3;
  return Math.max(-1, Math.min(1, force / (tune.leanForce || 8)));
}
