// ============================================================
// TOURIST ODOMETER — how far a Map Tourist ride has gone (#400, review B3)
//
// Tourist rides have no roadPath (TouristWorld owns the ground), so the bike's
// own road-progress odometer never moves. This one feeds bike.distanceTraveled
// instead, which is what the finish (the pseudo-level's distance), the goal
// readout, the coins and the achievements all read.
//
//   route (two addresses): progress along the route bearing — the furthest
//     projection reached, never negative — so arrival fires at ridableM and
//     riding sideways or back again counts nothing.
//   toward a point (a ride with a destination): how much closer the bike has come to that point,
//     the closest it has been. Arrival is being within ARRIVE_M of the point itself, so the ride
//     ends AT the place. Along a bearing it ended on a line across the map, which a rider who
//     drifted sideways crossed a long way from the door.
//   open world (one address): the distance ridden, frame by frame.
//
// Either way a single-frame jump over TELEPORT_M (a reset, the edge pull) is a
// teleport, not riding: the odometer re-bases instead of counting it. And when
// something else sets bike.distanceTraveled (a reset to 0), the odometer
// re-bases on that value. Pure: no THREE, no DOM — test/unit/tourist-odometer.
// ============================================================

/** A per-frame move longer than this is a teleport, not riding. */
export const TELEPORT_M = 20;

/** A ride toward a point arrives when the bike is this close to it, in metres. */
export const ARRIVE_M = 18;

/** Open-world rides pay coins for at most this much distance per ride. */
export const OPEN_WORLD_PAY_CAP_M = 10000;

export class TouristOdometer {
  /**
   * @param {{ heading?: number|null, target?: {x: number, z: number}|null, lengthM?: number, startM?: number }} [opts]
   *   heading: the route's forward heading (bike frame: forward = (sin h, cos h));
   *   target + lengthM: a point to reach, and how long the ride to it is (the bike is lengthM from it
   *     at the start); startM: the distance already counted when this leg begins (a ride's second leg);
   *   none of these = open world.
   */
  constructor({ heading = null, target = null, lengthM = 0, startM = 0, arriveM = ARRIVE_M } = {}) {
    /** How close to the point counts as there: ARRIVE_M, or more for a place that cannot be ridden into. */
    this.arriveM = Math.max(1, Number.isFinite(arriveM) ? arriveM : ARRIVE_M);
    this.target = target && isFinite(target.x) && isFinite(target.z) ? { x: target.x, z: target.z } : null;
    this.lengthM = Math.max(0, lengthM || 0);
    this.startM = Math.max(0, startM || 0);
    this.route = !this.target && typeof heading === 'number' && isFinite(heading);
    this.fx = this.route ? Math.sin(heading) : 0;
    this.fz = this.route ? Math.cos(heading) : 0;
    this.distance = 0;
    this._last = null;        // { x, z } last frame's position
    this._origin = null;      // route: where the current base was taken
    this._base = 0;           // route: distance at _origin
    this._written = null;     // the value last handed out (to spot outside resets)
  }

  /** Start counting from (x, z) at `distance` metres. */
  rebase(x, z, distance = 0) {
    this.distance = Math.max(0, distance || 0);
    this._last = { x, z };
    this._origin = { x, z };
    this._base = this.distance;
    this._written = this.distance;
  }

  /** The bike was put somewhere else (stood up after a crash): nothing was ridden getting there. */
  moved(x, z) {
    if (this._last && isFinite(x) && isFinite(z)) { this._last.x = x; this._last.z = z; }
  }

  /**
   * One frame. `current` is bike.distanceTraveled as it stands now: if it is not
   * what this odometer last returned, something reset the ride, so re-base on it.
   * @returns {number} the distance to write back to bike.distanceTraveled
   */
  update(x, z, current) {
    if (!isFinite(x) || !isFinite(z)) return this.distance;
    if (this._last === null || (current !== undefined && current !== this._written)) {
      this.rebase(x, z, current !== undefined ? current : 0);
      // toward a point, a reset to nothing starts the leg again; anything else carries on from it
      if (this.target && this.distance < this.startM) { this.distance = this.startM; this._written = this.distance; }
      return this.distance;
    }
    const dx = x - this._last.x;
    const dz = z - this._last.z;
    const step = Math.hypot(dx, dz);
    if (step > TELEPORT_M) {
      // Not ridden: keep what was counted and carry on from here.
      this.rebase(x, z, this.distance);
      return this.distance;
    }
    this._last.x = x;
    this._last.z = z;
    if (this.target) {
      // closer than ever before counts; within ARRIVE_M is the whole leg. The leg is spread over the
      // metres that can actually be ridden (its length less the arrival circle), so it starts at nothing.
      const away = Math.max(0, Math.hypot(this.target.x - x, this.target.z - z) - this.arriveM);
      const span = Math.max(1, this.lengthM - this.arriveM);
      const done = this.startM + this.lengthM * Math.max(0, 1 - away / span);
      if (done > this.distance) this.distance = done;
    } else if (this.route) {
      const along = this._base + (x - this._origin.x) * this.fx + (z - this._origin.z) * this.fz;
      if (along > this.distance) this.distance = along;
    } else {
      this.distance += step;
    }
    this._written = this.distance;
    return this.distance;
  }
}
