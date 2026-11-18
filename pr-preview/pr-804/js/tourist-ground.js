// ============================================================
// TOURIST GROUND — street-level ground following for Map Tourist (#402)
//
// Google Photorealistic 3D Tiles are one fused mesh: there is no "road" vs
// "roof" vs "tree" label. A single downward ray from high above the bike
// therefore hits whatever is HIGHEST at that x/z — a roof, a tree crown, a
// bridge deck — and taking that first hit lifted the bike onto canopies and
// roofs. This module owns the hit selection instead, purely from geometry:
//
//   1. Read ALL hits along the ray, not just the nearest.
//   2. Drop faces that are not roughly upward-facing (walls, leaf sides).
//   3. Accept only a hit inside a STEP WINDOW around the last accepted ground
//      point: a little up per metre of horizontal travel since that point
//      (kerbs, ramps, hills: yes; walls and roofs: no) and more down (slopes,
//      dropping off a roof or kerb). Among the survivors, take the one closest
//      to the last ground height.
//   4. Recovery (#402 option 5): accepted ground points leave a breadcrumb
//      trail. When no hit has been accepted for a while, or the bike has a
//      ceiling just above it (it is inside geometry), the bike resnaps to the
//      last breadcrumb; if the trail itself is stale, it snaps fresh.
//
// It has no dependency on the 3D Tiles library: anything with
// `raycast(raycaster, hits)` filling three.js intersections works, which is
// how the unit test feeds it a synthetic ground + building + tree.
// ============================================================

import * as THREE from 'three';

const DOWN = new THREE.Vector3(0, -1, 0);
const UPV = new THREE.Vector3(0, 1, 0);

export class TouristGround {
  /**
   * @param {object} o
   * @param {{raycast(ray: THREE.Raycaster, hits: THREE.Intersection[]): void}} o.tiles
   * @param {number} o.probeUp   metres above the bike (and above the anchor plane) the probe starts
   * @param {number} o.probeRay  metres of reach below the bike
   * @param {object} o.tune      TOURIST_TUNE (wheelOffset, groundLerp, ground.*)
   */
  constructor({ tiles, probeUp, probeRay, tune }) {
    this.tiles = tiles;
    this.probeUp = probeUp;
    this.probeRay = probeRay;
    this.tune = tune;

    this._raycaster = new THREE.Raycaster();
    this._raycaster.firstHitOnly = false;
    this._ceilRay = new THREE.Raycaster();
    this._ceilRay.firstHitOnly = true;
    this._fwdRay = new THREE.Raycaster();   // #402 §3: what is just ahead of the bike
    this._fwdRay.firstHitOnly = true;
    this._topRay = new THREE.Raycaster();   // …and how tall it is
    this._topRay.firstHitOnly = false;
    this._tmpDir = new THREE.Vector3();
    this._tmpOrigin = new THREE.Vector3();
    this._tmpNormalMat = new THREE.Matrix3();
    this._tmpNormal = new THREE.Vector3();

    /** Bike origin height (surface + wheelOffset), eased. */
    this.groundY = tune.wheelOffset;
    /** True once a hit has ever been accepted. */
    this.hasGround = false;
    /**
     * Settling: from the first hit until the bike rides off. The first geometry to arrive at a place
     * is coarse, and can sit hundreds of metres above or below the street (London came in 340 m high,
     * Tokyo 350 m low, measured 2026-11-17). Taking that first hit as the ground left the bike in the
     * sky or under the city, because the steady-state window then held it there. While settling, every
     * frame chooses again as a spawn would, so the bike follows the ground down (or up) to the street
     * as the detail streams in.
     */
    this.settling = true;
    /** Seconds the chosen height has held still (within settleTolerance) while settling. */
    this.stableFor = 0;
    /** Where the ground is KNOWN to be (a measured place), as a local height: while arriving, a surface
     *  far from it (the water under a bridge whose deck has not loaded yet) is stood on but not trusted. */
    this.expectY = null;
    this._settleX = 0; this._settleZ = 0;
    this._settleFor = 0;
    /** World-space normal of the last accepted face (upward-facing). */
    this.normal = new THREE.Vector3(0, 1, 0);
    /** Seconds since the probe last hit ANYTHING (coverage notice). */
    this.noHitElapsed = 0;
    /** Seconds since a hit was last ACCEPTED (resnap trigger). */
    this.noGroundElapsed = 0;
    /** Last accepted surface point: the step window is measured from here. */
    this._refX = 0; this._refY = 0; this._refZ = 0;
    /** @type {{x:number,y:number,z:number}[]} accepted ground points, oldest first */
    this.breadcrumbs = [];
    this._resnapTries = 0;
    /**
     * #402 §3 · set by the last step() when a wall/trunk/crown is right ahead:
     * {distance, point, top} — the world turns it into a tree-collision hit.
     * @type {{distance:number, point:THREE.Vector3, top:number|null}|null}
     */
    this.bump = null;
    /** A low obstacle ahead (car, kerb, hedge) the step window may climb onto. */
    this._rideOver = null;
    /**
     * #801 · a wall is coming: something too tall to ride over, wide enough to count, further off than
     * a bump. {distance, point} — the world marks it and the game sounds the warning.
     * @type {{distance:number, point:THREE.Vector3}|null}
     */
    this.warn = null;
    /** #801 · where a thin thing (a pole, a sign) was last met: the bike rides through it. */
    this._thinAt = null;
    this._sideRay = new THREE.Raycaster();
    this._sideRay.firstHitOnly = true;
  }

