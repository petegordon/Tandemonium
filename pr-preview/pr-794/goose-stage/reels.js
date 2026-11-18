// ============================================================
// GOOSE STAGE REELS — scripted shots for social posts (docs: tandemonium-claude-3d docs/goose-studio-plan.md §6)
// ============================================================
//
// A reel = cast + a timeline of [time, action] + a camera function. Everything is driven by the director's
// fixed time step and a seeded random, so a capture (scripts/goose-reel.mjs) is frame-exact and repeatable.
//   setup(ctx)        load / place the cast (ctx.load(name) -> GooseActor already in the scene)
//   events            [[t, (ctx) => void], ...]  (may be built in setup: ctx.at(t, fn))
//   camera(ctx, t)    place ctx.camera every frame
//   music             { file, gain, fadeOut } -- mixed offline by the capture; played live in the page

import * as THREE from 'three';

export const PAIRS = {
  victorian: { captain: 'goose_captain', stoker: 'goose_stoker_victorian' },
  cyclists: { captain: 'goose_captain_cyclist', stoker: 'goose_stoker_cyclist' },
  fancy: { captain: 'goose_captain_fancy', stoker: 'goose_stoker' },
  georgian: { captain: 'goose_captain_georgian', stoker: 'goose_stoker_georgian' },
};

/** Half-width of the view at depth `dist` from the camera. */
function halfWidth(camera, dist) {
  return Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist * camera.aspect;
}

function shake(ctx, t, t0, dur, amp) {
  if (t < t0 || t > t0 + dur) return;
  const k = 1 - (t - t0) / dur;
  const n = ctx.noise;
  ctx.camera.position.x += (n(t * 37.1) - 0.5) * amp * k;
  ctx.camera.position.y += (n(t * 41.7 + 3) - 0.5) * amp * k;
}

// ---------------------------------------------------------------- 0. intro (Pete, 2026-10-15)
// The male enters from the left, the female from the right; they meet in the middle, look at each other,
// then both turn to face the camera and hold.
export const intro = {
  title: 'Intro: they meet in the middle',
  music: { file: 'assets/Professor Umlaut.mp3', gain: 0.55, fadeOut: 1.2 },
  async setup(ctx) {
    const cast = PAIRS[ctx.pair] || PAIRS.victorian;
    const m = await ctx.load(cast.captain), f = await ctx.load(cast.stoker);
    ctx.setBackdrop(ctx.pair);
    const cam = ctx.camera;
    const vertical = cam.aspect < 1;
    cam.fov = vertical ? 30 : 24;
    const dist = vertical ? 6.4 : 5.2;
    this.dist = dist;
    cam.position.set(0, vertical ? 1.15 : 1.05, dist);
    cam.lookAt(0, vertical ? 1.1 : 0.95, 0);
    cam.updateProjectionMatrix();
    // walk distances: whole walk cycles, starting just outside the frame edge; she starts one cycle later
    const MEET = 0.52;                                   // each goose stops this far from centre
    const need = halfWidth(cam, dist) + 0.55 - MEET;     // centre -> fully off-screen
    const meta = m.meta;
    const cyc = meta.clips.walk.root_speed * meta.clips.walk.duration;
    const loopsM = Math.max(1, Math.ceil((need + cyc - (meta.clips.walk_start.root_dist + meta.clips.walk_stop.root_dist)) / cyc));
    const distM = m.constructor.walkDistance(m.meta, loopsM);
    const distF = f.constructor.walkDistance(f.meta, loopsM - 1);
    m.root.position.set(-(MEET + distM), 0, 0); m.setHeading(Math.PI / 2);
    f.root.position.set(MEET + distF, 0, 0); f.setHeading(-Math.PI / 2);
    m.lookAt(null); f.lookAt(null);
    const t0 = 0.4;
    const arrive = t0 + m.walkDuration(loopsM);
    ctx.at(t0, () => m.walk(distM));
    ctx.at(t0 + meta.clips.walk.duration, () => f.walk(distF));
    ctx.at(t0 + 1.6, () => m.lookAt(ctx.camera));          // a glance at us on the way in
    ctx.at(t0 + 2.3, () => m.lookAt(null));
    ctx.at(arrive - 0.15, () => { m.lookAt(f.bones.Head); f.lookAt(m.bones.Head); });
    ctx.at(arrive + 0.75, () => { m.blink(); });
    ctx.at(arrive + 0.85, () => { f.blink(); });
    ctx.at(arrive + 1.25, () => { m.lookAt(ctx.camera); f.lookAt(ctx.camera); });   // eyes snap to the lens first
    ctx.at(arrive + 1.45, () => { m.turnTo(0); f.turnTo(0); });
    ctx.at(arrive + 3.3, () => { m.blink(); f.blink(); });
    this.duration = arrive + 1.45 + 1.0 + 2.2;
    this.lead = m;
    this.edge = halfWidth(cam, dist);
  },
  // start filming as the gent's beak reaches the frame edge
  prerollUntil(ctx) { void ctx; return this.lead.root.position.x > -(this.edge + 0.3); },
  camera(ctx) {
    void ctx;    // locked off
  },
};

