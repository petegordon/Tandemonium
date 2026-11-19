// ============================================================
// TOKEN RUNS (pure) — where the Tandem Tokens sit on a regular road (#512)
// ============================================================
//
// A token is the Slingshot's gold disc, worth TOKEN_VALUE, collected on
// contact like a present but with NO speed boost (the presents keep the 3 s
// boost). Tokens come in runs of TOKENS_PER_RUN along the road, so a run reads
// as a line from the chase camera. Tutorial 1 run, Grandma's 4, Daily Ride 8;
// the Daily Ride's layout comes from the day seed so everyone meets the same
// runs.
//
// About half the runs are a CHOICE; the rest are free runs down the middle so
// every ride pays something:
//   'present'  tokens in one lane, a present in the other — the boost or the money;
//   'goose'    a run along the road's edge beside a goose flock — grab it and
//              risk the scatter, or swing wide and lose it;
//   'arc'      a curved run that bulges out to a lane and back — a tandem
//              leaning together follows it all the way through;
//   'double'   the one late run near the finish, worth DOUBLE_VALUE a token —
//              late in the ride is where crashes happen;
//   'free'     a straight run in one lane, clear of everything.
//
// Pure and DOM-free: given the road, a seed and where the presents, obstacles
// and geese already are, it returns the runs and a flat list of token
// positions for js/collectibles.js. The game glue is Game._setupTokens.

export const TOKEN_VALUE = 5;
export const DOUBLE_VALUE = 10;
export const TOKENS_PER_RUN = 5;
/** Metres between the tokens of a straight run (a run is 12 m long). */
export const TOKEN_SPACING = 3;
/** The lean-together arc is longer, so the bend is gentle enough to ride. */
export const ARC_SPACING = 4;
/** A lane: this far from the centre line. */
export const LANE = 1.5;
/** The road's edge lane, beside the goose verge (the road is 5 m wide). */
export const EDGE_LANE = 1.8;
export const MAX_OFFSET = EDGE_LANE;
/** No tokens in the first metres (the start) or the last (the finish line). */
export const START_CLEAR = 30;
export const FINISH_CLEAR = 12;
/** A run needs this much lateral room from a present or pylon in its window. */
export const CLEARANCE = 2.0;
/** Metres either side of a run that count as its window. */
export const WINDOW = 3;
/** Checkpoint gates stand clear of every run by this much. */
export const CHECKPOINT_CLEAR = 10;
/** A present must sit at least this far off the centre for a tokens-or-present run. */
export const PRESENT_MIN_OFFSET = 1.0;
/** Geese within this many metres of each other are one flock. */
export const FLOCK_GAP = 10;

export const KIND = Object.freeze({ FREE: 'free', PRESENT: 'present', GOOSE: 'goose', ARC: 'arc', DOUBLE: 'double' });
export const CHOICE_KINDS = Object.freeze([KIND.PRESENT, KIND.GOOSE, KIND.ARC]);

/** Runs per road (Pete, #512). Other roads: about one run per 60 m. */
export const RUNS_BY_LEVEL = Object.freeze({ tutorial: 1, grandma: 4, daily: 8 });

export function runsFor(levelId, distance) {
  if (levelId in RUNS_BY_LEVEL) return RUNS_BY_LEVEL[levelId];
  const usable = (distance || 0) - START_CLEAR - FINISH_CLEAR;
  return usable < runLength(KIND.FREE) ? 0 : Math.max(1, Math.round(usable / 60));
}

/** How long a run of this kind is, first token to last. */
export function runLength(kind) {
  return (TOKENS_PER_RUN - 1) * (kind === KIND.ARC ? ARC_SPACING : TOKEN_SPACING);
}

/** The most a road can pay in tokens (the double run counts double). */
export function maxTokenPay(runs) {
  return runs.reduce((a, r) => a + r.tokens.reduce((b, t) => b + t.value, 0), 0);
}

// mulberry32: a small, well-mixed PRNG (the collectibles' LCG carries a seed's
// low bits almost unchanged into its first draw, which would make the day's
// first run land in the same place most days).
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The choice kinds for n runs: floor(n / 2) of them. One is always the double
 * run (the last run on the road); the others cycle through CHOICE_KINDS in a
 * seeded order. The remaining runs are free.
 */