  /**
   * One frame of ground following. Mutates bikePos.x/z only on a resnap; the
   * caller applies `groundY` to the bike itself.
   * @param {THREE.Vector3} bikePos  live bike position
   * @param {number} dt
   * @param {boolean} tilesStarted  false while tile streaming is still gated (mobile): no-hit time is not counted
   * @param {number} [heading]  bike yaw (x = sin, z = cos); when given, the forward probe runs
   * @param {number} [speed]  bike speed in m/s: how far ahead a wall is worth a warning
   */
  step(bikePos, dt, tilesStarted = true, heading = undefined, speed = 0) {
    const tune = this.tune;
    const g = tune.ground;
    const ray = this._raycaster;

    // #402 §3 · look a few metres ahead BEFORE the ground probe, so a low
    // obstacle it finds widens this frame's step window.
    this.bump = null;
    this.warn = null;
    if (this.hasGround && Number.isFinite(heading)) this._probeAhead(bikePos, heading, g, speed);

    // The ray starts above the bike, but never below the anchor plane + probeUp.
    // Without that floor the probe is a one-way trapdoor: accept one bad hit far
    // below the real ground (a coarse root tile), and the origin drops with the
    // bike until the true surface is ABOVE the ray start — at which point a
    // downward ray can never find it again and the rider is stuck underground
    // forever. Clamping up means the bike can always climb back out.
    const probeTop = Math.max(bikePos.y + this.probeUp, this.probeUp);
    this._tmpOrigin.set(bikePos.x, probeTop, bikePos.z);
    ray.set(this._tmpOrigin, DOWN);
    // Measured from the bike, not the (possibly clamped) ray origin, so the reach
    // below the bike stays constant however far the origin was lifted.
    ray.far = (probeTop - bikePos.y) + this.probeRay;

    // Use the library's own raycast: it transforms the world-space ray into the
    // tiles' (ECEF) coordinate frame via the group transform. Raycasting the tile
    // meshes directly bypasses that and never hits (the meshes live at raw ECEF).
    const hits = [];
    this.tiles.raycast(ray, hits);

    const result = {
      probeTop, hits: hits.length, rejected: 0,
      /** @type {THREE.Intersection|null} */ hit: null,
      /** @type {'crumb'|'fresh'|null} */ resnapped: null,
      /** true when hits existed but none was rideable (wall/roof/ceiling) */
      blocked: false,
    };

    // Candidates: upward-facing hits, annotated with the world-space normal.
    const candidates = [];
    for (const h of hits) {
      const ny = this._worldNormal(h);
      if (ny < g.minNormalY) { result.rejected++; continue; }
      candidates.push(h);
    }

    const ease = Math.min(1, tune.groundLerp * dt);
    let chosen = null;

    // riding off ends the settling (and so does a long wait: something is better than nothing)
    if (this.settling && this.hasGround) {
      this._settleFor += dt;
      const moved = Math.hypot(bikePos.x - this._settleX, bikePos.z - this._settleZ);
      const maxS = this.expectY != null ? (g.settleExpectMaxS || 20) : (g.settleMaxS || 30);
      if (moved > (g.settleLeaveM || 4) || this._settleFor > maxS) this.settling = false;
    }

    if (candidates.length && (!this.hasGround || this.settling)) {
      chosen = this._pickExpected(candidates, g) || this._pickSpawn(candidates, g);
    } else if (candidates.length) {
      chosen = this._pickStep(candidates, bikePos, g);
      result.rejected += candidates.length - (chosen ? 1 : 0);
    }

    if (chosen) {
      result.hit = chosen;
      const targetY = chosen.point.y + tune.wheelOffset;
      // First hit SNAPS rather than eases: this is the moment the real surface
      // height becomes known, and for a custom location it can be a kilometre
      // from the guessed anchor — easing that would be a long visible fall.
      // It also means the anchor height never has to be looked up or tuned.
      if (!this.hasGround) {
        this.groundY = targetY;
        this._settleX = bikePos.x; this._settleZ = bikePos.z;
        this.stableFor = 0;
      } else if (this.settling) {
        // still arriving: go where the ground is now, and count how long it has held still
        const moved = Math.abs(targetY - this.groundY);
        const off = this.expectY != null && this._settleFor < (g.settleExpectMaxS || 20) && Math.abs(targetY - this.expectY) > (g.expectTolerance || 25);
        this.stableFor = (moved > (g.settleTolerance || 1.5) || off) ? 0 : this.stableFor + dt;
        this.groundY = targetY;
      } else this.groundY += (targetY - this.groundY) * ease;
      this.hasGround = true;
      if (chosen.face) { this._worldNormal(chosen); this.normal.copy(this._tmpNormal); }
      this._refX = bikePos.x; this._refY = chosen.point.y; this._refZ = bikePos.z;
      this.noHitElapsed = 0;
      this.noGroundElapsed = 0;
      this._resnapTries = 0;
      this._dropCrumb(bikePos.x, chosen.point.y, bikePos.z, g);
      return result;
    }

    // Nothing accepted this frame. Hold the last height (tiles stream in and
    // out, so a single frame means little) and count how long this has lasted.
    // Gated on tilesStarted so the mobile tile-gate wait never counts.
    if (!tilesStarted) return result;
    this.noGroundElapsed += dt;
    if (hits.length) result.blocked = true;
    else this.noHitElapsed += dt;
    if (!this.hasGround) return result;   // nothing to fall back to yet

    // Inside geometry? Either an upward ray meets an underside just overhead
    // (double-sided meshes), or the downward probe's nearest surface is only a
    // few metres above the bike with no rideable ground under it (single-sided
    // meshes, which is what Google ships: from inside a closed shell an upward
    // ray only sees back faces, but the roof top is still a downward hit).
    // (a thin thing being ridden through has sides overhead: that is not being inside a building)
    const thin = !!this._thinAt && Math.hypot(bikePos.x - this._thinAt.x, bikePos.z - this._thinAt.z) < (g.thinPassM || 2.5);
    if (this._thinAt && !thin) this._thinAt = null;
    const ceiling = !thin && hits.length && (this._ceilingAbove(bikePos, g) ||
      hits.some((h) => h.point.y > bikePos.y + g.ceilingClearance &&
                       h.point.y < bikePos.y + g.ceilingProbe));

    if (ceiling || this.noGroundElapsed > g.resnapAfter) {
      result.resnapped = this._resnap(bikePos, g);
      if (hits.length) result.blocked = true;
    }
    return result;
  }

