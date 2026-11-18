// ============================================================
// ROAD PATH — seeded procedural road centerline with curves & hills
//             Closed loop with Hermite spline closure
// ============================================================

import * as THREE from 'three';

const SEGMENT_LENGTH = 40;     // distance between control points
const MAX_CURVATURE = 0.03;    // rad per unit at control point
const MAX_ELEVATION = 4.0;     // tallest hill
const MIN_ELEVATION = -1.0;    // deepest valley
const SAMPLE_STEP = 0.5;       // cache resolution
const FLAT_ZONE = 80;          // first N units are straight & flat
const ROAD_HALF_WIDTH = 2.5;   // road is 5 units wide

const LOOP_LENGTH = 1200;      // total loop distance
const CLOSURE_ZONE = 300;      // Hermite spline from (LOOP_LENGTH - CLOSURE_ZONE) to LOOP_LENGTH
const RAMP_DOWN = 200;         // elevation ramps to 0 over this distance before closure

// The road behind the start line. The road chunks draw 100 m behind the rider,
// so at the start line the last 100 m of the loop is on screen together with
// the first 500 m. On some seeds the closure spline hairpinned right beside
// the start, which drew a second road parallel to the real one, with the
// "Your Home" sign standing on it (Daily Ride, 2026-11-07). When the closure
// crowds the start road like that it is rebuilt to aim at a point behind the
// start and finish on a straight runway into the start line.
export const START_BEHIND = 100;  // loop drawn behind the start line (m) — road-chunks.js
export const START_AHEAD = 500;   // road drawn ahead of the start line (m)
export const START_CLEARANCE = 15; // min gap between that tail and the start road (m)

export class RoadPath {
  constructor(seed = 42) {
    this._seed = seed;
    this._rngState = seed;
    this._controlPoints = [];   // {d, curvature, elevation}
    this._cache = [];            // {x, y, z, heading} at SAMPLE_STEP intervals
    this._cacheMaxD = 0;
    this.loopLength = LOOP_LENGTH;

    this._buildFullLoop();
  }

  // Seeded LCG PRNG (same as trees for consistency)
  _seededRandom() {
    this._rngState = (this._rngState * 9301 + 49297) % 233280;
    return this._rngState / 233280;
  }

  // Returns [-1, 1] from seeded random
  _signedRandom() {
    return this._seededRandom() * 2 - 1;
  }

  _buildFullLoop() {
    const randomEnd = LOOP_LENGTH - CLOSURE_ZONE; // 900

    // Generate control points for the random portion [0, 900]
    this._ensureControlPoints(randomEnd);

    // Build cache for random portion
    this._buildCacheTo(randomEnd);

    // Build closure spline for [900, 1200]
    this._buildClosure();

    // A tail that crowds the start road is rebuilt with a straight runway.
    // Roads whose tail was already clear (seed 42 among them) are untouched.
    if (!this.startIsClear()) {
      this._cache.length = Math.round(randomEnd / SAMPLE_STEP) + 1;
      this._buildClosure(START_BEHIND);
    }
  }

  /**
   * Is the start of the ride free of a second road? Checks the tail of the
   * loop (the START_BEHIND m drawn behind the rider at the start line) against
   * the first START_AHEAD m of road. A tail point only belongs there when it
   * is the approach: behind the start line, inside a 45° cone, meeting the
   * first few metres of road.
   * @returns {boolean}
   */
  startIsClear() {
    const L = LOOP_LENGTH;
    const step = 1;
    for (let b = L - START_BEHIND; b < L; b += step) {
      const q = this.getPointAtDistance(b);
      const onApproach = q.z <= 0 && Math.abs(q.x) <= -q.z;
      for (let a = 0; a <= START_AHEAD; a += step) {
        if (onApproach && a <= START_CLEARANCE + 5) continue;
        const p = this.getPointAtDistance(a);
        if (Math.hypot(p.x - q.x, p.z - q.z) < START_CLEARANCE) return false;
      }
    }
    return true;
  }