// ---------------------------------------------------------------- 1. "It's watching you"
// One goose, the camera drifts round and pushes in; its eyes never leave the lens. Then: HONK.
export const watching = {
  title: "It's watching you",
  music: { file: 'assets/Mischief Maker.mp3', gain: 0.35, fadeOut: 0.8 },
  duration: 8.0,
  async setup(ctx) {
    const g = await ctx.load(ctx.goose || 'goose_captain_fancy');
    ctx.setBackdrop(g.info.pair);
    g.root.position.set(0, 0, 0); g.setHeading(0);
    this.g = g;
    ctx.camera.fov = 28;
    ctx.at(0.0, () => g.lookAt(ctx.camera));
    ctx.at(2.1, () => g.blink());
    ctx.at(4.0, () => g.blink());
    ctx.at(5.55, () => ctx.honk(g));
    ctx.at(6.5, () => g.blink());
  },
  camera(ctx, t) {
    const head = this.g.headPosition(new THREE.Vector3());
    const u = THREE.MathUtils.smoothstep(t, 0, 5.2);
    const ang = THREE.MathUtils.lerp(-0.75, -0.05, u);
    const r = THREE.MathUtils.lerp(3.6, 1.45, u);
    const y = THREE.MathUtils.lerp(1.25, head.y + 0.05, u);
    const look = new THREE.Vector3(0, THREE.MathUtils.lerp(1.05, head.y + 0.02, u), 0);
    let lunge = 0;
    if (t > 5.5) lunge = Math.sin(Math.min(1, (t - 5.5) / 0.35) * Math.PI) * 0.18;   // the honk punches in
    ctx.camera.position.set(Math.sin(ang) * (r - lunge), y, Math.cos(ang) * (r - lunge));
    ctx.camera.lookAt(look);
    shake(ctx, t, 5.55, 0.45, 0.03);
  },
};

// ---------------------------------------------------------------- 2. "Getting dressed" (Victorian)
// From naked goose to Victorian gent, one garment per beat; hat tip, honk, twirl.
export const dressed = {
  title: 'Getting dressed',
  music: { file: 'assets/Professor Umlaut.mp3', gain: 0.55, fadeOut: 1.0 },
  duration: 10.5,
  async setup(ctx) {
    const g = await ctx.load(ctx.goose || 'goose_captain_fancy');
    ctx.setBackdrop(g.info.pair);
    g.root.position.set(0, 0, 0); g.setHeading(0);
    g.wearAll(false);
    this.g = g;
    ctx.camera.fov = 28;
    const order = ['boots', 'socks', 'breeches', 'skirt', 'shirt', 'bodice', 'waistcoat', 'coat', 'jacket', 'cardigan',
      'bowtie', 'necktie', 'collar', 'pancollar', 'cuffs', 'gloves', 'hat'].filter(p => g.pieces.includes(p));
    for (const p of g.pieces) if (!order.includes(p)) order.splice(order.length - 1, 0, p);
    const beat = 0.5, start = 0.9;
    this.beats = [];
    ctx.at(0.2, () => g.play('admire'));
    order.forEach((p, i) => {
      const t = start + i * beat;
      this.beats.push(t);
      ctx.at(t, () => g.setWorn(p, true));
    });
    const done = start + order.length * beat;
    ctx.at(2.6, () => g.lookAt(ctx.camera));
    ctx.at(done + 0.1, () => g.play(g.info.sex === 'f' ? 'curtsy' : 'hat_tip'));
    ctx.at(done + 0.85, () => ctx.honk(g));
    ctx.at(done + 2.3, () => g.play('twirl'));
    ctx.at(done + 4.0, () => g.blink());
    this.duration = done + 4.8;
  },
  camera(ctx, t) {
    const ang = -0.35 + 0.5 * THREE.MathUtils.smoothstep(t, 0, this.duration);
    let r = 4.3;
    for (const b of this.beats) if (t >= b && t < b + 0.25) r -= 0.12 * Math.sin((t - b) / 0.25 * Math.PI);   // beat punch
    ctx.camera.position.set(Math.sin(ang) * r, 1.15, Math.cos(ang) * r);
    ctx.camera.lookAt(0, 0.98, 0);
  },
};

export const REELS = { intro, watching, dressed };