  /** Has the ground under the bike been found and stopped moving (detail has streamed in)? */
  get ready() {
    return this.hasGround && (!this.settling || this.stableFor >= (this.tune.ground.settleStableS || 1.0));
  }

  /**
   * A measured place: the surface nearest the height that was measured there, if one is within
   * expectTolerance of it. (On a bridge the usual spawn rule, the lowest of the top cluster, is the water.)
   */
  _pickExpected(candidates, g) {
    if (this.expectY == null) return null;
    const want = this.expectY - this.tune.wheelOffset, tol = g.expectTolerance || 25;
    let chosen = null, best = tol;
    for (const h of candidates) { const d = Math.abs(h.point.y - want); if (d <= best) { best = d; chosen = h; } }
    return chosen;
  }

  /**
   * First acceptance (no ground known yet). Snap, and prefer the LOWEST
   * upward-facing hit in the cluster just below the highest one, so spawning
   * under a street tree lands on the street rather than the crown.
   *
   * Why a cluster and not simply the lowest hit: the coarse root tiles that
   * stream first sag KILOMETRES below the true surface (see tourist-config.js).
   * For an anchored origin the tight probe window keeps them out of reach, but
   * a blind-guess anchor widens that window and both the true surface and a
   * root tile can be in the same frame's hits — picking the lowest would snap
   * the bike kilometres underground. Roofs and crowns, by contrast, sit tens of
   * metres above the street, so "lowest within spawnClusterDepth of the highest"
   * finds the street while a hit far below the anchor plane is left alone.
   * If the ONLY hit in range is a root tile, it is accepted as today (there is
   * nothing better to know yet) and the resnap/fresh-snap path below recovers
   * once the real surface streams in — the ray start clamps to the anchor plane
   * + probeUp, so that surface is always within reach.
   */
  _pickSpawn(candidates, g) {
    let top = -Infinity;
    for (const h of candidates) if (h.point.y > top) top = h.point.y;
    let chosen = null;
    for (const h of candidates) {
      if (h.point.y < top - g.spawnClusterDepth) continue;
      if (!chosen || h.point.y < chosen.point.y) chosen = h;
    }
    return chosen;
  }

