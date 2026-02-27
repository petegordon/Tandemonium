// ============================================================
// RACE CONFIG — level definitions
// ============================================================

export const LEVELS = [
  {
    id: 'grandma',
    name: "Grandma's House",
    distance: 1000,
    collectibles: 'presents',
    checkpointInterval: 250,
    icon: '\uD83C\uDFE0',        // 🏠
    description: 'A short ride to Grandma\'s house'
  },
  {
    id: 'castle',
    name: 'The Castle',
    distance: 5000,
    collectibles: 'gems',
    checkpointInterval: 1000,
    icon: '\uD83C\uDFF0',        // 🏰
    description: 'An epic journey to the castle'
  }
];

export function getLevelById(id) {
  return LEVELS.find(l => l.id === id) || LEVELS[0];
}
