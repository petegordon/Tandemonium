// ============================================================
// ARCH INDICATOR — polished radial gauge with band arch + tapered needles
// ============================================================

import * as THREE from 'three';
import { BALANCE_DEFAULTS } from './config.js';

const ARCH_RADIUS = 3.0;
const ARCH_BAND_WIDTH = 0.35;       // width of the gauge band
const ARCH_INNER = ARCH_RADIUS - ARCH_BAND_WIDTH / 2;
const ARCH_OUTER = ARCH_RADIUS + ARCH_BAND_WIDTH / 2;
const ARCH_EDGE_RADIUS = 0.025;     // thin edge tubes
const ARCH_BASE_Y = 0.3;
const ARCH_SEGMENTS = 48;

const NEEDLE_LENGTH = ARCH_RADIUS * 0.92;
const NEEDLE_BASE_WIDTH = 0.10;     // wider at pivot
const NEEDLE_TIP_WIDTH = 0.025;     // tapered tip

// Derive sweep from sensitivity (degrees → radians)
const LEAN_SCALE = BALANCE_DEFAULTS.sensitivity * Math.PI / 180;
const ARCH_MARGIN = 0.08;           // small pad beyond max needle travel
// Arch spans from (90° - sweep - margin) to (90° + sweep + margin)
const ARCH_START = Math.PI / 2 - LEAN_SCALE - ARCH_MARGIN;
const ARCH_END   = Math.PI / 2 + LEAN_SCALE + ARCH_MARGIN;
const ARCH_SPAN  = ARCH_END - ARCH_START;

export class ArchIndicator {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.scene.add(this.group);

    this._archParts = [];   // all arch meshes for disposal
    this._playerNeedle = null;
    this._partnerNeedle = null;
    this._visible = false;
    this._mode = 'solo';

