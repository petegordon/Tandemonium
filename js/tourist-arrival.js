// ============================================================
// TOURIST ARRIVAL — the camera's part of arriving somewhere (#802)
//
// Pete, 2026-11-18: "I love the pan around the scenic landmark maybe as rising up in the sky from
// the pan in front of the completion."
//
// The ordinary finish swings the camera round to the front of the bike. On a Map Tourist ride that
// is where this takes over: from that pose the camera rises into the sky while it pans round the
// place the ride was to, so the last thing seen before the end screen is the place itself.
//
// arrivalPose() is the path (pure, tested); ArrivalOrbit drives a camera along it and keeps the
// camera out of buildings: `clear(from, to)` says how far along the line from the place to the
// camera the view is open (the world answers with a ray into the tiles).
// ============================================================

export const ARRIVAL = {
  /** Seconds the rise takes. */
  riseS: 7.5,
  /** How far round the place the camera pans, in radians. */
  sweep: Math.PI * 1.1,
  /** Where it ends: this far from the place, this far above its ground. */
  endRadius: 110,
  endHeight: 80,
  /** It looks at a point this far above the ground at the place. */
  lookHeight: 10,
  /** The part of the rise over which the look moves from the bike to the place. */
  lookBlend: 0.4,
  /** Never closer to the place than this, and this far in front of whatever blocks the view. */
  minRadius: 9,
  clearMargin: 4,
};

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Where the camera is at t (0 = the pose it starts from, 1 = high over the place).
 * It climbs first and moves out after, so it clears the street before it widens.
 * @param {number} t
 * @param {{angle:number, radius:number, height:number, dir?:number}} start  the pose it starts from,
 *   as an angle round the place (0 = +z, toward +x), a distance from it and a height above its ground
 * @returns {{angle:number, radius:number, height:number, look:number}}  look: 0 = at the bike, 1 = at the place
 */
export function arrivalPose(t, start, tune = ARRIVAL) {
  const u = clamp01(t);
  const dir = start.dir < 0 ? -1 : 1;
  return {
    angle: start.angle + dir * tune.sweep * easeInOut(u),
    radius: lerp(start.radius, Math.max(start.radius, tune.endRadius), easeInOut(u)),
    height: lerp(start.height, Math.max(start.height, tune.endHeight), easeOut(u)),
    look: easeInOut(clamp01(u / tune.lookBlend)),
  };
}

export class ArrivalOrbit {
  /**
   * @param {import('three').PerspectiveCamera} camera  starts from wherever it is now
   * @param {{x:number, y:number, z:number}} place  the destination, on its ground
   * @param {{x:number, y:number, z:number}} bikePos  what the camera is looking at now
   * @param {{ clear?: (from:{x:number,y:number,z:number}, to:{x:number,y:number,z:number}) => number|null, tune?: typeof ARRIVAL }} [opts]
   *   clear: the distance from `from` toward `to` at which something blocks the view (null = nothing does)
   */
  constructor(camera, place, bikePos, { clear = null, tune = ARRIVAL } = {}) {
    this.camera = camera;
    this.place = { x: place.x, y: place.y, z: place.z };
    this.tune = tune;
    this.clear = clear;
    this.elapsed = 0;
    this.done = false;
    const dx = camera.position.x - place.x, dz = camera.position.z - place.z;
    // pan the short way round the bike: away from the side the camera is already on
    const bx = bikePos.x - place.x, bz = bikePos.z - place.z;
    const cross = bx * dz - bz * dx;
    this.start = {
      angle: Math.atan2(dx, dz),
      radius: Math.max(0.5, Math.hypot(dx, dz)),     // (wherever the swing left it: no snap)
      height: camera.position.y - place.y,
      dir: cross >= 0 ? 1 : -1,
    };
    this.startLook = { x: bikePos.x, y: bikePos.y + 1.3, z: bikePos.z };
    this._radius = this.start.radius;
  }

  /** One frame. @returns {boolean} true once the camera is at the top */
  update(dt) {
    const tune = this.tune;
    this.elapsed += dt;
    const t = clamp01(this.elapsed / tune.riseS);
    const p = arrivalPose(t, this.start, tune);
    const look = {
      x: lerp(this.startLook.x, this.place.x, p.look),
      y: lerp(this.startLook.y, this.place.y + tune.lookHeight, p.look),
      z: lerp(this.startLook.z, this.place.z, p.look),
    };
    // out of buildings: no further from the place than the view is open, less a margin
    let radius = p.radius;
    if (this.clear) {
      const want = { x: this.place.x + Math.sin(p.angle) * p.radius, y: this.place.y + p.height, z: this.place.z + Math.cos(p.angle) * p.radius };
      const from = { x: this.place.x, y: this.place.y + tune.lookHeight, z: this.place.z };
      const open = this.clear(from, want);
      if (open != null) {
        const full = Math.hypot(want.x - from.x, want.y - from.y, want.z - from.z) || 1;
        radius = Math.max(Math.min(tune.minRadius, p.radius), p.radius * Math.max(0, open - tune.clearMargin) / full);
      }
    }
    // (eased, so a building edge passing the line of sight does not jerk the camera)
    this._radius += (radius - this._radius) * Math.min(1, dt * 3);
    if (this._radius > p.radius) this._radius = p.radius;
    this.camera.position.set(
      this.place.x + Math.sin(p.angle) * this._radius,
      this.place.y + p.height,
      this.place.z + Math.cos(p.angle) * this._radius,
    );
    this.camera.lookAt(look.x, look.y, look.z);
    this.done = t >= 1;
    return this.done;
  }
}
