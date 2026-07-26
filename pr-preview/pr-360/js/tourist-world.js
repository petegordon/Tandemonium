// ============================================================
// TOURIST WORLD — Tourist Mode (#333)
//
// Drop-in alternative to World that streams Google Photorealistic
// 3D Tiles for a real location instead of the procedural road.
// It mirrors the slice of World's interface the game loop touches:
//   - update(bikePos, bikeD, dt)
//   - .roadPath  (consumed by ChaseCamera for terrain clipping)
//   - dispose()
//
// The bike's own roadPath is set to null in Tourist Mode (see game.js),
// so procedural slope/off-road physics are skipped and THIS module owns
// the bike's vertical placement via downward raycasting (Step 4).
// ============================================================

import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GoogleCloudAuthPlugin,
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  ReorientationPlugin,
} from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { getTouristOrigin, TOURIST_TUNE } from './tourist-config.js';
import { isMobile } from './config.js';

const DEG2RAD = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

export class TouristWorld {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   * @param {THREE.WebGLRenderer} renderer
   * @param {{apiKey: string}} options
   */
  constructor(scene, camera, renderer, options = {}) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this._bike = null;

    this._mobile = isMobile;

    // Roads/hills are real and can run far — open up the view distance and
    // soften fog so streamed terrain isn't culled or washed out. Mobile pulls
    // the far plane in to bound how much terrain streams (memory headroom).
    camera.far = this._mobile ? TOURIST_TUNE.mobile.cameraFar : TOURIST_TUNE.cameraFar;
    camera.updateProjectionMatrix();
    scene.fog = new THREE.FogExp2(0xcfe0ee, 0.00018);

    // Tourist Mode skips the procedural World, so it must light the scene
    // itself (both the photorealistic tiles' glTF materials and the bike).
    this._hemi = new THREE.HemisphereLight(0xffffff, 0x808088, 1.6);
    this.scene.add(this._hemi);
    this._sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
    this._sun.position.set(120, 200, 80);
    this.scene.add(this._sun);

    // Google Photorealistic Tiles ship Draco-compressed glTF; the decoder is
    // required or tiles fail to parse.
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.161.0/examples/jsm/libs/draco/gltf/');
    this._draco = draco;