  /**
   * Steady state: the window is measured from the last accepted ground point,
   * widening with HORIZONTAL distance travelled since then. Rise is tight (a
   * 1:2 ramp at most, hard-capped so a long wall never grows the window up to a
   * roof); drop is generous (slopes, riding off a roof or kerb) but capped so a
   * coarse tile far below is never taken. Closest to the last height wins.
   */
  _pickStep(candidates, bikePos, g) {
    const travelled = Math.hypot(bikePos.x - this._refX, bikePos.z - this._refZ);
    let maxUp = Math.min(g.stepUpMax, g.stepUpBase + g.stepUpPerMetre * travelled);
    const maxDown = Math.min(g.stepDownMax, g.stepDownBase + g.stepDownPerMetre * travelled);
    // A rideable obstacle was seen ahead: let the window reach its top until
    // the bike has had the chance to roll onto it (then it expires).
    const ro = this._rideOver;
    if (ro) {
      if (Math.hypot(bikePos.x - ro.x, bikePos.z - ro.z) > g.aheadDist * 2) this._rideOver = null;
      else maxUp = Math.max(maxUp, ro.top - this._refY + g.stepUpBase);
    }
    let chosen = null, best = Infinity;
    for (const h of candidates) {
      const dy = h.point.y - this._refY;
      if (dy > maxUp || dy < -maxDown) continue;
      const d = Math.abs(dy);
      if (d < best) { best = d; chosen = h; }
    }
    return chosen;
  }

  /** World-space normal y of a hit; +1 when the hit carries no face. */
  _worldNormal(hit) {
    if (!hit.face) { this._tmpNormal.set(0, 1, 0); return 1; }
    this._tmpNormalMat.getNormalMatrix(hit.object.matrixWorld);
    this._tmpNormal.copy(hit.face.normal).applyMatrix3(this._tmpNormalMat).normalize();
    if (this._tmpNormal.y < 0) this._tmpNormal.negate(); // face upward
    return this._tmpNormal.y;
  }

