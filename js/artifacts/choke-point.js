// ============================================================
// CHOKE POINT — two opposing scenery blocks bordering a `gap` lane.
// Crash on contact (or scrape = slow, if mode==='scrape').
// ============================================================

import * as THREE from 'three';
import { roadFrame, inVisibilityWindow, pointInRoadRect, circleHit } from './artifact-base.js';

const BIKE_RADIUS = 0.45;

function makeSideMesh(skin, width, depth) {
  // Both sides are a stack of 2 boxes for "haystack" look, or a single box for "barrier".
  const grp = new THREE.Group();
  if (skin === 'barrier') {
    const geo = new THREE.BoxGeometry(width, 0.9, depth);
    const mat = new THREE.MeshLambertMaterial({ color: 0xc0392b });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = 0.45;
    grp.add(m);
    // White stripes
    const stripeGeo = new THREE.BoxGeometry(width * 1.02, 0.18, depth * 1.02);
    const stripeMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const s = new THREE.Mesh(stripeGeo, stripeMat);
    s.position.y = 0.6;
    grp.add(s);
  } else if (skin === 'statue') {
    const geo = new THREE.BoxGeometry(width, 1.6, depth);
    const mat = new THREE.MeshLambertMaterial({ color: 0x8d8d8d });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = 0.8;
    grp.add(m);
  } else {
    // haystack (default): two stacked cylinders, golden
    const matH = new THREE.MeshLambertMaterial({ color: 0xc9a23a });
    const lower = new THREE.Mesh(new THREE.CylinderGeometry(width * 0.55, width * 0.55, 0.6, 12), matH);
    lower.position.y = 0.3;
    grp.add(lower);
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(width * 0.45, width * 0.45, 0.5, 12), matH);
    upper.position.y = 0.85;
    grp.add(upper);
  }
  return grp;
}

export class ChokePoint {
  constructor(scene, roadPath, params) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.p = params;

    const ROAD_HW = 2.5;
    const halfGap = params.gap / 2;
    const sideInnerEdge = (params.offset || 0); // center of gap
    // Each side block fills from inner edge to road edge
    this._sideAWidth = Math.max(0.4, (ROAD_HW + (sideInnerEdge - halfGap)));
    this._sideBWidth = Math.max(0.4, (ROAD_HW - (sideInnerEdge + halfGap)));
    this._sideAOffset = (sideInnerEdge - halfGap) - this._sideAWidth / 2;
    this._sideBOffset = (sideInnerEdge + halfGap) + this._sideBWidth / 2;

    this.groupA = makeSideMesh(params.skin, this._sideAWidth, params.depth);
    this.groupB = makeSideMesh(params.skin, this._sideBWidth, params.depth);
    this.groupA.visible = false;
    this.groupB.visible = false;
    scene.add(this.groupA);
    scene.add(this.groupB);

    // Track per-crossing so the same artifact doesn't re-trigger every frame
    this._lastTriggerFrame = -1;
  }

  update(dt, bikeDistanceTraveled, bikePos) {
    const visible = inVisibilityWindow(this.p.d, bikeDistanceTraveled);
    this.groupA.visible = visible;
    this.groupB.visible = visible;
    if (!visible) return;
    const fA = roadFrame(this.roadPath, this.p.d, this._sideAOffset);
    const fB = roadFrame(this.roadPath, this.p.d, this._sideBOffset);
    this.groupA.position.set(fA.x, fA.y, fA.z);
    this.groupA.rotation.y = fA.heading;
    this.groupB.position.set(fB.x, fB.y, fB.z);
    this.groupB.rotation.y = fB.heading;
  }

  /** Returns 'crash' | 'scrape' | null when bike enters a side block. */
  checkCollision(bikePos) {
    const hitA = pointInRoadRect(this.roadPath, this.p.d, this._sideAOffset,
                                 this._sideAWidth + BIKE_RADIUS * 2, this.p.depth + BIKE_RADIUS * 2, bikePos);
    const hitB = pointInRoadRect(this.roadPath, this.p.d, this._sideBOffset,
                                 this._sideBWidth + BIKE_RADIUS * 2, this.p.depth + BIKE_RADIUS * 2, bikePos);
    if (!hitA && !hitB) return null;
    return this.p.mode === 'scrape' ? 'scrape' : 'crash';
  }

  /**
   * Called by manager if mode==='scrape' and bike is intersecting.
   * Hard-wall pushback: clamps the bike laterally so it can't penetrate the
   * side block, then drags speed so scraping costs real momentum.
   */
  applyScrape(bike, bikePos, dt) {
    const halfGap = this.p.gap / 2;
    const sideInner = (this.p.offset || 0);
    const innerA = sideInner - halfGap; // right edge of left block (faces gap)
    const innerB = sideInner + halfGap; // left edge of right block (faces gap)

    const f = roadFrame(this.roadPath, this.p.d, 0);
    const dx = bikePos.x - f.x;
    const dz = bikePos.z - f.z;
    const lat = dx * f.rightX + dz * f.rightZ;
    const along = dx * f.forwardX + dz * f.forwardZ;

    // Only push laterally if we're actually within the block's depth window
    if (Math.abs(along) <= this.p.depth / 2 + BIKE_RADIUS) {
      const EPS = 0.05; // small buffer so the bike pops out of the inflated rect
      let push = 0;
      if (lat - BIKE_RADIUS < innerA) {
        push = (innerA + BIKE_RADIUS + EPS) - lat;     // push toward +lat (right)
      } else if (lat + BIKE_RADIUS > innerB) {
        push = (innerB - BIKE_RADIUS - EPS) - lat;     // push toward -lat (left)
      }
      if (push !== 0) {
        bike.position.x += push * f.rightX;
        bike.position.z += push * f.rightZ;
        // Dampen the lean that drove the bike into the wall, so it doesn't
        // instantly squish back in next frame.
        bike.leanVelocity *= 0.4;
      }
    }
    // Strong drag while scraping
    bike.speed *= Math.max(0, 1 - 5.0 * dt);
  }

  destroy() {
    for (const grp of [this.groupA, this.groupB]) {
      this.scene.remove(grp);
      grp.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
  }
}
