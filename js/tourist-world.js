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
import { dracoDecoderPath } from './draco-path.js';
import { getTouristOrigin, TOURIST_TUNE, TOURIST_MAX_RADIUS_M } from './tourist-config.js';
import { TouristGround } from './tourist-ground.js';
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
    // itself. NOTE: with unlit tiles (see _makeTilesUnlit) these lights now reach
    // only the bike and riders — the tiles carry their own baked lighting.
    this._hemi = new THREE.HemisphereLight(0xffffff, 0x808088, 1.6);
    this.scene.add(this._hemi);
    this._sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
    this._sun.position.set(120, 200, 80);
    this.scene.add(this._sun);

    // Google Photorealistic Tiles ship Draco-compressed glTF; the decoder is
    // required or tiles fail to parse. Local on desktop, CDN on web (#353).
    const draco = new DRACOLoader();
    draco.setDecoderPath(dracoDecoderPath('libs/draco/gltf/'));
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
    // #400: a lobby ride passes the anchor it resolved for its first address.
    const origin = options.origin || getTouristOrigin();
    this._origin = origin;
    console.log(`[Tourist] riding ${origin.name} — anchor ${Math.round(origin.height)}m ` +
      `(${origin.anchored === false ? 'GUESSED, wide probe' : origin.source || 'explicit ?h'})`);

    // Anchor the chosen lat/lon/height at the three.js origin with +Y up so
    // the bike's abstract X/Z world maps to local east/north metres.
    tiles.registerPlugin(new ReorientationPlugin({
      lat: origin.lat * DEG2RAD,
      lon: origin.lon * DEG2RAD,
      height: origin.height,
    }));

    // Probe width follows how much we trust the anchor. An anchored origin (real
    // elevation, or an explicit ?h) keeps the TIGHT default window, which is what
    // puts coarse root-tile hits — kilometres below the true surface — out of
    // range so they are never accepted. Only a blind-guess anchor widens it.
    const probe = (origin.custom && !origin.anchored) ? TOURIST_TUNE.customProbe : TOURIST_TUNE;
    this._probeUp = probe.spawnProbeHeight;
    this._probeRay = probe.rayLength;

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

    // Render the photogrammetry as captured (no AgX over an already-graded
    // image). ?tlight=legacy restores the old look for an A/B.
    this._unlitTiles = new URLSearchParams(window.location.search).get('tlight') !== 'legacy';
    if (this._unlitTiles) {
      tiles.addEventListener('load-model', ({ scene: tileScene }) => {
        tileScene.traverse((c) => { if (c.material) this._renderTileAsCaptured(c.material); });
      });
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

    // Ground-following state. Hit selection + breadcrumb recovery live in
    // tourist-ground.js (#402) so they can be unit-tested without the tiles library.
    this._ground = new TouristGround({
      tiles, probeUp: this._probeUp, probeRay: this._probeRay, tune: TOURIST_TUNE,
    });
    // Ground-follow telemetry only when ?ttdebug is present (keeps console clean).
    this._dbg = new URLSearchParams(window.location.search).has('ttdebug');
    this._groundY = TOURIST_TUNE.wheelOffset; // best guess until first hit
    this._tiltQ = new THREE.Quaternion();     // smoothed ground tilt
    this._smoothNormal = new THREE.Vector3(0, 1, 0);
    this._tmpUpQ = new THREE.Quaternion();

    // Attribution overlay (Google requires visible credit when streaming tiles).
    this._creditsEl = document.getElementById('tourist-credits');
    this._creditTimer = 0;

    // "No 3D coverage" notice state — see _setCoverageNotice (the no-hit timer
    // itself lives in this._ground.noHitElapsed).
    this._noticeEl = null;
  }

  /** Give the world the bike so it can place/pitch it on the streamed ground. */
  /**
   * E-5/E-6 · how far this ride is allowed to roam. A planned route sets its
   * own budget (its length plus a margin); free-roam gets the default.
   */
  setMaxRadius(metres) {
    this._maxRadiusM = Math.max(500, metres || TOURIST_MAX_RADIUS_M);
  }

  /** E-6 · a planned A-to-B ride: budget the radius for its actual length. */
  setRoute(plan) {
    this._route = plan;
    // #400: an open-world ride (one address) roams the usual free-roam radius.
    if (plan && plan.explore) { this.setMaxRadius(TOURIST_MAX_RADIUS_M); return; }
    this.setMaxRadius((plan && plan.route ? plan.route.ridableM : 0) + 500);
  }

  /** Turn the bike around at the edge of the budget, and say why. */
  _enforceRadius(bikePos) {
    if (!bikePos || !this._bike) return;
    const limit = this._maxRadiusM || TOURIST_MAX_RADIUS_M;
    const dist = Math.hypot(bikePos.x, bikePos.z);
    if (dist <= limit) {
      if (this._atEdge) { this._atEdge = false; this._setEdgeMessage(''); }
      return;
    }
    if (!this._atEdge) {
      this._atEdge = true;
      this._setEdgeMessage('You have reached the edge of the streamed area — turning around.');
    }
    // Point the bike back at the anchor and nudge it inside the boundary, so it
    // cannot sit on the edge requesting new tiles every frame.
    this._bike.heading = Math.atan2(-bikePos.x, -bikePos.z);
    const pull = (dist - limit) + 1;
    bikePos.x -= (bikePos.x / dist) * pull;
    bikePos.z -= (bikePos.z / dist) * pull;
    if (this._bike.speed > 4) this._bike.speed = 4;
  }

  _setEdgeMessage(text) {
    const el = document.getElementById('tourist-credits');
    if (el && (text || this._edgeMessageShown)) {
      el.textContent = text || '';
      this._edgeMessageShown = !!text;
    }
  }

  setBike(bike) {
    this._bike = bike;
  }

  /**
   * Render one tile material as captured rather than as a re-graded surface.
   *
   * MEASURED, not assumed: Google ships Photorealistic 3D Tiles with
   * KHR_materials_unlit, which GLTFLoader maps to MeshBasicMaterial. The tiles
   * therefore already ignore the scene lights — the hemi/sun above reach only the
   * bike and riders. An earlier version of this method assumed the opposite and
   * tried to drive `emissive` from the base map; MeshBasicMaterial has no
   * `emissive`, so it silently skipped all 204 materials and changed nothing.
   *
   * The one lever that does apply is TONE MAPPING. Show Riders turns on AgX at
   * exposure 1.3 (game.js `_applyShowRiders`) for the riders' PBR, and that runs
   * over the tiles too — lifting midtones and desaturating, since AgX rolls off
   * and desaturates highlights. The capture was already tone-mapped by the camera
   * that shot it, so doing it again is the one genuine double-application here.
   *
   * Per-material and NOT a renderer-level change, so the riders keep their AgX.
   */
  _renderTileAsCaptured(material) {
    const mats = Array.isArray(material) ? material : [material];
    for (const mat of mats) {
      if (!mat || mat.userData?._touristUnlit) continue;
      mat.toneMapped = false;
      // Defensive: if a tile ever arrives lit (no KHR_materials_unlit), drive it
      // from its own base map so it still renders as captured.
      if ('emissive' in mat && mat.emissive && mat.color) {
        mat.emissive = new THREE.Color(0xffffff);
        mat.emissiveMap = mat.map;
        mat.emissiveIntensity = 1;
        mat.color.setRGB(0, 0, 0);
      }
      // Keep fog — aerial perspective is the depth cue separating near from far.
      mat.fog = true;
      mat.userData = mat.userData || {};
      mat.userData._touristUnlit = true;
      mat.needsUpdate = true;
      this._gradedMaterials = (this._gradedMaterials || 0) + 1;
    }
  }

  /**
   * Show/hide the "no 3D coverage" notice. Without it, a location Google has
   * never captured in 3D just leaves the bike hanging in empty space with no
   * explanation — indistinguishable from a bug. Deliberately says "3D coverage",
   * NOT "map coverage": Google Maps covers these places perfectly well (roads,
   * labels, satellite), and it is only the photogrammetry mesh that is missing.
   * Calling it a map problem would read as our bug rather than a limit of the
   * data, and would misdescribe the common case — a rural address Maps knows
   * fine but that has never been scanned.
   */
  _setCoverageNotice(show) {
    if (!show) {
      if (this._noticeEl) this._noticeEl.style.display = 'none';
      return;
    }
    if (!this._noticeEl) {
      const el = document.createElement('div');
      el.id = 'tourist-notice';
      // pre-line keeps the two lines in one textContent write (no innerHTML).
      el.style.cssText = [
        'position:fixed', 'left:50%', 'top:38%', 'transform:translate(-50%,-50%)',
        'z-index:60', 'max-width:min(80vw,460px)', 'padding:14px 20px',
        'background:rgba(0,0,0,.72)', 'border-radius:10px', 'color:#fff',
        'font:15px/1.45 system-ui,sans-serif', 'text-align:center',
        'white-space:pre-line', 'pointer-events:none',
        'text-shadow:0 1px 2px rgba(0,0,0,.8)',
      ].join(';');
      document.body.appendChild(el);
      this._noticeEl = el;
    }
    this._noticeEl.textContent =
      'No 3D coverage here\nGoogle hasn’t captured this spot in 3D. Try a street in a town or city.';
    this._noticeEl.style.display = '';
  }

  /**
   * Per-frame: advance tile streaming, follow the ground, refresh attribution.
   * Called AFTER bike.update() and BEFORE chaseCamera.update() so the bike's
   * corrected Y is what the camera follows.
   */
  update(bikePos, bikeD, dt) {
    // E-5 · billing bound. Tiles are metered per request, so a rider heading in
    // a straight line forever is an open-ended invoice. Turn them around at the
    // edge with a message rather than letting them stream the planet.
    this._enforceRadius(bikePos);

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

    // Report the conversion ONCE the world has actually streamed, not on the
    // first tile — the first-tile count is 1 and reads as "it barely did
    // anything", which is exactly the misleading signal this log exists to stop.
    if (this._unlitTiles && !this._gradeLogged && this._tilesStarted) {
      this._gradeLogTimer = (this._gradeLogTimer || 0) + dt;
      if (this._gradeLogTimer > 5 && this._gradedMaterials) {
        this._gradeLogged = true;
        console.log(`[Tourist] rendering tiles as captured — ${this._gradedMaterials} materials ` +
          'converted so far, tone mapping off. Add &tlight=legacy to compare.');
      }
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
   * tile meshes, pick the STREET-LEVEL hit (#402: not the roof or tree crown
   * that happens to be highest — see TouristGround), clamp the bike's Y to it
   * (+ wheel offset), and pitch the bike to the ground normal. Tiles stream
   * in/out, so frames with no hit hold the last height to avoid pops; a long
   * run of unrideable hits resnaps the bike to its breadcrumb trail.
   */
  _groundFollow(bikePos, dt) {
    const ground = this._ground;
    const r = ground.step(bikePos, dt, this._tilesStarted);
    this._groundY = ground.groundY;

    // Throttled ground-follow telemetry (~2/sec), only with ?ttdebug.
    this._dbgTimer = (this._dbgTimer || 0) + dt;
    if (this._dbg && (this._dbgTimer > 0.5 || r.resnapped)) {
      this._dbgTimer = 0;
      const picked = r.hit ? r.hit.point.y.toFixed(1) : 'none';
      console.log(`[Tourist GF] bikeXZ=(${bikePos.x.toFixed(0)},${bikePos.z.toFixed(0)}) ` +
        `bikeY=${bikePos.y.toFixed(1)} groundY=${this._groundY.toFixed(1)} ` +
        `hits=${r.hits} rejected=${r.rejected} pickedY=${picked} probeTop=${r.probeTop.toFixed(0)}` +
        (r.resnapped ? ` RESNAP=${r.resnapped} crumbs=${ground.breadcrumbs.length}` : ''));
    }

    const ease = Math.min(1, TOURIST_TUNE.groundLerp * dt);

    if (r.hit) {
      // Ground normal (already world space, upward), smoothed, for pitch/roll.
      if (r.hit.face) this._smoothNormal.lerp(ground.normal, ease).normalize();
      this._setCoverageNotice(false);
    } else if (this._tilesStarted) {
      // No ground this frame — hold last _groundY/normal. Usually just tiles
      // still streaming, so only the SUSTAINED case with no hit at all means
      // "nothing here to ride". (Gated on _tilesStarted inside step() too, so
      // the mobile tile-gate wait never counts.)
      if (ground.noHitElapsed > TOURIST_TUNE.noCoverageAfter) this._setCoverageNotice(true);
    }

    // #402 option 5 · the bike was pulled back to its last good ground point
    // because it rode into geometry (wall/roof overhead). Take the speed off so
    // it doesn't drive straight back in; what a wall should DO beyond this
    // (bump and turn vs. pass through with an X-ray) is still Pete's call (#402 §3).
    if (r.resnapped && r.blocked && this._bike && this._bike.speed > TOURIST_TUNE.ground.resnapSpeed) {
      this._bike.speed = TOURIST_TUNE.ground.resnapSpeed;
    }

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
  // _startCountdown reseeds the world from the level; real streets have no seed.
  // (Without this _startCountdown threw before it built the RaceManager, so a
  // tourist ride rolled but never had a finish.)
  reseed() { return false; }

  dispose() {
    if (this.tiles) {
      this.scene.remove(this.tiles.group);
      this.tiles.dispose();
      this.tiles = null;
    }
    if (this._draco) this._draco.dispose();
    if (this._hemi) this.scene.remove(this._hemi);
    if (this._sun) this.scene.remove(this._sun);
    // #400: nothing of this ride may outlive it on the next (procedural) one.
    if (this._noticeEl) { this._noticeEl.remove(); this._noticeEl = null; }
    if (this._creditsEl) this._creditsEl.textContent = '';
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
