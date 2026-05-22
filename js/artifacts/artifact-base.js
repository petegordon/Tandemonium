// ============================================================
// ARTIFACT BASE — shared helpers for placement, visibility,
// road-frame transforms, and AABB-on-road collision math.
// (Pure math + DOM-free so it can be unit-tested under Node.)
// ============================================================

export const VISIBLE_AHEAD = 220;   // meters
export const VISIBLE_BEHIND = 40;

/**
 * Compute the world-space position + heading at a point on the road,
 * with an optional lateral offset from the centerline.
 */
export function roadFrame(roadPath, d, lateralOffset = 0) {
  const pt = roadPath.getPointAtDistance(d);
  // right vector in world-XZ (90deg clockwise from heading)
  const rightX = Math.cos(pt.heading);
  const rightZ = -Math.sin(pt.heading);
  return {
    x: pt.x + rightX * lateralOffset,
    y: pt.y,
    z: pt.z + rightZ * lateralOffset,
    heading: pt.heading,
    rightX, rightZ,
    forwardX: Math.sin(pt.heading),
    forwardZ: Math.cos(pt.heading)
  };
}

/** Whether an artifact at `artifactD` is in the visibility window. */
export function inVisibilityWindow(artifactD, bikeDistanceTraveled, loopLen) {
  // Use loop-aware delta so artifacts placed near distance == raceDistance
  // are still visible when the bike is "near" them on the underlying loop.
  let delta = artifactD - bikeDistanceTraveled;
  return delta >= -VISIBLE_BEHIND && delta <= VISIBLE_AHEAD;
}

/**
 * Test whether a world-space bike position is inside an oriented rectangle
 * lying flat on the road at distance `d` with width × length and lateral offset.
 * Returns the (normalizedAlong, normalizedAcross) within the rectangle, or null.
 */
export function pointInRoadRect(roadPath, d, offset, width, length, bikePos) {
  const f = roadFrame(roadPath, d, offset);
  const dx = bikePos.x - f.x;
  const dz = bikePos.z - f.z;
  // Project onto road-aligned axes
  const along = dx * f.forwardX + dz * f.forwardZ;   // meters along road
  const across = dx * f.rightX + dz * f.rightZ;      // meters perpendicular
  const halfW = width / 2;
  const halfL = length / 2;
  if (along < -halfL || along > halfL) return null;
  if (across < -halfW || across > halfW) return null;
  return { along, across, alongNorm: (along + halfL) / length, acrossNorm: (across + halfW) / width };
}

/** Cheap circle-vs-circle collision in XZ plane. */
export function circleHit(x1, z1, r1, x2, z2, r2) {
  const dx = x1 - x2;
  const dz = z1 - z2;
  const r = r1 + r2;
  return dx * dx + dz * dz < r * r;
}

/** Make the mesh face the camera's yaw without copying full quaternion. */
export function billboardYaw(mesh, camera) {
  if (!camera) return;
  mesh.quaternion.copy(camera.quaternion);
}