  _ensureControlPoints(upToD) {
    const cap = LOOP_LENGTH - CLOSURE_ZONE; // don't generate past random zone
    const clampedD = Math.min(upToD, cap);
    const needed = Math.ceil(clampedD / SEGMENT_LENGTH) + 2;
    const rampStart = cap - RAMP_DOWN; // 700

    while (this._controlPoints.length < needed) {
      const i = this._controlPoints.length;
      const d = i * SEGMENT_LENGTH;

      let curvature = 0;
      let elevation = 0;

      if (d >= FLAT_ZONE) {
        // Gradual ramp-in of curvature and elevation after flat zone
        const rampT = Math.min((d - FLAT_ZONE) / (SEGMENT_LENGTH * 2), 1);
        curvature = this._signedRandom() * MAX_CURVATURE * rampT;
        elevation = (this._seededRandom() * (MAX_ELEVATION - MIN_ELEVATION) + MIN_ELEVATION) * rampT;

        // Ramp elevation and curvature toward 0 for smooth closure approach
        if (d > rampStart) {
          const rampDown = Math.max(0, 1 - (d - rampStart) / RAMP_DOWN);
          elevation *= rampDown;
          curvature *= rampDown;
        }
      }

      this._controlPoints.push({ d, curvature, elevation });
    }
  }

  _buildCacheTo(targetD) {
    if (targetD <= this._cacheMaxD) return;

    this._ensureControlPoints(targetD + SEGMENT_LENGTH * 2);

    // Start from where cache left off
    let d = this._cacheMaxD;
    if (this._cache.length === 0) {
      // First point: origin facing +Z
      this._cache.push({ x: 0, y: 0, z: 0, heading: 0 });
      d = SAMPLE_STEP;
    }

    const randomEnd = LOOP_LENGTH - CLOSURE_ZONE;
    const homingStart = randomEnd * 0.35; // begin gentle homing at ~315

    while (d <= targetD) {
      const prev = this._cache[this._cache.length - 1];
      let curvature = this._interpolateCurvature(d);
      const elevation = this._interpolateElevation(d);

      // Homing bias: gently steer toward origin so the road naturally loops
      if (d > homingStart) {
        const distToOrigin = Math.sqrt(prev.x * prev.x + prev.z * prev.z);
        if (distToOrigin > 1) {
          const angleToOrigin = Math.atan2(-prev.x, -prev.z);
          let headingError = angleToOrigin - prev.heading;
          // Wrap to [-PI, PI]
          while (headingError > Math.PI) headingError -= 2 * Math.PI;
          while (headingError < -Math.PI) headingError += 2 * Math.PI;

          const t = Math.min(1, (d - homingStart) / (randomEnd - homingStart));
          const homingStrength = t * t * 0.004; // quadratic ramp, subtle early, firm late
          curvature += headingError * homingStrength;
        }
      }

      const heading = prev.heading + curvature * SAMPLE_STEP;
      const x = prev.x + Math.sin(heading) * SAMPLE_STEP;
      const z = prev.z + Math.cos(heading) * SAMPLE_STEP;
      const y = elevation;

      this._cache.push({ x, y, z, heading });
      d += SAMPLE_STEP;
    }

    this._cacheMaxD = d - SAMPLE_STEP;
  }