  /**
   * #402 §3 (Pete, 2026-10-26: "bump off walls and trees, go over cars and
   * smaller shorter meshes"). A short ray runs forward from just above the
   * last accepted ground. If it meets a face within aheadDist, a second ray
   * drops from rideOverHeight above the ground just past that face:
   *   - it finds an upward-facing top (car roof, hedge, kerb, low wall)
   *     → rideable: the step window is allowed up to that top (see _pickStep),
   *       so Y rises onto it and comes back down after;
   *   - it finds nothing (the thing is taller than rideOverHeight: a building
   *     wall, a tree trunk under its crown) and the face is within bumpDist
   *     → a bump: the bike is pushed back to bumpDist + bumpClearance and
   *       `this.bump` is set for the world's checkTreeCollision.
   * The forward ray starts forwardLift above the ground so kerbs and road
   * texture never register, and runs at the last ACCEPTED height so a bike
   * already on a car roof probes from the roof.
   */
  _probeAhead(bikePos, heading, g, speed = 0) {
    const sx = Math.sin(heading), cz = Math.cos(heading);
    this._tmpDir.set(sx, 0, cz);
    this._tmpOrigin.set(bikePos.x, this._refY + g.forwardLift, bikePos.z);
    this._fwdRay.set(this._tmpOrigin, this._tmpDir);
    // #801: look further the faster the bike goes, so a wall is announced warnSeconds before it
    this._fwdRay.far = Math.max(g.aheadDist, Math.min(g.warnMaxDist || 0, (speed || 0) * (g.warnSeconds || 0)));
    const ahead = [];
    this.tiles.raycast(this._fwdRay, ahead);
    if (!ahead.length) return;
    let near = ahead[0];
    for (const h of ahead) if (h.distance < near.distance) near = h;

    // How tall is it? Probe straight down just past the face.
    const px = near.point.x + sx * g.aheadStepIn, pz = near.point.z + cz * g.aheadStepIn;
    this._tmpOrigin.set(px, this._refY + g.rideOverHeight, pz);
    this._topRay.set(this._tmpOrigin, DOWN);
    this._topRay.far = g.rideOverHeight + g.stepDownBase;
    const tops = [];
    this.tiles.raycast(this._topRay, tops);
    let top = null;
    for (const h of tops) {
      if (this._worldNormal(h) < g.minNormalY) continue;
      if (top === null || h.point.y > top) top = h.point.y;
    }

    if (top !== null) {
      // Rideable (or thinner than aheadStepIn, in which case the ground beyond
      // is the top and the bike simply rolls through it).
      if (near.distance <= g.aheadDist) this._rideOver = { x: bikePos.x, z: bikePos.z, top };
      return;
    }
    // #801 (Pete, 2026-11-18): thin things are ridden through. A pole or a sign is a spike in the mesh,
    // and nobody steering down a street expects one to count as a wall.
    if (this._isThin(bikePos, near, sx, cz, g)) {
      if (near.distance <= g.aheadDist) this._thinAt = { x: near.point.x, z: near.point.z };
      return;
    }
    if (near.distance > g.bumpDist) {         // too tall, but not close yet: say so
      this.warn = { distance: near.distance, point: near.point };
      return;
    }
    const back = (g.bumpDist + g.bumpClearance) - near.distance;
    bikePos.x -= sx * back;
    bikePos.z -= cz * back;
    this.bump = { distance: near.distance, point: near.point, top };
  }

  /**
   * Is the thing the forward ray met narrow? Two more rays run alongside, thinHalfWidth to each side.
   * If neither meets anything by a little past the face, it is a pole, a sign or a sapling.
   */
  _isThin(bikePos, near, sx, cz, g) {
    const w = g.thinHalfWidth || 0;
    if (!(w > 0)) return false;
    for (const side of [1, -1]) {
      this._tmpOrigin.set(bikePos.x + cz * w * side, this._refY + g.forwardLift, bikePos.z - sx * w * side);
      this._sideRay.set(this._tmpOrigin, this._tmpDir);
      this._sideRay.far = near.distance + (g.thinDepth || 1);
      const hits = [];
      this.tiles.raycast(this._sideRay, hits);
      if (hits.length) return false;
    }
    return true;
  }

  /**
   * #801 (Pete, 2026-11-18: "take them back 5 m before the crash"). Where the bike stands up after a
   * crash at (x, z): backM back along the trail it rode in on, facing the way it was going. If a wall
   * is right in front of that spot, it goes further back until the way is clear (or the trail ends).
   * The trail past the spot is dropped, so nothing later puts the bike back at the wall.
   * @returns {{x:number, y:number, z:number, heading:number}|null}  null when there is no trail
   */
  recoverySpot(x, z, backM, g = this.tune.ground) {
    const trail = this.breadcrumbs;
    if (!trail.length) return null;
    // the way back: the crash point, then the crumbs, newest first
    const path = [{ x, y: this._refY, z }];
    for (let i = trail.length - 1; i >= 0; i--) path.push(trail[i]);
    let want = backM, spot = null;
    for (let tries = 0; tries < 6 && !spot; tries++) {
      const at = this._alongPath(path, want);
      if (at.end || !this._wallAhead(at, g)) spot = at;
      else want += g.breadcrumbSpacing;
    }
    if (!spot) spot = this._alongPath(path, want);
    while (trail.length > 1 && trail.length > spot.left) trail.pop();
    this._refX = spot.x; this._refY = spot.y; this._refZ = spot.z;
    this.groundY = spot.y + this.tune.wheelOffset;
    this.noGroundElapsed = 0;
    this._resnapTries = 0;
    this._rideOver = null;
    this._thinAt = null;
    this.bump = null;
    this.warn = null;
    return { x: spot.x, y: spot.y, z: spot.z, heading: spot.heading };
  }

