// lead-ins.mjs — re-capture the achievements-screen lead-in (achievements.mjs leadIn) for some reels, without their
// rides (#506).  node scripts/reel/lead-ins.mjs <id,...> [--aspect 9x16|16x9]
// Out: clips/ach-lead-<id>-<aspect>.mp4 + ach/lead-<id>-<aspect>.json, the files edit.py dissolves into the ride.
import { ASPECT, leadIn } from './achievements.mjs';

const ids = (process.argv.slice(2).find(a => !a.startsWith('--')) || '').split(',').filter(Boolean);
if (!ids.length) { console.log('usage: node scripts/reel/lead-ins.mjs <id,...> [--aspect 9x16|16x9]'); process.exit(1); }
for (const id of ids) {
  console.log(`== lead-in ${id} ${ASPECT}`);
  try { await leadIn(id, id); } catch (e) { console.log('  FAILED', id, e.stack); }
}
