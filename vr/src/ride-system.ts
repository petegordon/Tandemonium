// The VR SOLO RIDE loop (#425, phase V0).
//
// Builds the game's own world (js/world.js) and bike (js/bike-model.js) into
// the IWSDK scene, then each frame: read the lean (keyboard, or the angle of
// the handlebars held between your two hands in VR), step the bike with the
// bike model's own auto-speed (no pedalling), step the world, and put the
// player on the captain's seat. The rig only turns with the bike's heading:
// it never rolls with the lean, so the horizon stays level.
import {
  CanvasTexture,
  FogExp2,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
  createSystem,
} from '@iwsdk/core';
// Shared with the flat game (plain JS modules, see ../js).
// @ts-ignore: untyped JS module
import { World as RoadWorld } from '../../js/world.js';
// @ts-ignore: untyped JS module
import { BikeModel } from '../../js/bike-model.js';
// @ts-ignore: untyped JS module
import { CHOOSER_MODEL_PATH } from '../../js/config.js';
// @ts-ignore: untyped JS module
import { LEVELS } from '../../js/race-config.js';
import { HandlebarLean } from './handlebar-lean.js';

/** How far ahead of the bike's origin the captain sits (m, along the heading). */
const SEAT_FORWARD = 0.45;
/** Lifts a seated player (real head ~1.2 m) to riding eye height (~1.45 m). */
const SEAT_LIFT = 0.25;
/** Flat-screen camera height above the rig (no headset to track). */
const FLAT_EYE = 1.2;

export class RideSystem extends createSystem({}) {
  private road!: any;
  private bike!: any;
  private level!: any;
  private bars!: HandlebarLean;
  private keys = new Set<string>();
  private crank = 0;
  private fwd = new Vector3();
  private hud!: HTMLElement;
  private panel!: { canvas: HTMLCanvasElement; tex: CanvasTexture; mesh: Mesh };
  private frames = 0;
  private fpsT0 = 0;
  private fps = 0;
  private lastHud = 0;
  private finishedAt = 0;
  private started = performance.now();

  init(): void {
    const world = this.world;
    const scene = world.scene;

    // Sky and fog as in the flat game (js/game.js): the world module expects them.
    const sky = document.createElement('canvas');
    sky.width = 1; sky.height = 512;
    const g = sky.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#1a6abf'); grad.addColorStop(0.3, '#3e9ce0'); grad.addColorStop(0.6, '#8ecbf0');
    grad.addColorStop(0.85, '#c8e4f8'); grad.addColorStop(1, '#e4f0f8');
    g.fillStyle = grad; g.fillRect(0, 0, 1, 512);
    const skyTex = new CanvasTexture(sky);
    skyTex.magFilter = LinearFilter;
    scene.background = skyTex;
    scene.fog = new FogExp2(0xe4f0f8, 0.006);

    // Low tier: no shadows, fewest draw calls (Quest renders every frame twice).
    world.renderer.shadowMap.enabled = false;
    this.level = LEVELS.find((l: any) => l.id === 'grandma');
    this.road = new RoadWorld(scene, { lowEnd: true, tier: 'low', showRiders: false });
    this.bike = new BikeModel(scene, CHOOSER_MODEL_PATH);
    this.bike.roadPath = this.road.roadPath;
    this.road.setRaceMarkers(this.level, world.camera);

    this.bars = new HandlebarLean(world);
    this.buildFpsPanel();
    this.hud = document.getElementById('hud')!;

    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.started = performance.now();
  }

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.05);
    const inXR = !!this.world.session;

    // ── Lean: the handlebars in VR when both hands hold them, else the keyboard ──
    const barLean = inXR ? this.bars.update() : null;
    let lean = 0;
    if (barLean != null) lean = barLean;
    else {
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) lean -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) lean += 1;
    }

    // ── Bike + world (auto-speed: no pedalling in V0) ──
    const bike = this.bike;
    this.crank += bike.speed * dt * 2.2;
    bike.update(
      { crankAngle: this.crank, acceleration: 0, braking: false, wobble: 0 },
      { leanInput: lean, visualLean: lean, gyroActive: barLean != null },
      dt, true, true,
    );
    this.road.update(bike.position, bike.roadD, dt);
    if (!this.finishedAt && bike.distanceTraveled >= this.level.distance) this.finishedAt = performance.now();

    // ── Put the player on the captain's seat, turned with the bike only ──
    this.fwd.set(Math.sin(bike.heading), 0, Math.cos(bike.heading));
    const player = this.world.player;
    player.position.copy(bike.position).addScaledVector(this.fwd, SEAT_FORWARD);
    player.position.y += SEAT_LIFT;
    player.rotation.set(0, bike.heading + Math.PI, 0);   // the rig looks down its -Z
    if (!inXR) {
      this.world.camera.position.set(0, FLAT_EYE, 0);
      this.world.camera.rotation.set(-0.08, 0, 0);
    }

    // ── Frame rate (shown on screen, and on a panel by the bars in VR) ──
    const now = performance.now();
    if (!this.fpsT0) this.fpsT0 = now;
    this.frames++;
    if (now - this.fpsT0 >= 500) { this.fps = Math.round((this.frames * 1000) / (now - this.fpsT0)); this.frames = 0; this.fpsT0 = now; }
    if (now - this.lastHud > 250) {
      this.lastHud = now;
      const info = this.world.renderer.info;
      const lines = [
        `FPS ${this.fps}   ${inXR ? 'VR' : 'flat'}`,
        `lean ${lean.toFixed(2)}  ${barLean != null ? 'bars' : 'keys'}`,
        `speed ${bike.speed.toFixed(1)} m/s   ${Math.min(bike.distanceTraveled, this.level.distance).toFixed(0)} / ${this.level.distance} m`,
        `draws ${info.render.calls}   tris ${Math.round(info.render.triangles / 1000)}k`,
      ];
      if (this.finishedAt) lines.push(`Grandma's! ${((this.finishedAt - this.started) / 1000).toFixed(1)} s`);
      this.hud.textContent = lines.join('\n');
      this.drawPanel(lines, this.bars.status);
      if (bike.group && bike.group.children.length) document.getElementById('splash')?.classList.add('gone');
    }
    this.panel.mesh.visible = inXR;
    void time;
  }

  /** A small readout below the bars, for checking frame rate on the headset. */
  private buildFpsPanel(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 160;
    const tex = new CanvasTexture(canvas);
    const mesh = new Mesh(new PlaneGeometry(0.32, 0.1), new MeshBasicMaterial({ map: tex, transparent: true, fog: false, depthTest: false }));
    mesh.renderOrder = 10;
    mesh.position.set(0, 0.62, -0.5);
    mesh.rotation.x = -0.6;
    this.world.player.add(mesh);
    this.panel = { canvas, tex, mesh };
  }

  private drawPanel(lines: string[], bars: string): void {
    const { canvas, tex } = this.panel;
    const c = canvas.getContext('2d')!;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = 'rgba(0,0,0,0.65)';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = '#cfe';
    c.font = '600 26px monospace';
    [lines[0], lines[1], bars].forEach((t, i) => c.fillText(t, 14, 40 + i * 44));
    tex.needsUpdate = true;
  }
}
