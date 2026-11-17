#!/usr/bin/env node
// ============================================================
// gen-achievements-json.mjs — publish Tandemonium's achievement list
// ============================================================
//
// achievements.json (repo root, served at https://tandemonium.housetandem.com/achievements.json)
// is the list other House Tandem sites read to show a player's Tandemonium badges: the
// account page on housetandem.com shows them in the same sheet as every other game's.
// It is generated from js/achievement-defs.js, the one place the 100 are defined, and
// committed; test/unit/achievements-json.test.mjs fails when the two differ.
//
//   npm run gen:achievements          write achievements.json
//   npm run gen:achievements -- --check   fail if it is out of date
//
// Same shape as the other games' lists ({ achievements: [{ id, name, description, icon,
// group }] }), plus:
//   sections   [{ id, title }]   the groups, in order, with their titles
//   hidden     on an achievement: show it as ??? until the player has earned it
//   renamed    { old id: new id }   an account may still hold a badge under its old id

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACHIEVEMENTS, SECTIONS, RENAMED_IDS } from '../js/achievement-defs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'achievements.json');

export function achievementsJson() {
  return JSON.stringify({
    game: 'tandemonium',
    sections: SECTIONS.map((s) => ({ id: s.id, title: s.title })),
    achievements: ACHIEVEMENTS.map((a) => ({
      id: a.id, name: a.name, description: a.desc, icon: a.icon, group: a.section,
      ...(a.hidden ? { hidden: true } : {}),
    })),
    renamed: { ...RENAMED_IDS },
  }, null, 1) + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = achievementsJson();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n') : '';
    if (cur !== next) {
      console.error('achievements.json is out of date with js/achievement-defs.js. Run: npm run gen:achievements');
      process.exit(1);
    }
    console.log('achievements.json matches js/achievement-defs.js.');
  } else {
    fs.writeFileSync(FILE, next);
    console.log(`Wrote achievements.json (${ACHIEVEMENTS.length} achievements, ${SECTIONS.length} sections).`);
  }
}
