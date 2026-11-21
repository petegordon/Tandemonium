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
import { ANCHOR_MARGIN, getTouristOrigin, TOURIST_TUNE, TOURIST_MAX_RADIUS_M } from './tourist-config.js';
import { TouristGround } from './tourist-ground.js';
import { TilesSessionPlugin, watchTileRefusals } from './tourist-tiles-session.js';
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
    this._reorient = new ReorientationPlugin({
      lat: origin.lat * DEG2RAD,
      lon: origin.lon * DEG2RAD,
      height: origin.height,
    });
    tiles.registerPlugin(this._reorient);
    // Registered last, with a lower priority than the rest, so the library asks it first: it hands
    // this ride the root (and session) an earlier ride already paid for (js/tourist-tiles-session.js).
    this._session = new TilesSessionPlugin();
    this._unwatchRefusals = watchTileRefusals();   // #824
    tiles.registerPlugin(this._session);

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
    this._ground.expectY = origin.measured ? -ANCHOR_MARGIN : null;
    // Ground-follow telemetry only when ?ttdebug is present (keeps console clean).
    this._dbg = new URLSearchParams(window.location.search).has('ttdebug');
    this._groundY = 0;          // the anchor height, until the street is found (see _groundFollow)
    this._landing = true;
    this._descended = false;
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

  /**
   * The edge message, in a line of its own near the top. It used to be written into the attribution
   * line, which is rewritten three times a second, so nobody saw why the bike had turned round.
   */
  _setEdgeMessage(text) {
    if (!text) { if (this._edgeEl) this._edgeEl.style.display = 'none'; return; }
    if (!this._edgeEl) {
      const el = document.createElement('div');
      el.id = 'tourist-edge';
      el.setAttribute('role', 'status');
      el.style.cssText = [
        'position:fixed', 'left:50%', 'top:16%', 'transform:translateX(-50%)', 'z-index:60',
        'max-width:min(86vw,560px)', 'padding:10px 18px', 'background:rgba(0,0,0,.72)', 'border-radius:10px',
        'color:#fff', 'font:600 15px/1.4 system-ui,sans-serif', 'text-align:center', 'pointer-events:none',
      ].join(';');
      document.body.appendChild(el);
      this._edgeEl = el;
    }
    this._edgeEl.textContent = text;
    this._edgeEl.style.display = '';
  }

  /** A line of status near the top ("Loading the streets…"); '' clears it. Shares the edge message's place. */
  setStatus(text) { this._setEdgeMessage(text || (this._atEdge ? 'You have reached the edge of the streamed area — turning around.' : '')); }

  /** Has the ground under the bike been found (tiles streamed in enough to ride)? */
  /** true for a place whose ground height was measured (the scenic rides): worth a longer wait. */
  get measuredGround() { return !!(this._ground && this._ground.expectY != null); }

  hasGround() {
    return !!this._ground && this._ground.ready && !this._landing;
  }

  /**
   * Move the whole ride to another place on the globe, keeping the tiles, their session and
   * everything already loaded: the same renderer is pointed at a new anchor, and the bike starts
   * again at its origin. Used for the skip in the middle of a long ride (the first 2.5 km from one
   * address, then the last 2.5 km to the other). The caller places the bike and waits for hasGround().
   * @param {{lat: number, lon: number, height: number, anchored?: boolean, custom?: boolean, name?: string}} origin
   */
  reanchor(origin) {
    this._origin = origin;
    const r = this._reorient;
    r.lat = origin.lat * DEG2RAD;
    r.lon = origin.lon * DEG2RAD;
    r.height = origin.height;
    try { r.transformLatLonHeightToOrigin(r.lat, r.lon, r.height); } catch (e) { /* root not in yet: the plugin applies it on load */ }
    this.tiles.group.updateMatrixWorld(true);
    const probe = (origin.custom && origin.anchored === false) ? TOURIST_TUNE.customProbe : TOURIST_TUNE;
    this._probeUp = probe.spawnProbeHeight;
    this._probeRay = probe.rayLength;
    this._ground = new TouristGround({ tiles: this.tiles, probeUp: this._probeUp, probeRay: this._probeRay, tune: TOURIST_TUNE });
    this._ground.expectY = origin.measured ? -ANCHOR_MARGIN : null;
    this._zeroBikeHeight();
    this._groundFound = false;
    this._groundY = 0;
    this._landing = true;
    this._descended = false;
    this._smoothNormal.set(0, 1, 0);
    this._tiltQ.identity();
    this._atEdge = false;
    this._setEdgeMessage('');
    this._setCoverageNotice(false);
  }

  /**
   * Mark where the ride is going: a tall beam of light at a point in the ride's own frame (metres from
   * the anchor), seen over the rooftops from the start. There is no road to follow here, so without it
   * the only guide was a number counting down. null takes it away.
   * @param {{x: number, z: number}|null} at
   * @param {{color?: number}} [opts]
   */
  setDestination(at, { color = 0xffd36b } = {}) {
    this.clearCelebration();
    if (this._beacon) {
      this.scene.remove(this._beacon);
      this._beacon.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      this._beacon = null;
    }
    if (!at) return;
    const group = new THREE.Group();
    group.name = 'tourist-destination';
    const beamMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, fog: false, toneMapped: false });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 1400, 16, 1, true), beamMat);
    beam.position.y = 500;
    const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide });
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 1400, 20, 1, true), glowMat);
    glow.position.y = 500;
    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(9, 12, 40), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.name = 'tourist-destination-ring';
    group.add(glow, beam, ring);
    group.position.set(at.x, this._groundY || 0, at.z);
    group.renderOrder = 5;
    this.scene.add(group);
    this._beacon = group;
    this._beaconT = 0;
  }

  /** The beam stands on whatever ground is under the bike's height, and breathes a little. */
  _updateBeacon(dt) {
    const b = this._beacon;
    if (!b) return;
    this._beaconT += dt;
    b.position.y += (this._groundY - b.position.y) * Math.min(1, dt * 2);
    const ring = b.getObjectByName('tourist-destination-ring');
    if (ring) { const k = 1 + 0.25 * Math.sin(this._beaconT * 2.2); ring.scale.set(k, k, 1); }
    // #802 · arrived: the beam flares and the ring runs out across the ground
    if (this._celebT != null && ring) {
      const t = this._celebT;
      const out = 1 + 7 * (1 - Math.exp(-t * 1.6));
      ring.scale.set(out, out, 1);
      ring.material.opacity = 0.8 * Math.max(0.15, 1 - t / 5);
      const flare = 1 + 1.6 * Math.exp(-t * 1.2) * (0.75 + 0.25 * Math.sin(t * 18));
      for (const o of b.children) if (o !== ring) o.scale.set(flare, 1, flare);
    }
  }

  /** Where the ride is to, on its ground (null without a destination). */
  get destination() {
    const b = this._beacon;
    return b ? { x: b.position.x, y: this._ground.groundY - TOURIST_TUNE.wheelOffset, z: b.position.z } : null;
  }

  /** The line under the picture: who the imagery is from (Google's attribution, as on screen). */
  get attribution() {
    return (this._creditsEl && this._creditsEl.textContent) || 'Google';
  }

  /**
   * #802 · how far the view is open from one point toward another: the distance at which the tiles
   * block it, or null when nothing does. The arrival camera uses it to stay out of buildings.
   */
  viewOpen(from, to) {
    if (!this.tiles) return null;
    if (!this._viewRay) { this._viewRay = new THREE.Raycaster(); this._viewRay.firstHitOnly = true; this._viewDir = new THREE.Vector3(); this._viewFrom = new THREE.Vector3(); }
    this._viewFrom.set(from.x, from.y, from.z);
    this._viewDir.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const far = this._viewDir.length();
    if (!(far > 0)) return null;
    this._viewDir.multiplyScalar(1 / far);
    this._viewRay.set(this._viewFrom, this._viewDir);
    this._viewRay.far = far;
    const hits = [];
    this.tiles.raycast(this._viewRay, hits);
    let near = null;
    for (const h of hits) if (near === null || h.distance < near) near = h.distance;
    return near;
  }

  /**
   * #802 (Pete, 2026-11-18: "Need a celebration when you reach the destination"). Confetti goes up from
   * the foot of the beam and from the bike, the beam flares, the ring runs out. updateFinishFx moves it.
   * @param {{x:number, y:number, z:number}} [bikePos]
   */
  celebrate(bikePos) {
    this.clearCelebration();
    const at = this.destination;
    if (!at) return false;
    this._celebT = 0;
    // Paper: small rectangles that are thrown up fast, stop quickly in the air, then tumble down
    // slowly, swaying, catching the light on one side and then the other. A few are long streamers.
    const N = 1800;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, fog: false, toneMapped: false, transparent: true, opacity: 1 });
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.name = 'tourist-confetti';
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    const palette = [0xffd23f, 0xff5d8f, 0x4cc9f0, 0x70e000, 0xffffff, 0xb388ff, 0xff8c42, 0xe63946, 0xc0c0c8];
    const c = new THREE.Color();
    const pieces = new Array(N);
    // cannons: four round the foot of the beam, firing in turn, and a popper each side of the bike
    // Cannons: four round the foot of the beam firing in turn, three salvos of them so there is still
    // paper going up when the camera is high over the place; one straight up the beam; and poppers
    // just ahead of the bike on each side, three times, so paper is falling round the riders while
    // the camera is in front of them.
    const cannons = [];
    for (let salvo = 0; salvo < 3; salvo++) {
      for (let i = 0; i < 4; i++) {
        const a0 = i * Math.PI / 2 + 0.6 + salvo * 0.5;
        cannons.push({ x: at.x + Math.cos(a0) * 8, y: at.y + 0.3, z: at.z + Math.sin(a0) * 8, ax: -Math.cos(a0) * 0.3, az: -Math.sin(a0) * 0.3, t: 0.15 + i * 0.5 + salvo * 3.6, power: 30 + salvo * 5, share: 0.065, cone: 0.5 });
      }
    }
    cannons.push({ x: at.x, y: at.y + 0.3, z: at.z, ax: 0, az: 0, t: 2.4, power: 40, share: 0.08, cone: 0.35 });
    if (bikePos) {
      const h = this._bike ? this._bike.heading : 0, fx = Math.sin(h), fz = Math.cos(h);
      for (let shot = 0; shot < 3; shot++) {
        for (const side of [1, -1]) {
          cannons.push({ x: bikePos.x + fx * 1.5 + fz * side * 1.7, y: bikePos.y + 0.2, z: bikePos.z + fz * 1.5 - fx * side * 1.7,
            ax: -fz * side * 0.16, az: fx * side * 0.16, t: 0.05 + shot * 1.5, power: 17, share: 0.03, cone: 0.4 });
        }
      }
    }
    const total = cannons.reduce((n, k) => n + k.share, 0);
    let i = 0;
    for (const k of cannons) {
      const count = Math.round(N * k.share / total);
      for (let j = 0; j < count && i < N; j++, i++) {
        // a cone round the cannon's aim, most of the paper near the middle of it
        const spread = Math.pow(Math.random(), 0.7) * (k.cone || 0.42), round = Math.random() * Math.PI * 2;
        let dx = k.ax + Math.cos(round) * spread, dz = k.az + Math.sin(round) * spread, dy = 1;
        const len = Math.hypot(dx, dy, dz); dx /= len; dy /= len; dz /= len;
        const speed = k.power * (0.45 + Math.random() * 0.75);
        const streamer = Math.random() < 0.07;
        const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
        pieces[i] = {
          born: k.t + Math.random() * 0.12, x: k.x, y: k.y, z: k.z,
          vx: dx * speed, vy: dy * speed, vz: dz * speed,
          w: streamer ? 0.035 : 0.06 + Math.random() * 0.05, h: streamer ? 0.55 + Math.random() * 0.5 : 0.09 + Math.random() * 0.08,
          q: new THREE.Quaternion().setFromAxisAngle(axis, Math.random() * Math.PI * 2),
          axis, spin: (streamer ? 3 : 7) + Math.random() * 9,
          sway: 0.5 + Math.random() * 1.1, phase: Math.random() * Math.PI * 2, swayRate: 2.2 + Math.random() * 2.6,
          fall: 0.55 + Math.random() * 0.85,         // how fast this piece comes down once the air has it
          landed: false,
        };
        c.setHex(palette[(Math.random() * palette.length) | 0]);
        mesh.setColorAt(i, c);
      }
    }
    for (; i < N; i++) { pieces[i] = null; }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.count = N;
    this.scene.add(mesh);
    this._confetti = { mesh, pieces, floor: at.y, at, m: new THREE.Matrix4(), dq: new THREE.Quaternion(), sc: new THREE.Vector3(), p: new THREE.Vector3(), flat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2) };
    this.updateFinishFx(0);
    return true;
  }

  /** The celebration, one frame (real time, whatever the bike's slow motion is doing). */
  updateFinishFx(dt) {
    if (this._celebT == null) return;
    this._celebT += dt;
    const k = this._confetti;
    if (!k) return;
    const t = this._celebT;
    const LIFE = 24;
    // paper the size of paper beside the bike, and still to be seen from high over the place
    const camD = this.camera ? Math.hypot(this.camera.position.x - k.at.x, this.camera.position.y - k.at.y, this.camera.position.z - k.at.z) : 10;
    const grow = Math.max(1, Math.min(9, camD * 0.075));
    const drag = Math.exp(-dt * 2.4);            // paper stops quickly in the air
    for (let i = 0, n = k.pieces.length; i < n; i++) {
      const p = k.pieces[i];
      if (!p || t < p.born) { k.sc.set(0, 0, 0); k.p.set(k.at.x, k.at.y, k.at.z); k.m.compose(k.p, k.flat, k.sc); k.mesh.setMatrixAt(i, k.m); continue; }
      if (!p.landed) {
        p.vx *= drag; p.vz *= drag;
        // rising: thrown, slowed by the air. Falling: it settles to its own slow speed.
        p.vy -= 9.8 * dt;
        if (p.vy > 0) p.vy *= drag; else p.vy = Math.max(p.vy, -p.fall);
        const flutter = p.vy <= 0.5 ? 1 : 0.25;  // it only sways once it is drifting
        const sw = Math.sin(t * p.swayRate + p.phase) * p.sway * flutter;
        const sw2 = Math.cos(t * p.swayRate * 0.83 + p.phase * 1.7) * p.sway * flutter;
        p.x += (p.vx + sw) * dt; p.y += (p.vy + Math.abs(sw) * 0.18 * flutter) * dt; p.z += (p.vz + sw2) * dt;
        k.dq.setFromAxisAngle(p.axis, p.spin * dt * (0.55 + 0.45 * Math.sin(t * p.swayRate + p.phase)));
        p.q.premultiply(k.dq);
        if (p.y <= k.floor + 0.02) { p.y = k.floor + 0.02 + (i % 7) * 0.002; p.landed = true; p.q.copy(k.flat); k.dq.setFromAxisAngle(UP, p.phase); p.q.premultiply(k.dq); }
      }
      k.p.set(p.x, p.y, p.z);
      k.sc.set(p.w * grow, p.h * grow, 1);
      k.m.compose(k.p, p.q, k.sc);
      k.mesh.setMatrixAt(i, k.m);
    }
    k.mesh.instanceMatrix.needsUpdate = true;
    k.mesh.material.opacity = Math.max(0, Math.min(1, (LIFE - t) / 2.5));
    if (t > LIFE) this._removeConfetti();
  }

  _removeConfetti() {
    const k = this._confetti;
    if (!k) return;
    this.scene.remove(k.mesh);
    k.mesh.geometry.dispose();
    k.mesh.material.dispose();
    if (k.mesh.dispose) k.mesh.dispose();
    this._confetti = null;
  }

  clearCelebration() {
    this._removeConfetti();
    this._celebT = null;
  }

  setBike(bike) {
    this._bike = bike;
    this._zeroBikeHeight();
  }

  /**
   * The bike starts each ride at the anchor plane. Its height from the last ride (say 1,400 m under
   * the anchor, after a guessed one) moved the ground probe's start and reach with it, so the next
   * place's probe caught coarse geometry far from the street.
   */
  _zeroBikeHeight() {
    const b = this._bike;
    if (!b) return;
    if (b.position) b.position.y = 0;
    if (b.group && b.group.position) b.group.position.y = 0;
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
    this._updateBeacon(dt);

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
    const bike = this._bike;
    const r = ground.step(bikePos, dt, this._tilesStarted, bike ? bike.heading : undefined, bike && !bike.fallen ? bike.speed : 0);
    // #801: the grace after standing up runs while the bike is being ridden, not through the countdown
    if (this._crashGraceS > 0 && bike && !bike.fallen && bike.speed > 0.3) this._crashGraceS = Math.max(0, this._crashGraceS - dt);
    this._updateWarning(dt);
    // Until the street has been found and has stopped moving, the bike waits at the anchor height, above
    // the place. Dropping it onto the first (coarse) hit took the camera down with it, sometimes kilometres
    // under the city, and from there the detailed tiles were never asked for. From above they are. Then it
    // comes down onto the street over a moment.
    // It comes down ONCE. Going back up whenever the ground moved again made a loop downtown: near the
    // street the detailed tiles show a roof, from the anchor height the coarser ones show the street under
    // it, so the bike went up and down between the two for as long as the settling lasted (Columbus,
    // 2026-11-17: 10 s of it, then the street was lost).
    if (!ground.ready && !this._descended) {
      this._groundY = 0;
      this._landing = true;
    } else if (this._landing || !ground.ready) {
      this._descended = true;
      this._landing = true;
      this._groundY += (ground.groundY - this._groundY) * Math.min(1, dt * 4);
      if (ground.ready && Math.abs(ground.groundY - this._groundY) < 0.3) { this._groundY = ground.groundY; this._landing = false; }
    } else {
      this._groundY = ground.groundY;
    }

    // Throttled ground-follow telemetry (~2/sec), only with ?ttdebug.
    this._dbgTimer = (this._dbgTimer || 0) + dt;
    if (this._dbg && (this._dbgTimer > 0.5 || r.resnapped)) {
      this._dbgTimer = 0;
      const picked = r.hit ? r.hit.point.y.toFixed(1) : 'none';
      console.log(`[Tourist GF] bikeXZ=(${bikePos.x.toFixed(0)},${bikePos.z.toFixed(0)}) ` +
        `bikeY=${bikePos.y.toFixed(1)} groundY=${this._groundY.toFixed(1)} ` +
        `hits=${r.hits} rejected=${r.rejected} pickedY=${picked} probeTop=${r.probeTop.toFixed(0)}` +
        (r.resnapped ? ` RESNAP=${r.resnapped} crumbs=${ground.breadcrumbs.length}` : '') +
        (ground.bump ? ` BUMP at ${ground.bump.distance.toFixed(1)}m` : ''));
    }

    const ease = Math.min(1, TOURIST_TUNE.groundLerp * dt);

    if (r.hit) {
      this._groundFound = true;
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
      // (While nothing drives the bike, a countdown, its quaternion is still the one tilted here last
      // frame. Tilting that again every frame turned the bike over on any slope: take our tilt off first.)
      const q = this._bike.group.quaternion;
      if (!this._wroteQ) { this._wroteQ = new THREE.Quaternion(); this._tiltInv = new THREE.Quaternion(); this._wroteQ.set(NaN, 0, 0, 1); }
      if (q.equals(this._wroteQ)) q.premultiply(this._tiltInv);
      this._tmpUpQ.setFromUnitVectors(UP, this._smoothNormal);
      this._tiltQ.slerp(this._tmpUpQ, ease);
      q.premultiply(this._tiltQ);
      this._wroteQ.copy(q);
      this._tiltInv.copy(this._tiltQ).invert();
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
  // #478/#484 · no Grandma's house or present pile on real streets (the
  // victory path calls both every tourist ride; without them it threw).
  startPresentStack() { return false; }
  /**
   * #402 §3 · a wall, trunk or crown right ahead (TouristGround._probeAhead)
   * is reported as a tree hit, so game.js gives it the same crash beat as a
   * procedural tree. The ground follower has already pushed the bike back out
   * of the face. Low things (cars, kerbs, hedges) are ridden over instead and
   * never reach here.
   */
  checkTreeCollision() { return { hit: !!this._ground.bump && !(this._crashGraceS > 0), tree: null }; }

  /**
   * #801 · where the bike stands up after a crash at (x, z): back along its own trail (5 m; further when
   * it is `repeat` crashes into the same spot), facing the way it was going, with a clear way ahead.
   * Starts the grace during which nothing counts as a crash.
   * @returns {{x:number, z:number, heading:number}|null}
   */
  crashSpot(x, z, repeat = 1, heading = 0) {
    const g = TOURIST_TUNE.ground;
    const steps = g.recoverBackM;
    const backM = steps[Math.min(steps.length, Math.max(1, repeat)) - 1];
    const spot = this._ground.recoverySpot(x, z, backM);
    this._crashGraceS = g.crashGraceS;
    // no trail to follow (the bike has only just been put here): straight back the way it was facing
    if (!spot) return { x: x - Math.sin(heading) * backM, z: z - Math.cos(heading) * backM, heading };
    this._groundY = this._ground.groundY;
    return { x: spot.x, z: spot.z, heading: spot.heading };
  }

  /** The bike has been put somewhere else (a restart): the trail it left is not the way it came. */
  clearTrail() {
    this._ground.breadcrumbs.length = 0;
    this._crashGraceS = 0;
  }

  /** Seconds of riding left in which nothing counts as a crash. */
  get crashGraceS() { return this._crashGraceS || 0; }

  /** #801 · a wall the bike is heading for: how far off it is, in metres (null = the way is clear). */
  get wallAhead() {
    const g = this._ground;
    if (this._crashGraceS > 0 || !this._bike || this._bike.fallen) return null;
    return g.warn ? g.warn.distance : null;
  }

  /**
   * #801 · the mark on the thing ahead: a red "!" on the wall the bike is heading for, so the crash reads
   * as coming. It stays on what was hit while the bike is down.
   */
  _updateWarning(dt) {
    const g = this._ground;
    const at = g.bump ? g.bump.point : (g.warn ? g.warn.point : null);
    const bike = this._bike;
    if (at && !(bike && bike.fallen)) {
      if (!this._warnMark) this._warnMark = this._makeWarnMark();
      this._warnMark.position.set(at.x, at.y + 2.4, at.z);   // above the riders' heads, not over them
      this._warnMark.visible = true;
      this._warnHold = 0.35;
    } else if (this._warnMark && this._warnMark.visible && !(bike && bike.fallen)) {
      this._warnHold -= dt;
      if (this._warnHold <= 0) this._warnMark.visible = false;
    }
    if (this._warnMark && this._warnMark.visible) {
      this._warnT = (this._warnT || 0) + dt;
      const k = 1.5 * (1 + 0.18 * Math.sin(this._warnT * 14));
      this._warnMark.scale.set(k, k, 1);
    }
  }

  _makeWarnMark() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    if (x) {
      x.fillStyle = 'rgba(214,40,40,.92)';
      x.beginPath(); x.arc(64, 64, 58, 0, Math.PI * 2); x.fill();
      x.lineWidth = 8; x.strokeStyle = '#fff'; x.stroke();
      x.fillStyle = '#fff'; x.font = '900 92px system-ui,sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText('!', 64, 70);
    }
    const tex = new THREE.CanvasTexture(c);
    const mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false }));
    mark.name = 'tourist-wall-warning';
    mark.renderOrder = 20;
    mark.visible = false;
    this.scene.add(mark);
    return mark;
  }
  // _startCountdown reseeds the world from the level; real streets have no seed.
  // (Without this _startCountdown threw before it built the RaceManager, so a
  // tourist ride rolled but never had a finish.)
  reseed() { return false; }

  dispose() {
    if (this._unwatchRefusals) { this._unwatchRefusals(); this._unwatchRefusals = null; }
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
    if (this._edgeEl) { this._edgeEl.remove(); this._edgeEl = null; }
    this.setDestination(null);
    if (this._warnMark) {
      this.scene.remove(this._warnMark);
      if (this._warnMark.material.map) this._warnMark.material.map.dispose();
      this._warnMark.material.dispose();
      this._warnMark = null;
    }
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