    this._buildArch();
  }

  // ----------------------------------------------------------
  // Arch — two edge tubes + translucent band fill between them
  // ----------------------------------------------------------

  _buildArch() {
    // Shared edge material — subtle, sits in background
    const edgeMat = new THREE.MeshBasicMaterial({
      color: 0x333333,
      opacity: 0.35,
      transparent: true,
      depthWrite: false
    });

    // Inner edge tube
    const innerPts = this._arcPoints(ARCH_INNER);
    const innerCurve = new THREE.CatmullRomCurve3(innerPts);
    const innerGeom = new THREE.TubeGeometry(innerCurve, ARCH_SEGMENTS, ARCH_EDGE_RADIUS, 6, false);
    const innerMesh = new THREE.Mesh(innerGeom, edgeMat);
    this.group.add(innerMesh);
    this._archParts.push(innerMesh);

    // Outer edge tube
    const outerPts = this._arcPoints(ARCH_OUTER);
    const outerCurve = new THREE.CatmullRomCurve3(outerPts);
    const outerGeom = new THREE.TubeGeometry(outerCurve, ARCH_SEGMENTS, ARCH_EDGE_RADIUS, 6, false);
    const outerMesh = new THREE.Mesh(outerGeom, edgeMat.clone());
    this.group.add(outerMesh);
    this._archParts.push(outerMesh);

    // Translucent band fill between inner and outer arcs
    const bandGeom = this._buildBandGeometry();
    const bandMat = new THREE.MeshBasicMaterial({
      color: 0x222222,
      opacity: 0.10,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const bandMesh = new THREE.Mesh(bandGeom, bandMat);
    this.group.add(bandMesh);
    this._archParts.push(bandMesh);

    // Tick marks at center (12 o'clock) and quarter positions
    this._addTickMarks(edgeMat);
  }

  _arcPoints(radius) {
    const pts = [];
    for (let i = 0; i <= ARCH_SEGMENTS; i++) {
      const angle = ARCH_START + ARCH_SPAN * (i / ARCH_SEGMENTS);
      pts.push(new THREE.Vector3(
        Math.cos(angle) * radius,
        ARCH_BASE_Y + Math.sin(angle) * radius,
        0
      ));
    }
    return pts;
  }

  _buildBandGeometry() {
    // Triangle strip between inner and outer arcs
    const positions = [];
    const indices = [];
    for (let i = 0; i <= ARCH_SEGMENTS; i++) {
      const angle = ARCH_START + ARCH_SPAN * (i / ARCH_SEGMENTS);
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      // Inner vertex
      positions.push(cosA * ARCH_INNER, ARCH_BASE_Y + sinA * ARCH_INNER, 0);
      // Outer vertex
      positions.push(cosA * ARCH_OUTER, ARCH_BASE_Y + sinA * ARCH_OUTER, 0);
      if (i < ARCH_SEGMENTS) {
        const base = i * 2;
        indices.push(base, base + 1, base + 2);
        indices.push(base + 1, base + 3, base + 2);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
  }

  _addTickMarks(edgeMat) {
    // Tick marks: center, ±25%, ±50%, ±75%, ±100% of max lean
    const tickOffsets = [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1.0, -1.0];
    const tickLengths = [0.20, 0.08, 0.08, 0.10, 0.10, 0.08, 0.08, 0.14, 0.14];
    const tickAngles = tickOffsets.map(f => Math.PI / 2 + f * LEAN_SCALE);

    for (let t = 0; t < tickAngles.length; t++) {
      const angle = tickAngles[t];
      const len = tickLengths[t];
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      const midR = ARCH_RADIUS;
      const cx = cosA * midR;
      const cy = ARCH_BASE_Y + sinA * midR;

      const geom = new THREE.BoxGeometry(0.02, len, 0.02);
      // Rotate tick to be radial (perpendicular to arc)
      const tickMesh = new THREE.Mesh(geom, edgeMat.clone());
      tickMesh.position.set(cx, cy, 0);
      tickMesh.rotation.z = angle - Math.PI / 2; // align radially
      this.group.add(tickMesh);
      this._archParts.push(tickMesh);
    }
  }

  // ----------------------------------------------------------
  // Tapered radial needle — wide at pivot, narrow at tip
  // ----------------------------------------------------------

  _buildNeedle(color, opacity, labelText, labelY) {
    const needleGroup = new THREE.Group();

    // Tapered needle using CylinderGeometry (radiusTop, radiusBottom, height)
    // Bottom = pivot (wider), Top = tip (narrow)
    const geom = new THREE.CylinderGeometry(
      NEEDLE_TIP_WIDTH / 2,   // top radius (tip)
      NEEDLE_BASE_WIDTH / 2,  // bottom radius (pivot)
      NEEDLE_LENGTH,
      6                        // radial segments
    );
    // Shift geometry up so bottom is at origin (pivot point)
    geom.translate(0, NEEDLE_LENGTH / 2, 0);

    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      opacity: opacity,
      transparent: true,
      depthWrite: false
    });
    const needleMesh = new THREE.Mesh(geom, mat);
    needleGroup.add(needleMesh);

    // Small pivot hub circle at the base
    const hubGeom = new THREE.SphereGeometry(0.08, 8, 8);
    const hubMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      opacity: Math.min(opacity + 0.1, 1.0),
      transparent: true,
      depthWrite: false
    });
    const hubMesh = new THREE.Mesh(hubGeom, hubMat);
    needleGroup.add(hubMesh);

    // Label sprite — matches needle opacity
    const label = this._buildLabel(labelText, color, opacity);
    label.position.set(0, labelY, 0);
    needleGroup.add(label);

    // Pivot at arch center
    needleGroup.position.set(0, ARCH_BASE_Y, 0);

    return needleGroup;
  }

  // ----------------------------------------------------------
  // Text label — canvas-texture sprite
  // ----------------------------------------------------------

  _buildLabel(text, color, opacity = 1.0) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    ctx.font = 'bold 36px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Black stroke outline for readability
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 5;
    ctx.strokeText(text, 128, 32);

    // Fill with player color
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 32);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      opacity: opacity,
      transparent: true,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.0, 0.5, 1);
    return sprite;
  }

  // ----------------------------------------------------------
  // Setup — called at countdown start
  // ----------------------------------------------------------

  setup(mode, playerColor, partnerColor) {
    this._clearNeedles();
    this._mode = mode;

    const isMultiplayer = (mode === 'captain' || mode === 'stoker');
    const playerRole = mode === 'captain' ? 'YOU CAPTAIN' : mode === 'stoker' ? 'YOU STOKER' : 'YOU';
    const partnerRole = mode === 'captain' ? 'STOKER' : 'CAPTAIN';

    // Player needle — label on inner (bottom) edge of arch
    this._playerNeedle = this._buildNeedle(playerColor, 0.75, playerRole, ARCH_INNER - 0.35);
    this.group.add(this._playerNeedle);

    // Partner needle — label on outer (top) edge of arch
    if (isMultiplayer) {
      this._partnerNeedle = this._buildNeedle(partnerColor, 0.6, partnerRole, ARCH_OUTER + 0.35);
      this.group.add(this._partnerNeedle);
    }

    this.group.visible = true;
    this._visible = true;
  }

  // ----------------------------------------------------------
  // Per-frame update
  // ----------------------------------------------------------

  update(bike, playerLean, partnerLean) {
    if (!this._visible) return;

    // Position at bike location
    this.group.position.copy(bike.position);

    // Orient with yaw + pitch only (NO lean — arch stays upright)
    const qYaw = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), bike.heading
    );
    const qPitch = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), bike._smoothPitch
    );
    const q = new THREE.Quaternion();
    q.multiplyQuaternions(qYaw, qPitch);
    this.group.quaternion.copy(q);

    // Rotate player needle — 0 = straight up, lean left tilts needle left
    if (this._playerNeedle) {
      this._playerNeedle.rotation.z = (playerLean || 0) * LEAN_SCALE;
    }

    // Rotate partner needle
    if (this._partnerNeedle) {
      this._partnerNeedle.rotation.z = (partnerLean || 0) * LEAN_SCALE;
    }
  }

  // ----------------------------------------------------------
  // Update partner color (when profile received)
  // ----------------------------------------------------------

  updatePartnerColor(color) {
    if (!this._partnerNeedle) return;

    // Update needle mesh material (child 0)
    const needleMesh = this._partnerNeedle.children[0];
    if (needleMesh && needleMesh.material) needleMesh.material.color.set(color);

    // Update hub mesh material (child 1)
    const hubMesh = this._partnerNeedle.children[1];
    if (hubMesh && hubMesh.material) hubMesh.material.color.set(color);

    // Rebuild label sprite with new color (child 2)
    const oldLabel = this._partnerNeedle.children[2];
    if (oldLabel) {
      this._partnerNeedle.remove(oldLabel);
      this._disposeSprite(oldLabel);
    }
    const partnerRole = this._mode === 'captain' ? 'STOKER' : 'CAPTAIN';
    const partnerOpacity = needleMesh ? needleMesh.material.opacity : 0.2;
    const newLabel = this._buildLabel(partnerRole, color, partnerOpacity);
    newLabel.position.set(0, ARCH_OUTER + 0.35, 0);
    this._partnerNeedle.add(newLabel);
  }

  // ----------------------------------------------------------
  // Hide / Destroy
  // ----------------------------------------------------------

  hide() {
    this.group.visible = false;
    this._visible = false;
    this._clearNeedles();
  }

  _clearNeedles() {
    if (this._playerNeedle) {
      this._disposeGroup(this._playerNeedle);
      this.group.remove(this._playerNeedle);
      this._playerNeedle = null;
    }
    if (this._partnerNeedle) {
      this._disposeGroup(this._partnerNeedle);
      this.group.remove(this._partnerNeedle);
      this._partnerNeedle = null;
    }
  }

  _disposeGroup(grp) {
    grp.children.forEach(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (c.material.map) c.material.map.dispose();
        c.material.dispose();
      }
    });
  }

  _disposeSprite(sprite) {
    if (sprite.material.map) sprite.material.map.dispose();
    if (sprite.material) sprite.material.dispose();
  }

  destroy() {
    this.hide();
    for (const part of this._archParts) {
      if (part.geometry) part.geometry.dispose();
      if (part.material) part.material.dispose();
    }
    this._archParts.length = 0;
    this.scene.remove(this.group);
  }
}