    const tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({
      apiToken: options.apiKey,
      autoRefreshToken: true,
    }));
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    tiles.registerPlugin(new TileCompressionPlugin());
    tiles.registerPlugin(new TilesFadePlugin());
    // Where are we riding? Defaults to Scioto Mile; ?lat/?lon points it anywhere.
    const origin = getTouristOrigin();
    this._origin = origin;
    console.log(`[Tourist] riding ${origin.name} (anchor ${origin.height}m)`);

    // Anchor the chosen lat/lon/height at the three.js origin with +Y up so
    // the bike's abstract X/Z world maps to local east/north metres.
    tiles.registerPlugin(new ReorientationPlugin({
      lat: origin.lat * DEG2RAD,
      lon: origin.lon * DEG2RAD,
      height: origin.height,
    }));

    // A custom location's anchor height is a guess, so the ground can be far
    // below (or above) local y=0. Widen the probe to find it; the first hit
    // snaps the bike down and the guess stops mattering.
    const probe = origin.custom ? TOURIST_TUNE.customProbe : TOURIST_TUNE;
    this._probeUp = probe.spawnProbeHeight;
    this._probeFar = probe.spawnProbeHeight + probe.rayLength;

    // Fix #2 — mobile tile budget. The library defaults (0.4 GB cache, 10
    // concurrent downloads, unbounded depth) can exhaust a mobile browser's
    // per-tab memory and starve other allocations (e.g. the bike GLB decode).
    // Cap detail + footprint on mobile so the ride stays within budget; desktop
    // keeps the defaults. Must be set before the first update() streams tiles.
    if (this._mobile) {
      const m = TOURIST_TUNE.mobile;
      tiles.errorTarget = m.errorTarget;
      // NB: deliberately NOT capping tiles.maxDepth — Google's tileset is rooted
      // at the globe and street-level geometry is dozens of levels deep, so a
      // depth cap halts refinement before buildings ever load. errorTarget + the
      // cache byte caps below bound memory without hiding the world.
      tiles.downloadQueue.maxJobs = m.downloadJobs;
      tiles.lruCache.minBytesSize = m.cacheMinBytes;
      tiles.lruCache.maxBytesSize = m.cacheMaxBytes;
      tiles.lruCache.minSize = m.cacheMinTiles;
      tiles.lruCache.maxSize = m.cacheMaxTiles;
    }

    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    scene.add(tiles.group);
    this.tiles = tiles;

    // Fix #1 — on mobile, don't start streaming tiles until the bike GLB has
    // decoded, so the small one-shot load isn't racing the tile firehose for
    // memory. Desktop has headroom, so it streams immediately (gate open).
    this._tilesStarted = !this._mobile;
    this._tileGateElapsed = 0;

    // Camera terrain-clipping shim (ChaseCamera calls roadPath.getHeightAtWorld).
    this.roadPath = new TouristRoadPath(this);

    // Ground-following state.
    this._raycaster = new THREE.Raycaster();
    this._raycaster.firstHitOnly = false;
    // Ground-follow telemetry only when ?ttdebug is present (keeps console clean).
    this._dbg = new URLSearchParams(window.location.search).has('ttdebug');
    this._groundY = TOURIST_TUNE.wheelOffset; // best guess until first hit
    this._hasGround = false;
    this._tiltQ = new THREE.Quaternion();     // smoothed ground tilt
    this._smoothNormal = new THREE.Vector3(0, 1, 0);
    this._tmpOrigin = new THREE.Vector3();
    this._tmpNormalMat = new THREE.Matrix3();
    this._tmpNormal = new THREE.Vector3();
    this._tmpUpQ = new THREE.Quaternion();

    // Attribution overlay (Google requires visible credit when streaming tiles).
    this._creditsEl = document.getElementById('tourist-credits');
    this._creditTimer = 0;
  }

  /** Give the world the bike so it can place/pitch it on the streamed ground. */
  setBike(bike) {
    this._bike = bike;
  }

  /**
   * Per-frame: advance tile streaming, follow the ground, refresh attribution.
   * Called AFTER bike.update() and BEFORE chaseCamera.update() so the bike's
   * corrected Y is what the camera follows.
   */
  update(bikePos, bikeD, dt) {
    // Fix #1 — hold tile streaming until the bike GLB has decoded (mobile only;
    // desktop opens the gate at construction). A time cap makes sure tiles still
    // start even if the bike load stalls, so the ride is never permanently blank.
    if (!this._tilesStarted) {
      this._tileGateElapsed += dt;
      if ((this._bike && this._bike.modelLoaded) ||
          this._tileGateElapsed > TOURIST_TUNE.tileStartMaxWait) {
        this._tilesStarted = true;
      }
    }

    if (this._tilesStarted) {
      // Camera moves every frame; keep tile LOD selection in sync.
      this.tiles.setResolutionFromRenderer(this.camera, this.renderer);
      this.tiles.setCamera(this.camera);
      this.tiles.update();

      // Force matrixWorld to reflect the ReorientationPlugin transform NOW, before
      // we raycast. Without this the tile meshes' matrixWorld is stale at raw ECEF
      // (Earth-radius) scale until the renderer updates it post-update, so the
      // ground probe finds nothing. (The library's own examples do this too.)
      this.tiles.group.updateMatrixWorld(true);
    }

    this._groundFollow(bikePos, dt);

    // Refresh Google attribution ~3x/sec (it changes as tiles stream in).
    this._creditTimer += dt;
    if (this._creditsEl && this._creditTimer > 0.33) {
      this._creditTimer = 0;
      const attrib = this.tiles.getAttributions && this.tiles.getAttributions()[0];
      this._creditsEl.textContent = attrib ? attrib.value : '';
    }
  }

  /**
   * Step 4 — vertical ground-following. Raycast straight down onto the loaded
   * tile meshes, clamp the bike's Y to the hit (+ wheel offset), and pitch the
   * bike to the ground normal. Tiles stream in/out, so frames with no hit hold
   * the last height to avoid pops.
   */
  _groundFollow(bikePos, dt) {
    const ray = this._raycaster;
    const probeTop = bikePos.y + this._probeUp;
    this._tmpOrigin.set(bikePos.x, probeTop, bikePos.z);
    ray.set(this._tmpOrigin, new THREE.Vector3(0, -1, 0));
    ray.far = this._probeFar;

    // Use the library's own raycast: it transforms the world-space ray into the
    // tiles' (ECEF) coordinate frame via the group transform. Raycasting the tile
    // meshes directly bypasses that and never hits (the meshes live at raw ECEF).
    const hits = [];
    this.tiles.raycast(ray, hits);

    // Throttled ground-follow telemetry (~2/sec), only with ?ttdebug.
    this._dbgTimer = (this._dbgTimer || 0) + dt;
    if (this._dbg && this._dbgTimer > 0.5) {
      this._dbgTimer = 0;
      hits.sort((a, b) => a.distance - b.distance);
      const nearest = hits.length ? hits[0].point.y.toFixed(1) : 'none';
      console.log(`[Tourist GF] bikeXZ=(${bikePos.x.toFixed(0)},${bikePos.z.toFixed(0)}) ` +
        `bikeY=${bikePos.y.toFixed(1)} groundY=${this._groundY.toFixed(1)} ` +
        `hits=${hits.length} nearestHitY=${nearest} probeTop=${probeTop.toFixed(0)}`);
    }

    const ease = Math.min(1, TOURIST_TUNE.groundLerp * dt);

    if (hits.length) {
      hits.sort((a, b) => a.distance - b.distance);
      const hit = hits[0];
      const targetY = hit.point.y + TOURIST_TUNE.wheelOffset;
      // First hit SNAPS rather than eases: this is the moment the real surface
      // height becomes known, and for a custom location it can be a kilometre
      // from the guessed anchor — easing that would be a long visible fall.
      // It also means the anchor height never has to be looked up or tuned.
      if (!this._hasGround) this._groundY = targetY;
      else this._groundY += (targetY - this._groundY) * ease;
      this._hasGround = true;

      // Ground normal → world space, smoothed, for pitch/roll.
      if (hit.face) {
        this._tmpNormalMat.getNormalMatrix(hit.object.matrixWorld);
        this._tmpNormal.copy(hit.face.normal).applyMatrix3(this._tmpNormalMat).normalize();
        if (this._tmpNormal.y < 0) this._tmpNormal.negate(); // face upward
        this._smoothNormal.lerp(this._tmpNormal, ease).normalize();
      }
    }
    // else: no hit this frame (tiles not loaded yet) — hold last _groundY/normal.

    // Apply Y to the bike (bikePos is the bike's live position vector).
    bikePos.y = this._groundY;

    // Apply ground tilt to the bike. bike.update() already set the group
    // quaternion to yaw*lean (no pitch, since bike.roadPath is null); we
    // pre-multiply a world-space tilt that rotates +Y to the ground normal.
    if (this._bike && this._bike.group) {
      this._tmpUpQ.setFromUnitVectors(UP, this._smoothNormal);
      this._tiltQ.slerp(this._tmpUpQ, ease);
      this._bike.group.quaternion.premultiply(this._tiltQ);
      this._bike.group.position.y = this._groundY;
    }
  }

  /** Current ground height under the bike (for the camera clip shim). */
  getGroundY() {
    return this._groundY;
  }

  // --- World-interface no-ops (gameplay content is deferred in Tourist v1) ---
  setRaceMarkers() {}
  clearRaceMarkers() {}
  setBalloonColor() {}
  checkTreeCollision() { return { hit: false }; }

  dispose() {
    if (this.tiles) {
      this.scene.remove(this.tiles.group);
      this.tiles.dispose();
      this.tiles = null;
    }
    if (this._draco) this._draco.dispose();
    if (this._hemi) this.scene.remove(this._hemi);
    if (this._sun) this.scene.remove(this._sun);
  }
}

/**
 * Minimal roadPath stand-in for Tourist Mode. ChaseCamera only calls
 * getHeightAtWorld(); the rest are benign stubs so anything else that probes
 * the road interface gets sane, flat values (the bike itself uses roadPath=null).
 */
class TouristRoadPath {
  constructor(world) {
    this.world = world;
    this.loopLength = Infinity;
  }

  getHeightAtWorld(_x, _z, _hintD) {
    return this.world.getGroundY();
  }

  getSlopeAtDistance(_d) {
    return 0;
  }

  getPointAtDistance(_d) {
    return { x: 0, y: this.world.getGroundY(), z: 0, heading: 0 };
  }

  // Neutral road info: zero lateral offset = "on center", so the bike's
  // distance-from-center speed logic neither boosts hard nor drags (flat
  // speed model for v1).
  getClosestRoadInfo(x, _z, hintD) {
    return {
      d: hintD || 0,
      roadX: x,
      roadY: this.world.getGroundY(),
      roadZ: _z,
      lateralOffset: 0,
      heading: 0,
    };
  }
}