  /**
   * Hermite spline from the end of the random road back to the start line.
   * With `runway` > 0 the spline aims at a point `runway` m behind the start
   * (heading 0) and the loop then runs straight into the start line.
   * @param {number} runway
   */
  _buildClosure(runway = 0) {
    const splineLength = CLOSURE_ZONE - runway;

    // Get state at end of random portion
    const lastEntry = this._cache[this._cache.length - 1];
    const p0x = lastEntry.x;
    const p0z = lastEntry.z;
    const p0y = lastEntry.y;
    const h0 = lastEntry.heading;

    // Target: origin (or the head of the runway) at heading 0
    const p1x = 0;
    const p1z = runway > 0 ? -runway : 0;
    const p1y = 0;
    const h1 = 0; // heading at d=0

    // Distance from last point to the target
    const tx = p0x - p1x;
    const tz = p0z - p1z;
    const distToOrigin = Math.sqrt(tx * tx + tz * tz);

    // Tangent scale for Hermite: big enough for smooth curve
    const tangentScale = Math.max(splineLength * 0.35, distToOrigin * 0.5);

    // Hermite tangent vectors (direction from heading, scaled)
    const m0x = Math.sin(h0) * tangentScale;
    const m0z = Math.cos(h0) * tangentScale;
    const m1x = Math.sin(h1) * tangentScale;
    const m1z = Math.cos(h1) * tangentScale;

    // Sample closure zone in SAMPLE_STEP increments
    const numSteps = Math.round(splineLength / SAMPLE_STEP);

    for (let i = 1; i <= numSteps; i++) {
      const t = i / numSteps;

      // Cubic Hermite basis functions
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;

      // Position
      const x = h00 * p0x + h10 * m0x + h01 * p1x + h11 * m1x;
      const z = h00 * p0z + h10 * m0z + h01 * p1z + h11 * m1z;

      // Elevation: smoothstep blend from p0y to 0
      const st = t * t * (3 - 2 * t); // smoothstep
      const y = p0y * (1 - st);

      // Heading from tangent of Hermite curve
      const dt2 = 2 * t;
      const dt3 = 3 * t2;
      const dh00 = 6 * t2 - 6 * t;
      const dh10 = 3 * t2 - 4 * t + 1;
      const dh01 = -6 * t2 + 6 * t;
      const dh11 = 3 * t2 - 2 * t;

      const dxdt = dh00 * p0x + dh10 * m0x + dh01 * p1x + dh11 * m1x;
      const dzdt = dh00 * p0z + dh10 * m0z + dh01 * p1z + dh11 * m1z;
      const heading = Math.atan2(dxdt, dzdt);

      this._cache.push({ x, y, z, heading });
    }

    // The straight runway into the start line.
    const runwaySteps = Math.round(runway / SAMPLE_STEP);
    for (let i = 1; i <= runwaySteps; i++) {
      this._cache.push({ x: 0, y: 0, z: -runway + i * SAMPLE_STEP, heading: 0 });
    }

    this._cacheMaxD = LOOP_LENGTH;
  }

  // Hermite interpolation of curvature at distance d
  _interpolateCurvature(d) {
    const segIdx = Math.floor(d / SEGMENT_LENGTH);
    const t = (d - segIdx * SEGMENT_LENGTH) / SEGMENT_LENGTH;

    const p0 = this._getCP(segIdx);
    const p1 = this._getCP(segIdx + 1);

    // Smooth hermite: 3t^2 - 2t^3
    const h = t * t * (3 - 2 * t);
    return p0.curvature * (1 - h) + p1.curvature * h;
  }

  // Hermite interpolation of elevation at distance d
  _interpolateElevation(d) {
    const segIdx = Math.floor(d / SEGMENT_LENGTH);
    const t = (d - segIdx * SEGMENT_LENGTH) / SEGMENT_LENGTH;

    const p0 = this._getCP(segIdx);
    const p1 = this._getCP(segIdx + 1);

    // Smooth hermite
    const h = t * t * (3 - 2 * t);
    return p0.elevation * (1 - h) + p1.elevation * h;
  }

  _getCP(idx) {
    if (idx < 0) return { d: 0, curvature: 0, elevation: 0 };
    if (idx < this._controlPoints.length) return this._controlPoints[idx];
    return { d: idx * SEGMENT_LENGTH, curvature: 0, elevation: 0 };
  }

  // Wrap d into [0, LOOP_LENGTH)
  _wrapD(d) {
    return ((d % LOOP_LENGTH) + LOOP_LENGTH) % LOOP_LENGTH;
  }

  // === Public API ===

  /** Get road centerline point at distance d along the road */
  getPointAtDistance(d) {
    d = this._wrapD(d);

    const idx = d / SAMPLE_STEP;
    const i0 = Math.floor(idx);
    const frac = idx - i0;

    if (i0 >= this._cache.length - 1) {
      return { ...this._cache[this._cache.length - 1] };
    }

    const a = this._cache[i0];
    const b = this._cache[i0 + 1];

    return {
      x: a.x + (b.x - a.x) * frac,
      y: a.y + (b.y - a.y) * frac,
      z: a.z + (b.z - a.z) * frac,
      heading: a.heading + (b.heading - a.heading) * frac
    };
  }

