// ============================================================
// RACE CONFIG — level definitions
// ============================================================

// Medal thresholds are derived from the difficulty presets' time budgets (B-3).
import { DIFFICULTY_PRESETS } from './config.js';

export const LEVELS = [
  {
    id: 'tutorial',
    name: 'Tutorial',
    distance: 225,
    collectibles: 'presents',
    checkpointInterval: 225,   // single checkpoint = entire ride
    icon: '\uD83D\uDEB4',        // 🚴
    description: 'Master pedaling and steering!',
    isTutorial: true,
    coaching: { dodgeArrow: true, collectIndicator: true },
    timerEnabled: false,
    treeCollision: false,
    motionAdaptation: false
  },
  {
    id: 'grandma',
    name: "Grandma's",
    distance: 250,
    collectibles: 'presents',
    checkpointInterval: 62,
    icon: '\uD83C\uDFE0',        // 🏠
    description: 'Grandma called — she needs her presents!'
  },
  {
    id: 'castle',
    name: 'The Castle',
    distance: 500,
    collectibles: 'gems',
    checkpointInterval: 125,
    icon: '\uD83C\uDFF0',        // 🏰
    description: 'The King awaits! Collect gems on the road to glory!'
  },
  {
    // C-2 · Today's Road. The seed is NOT stored here: it is resolved at
    // selection time by js/daily-ride.js, so this object never carries a stale
    // date from whenever the page happened to load.
    id: 'daily',
    name: "Today's Road",
    distance: 500,
    collectibles: 'presents',
    checkpointInterval: 125,
    icon: '📅',        // 📅
    description: 'A new road every day. Same for everyone.',
    isDaily: true,
    fixedDifficulty: 'adventurous',
    treeCollision: true
  }
];

export function getLevelById(id) {
  return LEVELS.find(l => l.id === id) || LEVELS[0];
}

// ============================================================
// A-5 · Per-difficulty instruction text
// ============================================================
//
// The pre-ride overlay used to say "Don't lean too far or you'll crash!" on
// every difficulty, including the two where safety mode makes falling
// impossible. Each preset now states what is actually true of itself, and
// whether safety is on to begin with.
export const DIFFICULTY_INSTRUCTIONS = {
  tutorial: {
    title: 'Learn to ride',
    lines: [
      'Alternate the LEFT and RIGHT pedals to ride.',
      'Lean to steer. You cannot fall here — take your time.'
    ]
  },
  chill: {
    title: 'Chill',
    lines: [
      'Alternate the LEFT and RIGHT pedals to ride.',
      'Lean to steer. You cannot fall on Chill — but you can go off-road and lose time.'
    ]
  },
  adventurous: {
    title: 'Adventurous',
    lines: [
      'Alternate the LEFT and RIGHT pedals to ride.',
      'Lean to steer. Lean too far and you will go down — the bike shakes first.',
      'Safety is OFF. Press SAFETY to turn it on.'
    ]
  },
  daredevil: {
    title: 'Daredevil',
    lines: [
      'Alternate the LEFT and RIGHT pedals to ride.',
      'Lean to steer. It falls fast and it barely helps you.',
      'Safety is OFF. Press SAFETY to turn it on.'
    ]
  }
};

/** Instruction text for a difficulty, falling back to Adventurous. */
export function getInstructions(difficultyName) {
  return DIFFICULTY_INSTRUCTIONS[difficultyName] || DIFFICULTY_INSTRUCTIONS.adventurous;
}

// ============================================================
// B-3 · Medal thresholds (finish time in ms)
// ============================================================
//
// SOURCE: these are provisional. A-1 (the analytics baseline) is meant to set
// them from the real finish-time distribution — p10 / p35 / p65 per
// level × difficulty — but it is blocked on `wrangler login`, so nothing has
// been read from the live data yet.
//
// Until then they are derived from THE GAME'S OWN CLOCK rather than from an
// independent guess at pace. The segment timer already encodes what the design
// considers a reasonable ride: 60 s per 250 m, scaled by the preset's
// timeMultiplier. So the medals are fractions of the time the game itself
// allows:
//
//   bronze = 90% of the clock — you finished, comfortably inside it
//   silver = 72%
//   gold   = 55%
//
// This matters more than it looks. The first version of this table derived
// medals from a guessed pace, and the result was that BRONZE WAS UNREACHABLE on
// five of nine level/difficulty combinations: the segment timer expired before
// a rider could finish that slowly. A medal nobody can earn is worse than no
// medal — it is a permanently greyed-out target telling the player they are bad
// at something the game refuses to let them do. Deriving from the clock makes
// that impossible by construction, and the unit test asserts it.
//
// WHEN A-1 RUNS: replace these with the measured percentiles, cite
// docs/analytics-baseline-2026-09.md here, and KEEP the reachability test. Do
// not tune them by feel — the point of a medal is that it means the same thing
// to everyone.
const MEDAL_FRACTION = { gold: 0.55, silver: 0.72, bronze: 0.90 };

/** The total time the segment timer allows for a whole clean run. */
export function timerBudgetMs(level, difficulty) {
  const preset = DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.adventurous;
  const interval = level.checkpointInterval || level.distance;
  const perSegment = Math.max(10, (interval / 250) * 60) * (preset.timeMultiplier || 1);
  const segments = Math.max(1, Math.ceil(level.distance / interval));
  // + the A-6 first-segment bonus, which every ride gets.
  return (perSegment * segments + 8) * 1000;
}

function medalsFor(level, difficulty) {
  const budget = timerBudgetMs(level, difficulty);
  return {
    gold: Math.round(budget * MEDAL_FRACTION.gold),
    silver: Math.round(budget * MEDAL_FRACTION.silver),
    bronze: Math.round(budget * MEDAL_FRACTION.bronze)
  };
}

/**
 * Medal thresholds for a level and difficulty, or null when the level has no
 * medals (the tutorial does not — it is not a race).
 */
export function getMedals(levelId, difficulty) {
  const level = getLevelById(levelId);
  if (!level || level.isTutorial || level.timerEnabled === false) return null;
  return medalsFor(level, difficulty || 'adventurous');
}
