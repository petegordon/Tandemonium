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
//   open world (one address): the distance ridden, frame by frame.
//
// Either way a single-frame jump over TELEPORT_M (a reset, the edge pull) is a
// teleport, not riding: the odometer re-bases instead of counting it. And when
// something else sets bike.distanceTraveled (a reset to 0), the odometer
// re-bases on that value. Pure: no THREE, no DOM — test/unit/tourist-odometer.
// ============================================================

/** A per-frame move longer than this is a teleport, not riding. */
export const TELEPORT_M = 20;

/** Open-world rides pay coins for at most this much distance per ride. */
export const OPEN_WORLD_PAY_CAP_M = 10000;

export class TouristOdometer {
  /**
   * @param {{ heading?: number|null }} [opts]  heading: the route's forward
   *   heading (bike frame: forward = (sin h, cos h)); null/undefined = open world.
   */
  constructor({ heading = null } = {}) {
    this.route = typeof heading === 'number' && isFinite(heading);
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

  /**
   * One frame. `current` is bike.distanceTraveled as it stands now: if it is not
   * what this odometer last returned, something reset the ride, so re-base on it.
   * @returns {number} the distance to write back to bike.distanceTraveled
   */
  update(x, z, current) {
    if (!isFinite(x) || !isFinite(z)) return this.distance;
    if (this._last === null || (current !== undefined && current !== this._written)) {
      this.rebase(x, z, current !== undefined ? current : 0);
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
    if (this.route) {
      const along = this._base + (x - this._origin.x) * this.fx + (z - this._origin.z) * this.fz;
      if (along > this.distance) this.distance = along;
    } else {
      this.distance += step;
    }
    this._written = this.distance;
    return this.distance;
  }
}