export function choiceKinds(n, rng) {
  const choices = Math.floor(n / 2);
  if (choices === 0) return [];
  const pool = [];
  while (pool.length < choices - 1) pool.push(...shuffle(CHOICE_KINDS, rng));
  return [KIND.DOUBLE, ...pool.slice(0, choices - 1)];
}

/** Group the roadside geese into flocks: { start, end, side }. */
export function flocksFrom(geese) {
  const sorted = (geese || []).filter(g => Number.isFinite(g.d)).slice().sort((a, b) => a.d - b.d);
  const flocks = [];
  for (const g of sorted) {
    const side = g.offset < 0 ? -1 : 1;
    const last = flocks[flocks.length - 1];
    if (last && g.d - last.end <= FLOCK_GAP && last.side === side) last.end = g.d;
    else flocks.push({ start: g.d, end: g.d, side });
  }
  return flocks;
}

/** The tokens of a run: straight in one lane, or an arc out to a lane and back. */
function tokensOf(kind, start, lane, value) {
  const spacing = kind === KIND.ARC ? ARC_SPACING : TOKEN_SPACING;
  const out = [];
  for (let k = 0; k < TOKENS_PER_RUN; k++) {
    const offset = kind === KIND.ARC ? lane * Math.sin((k / (TOKENS_PER_RUN - 1)) * Math.PI) : lane;
    out.push({ d: start + k * spacing, offset: round2(offset), value });
  }
  return out;
}

const round2 = x => Math.round(x * 100) / 100 + 0;   // + 0: no -0 from sin(π)

/**
 * Items (presents, pylons) that would sit in a run's path: within WINDOW
 * metres along the road of one of its tokens and within CLEARANCE of that
 * token's offset (so an arc is checked token by token as it bends). `ignore`
 * is the present a tokens-or-present run is deliberately placed beside.
 */
export function clashes(items, tokens, ignore = null) {
  let n = 0;
  for (const it of items) {
    if (it === ignore) continue;
    if (tokens.some(t => Math.abs(it.d - t.d) <= WINDOW && Math.abs(it.offset - t.offset) < CLEARANCE)) n++;
  }
  return n;
}

function nearCheckpoint(checkpoints, start, end) {
  return checkpoints.some(c => c > start - CHECKPOINT_CLEAR && c < end + CHECKPOINT_CLEAR);
}

/**
 * Lay out the token runs for one road.
 *
 * @param {object} p
 * @param {string}  p.levelId     'tutorial' | 'grandma' | 'daily' | …
 * @param {number}  p.distance    road length in metres
 * @param {number}  p.seed        js/daily-seed.js · itemSeed(level, SALT.tokens, …)
 * @param {{d:number, offset:number}[]} [p.presents]
 * @param {{d:number, offset:number}[]} [p.obstacles]
 * @param {{d:number, offset:number}[]} [p.geese]      roadside geese (offset: verge side)
 * @param {number[]} [p.checkpoints]                   checkpoint gate distances
 * @returns {{ runs: Array<{kind, start, end, lane, value, tokens}>, tokens: Array<{d, offset, value, run}>, available: number, maxPay: number }}
 */
