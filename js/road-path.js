// ============================================================
// ROAD PATH — seeded procedural road centerline with curves & hills
// ============================================================

import * as THREE from 'three';

const SEGMENT_LENGTH = 40;     // distance between control points
const MAX_CURVATURE = 0.03;    // rad per unit at control point
const MAX_ELEVATION = 4.0;     // tallest hill
const MIN_ELEVATION = -1.0;    // deepest valley
const SAMPLE_STEP = 0.5;       // cache resolution
const FLAT_ZONE = 80;          // first N units are straight & flat
const ROAD_HALF_WIDTH = 2.5;   // road is 5 units wide

export class RoadPath {
  constructor(seed = 42) {
    this._seed = seed;
    this._rngState = seed;
    this._controlPoints = [];   // {d, curvature, elevation}
    this._cache = [];            // {x, y, z, heading} at SAMPLE_STEP intervals
    this._cacheMaxD = 0;
    this._generateInitialPoints();
    this._buildCacheTo(FLAT_ZONE + SEGMENT_LENGTH * 4);
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

  _generateInitialPoints() {
    // Generate enough control points for the initial cache
    this._ensureControlPoints(FLAT_ZONE + SEGMENT_LENGTH * 6);
  }

  _ensureControlPoints(upToD) {
    const needed = Math.ceil(upToD / SEGMENT_LENGTH) + 2;
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

    while (d <= targetD) {
      const prev = this._cache[this._cache.length - 1];
      const curvature = this._interpolateCurvature(d);
      const elevation = this._interpolateElevation(d);

      const heading = prev.heading + curvature * SAMPLE_STEP;
      const x = prev.x + Math.sin(heading) * SAMPLE_STEP;
      const z = prev.z + Math.cos(heading) * SAMPLE_STEP;
      const y = elevation;

      this._cache.push({ x, y, z, heading });
      d += SAMPLE_STEP;
    }

    this._cacheMaxD = d - SAMPLE_STEP;
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
    this._ensureControlPoints((idx + 2) * SEGMENT_LENGTH);
    return this._controlPoints[idx] || { d: idx * SEGMENT_LENGTH, curvature: 0, elevation: 0 };
  }

  // === Public API ===

  /** Get road centerline point at distance d along the road */
  getPointAtDistance(d) {
    if (d < 0) d = 0;
    this._buildCacheTo(d + SAMPLE_STEP * 2);

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
    const step = 2.0; // wider window → smoother slope (bike is 4.4m long)
    const a = this.getPointAtDistance(d - step * 0.5);
    const b = this.getPointAtDistance(d + step * 0.5);
    return (b.y - a.y) / step;
  }

  /** Find closest road point to a world position — returns {d, roadX, roadY, roadZ, lateralOffset, heading} */
  getClosestRoadInfo(worldX, worldZ, hintD) {
    // Estimate d from Z coordinate, then refine
    // Start with a rough search
    const searchRadius = 60;
    const searchStep = 5;

    // Use hint if provided, otherwise fall back to Z-based estimate
    let bestD = hintD !== undefined ? Math.max(0, hintD) : Math.max(0, worldZ);
    let bestDist = Infinity;

    // Coarse search
    const startD = Math.max(0, bestD - searchRadius);
    const endD = bestD + searchRadius;
    this._buildCacheTo(endD + SAMPLE_STEP * 2);

    for (let d = startD; d <= endD; d += searchStep) {
      const pt = this.getPointAtDistance(d);
      const dx = worldX - pt.x;
      const dz = worldZ - pt.z;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        bestD = d;
      }
    }

    // Fine search
    const fineStart = Math.max(0, bestD - searchStep);
    const fineEnd = bestD + searchStep;
    for (let d = fineStart; d <= fineEnd; d += SAMPLE_STEP) {
      const pt = this.getPointAtDistance(d);
      const dx = worldX - pt.x;
      const dz = worldZ - pt.z;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        bestD = d;
      }
    }

    // Parabolic sub-step refinement: sample at bestD ± SAMPLE_STEP,
    // fit parabola to find smooth fractional minimum
    const dL = Math.max(0, bestD - SAMPLE_STEP);
    const dR = bestD + SAMPLE_STEP;
    const pL = this.getPointAtDistance(dL);
    const pR = this.getPointAtDistance(dR);
    const fL = (worldX - pL.x) ** 2 + (worldZ - pL.z) ** 2;
    const fR = (worldX - pR.x) ** 2 + (worldZ - pR.z) ** 2;
    const denom = 2 * (fL - 2 * bestDist + fR);
    if (Math.abs(denom) > 1e-10) {
      const offset = ((fL - fR) / denom) * SAMPLE_STEP;
      bestD = Math.max(0, bestD + Math.max(-SAMPLE_STEP, Math.min(SAMPLE_STEP, offset)));
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
