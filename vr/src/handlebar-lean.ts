// Steering by the handlebars (#425, S1): hold your hands out in front of you as
// if gripping bars; the roll of the line between them is the lean. Left hand
// lower = lean left. Same idea as tilting a phone held like handlebars.
import { CylinderGeometry, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from '@iwsdk/core';
import type { World } from '@iwsdk/core';

/** Bar roll (degrees) that gives full lean. */
const FULL_LEAN_DEG = 30;
/** Small wobbles of your hands don't steer. */
const DEADZONE_DEG = 2;
/** Hands closer than this aren't holding bars (m). */
const MIN_SPAN = 0.2;

export class HandlebarLean {
  /** Short text for the readout: what the bars see. */
  status = 'bars: no hands';
  private world: World;
  private l = new Vector3();
  private r = new Vector3();
  private mid = new Vector3();
  private dir = new Vector3();
  private bar: Mesh;
  private up = new Vector3(0, 1, 0);
  private q = new Quaternion();
  private smooth = 0;

  constructor(world: World) {
    this.world = world;
    // A see-through bar drawn between your hands while you hold it.
    this.bar = new Mesh(
      new CylinderGeometry(0.014, 0.014, 1, 12),
      new MeshBasicMaterial({ color: 0x44ff66, transparent: true, opacity: 0.55, fog: false }),
    );
    this.bar.visible = false;
    world.player.add(this.bar);
  }

  /** The lean (-1..1) from the bars, or null when they aren't held. Call once per frame in XR. */
  update(): number | null {
    const session = this.world.session;
    const player = this.world.player;
    let left = false, right = false, handsOnly = true;
    for (const src of session ? session.inputSources : []) {
      // Controllers: hold the grip button. Tracked hands: the hand is there
      // (V2 adds a real grasp check, as SandQuest's whole-hand grip does).
      const holding = src.hand ? true : !!src.gamepad?.buttons[1]?.pressed;
      if (!src.hand) handsOnly = false;
      if (!holding) continue;
      if (src.handedness === 'left') left = true;
      if (src.handedness === 'right') right = true;
    }
    if (!left || !right) {
      this.bar.visible = false;
      this.status = `bars: ${left || right ? 'one hand' : 'no hands'}${handsOnly ? '' : ' (hold grip)'}`;
      return null;
    }
    player.gripSpaces.left.getWorldPosition(this.l);
    player.gripSpaces.right.getWorldPosition(this.r);
    player.worldToLocal(this.l);
    player.worldToLocal(this.r);
    this.dir.subVectors(this.r, this.l);
    const span = this.dir.length();
    if (span < MIN_SPAN) { this.bar.visible = false; this.status = 'bars: hands too close'; return null; }

    // Roll: how much higher the right hand is than the left, over their spread.
    const flat = Math.hypot(this.dir.x, this.dir.z);
    const deg = (Math.atan2(this.dir.y, flat) * 180) / Math.PI;
    const mag = Math.max(0, Math.abs(deg) - DEADZONE_DEG);
    const target = Math.max(-1, Math.min(1, (-Math.sign(deg) * mag) / FULL_LEAN_DEG));
    this.smooth += (target - this.smooth) * 0.35;

    // Draw the bar from hand to hand.
    this.mid.addVectors(this.l, this.r).multiplyScalar(0.5);
    this.bar.position.copy(this.mid);
    this.bar.scale.set(1, span, 1);
    this.q.setFromUnitVectors(this.up, this.dir.normalize());
    this.bar.quaternion.copy(this.q);
    this.bar.visible = true;
    this.status = `bars: ${deg.toFixed(0)}°`;
    return this.smooth;
  }
}
