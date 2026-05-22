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
    icon: '🚴',        // 🚴
    description: 'Master pedaling and steering!',
    isTutorial: true,
    coaching: { dodgeArrow: true, collectIndicator: true },
    timerEnabled: false,
    treeCollision: false,
    motionAdaptation: false,
    track: 'assets/tracks/tutorial.json'
  },
  {
    id: 'grandma',
    name: "Grandma's",
    distance: 350,
    collectibles: 'presents',
    checkpointInterval: 88,
    icon: '🏠',        // 🏠
    description: 'Grandma called — she needs her presents!',
    track: 'assets/tracks/grandma.json'
  },
  {
    id: 'castle',
    name: 'The Castle',
    distance: 700,
    collectibles: 'gems',
    checkpointInterval: 175,
    icon: '🏰',        // 🏰
    description: 'The King awaits! Collect gems on the road to glory!',
    track: 'assets/tracks/castle.json'
  }
];

export function getLevelById(id) {
  return LEVELS.find(l => l.id === id) || LEVELS[0];
}