export function planTokenRuns({ levelId, distance, seed, presents = [], obstacles = [], geese = [], checkpoints = [] } = {}) {
  const n = runsFor(levelId, distance);
  const empty = { runs: [], tokens: [], available: 0, maxPay: 0 };
  if (!n || !(distance > START_CLEAR + FINISH_CLEAR)) return empty;
  const rng = makeRng(seed);
  const items = [...presents, ...obstacles];
  const flocks = flocksFrom(geese);
  const lo = START_CLEAR, hi = distance - FINISH_CLEAR;
  const segLen = (hi - lo) / n;
  const segment = i => ({ start: lo + i * segLen, end: lo + (i + 1) * segLen });
  const runs = new Array(n).fill(null);
  const used = new Set();   // presents already paired with a run

  // A tokens-or-present run in this segment: the present at the middle token,
  // the tokens in the other lane. Null when the segment has no clean candidate.
  const placePresent = (seg) => {
    const half = runLength(KIND.PRESENT) / 2;
    const cands = presents.filter(p => !used.has(p) && Math.abs(p.offset) >= PRESENT_MIN_OFFSET
      && p.d - half >= seg.start && p.d + half <= seg.end);
    for (const p of shuffle(cands, rng)) {
      const lane = (p.offset < 0 ? 1 : -1) * LANE;
      const start = round2(p.d - half), end = p.d + half;
      if (clashes(items, tokensOf(KIND.PRESENT, start, lane, TOKEN_VALUE), p) || nearCheckpoint(checkpoints, start, end)) continue;
      used.add(p);
      return { start, lane, present: { d: p.d, offset: p.offset } };
    }
    return null;
  };

  // A tokens-or-a-clean-ride run: along the road's edge on the flock's side,
  // centred on the flock.
  const placeGoose = (seg) => {
    const len = runLength(KIND.GOOSE);
    const cands = flocks.filter(f => { const mid = (f.start + f.end) / 2; return mid - len / 2 >= seg.start && mid + len / 2 <= seg.end; });
    for (const f of shuffle(cands, rng)) {
      const start = round2((f.start + f.end) / 2 - len / 2), end = start + len;
      const lane = f.side * EDGE_LANE;
      if (clashes(items, tokensOf(KIND.GOOSE, start, lane, TOKEN_VALUE)) || nearCheckpoint(checkpoints, start, end)) continue;
      return { start, lane };
    }
    return null;
  };

  // Free, arc and double runs: scan the segment from a seeded spot for a clear
  // window, trying the lanes in seeded order; the double run hunts from the
  // segment's far end so it lands near the finish. `strict`: return null
  // rather than a spot with clashes (an arc that finds no clean bend becomes a
  // free run; a free run on a very busy segment takes the fewest clashes).
  const scan = (kind, seg, value, strict) => {
    const len = runLength(kind);
    const span = Math.max(0, segLen - len);
    const preferred = kind === KIND.DOUBLE ? seg.start + span - rng() * Math.min(10, span)
      : seg.start + rng() * span;
    const lanes = kind === KIND.ARC ? shuffle([LANE, -LANE], rng) : shuffle([0, LANE, -LANE], rng);
    let best = null;
    for (let step = 0; step * 2 <= span; step++) {
      for (const dir of step === 0 ? [0] : [-1, 1]) {
        const start = round2(Math.min(seg.start + span, Math.max(seg.start, preferred + dir * step * 2)));
        const end = start + len;
        if (nearCheckpoint(checkpoints, start, end)) continue;
        for (const lane of lanes) {
          const c = clashes(items, tokensOf(kind, start, lane, value));
          if (c === 0) return { start, lane };
          if (!best || c < best.c) best = { c, start, lane };
        }
      }
    }
    if (strict) return null;
    return best ? { start: best.start, lane: best.lane } : { start: round2(preferred), lane: 0 };
  };

  const finish = (i, kind, placed) => {
    const value = kind === KIND.DOUBLE ? DOUBLE_VALUE : TOKEN_VALUE;
    const tokens = tokensOf(kind, placed.start, placed.lane, value);
    runs[i] = { kind, start: placed.start, end: tokens[tokens.length - 1].d, lane: placed.lane, value, tokens,
                ...(placed.present ? { present: placed.present } : {}) };
  };

  // The choice runs first — each takes the first open segment (in seeded
  // order) where it can be laid cleanly; the double run owns the last segment.
  for (const kind of choiceKinds(n, rng)) {
    if (kind === KIND.DOUBLE) { finish(n - 1, kind, scan(kind, segment(n - 1), DOUBLE_VALUE, false)); continue; }
    const open = shuffle(runs.map((r, i) => (r ? -1 : i)).filter(i => i >= 0), rng);
    for (const i of open) {
      const seg = segment(i);
      const placed = kind === KIND.PRESENT ? placePresent(seg)
        : kind === KIND.GOOSE ? placeGoose(seg)
        : scan(kind, seg, TOKEN_VALUE, true);
      if (placed) { finish(i, kind, placed); break; }
    }
  }
  // Free runs fill what is left.
  for (let i = 0; i < n; i++) if (!runs[i]) finish(i, KIND.FREE, scan(KIND.FREE, segment(i), TOKEN_VALUE, false));

  const flat = [];
  runs.forEach((r, idx) => { for (const t of r.tokens) flat.push({ ...t, run: idx }); });
  flat.sort((a, b) => a.d - b.d);
  return { runs, tokens: flat, available: flat.length, maxPay: maxTokenPay(runs) };
}