  /** The point `metres` along a path (newest first), the heading the bike had there, and how many crumbs are behind it. */
  _alongPath(path, metres) {
    let left = metres;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d <= 0) continue;
      const heading = Math.atan2(a.x - b.x, a.z - b.z);   // riding from b toward a
      if (left <= d) {
        const t = left / d;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, heading, end: false, left: path.length - 1 - i };
      }
      left -= d;
    }
    const last = path[path.length - 1], prev = path[path.length - 2];
    const heading = prev && Math.hypot(prev.x - last.x, prev.z - last.z) > 0 ? Math.atan2(prev.x - last.x, prev.z - last.z) : 0;
    return { x: last.x, y: last.y, z: last.z, heading, end: true, left: 1 };
  }

  /** Is there something too tall to ride over within recoverClearM of a spot, the way it faces? */
  _wallAhead(spot, g) {
    const sx = Math.sin(spot.heading), cz = Math.cos(spot.heading);
    this._tmpDir.set(sx, 0, cz);
    this._tmpOrigin.set(spot.x, spot.y + g.forwardLift, spot.z);
    this._fwdRay.set(this._tmpOrigin, this._tmpDir);
    this._fwdRay.far = g.recoverClearM || 3;
    const ahead = [];
    this.tiles.raycast(this._fwdRay, ahead);
    if (!ahead.length) return false;
    let near = ahead[0];
    for (const h of ahead) if (h.distance < near.distance) near = h;
    this._tmpOrigin.set(near.point.x + sx * g.aheadStepIn, spot.y + g.rideOverHeight, near.point.z + cz * g.aheadStepIn);
    this._topRay.set(this._tmpOrigin, DOWN);
    this._topRay.far = g.rideOverHeight + g.stepDownBase;
    const tops = [];
    this.tiles.raycast(this._topRay, tops);
    for (const h of tops) if (this._worldNormal(h) >= g.minNormalY) return false;
    return true;
  }

  _ceilingAbove(bikePos, g) {
    this._tmpOrigin.set(bikePos.x, this.groundY + g.ceilingClearance, bikePos.z);
    this._ceilRay.set(this._tmpOrigin, UPV);
    this._ceilRay.far = g.ceilingProbe;
    const hits = [];
    this.tiles.raycast(this._ceilRay, hits);
    return hits.length > 0;
  }

  _dropCrumb(x, y, z, g) {
    const last = this.breadcrumbs[this.breadcrumbs.length - 1];
    if (last && Math.hypot(x - last.x, z - last.z) < g.breadcrumbSpacing) return;
    this.breadcrumbs.push({ x, y, z });
    if (this.breadcrumbs.length > g.breadcrumbMax) this.breadcrumbs.shift();
  }

  /**
   * Put the bike back on the last breadcrumb. A resnap that itself finds no
   * ground before the next timeout drops that crumb and tries the one before;
   * after resnapMaxTries the trail is treated as stale (the tiles under it have
   * changed) and the next frame snaps fresh, exactly like the first hit.
   */
  _resnap(bikePos, g) {
    this.noGroundElapsed = 0;
    if (this._resnapTries > 0 && this.breadcrumbs.length > 1) this.breadcrumbs.pop();
    const crumb = this.breadcrumbs[this.breadcrumbs.length - 1];
    if (!crumb || this._resnapTries >= g.resnapMaxTries) {
      this.hasGround = false;
      this.breadcrumbs.length = 0;
      this._resnapTries = 0;
      return 'fresh';
    }
    this._resnapTries++;
    bikePos.x = crumb.x; bikePos.z = crumb.z;
    this._refX = crumb.x; this._refY = crumb.y; this._refZ = crumb.z;
    this.groundY = crumb.y + this.tune.wheelOffset;
    return 'crumb';
  }
}