  /** Get terrain height at arbitrary world position */
  getHeightAtWorld(worldX, worldZ, hintD) {
    const info = this.getClosestRoadInfo(worldX, worldZ, hintD);
    if (!info) return 0;
    return info.roadY;
  }

  /** Get slope (rise per unit distance) at distance d */
  getSlopeAtDistance(d) {
    const step = 2.0; // wider window -> smoother slope (bike is 4.4m long)
    const a = this.getPointAtDistance(d - step * 0.5);
    const b = this.getPointAtDistance(d + step * 0.5);
    return (b.y - a.y) / step;
  }

  /** Find closest road point to a world position — returns {d, roadX, roadY, roadZ, lateralOffset, heading} */
  getClosestRoadInfo(worldX, worldZ, hintD) {
    const searchRadius = 60;
    const searchStep = 5;
    const L = LOOP_LENGTH;

    // Use hint if provided, otherwise fall back to Z-based estimate
    let bestD = hintD !== undefined ? this._wrapD(hintD) : Math.max(0, worldZ) % L;
    let bestDist = Infinity;

    // Coarse search (wraps naturally via getPointAtDistance).
    //
    // The window is measured from a FIXED centre. It used to be measured from
    // `bestD`, which the loop reassigns as it finds better candidates — so the
    // window walked instead of scanning, and could stride far outside its own
    // radius. The road is a closed 1200 m loop whose closure spline passes
    // within ~27 m of the first 50 m of the ride, so on a bike 30 m from the
    // start the walk stepped across the seam and latched onto the INCOMING
    // leg, ~90 m short of where the rider actually was. Everything downstream
    // reads progress from here: the ride distance collapsed to zero, the
    // checkpoint the rider had just ridden under never registered, and the
    // segment timer ran out. Seed-dependent — the old hard-coded road never
    // showed it, and 16 of the next 30 daily roads did.
    const searchCenter = bestD;
    for (let offset = -searchRadius; offset <= searchRadius; offset += searchStep) {
      const d = this._wrapD(searchCenter + offset);
      const pt = this.getPointAtDistance(d);
      const dx = worldX - pt.x;
      const dz = worldZ - pt.z;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        bestD = d;
      }
    }

    // Fine search — same fixed-centre rule as the coarse pass.
    const fineCenter = bestD;
    for (let offset = -searchStep; offset <= searchStep; offset += SAMPLE_STEP) {
      const d = this._wrapD(fineCenter + offset);
      const pt = this.getPointAtDistance(d);
      const dx = worldX - pt.x;
      const dz = worldZ - pt.z;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        bestD = d;
      }
    }

    // Parabolic sub-step refinement
    const dL = this._wrapD(bestD - SAMPLE_STEP);
    const dR = this._wrapD(bestD + SAMPLE_STEP);
    const pL = this.getPointAtDistance(dL);
    const pR = this.getPointAtDistance(dR);
    const fL = (worldX - pL.x) ** 2 + (worldZ - pL.z) ** 2;
    const fR = (worldX - pR.x) ** 2 + (worldZ - pR.z) ** 2;
    const denom = 2 * (fL - 2 * bestDist + fR);
    if (Math.abs(denom) > 1e-10) {
      const offset = ((fL - fR) / denom) * SAMPLE_STEP;
      bestD = this._wrapD(bestD + Math.max(-SAMPLE_STEP, Math.min(SAMPLE_STEP, offset)));
    }

    const pt = this.getPointAtDistance(bestD);

    // Lateral offset: positive = right of road
    const dx = worldX - pt.x;
    const dz = worldZ - pt.z;
    // Road forward direction
    const fwdX = Math.sin(pt.heading);
    const fwdZ = Math.cos(pt.heading);
    // Right vector (cross product with up)
    const rightX = fwdZ;
    const rightZ = -fwdX;
    const lateralOffset = dx * rightX + dz * rightZ;

    return {
      d: bestD,
      roadX: pt.x,
      roadY: pt.y,
      roadZ: pt.z,
      lateralOffset,
      heading: pt.heading
    };
  }
}
