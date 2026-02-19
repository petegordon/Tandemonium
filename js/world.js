// ============================================================
// WORLD — ground, road, trees, lighting
// ============================================================

import * as THREE from 'three';

export class World {
  constructor(scene) {
    this.scene = scene;
    this._treeMeshes = [];
    this.floor = null;
    this.tileSize = 4;
    this._rngState = 42; // fixed seed for deterministic tree placement
    this._buildGround();
    this._buildRoad();
    this._buildTrees();
    this._buildLighting();
  }

  // Simple seeded PRNG — same seed produces identical trees on all devices
  _seededRandom() {
    this._rngState = (this._rngState * 9301 + 49297) % 233280;
    return this._rngState / 233280;
  }

  _buildGround() {
    const floorSize = 200;
    const tilesPerSide = floorSize / this.tileSize;

    const floorGeom = new THREE.PlaneGeometry(floorSize, floorSize);
    const canvas2d = document.createElement('canvas');
    canvas2d.width = tilesPerSide;
    canvas2d.height = tilesPerSide;
    const ctx = canvas2d.getContext('2d');
    for (let y = 0; y < tilesPerSide; y++) {
      for (let x = 0; x < tilesPerSide; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#5a9a4a' : '#4a8a3a';
        ctx.fillRect(x, y, 1, 1);
      }
    }
    const floorTexture = new THREE.CanvasTexture(canvas2d);
    floorTexture.magFilter = THREE.NearestFilter;
    floorTexture.minFilter = THREE.NearestFilter;
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTexture });
    this.floor = new THREE.Mesh(floorGeom, floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
  }

  _buildRoad() {
    const roadGeo = new THREE.PlaneGeometry(5, 600);
    const roadMat = new THREE.MeshPhongMaterial({ color: 0x555555, flatShading: true });
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.y = 0.02;
    road.receiveShadow = true;
    this.scene.add(road);

    const dashMat = new THREE.MeshPhongMaterial({ color: 0xdddd00, flatShading: true });
    for (let z = -295; z < 300; z += 4) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 1.8), dashMat);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(0, 0.03, z);
      this.scene.add(dash);
    }

    const edgeMat = new THREE.MeshPhongMaterial({ color: 0xffffff, flatShading: true });
    for (const xOff of [-2.3, 2.3]) {
      const edge = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 600), edgeMat);
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(xOff, 0.03, 0);
      this.scene.add(edge);
    }
  }

  _buildTrees() {
    const trunkMat = new THREE.MeshPhongMaterial({ color: 0x7a5230, flatShading: true });
    const leafMat = new THREE.MeshPhongMaterial({ color: 0x2d8a2d, flatShading: true });
    const leafMat2 = new THREE.MeshPhongMaterial({ color: 0x1f7a1f, flatShading: true });

    for (let i = 0; i < 80; i++) {
      const side = this._seededRandom() > 0.5 ? 1 : -1;
      const x = side * (5 + this._seededRandom() * 50);
      const z = (this._seededRandom() - 0.5) * 500;
      const scale = 0.7 + this._seededRandom() * 0.8;

      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12 * scale, 0.18 * scale, 2.0 * scale, 6),
        trunkMat
      );
      trunk.position.set(x, scale, z);
      trunk.castShadow = true;
      this.scene.add(trunk);
      this._treeMeshes.push(trunk);

      const mat = this._seededRandom() > 0.5 ? leafMat : leafMat2;
      const canopy = new THREE.Mesh(
        new THREE.SphereGeometry(1.0 * scale, 6, 5),
        mat
      );
      canopy.position.set(x, 2.3 * scale, z);
      canopy.castShadow = true;
      this.scene.add(canopy);
      this._treeMeshes.push(canopy);
    }
  }

  _buildLighting() {
    const ambient = new THREE.AmbientLight(0x5566aa, 0.5);
    this.scene.add(ambient);

    this.sun = new THREE.DirectionalLight(0xffffdd, 1.1);
    this.sun.position.set(30, 40, 20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.width = 1024;
    this.sun.shadow.mapSize.height = 1024;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 120;
    this.sun.shadow.camera.left = -35;
    this.sun.shadow.camera.right = 35;
    this.sun.shadow.camera.top = 35;
    this.sun.shadow.camera.bottom = -35;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    const hemi = new THREE.HemisphereLight(0x99bbff, 0x44aa44, 0.35);
    this.scene.add(hemi);
  }

  update(bikePos) {
    // Sun follows bike
    this.sun.position.set(bikePos.x + 30, 40, bikePos.z + 20);
    this.sun.target.position.copy(bikePos);
    this.sun.target.updateMatrixWorld();

    // Infinite floor snap-follow
    const snapSize = this.tileSize * 2;
    this.floor.position.x = Math.round(bikePos.x / snapSize) * snapSize;
    this.floor.position.z = Math.round(bikePos.z / snapSize) * snapSize;
  }
}
