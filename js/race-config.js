// ============================================================
// RACE CONFIG — level definitions
// ============================================================

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
// been read from the live data yet. Until then they are derived from the
// design targets: a clean ride at the preset's cruising speed is the SILVER
// time, gold is that ride with no wasted metres, bronze is a ride that
// finishes with mistakes in it.
//
// Rule of thumb used: base = distance / expected pace, where expected pace is
// 4.2 m/s on chill, 4.8 on adventurous, 5.6 on daredevil (auto-speed cruise is
// 3 m/s; a pedalling pair beats it comfortably). gold = base, silver = base
// x 1.25, bronze = base x 1.6.
//
// WHEN A-1 RUNS: replace these with the measured percentiles and change this
// comment to cite docs/analytics-baseline-2026-09.md. Do not tune them by
// feel — the whole point of a medal is that it means the same thing to
// everyone.
const PACE = { tutorial: 3.6, chill: 4.2, adventurous: 4.8, daredevil: 5.6 };

function medalsFor(distanceM, difficulty) {
  const pace = PACE[difficulty] || PACE.adventurous;
  const base = (distanceM / pace) * 1000;
  return {
    gold: Math.round(base),
    silver: Math.round(base * 1.25),
    bronze: Math.round(base * 1.6)
  };
}

/**
 * Medal thresholds for a level and difficulty, or null when the level has no
 * medals (the tutorial does not — it is not a race).
 */
export function getMedals(levelId, difficulty) {
  const level = getLevelById(levelId);
  if (!level || level.isTutorial || level.timerEnabled === false) return null;
  return medalsFor(level.distance, difficulty || 'adventurous');
}
