// ============================================================
// RACE CONFIG — level definitions
// ============================================================

export const LEVELS = [
  {
    id: 'tutorial',
    name: 'Learn to Ride',
    distance: 100,
    collectibles: 'presents',
    checkpointInterval: 100,   // single checkpoint = entire ride
    icon: '\uD83D\uDEB4',        // 🚴
    description: 'Master pedaling and steering!',
    isTutorial: true
  },
  {
    id: 'grandma',
    name: "Grandma's House",
    distance: 250,
    collectibles: 'presents',
    checkpointInterval: 62,
    icon: '\uD83C\uDFE0',        // 🏠
    description: 'Grandma called — she needs her presents!'
  },
  {
    id: 'castle',
    name: 'The Castle',
    distance: 2000,
    collectibles: 'gems',
    checkpointInterval: 500,
    icon: '\uD83C\uDFF0',        // 🏰
    description: 'The King awaits! Collect gems on the road to glory!'
  }
];

export function getLevelById(id) {
  return LEVELS.find(l => l.id === id) || LEVELS[0];
}
