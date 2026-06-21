// ============================================================
// DRAWBRIDGE — two hinged planks that lift/lower on a fixed cycle.
// State is derived from race-clock time (race.startTime), so both
// Captain and Stoker clients render the same state with no sync.
// ============================================================

import * as THREE from 'three';
import { roadFrame, inVisibilityWindow } from './artifact-base.js';

const ROAD_HW = 2.5;
const PLANK_LEN = 3.0; // each plank length
const PLANK_THICK = 0.2;
const BIKE_RADIUS = 0.45;

function makePlank(skin) {
  const color = skin === 'stone' ? 0x9a9a9a : 0x7b4b2a;
  const mat = new THREE.MeshLambertMaterial({ color });
  const geo = new THREE.BoxGeometry(ROAD_HW * 2, PLANK_THICK, PLANK_LEN);
  return new THREE.Mesh(geo, mat);
}

export class Drawbridge {
  constructor(scene, roadPath, params) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.p = params;

    // Pivot groups (hinges at outer edges of the bridge gap)
    this.pivotA = new THREE.Group();
    this.pivotB = new THREE.Group();
    const plankA = makePlank(params.skin);
    plankA.position.z = -PLANK_LEN / 2;
    this.pivotA.add(plankA);
    const plankB = makePlank(params.skin);
    plankB.position.z = PLANK_LEN / 2;
    this.pivotB.add(plankB);

    // Warning paint stripes on the road approach
    const warnTex = this._makeWarnTexture();
    const warnGeo = new THREE.PlaneGeometry(ROAD_HW * 2, PLANK_LEN);
    const warnMat = new THREE.MeshBasicMaterial({ map: warnTex, transparent: true, opacity: 0.7, depthWrite: false });
    this.warnMesh = new THREE.Mesh(warnGeo, warnMat);
    this.warnMesh.rotation.x = -Math.PI / 2;
    this.warnMesh.renderOrder = 1;

    this.pivotA.visible = false;
    this.pivotB.visible = false;
    this.warnMesh.visible = false;
    scene.add(this.pivotA);
    scene.add(this.pivotB);
    scene.add(this.warnMesh);

    this._raceStartTime = 0; // set by manager before first update
    this._warnTex = warnTex;
  }

  setRaceStart(t) { this._raceStartTime = t; }

  _makeWarnTexture() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#1a1a1a';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#ffd33d';
    for (let i = 0; i < 8; i++) {
      g.fillRect(i * 8, 0, 4, 64);
    }
    return new THREE.CanvasTexture(c);
  }

  /**
   * Bridge openness: 0 = fully down (passable), 1 = fully up (wall).
   * Cycle is: downRatio fraction of period fully down, then equal
   * rise / up / fall over the rest.
   */
  _openness(t) {
    const period = this.p.period;
    const phase = ((t + this.p.phase) % period + period) % period;
    const downSec = period * this.p.downRatio;
    const transSec = (period - downSec) / 3;
    if (phase < downSec) return 0;
    const after = phase - downSec;
    if (after < transSec) return after / transSec;          // rising
    if (after < transSec * 2) return 1;                      // fully up
    return 1 - (after - transSec * 2) / transSec;            // falling
  }

  update(dt, bikeDistanceTraveled, bikePos) {
    const visible = inVisibilityWindow(this.p.d, bikeDistanceTraveled);
    this.pivotA.visible = visible;
    this.pivotB.visible = visible;
    this.warnMesh.visible = visible;
    if (!visible) return;

    const f = roadFrame(this.roadPath, this.p.d, 0);
    // Position pivots at the inner edges of the bridge gap (z=±PLANK_LEN/2 in plank-local)
    // ... but in world the hinges sit at d ± PLANK_LEN/2 along the road forward axis.
    const pA = { x: f.x - f.forwardX * (PLANK_LEN / 2), z: f.z - f.forwardZ * (PLANK_LEN / 2) };
    const pB = { x: f.x + f.forwardX * (PLANK_LEN / 2), z: f.z + f.forwardZ * (PLANK_LEN / 2) };
    this.pivotA.position.set(pA.x, f.y + PLANK_THICK / 2, pA.z);
    this.pivotB.position.set(pB.x, f.y + PLANK_THICK / 2, pB.z);
    this.pivotA.rotation.y = f.heading;
    this.pivotB.rotation.y = f.heading;
    this.warnMesh.position.set(f.x, f.y + 0.02, f.z);
    this.warnMesh.rotation.set(-Math.PI / 2, 0, -f.heading);

    // Rotate planks based on openness. Hinge axis is along road's right-vector,
    // i.e. local X after yaw — so rotate on local X.
    const now = performance.now() / 1000;
    const t = this._raceStartTime > 0 ? now - this._raceStartTime : now;
    const o = this._openness(t);
    // A lifts at its inner end (positive Z within group); rotate +X
    // B lifts at its inner end (negative Z within group); rotate -X
    const angle = o * (Math.PI / 2 - 0.05);
    this.pivotA.children[0].rotation.x = -angle;
    this.pivotB.children[0].rotation.x = angle;
    this._currentOpenness = o;
  }

  /** Crash when the bridge is sufficiently up AND bike is in the span. */
  checkCollision(bikePos) {
    if (this._currentOpenness === undefined) return false;
    if (this._currentOpenness < 0.15) return false; // safe to pass
    // bike in span?
    const f = roadFrame(this.roadPath, this.p.d, 0);
    const dx = bikePos.x - f.x;
    const dz = bikePos.z - f.z;
    const along = dx * f.forwardX + dz * f.forwardZ;
    if (Math.abs(along) > PLANK_LEN + BIKE_RADIUS) return false;
    const across = dx * f.rightX + dz * f.rightZ;
    if (Math.abs(across) > ROAD_HW + BIKE_RADIUS) return false;
    return true;
  }

  destroy() {
    for (const grp of [this.pivotA, this.pivotB]) {
      this.scene.remove(grp);
      grp.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    this.scene.remove(this.warnMesh);
    this.warnMesh.geometry.dispose();
    this.warnMesh.material.dispose();
    this._warnTex.dispose();
  }
}
