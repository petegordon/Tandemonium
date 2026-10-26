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
    this._tmpOrigin = new THREE.Vector3();
    this._tmpNormalMat = new THREE.Matrix3();
    this._tmpNormal = new THREE.Vector3();

    /** Bike origin height (surface + wheelOffset), eased. */
    this.groundY = tune.wheelOffset;
    /** True once a hit has ever been accepted. */
    this.hasGround = false;
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
  }

  /**
   * One frame of ground following. Mutates bikePos.x/z only on a resnap; the
   * caller applies `groundY` to the bike itself.
   * @param {THREE.Vector3} bikePos  live bike position
   * @param {number} dt
   * @param {boolean} tilesStarted  false while tile streaming is still gated (mobile): no-hit time is not counted
   */
  step(bikePos, dt, tilesStarted = true) {
    const tune = this.tune;
    const g = tune.ground;
    const ray = this._raycaster;

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

    if (candidates.length && !this.hasGround) {
      chosen = this._pickSpawn(candidates, g);
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
      if (!this.hasGround) this.groundY = targetY;
      else this.groundY += (targetY - this.groundY) * ease;
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
    const ceiling = hits.length && (this._ceilingAbove(bikePos, g) ||
      hits.some((h) => h.point.y > bikePos.y + g.ceilingClearance &&
                       h.point.y < bikePos.y + g.ceilingProbe));

    if (ceiling || this.noGroundElapsed > g.resnapAfter) {
      result.resnapped = this._resnap(bikePos, g);
      if (hits.length) result.blocked = true;
    }
    return result;
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
    const maxUp = Math.min(g.stepUpMax, g.stepUpBase + g.stepUpPerMetre * travelled);
    const maxDown = Math.min(g.stepDownMax, g.stepDownBase + g.stepDownPerMetre * travelled);
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
