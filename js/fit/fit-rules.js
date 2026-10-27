// ============================================================
// FIT RULES — tolerances for the bike × geese fit (pure, no three.js)
// ============================================================
//
// #505 · the fit viewer (tools/fit-viewer) and the headless fit check (scripts/smoke-fit.mjs)
// measure the in-game assembly in bike metres (the goose_tandem.glb units; the game scales
// the whole assembly by one factor, so every relationship is the same). This module says what
// the numbers must be. Positive = gap / clearance, negative = sink / penetration, unless noted.

/** Hip joints above the saddle-top socket (goose-rider-clips HIP_UP): the game's own placement. */
export const HIP_UP = 0.11;

export const TOL = {
  hipAboveSaddle: { target: HIP_UP, tol: 0.005 },  // the root sits where seatOffset put it
  socketOnSaddle: { min: -0.01, max: 0.01 },       // socket y − saddle mesh top under it
  seatProbe: { min: -0.03, max: 0.01 },            // lowest body point over the saddle's rear band − saddle top
  noseProbe: { min: -0.12, max: 0.03 },            // the same over the nose: the thighs wrap it (deep by nature)
  footOnPedal: { max: 0.012 },                      // |ball of foot − pedal pin (+ sole)|, every crank step
  handOnGrip: { min: 0.06, max: 0.16 },             // |hand joint − grip socket| (handshake grip)
  wheelPenetration: { maxVerts: 0 },                // bike vertices inside the rear tyre's tread band
  wheelClearance: { min: 0.004 },                   // nearest bike part to the tyre surface
  clothInWheel: { maxVerts: 30 },                   // skirt / coat vertices inside the rear wheel disc
};

/** A judged line of the report: {name, value, pass, note}. value is in bike metres. */
function line(name, value, pass, note) {
  return { name, value: round(value), pass: !!pass, note };
}

export function round(v, d = 4) {
  return Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v;
}

/**
 * Judge a fit report (fit-measure.js measureFit / sweepCrank shape) against TOL.
 * @returns {{lines: Array<{name:string,value:number,pass:boolean,note?:string}>, pass: boolean}}
 */
export function judge(report) {
  const lines = [];
  const bike = report.bike || {};
  if (bike.rearWheel) {
    const w = bike.rearWheel;
    lines.push(line('rear wheel · bike vertices in the tread band', w.inside,
      w.inside <= TOL.wheelPenetration.maxVerts, (w.penetrating || []).map(p => `${p.mesh} ${Math.round(p.depth * 1000)} mm`).join(', ')));
    lines.push(line('rear wheel · nearest bike part (m)', w.clearance, w.clearance >= TOL.wheelClearance.min, w.nearest));
  }
  for (const [seat, s] of Object.entries(bike.saddles || {})) {
    lines.push(line(`${seat} · socket above saddle mesh (m)`, s.socketAboveMesh,
      s.socketAboveMesh >= TOL.socketOnSaddle.min && s.socketAboveMesh <= TOL.socketOnSaddle.max));
  }
  for (const [seat, r] of Object.entries(report.riders || {})) {
    if (r.hipAboveSaddle !== undefined) {
      lines.push(line(`${seat} · hip joints above socket (m)`, r.hipAboveSaddle,
        Math.abs(r.hipAboveSaddle - TOL.hipAboveSaddle.target) <= TOL.hipAboveSaddle.tol, `target ${TOL.hipAboveSaddle.target}`));
    }
    if (r.seatProbe !== undefined) {
      lines.push(line(`${seat} · bottom over saddle top (m, − sinks in)`, r.seatProbe,
        r.seatProbe >= TOL.seatProbe.min && r.seatProbe <= TOL.seatProbe.max, r.seatProbeMesh));
    }
    if (r.noseProbe !== undefined) {
      lines.push(line(`${seat} · thighs over saddle nose (m, − sinks in)`, r.noseProbe,
        r.noseProbe >= TOL.noseProbe.min && r.noseProbe <= TOL.noseProbe.max, r.noseProbeMesh));
    }
    for (const side of ['L', 'R']) {
      const f = r.foot && r.foot[side];
      if (f) lines.push(line(`${seat} · ${side} foot off the pedal (m)`, f.err, f.err <= TOL.footOnPedal.max, f.crank !== undefined ? `worst at crank ${f.crank}°` : undefined));
      const h = r.hand && r.hand[side];
      if (h) lines.push(line(`${seat} · ${side} hand to grip (m)`, h.dist, h.dist >= TOL.handOnGrip.min && h.dist <= TOL.handOnGrip.max));
    }
    if (r.clothInWheel !== undefined) {
      lines.push(line(`${seat} · cloth vertices in the rear wheel`, r.clothInWheel, r.clothInWheel <= TOL.clothInWheel.maxVerts, r.clothInWheelMesh));
    }
  }
  return { lines, pass: lines.every(l => l.pass) };
}

/**
 * The viewer's nudges as a JSON patch. HIP_UP and the per-seat dy / dz / scale are the game's
 * placement (goose-rider-clips HIP_UP, GooseRiders._seat); saddleDy is the saddle MESH alone
 * (the socket, hips and feet stay), i.e. the saddle point to move in tandemonium-claude-3d's
 * frame spec, with HIP_UP growing by the same amount. Zero nudges are left out.
 */
export function nudgePatch(n) {
  const out = {};
  if (n.hipUp !== undefined && Math.abs(n.hipUp - HIP_UP) > 1e-6) out.HIP_UP = round(n.hipUp);
  for (const seat of ['Captain', 'Stoker']) {
    const s = (n.seats && n.seats[seat]) || {};
    const e = {};
    if (s.dy) e.dy = round(s.dy);
    if (s.dz) e.dz = round(s.dz);
    if (s.scale && Math.abs(s.scale - 1) > 1e-6) e.scale = round(s.scale);
    if (s.saddleDy) e.saddleDy = round(s.saddleDy);
    if (s.saddleDz) e.saddleDz = round(s.saddleDz);
    if (s.saddleScale && Math.abs(s.saddleScale - 1) > 1e-6) e.saddleScale = round(s.saddleScale);
    if (Object.keys(e).length) (out.seats = out.seats || {})[seat] = e;
  }
  return out;
}
