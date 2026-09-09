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
