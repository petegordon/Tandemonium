// ============================================================
// RACE CONFIG — level definitions
// ============================================================

export const LEVELS = [
  {
    id: 'grandma',
    name: "Grandma's House",
    distance: 250,
    collectibles: 'presents',
    checkpointInterval: 62,
    icon: '\uD83C\uDFE0',        // 🏠
    description: 'A short ride to Grandma\'s house'
  },
  {
    id: 'castle',
    name: 'The Castle',
    distance: 2000,
    collectibles: 'gems',
    checkpointInterval: 500,
    icon: '\uD83C\uDFF0',        // 🏰
    description: 'A longer journey to the castle'
  }
];

export function getLevelById(id) {
  return LEVELS.find(l => l.id === id) || LEVELS[0];
}
