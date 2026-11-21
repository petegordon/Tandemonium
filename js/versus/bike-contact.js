// ============================================================
// BIKE CONTACT — the shape two versus bikes touch with (#839)
// ============================================================
//
// One path for couch Versus and Versus Bots. Each bike is a capsule along its heading, as long as that bike's model
// really is: a goose tandem is 4.4 m, a Solo Flight 5.6 m. Three fixed circles used to stand in for every bike, which
// left gaps between them and ignored the bike's length.
//
// Pure: no DOM, no three.js.

/** Half the width of a bike with its riders (the models are about 0.94 m wide). */
export const BIKE_CONTACT_RADIUS = 0.45;
/** The length to assume for a bike whose model has not loaded yet. */
export const DEFAULT_BIKE_LENGTH = 4.4;

/** The centre segment of a bike's capsule. @param {{position: {x: number, z: number}, heading: number, contactLength?: number}} bike */
export function bikeSegment(bike) {
  const length = bike.contactLength > 0 ? bike.contactLength : DEFAULT_BIKE_LENGTH;
  const half = Math.max(0, length / 2 - BIKE_CONTACT_RADIUS);
  const fx = Math.sin(bike.heading), fz = Math.cos(bike.heading);
  return {
    ax: bike.position.x - fx * half, az: bike.position.z - fz * half,
    bx: bike.position.x + fx * half, bz: bike.position.z + fz * half,
  };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** The closest points of two segments. → { dist, nx, nz }, n pointing from the second toward the first. */
export function closestSegments(s, t) {
  const ux = s.bx - s.ax, uz = s.bz - s.az;
  const vx = t.bx - t.ax, vz = t.bz - t.az;
  const wx = s.ax - t.ax, wz = s.az - t.az;
  const a = ux * ux + uz * uz, e = vx * vx + vz * vz, f = vx * wx + vz * wz;
  let p = 0, q = 0;
  if (a <= 1e-9 && e <= 1e-9) { p = 0; q = 0; }
  else if (a <= 1e-9) q = clamp01(f / e);
  else {
    const c = ux * wx + uz * wz;
    if (e <= 1e-9) p = clamp01(-c / a);
    else {
      const b = ux * vx + uz * vz;
      const denom = a * e - b * b;
      p = denom > 1e-9 ? clamp01((b * f - c * e) / denom) : 0;
      q = (b * p + f) / e;
      if (q < 0) { q = 0; p = clamp01(-c / a); }
      else if (q > 1) { q = 1; p = clamp01((b - c) / a); }
    }
  }
  const dx = (s.ax + ux * p) - (t.ax + vx * q);
  const dz = (s.az + uz * p) - (t.az + vz * q);
  const dist = Math.hypot(dx, dz);
  return dist > 1e-6 ? { dist, nx: dx / dist, nz: dz / dist } : { dist: 0, nx: 1, nz: 0 };
}

/** Are these two bikes touching? → { touching, overlap, nx, nz }, n pointing from b toward a. */
export function bikeContact(a, b) {
  const c = closestSegments(bikeSegment(a), bikeSegment(b));
  const reach = BIKE_CONTACT_RADIUS * 2;
  let { nx, nz } = c;
  if (c.dist <= 1e-6) {   // the frames cross: push apart along the line between the bikes
    const dx = a.position.x - b.position.x, dz = a.position.z - b.position.z, d = Math.hypot(dx, dz);
    if (d > 1e-6) { nx = dx / d; nz = dz / d; }
  }
  return { touching: c.dist < reach, overlap: Math.max(0, reach - c.dist), nx, nz };
}
