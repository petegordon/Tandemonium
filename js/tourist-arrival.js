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
  /**
   * Pete, 2026-11-18: "If the camera is too close need to modify its positioning relative to the end."
   * Where the rise ends is chosen before it starts: of these pans (either way round) and these heights,
   * the one whose end has the most open view of the place. The first of each is the usual one, and is
   * kept unless another is better by more than preferBy.
   */
  sweeps: [Math.PI * 1.1, Math.PI * 0.8, Math.PI * 1.4, Math.PI * 0.5, Math.PI * 1.7],
  heights: [80, 125],
  preferBy: 0.12,
  /** The camera wants this much clear air round it where it ends (cables, a tower, a wall beside it). */
  elbowRoom: 30,
};

/**
 * How much of the way out to an end pose the view is open: 1 = all of it, 0 = blocked at the place.
 * @param {{x:number,y:number,z:number}} place
 * @param {{angle:number, radius:number, height:number}} end
 * @param {(from:{x:number,y:number,z:number}, to:{x:number,y:number,z:number}) => number|null} clear
 */
export function openFraction(place, end, clear, tune = ARRIVAL) {
  const from = { x: place.x, y: place.y + tune.lookHeight, z: place.z };
  const to = { x: place.x + Math.sin(end.angle) * end.radius, y: place.y + end.height, z: place.z + Math.cos(end.angle) * end.radius };
  const open = clear(from, to);
  if (open == null) return 1;
  const full = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) || 1;
  return Math.max(0, Math.min(1, (open - tune.clearMargin) / full));
}

/**
 * Choose the pan and the height the rise ends at: the most open view of the place.
 * @returns {{dir:number, sweep:number, endHeight:number, open:number}}
 */
export function chooseArrivalEnd(place, start, clear, tune = ARRIVAL) {
  const usual = { dir: start.dir < 0 ? -1 : 1, sweep: tune.sweeps[0], endHeight: tune.heights[0], open: 1 };
  if (!clear) return usual;
  // an end is as good as its view of the place, marked down for anything close beside the camera there
  const score = (c) => {
    const end = { angle: start.angle + c.dir * c.sweep, radius: Math.max(start.radius, tune.endRadius), height: Math.max(start.height, c.endHeight) };
    const view = openFraction(place, end, clear, tune);
    if (view <= 0) return 0;
    const at = { x: place.x + Math.sin(end.angle) * end.radius, y: place.y + end.height, z: place.z + Math.cos(end.angle) * end.radius };
    let room = 0;
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      const hit = clear(at, { x: at.x + Math.sin(a) * tune.elbowRoom, y: at.y, z: at.z + Math.cos(a) * tune.elbowRoom });
      room += hit == null ? 1 : Math.max(0, Math.min(1, hit / tune.elbowRoom));
    }
    return view * (0.35 + 0.65 * room / 8);
  };
  usual.open = score(usual);
  let best = usual;
  usual.tried = [[usual.dir, usual.sweep, usual.endHeight, usual.open]];
  if (usual.open >= 0.98) return usual;
  for (const endHeight of tune.heights) {
    for (const sweep of tune.sweeps) {
      for (const dir of [usual.dir, -usual.dir]) {
        const c = { dir, sweep, endHeight, open: 0 };
        c.open = score(c);
        usual.tried.push([dir, sweep, endHeight, c.open]);
        if (c.open > best.open + (best === usual ? tune.preferBy : 0.02)) best = c;
      }
    }
  }
  best.tried = usual.tried;
  return best;
}

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

/**
 * A place's own view (the scenic rides: set by hand where the usual end is a poor one, such as among a
 * bridge's cables, which no ray finds). bearing: where the camera ends, in degrees clockwise from north
 * as seen from the place; radius and height in metres; look: how far above the ground it looks.
 * @returns {{dir:number, sweep:number, endHeight:number, endRadius:number, lookHeight:number, open:number}|null}
 */
export function arrivalEndFromView(view, start, tune = ARRIVAL) {
  if (!view || !Number.isFinite(view.bearing)) return null;
  // the local frame: +z north, +x WEST, and angles here run from +z toward +x
  const want = -view.bearing * Math.PI / 180;
  let diff = Math.atan2(Math.sin(want - start.angle), Math.cos(want - start.angle));
  // too short a pan is no pan: go the long way round
  if (Math.abs(diff) < Math.PI * 0.3) diff -= Math.sign(diff || 1) * Math.PI * 2;
  return {
    dir: diff < 0 ? -1 : 1, sweep: Math.abs(diff), open: 1,
    endHeight: Number.isFinite(view.height) ? view.height : tune.endHeight,
    endRadius: Number.isFinite(view.radius) ? view.radius : tune.endRadius,
    lookHeight: Number.isFinite(view.look) ? view.look : tune.lookHeight,
  };
}

export class ArrivalOrbit {
  /**
   * @param {import('three').PerspectiveCamera} camera  starts from wherever it is now
   * @param {{x:number, y:number, z:number}} place  the destination, on its ground
   * @param {{x:number, y:number, z:number}} bikePos  what the camera is looking at now
   * @param {{ clear?: (from:{x:number,y:number,z:number}, to:{x:number,y:number,z:number}) => number|null, tune?: typeof ARRIVAL }} [opts]
   *   clear: the distance from `from` toward `to` at which something blocks the view (null = nothing does)
   *   view: the place's own end for the rise (arrivalEndFromView), when it has one
   */
  constructor(camera, place, bikePos, { clear = null, tune = ARRIVAL, view = null } = {}) {
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
    // where it ends: the usual pan and height, unless something stands in that view
    // (a place with a view of its own goes there, and is trusted: nothing is asked of the rays)
    const own = arrivalEndFromView(view, this.start, tune);
    if (own) this.clear = null;
    const end = own || chooseArrivalEnd(this.place, this.start, clear, tune);
    this.end = end;
    this.start.dir = end.dir;
    this.tune = tune = { ...tune, sweep: end.sweep, endHeight: end.endHeight, endRadius: end.endRadius || tune.endRadius, lookHeight: end.lookHeight || tune.lookHeight };
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
