// ============================================================
// ACHIEVEMENT DEFINITIONS — the 100, their stats, and the rules (#401, #500)
// ============================================================
//
// Pure and DOM-free so the unit tests can import it. js/achievements.js holds
// the manager (persistence, toasts, Steam, server sync) and the game glue.
//
// 100 achievements in the 15 sections of issue #401 (+ #500 Look, No Thumbs, which took Half a Klick's place: Steam caps an app at 100):
//   - 23 existing ids, kept unchanged (anything already earned, and its Steam
//     id, carries over) — including the 7 per-bike-colour Grandma's ones;
//   - 77 new ones.
//
// A condition is (s, L) => boolean:
//   s  the state of the moment — a ride frame, a finish, or {} for an event;
//   L  the lifetime stats below (persisted in 'tandemonium_achievement_stats').
// Most conditions read L, so an event anywhere (a payout, a launch, a garage
// purchase) can earn them without a ride in progress.
//
// #608 (Pete, 2026-11-06) swapped out Century Ride, A Month of Roads, Standing
// Date and Neck and Beak for Rainbow Gold, Clean Sweep, Underdog and Full House;
// Lifer became 100 rides and A Hundred Together became 5K Together (same ids).
// Five calendar achievements are left, and the longest wait is 7 days.
//
// #641 · the demo awards 20 of these (js/edition.js · DEMO_ACHIEVEMENTS, Pete
// 2026-11-07); `demo` on each row says whether it is one of them. The demo
// never awards the other 80, but their stats keep counting, so they unlock on
// the full game's first check.

import { LEVELS, getMedals } from './race-config.js';
import { DEMO_ACHIEVEMENTS } from './edition.js';
import { STAGE_GATES, STAGE_GOALS, UPGRADES, upgradeCost } from './slingshot.js';
import { medalFor, capMedal } from './records.js';

export const SECTIONS = [
  { id: 'first',    title: 'First rides' },
  { id: 'distance', title: 'Distance' },
  { id: 'back',     title: 'Coming back' },
  { id: 'medals',   title: 'Levels and medals' },
  { id: 'clean',    title: 'Clean riding' },
  { id: 'speed',    title: 'Speed and boost' },
  { id: 'collect',  title: 'Collecting' },
  { id: 'sling',    title: 'Slingshot' },
  { id: 'coins',    title: 'Tandem Tokens' },
  { id: 'daily',    title: 'Daily Ride' },
  { id: 'together', title: 'Riding together' },
  { id: 'versus',   title: 'Versus' },
  { id: 'chaos',    title: 'Chaos' },
  { id: 'explore',  title: 'Exploring' },
  { id: 'colours',  title: "Grandma's in every colour" },
];

const MEDAL_RANK = { bronze: 1, silver: 2, gold: 3 };
const rank = m => MEDAL_RANK[m] || 0;

/** The wallet's upgrade levels ({id: level}) from `live.wallet` (the lobby passes it), or {}. */
const walletLevels = live => (live && live.wallet && live.wallet.lv) || {};

/** Fully Tuned: the closest upgrade to its max, as [level, max]. */
export function upgradeProgressAny(live) {
  const lv = walletLevels(live);
  let bestU = null, bestF = -1;
  for (const u of UPGRADES) {
    const l = Math.min(u.max, Math.floor(n(lv[u.id])));
    if (l / u.max > bestF) { bestF = l / u.max; bestU = [l, u.max]; }
  }
  return bestU || [0, 1];
}

/** Garage Royalty: upgrades at their max, of all of them. */
export function upgradeProgressAll(live) {
  const lv = walletLevels(live);
  return [UPGRADES.filter(u => n(lv[u.id]) >= u.max).length, UPGRADES.length];
}

/** Levels that award medals (Gilded Goose wants gold on each of them). */
export const MEDAL_LEVELS = LEVELS.filter(l => !l.isTutorial && l.timerEnabled !== false).map(l => l.id);

/** The Slingshot stage whose goal first reaches `metres` (for the demo's stage cap). */
export function stageForDistance(metres) {
  const i = STAGE_GOALS.findIndex(g => g >= metres);
  return i < 0 ? STAGE_GOALS.length + 1 : i + 1;
}

const n = v => (Number.isFinite(v) ? v : 0);
const len = a => (Array.isArray(a) ? a.length : 0);
const fin = s => !!(s && s.finishedLevel);

/** Gyro frames a rider needs before a ride counts as steered by tilt (~5 s at 60 fps). */
export const GYRO_ONLY_MIN_FRAMES = 300;

/**
 * #500 · Look, No Thumbs: did this rider steer the whole ride by CONTROLLER gyro?
 * frames = BalanceController.steerFrames for the ride. Phone tilt ('motion'),
 * keys and the stick/D-pad ('gamepad') each disqualify; controller gyro must
 * have steered for at least GYRO_ONLY_MIN_FRAMES.
 */
export function gyroOnlySteer(frames) {
  if (!frames) return false;
  const f = k => Number(frames[k]) || 0;
  return f('gamepad-gyro') >= GYRO_ONLY_MIN_FRAMES && f('keyboard') === 0 && f('gamepad') === 0 && f('motion') === 0;
}

/**
 * A best-so-far achievement (Pete, Steam playtest 2026-11-07: "a lot of the achievements don't give you
 * progress"): `best(s, L)` reads the moment's value (a ride frame or a finish), the manager keeps the highest
 * ever seen in L.bests[id], and the lobby shows it as [best, goal] progress.
 */
const best = (goal, unit, value) => ({ best: value, goal, unit });

/** A counter achievement: condition + lobby progress from one lifetime stat. */
function count(stat, goal) {
  return {
    condition: (s, L) => n(L[stat]) >= goal,
    progress: L => [Math.min(goal, Math.floor(n(L[stat]))), goal],
  };
}
function countList(stat, goal) {
  return {
    condition: (s, L) => len(L[stat]) >= goal,
    progress: L => [Math.min(goal, len(L[stat])), goal],
  };
}
function km(goalM) {
  return {
    condition: (s, L) => n(L.cumulativeDistance) >= goalM,
    progress: L => [Math.min(goalM, Math.floor(n(L.cumulativeDistance) / 100) * 100), goalM],
    unit: 'm',
  };
}

/**
 * A day-streak badge's progress: the streak held TODAY (live.dailyStreak, from
 * js/daily-ride.js · computeStreak), not the last run ever counted — a streak
 * broken a month ago shows 0, not "2/3 days".
 */
function streakProgress(goal) {
  return (L, live) => [Math.min(goal, Math.floor(n(live && live.dailyStreak))), goal];
}

const grandmaBike = key => s => s.finishedLevel === 'grandma' && s.bikeKey === key;

/** #608 · Rainbow Gold: the 7 bike colours (the lobby's preset keys). */
export const COLOUR_BIKES = Object.freeze(['default', 'bike_orange', 'bike_magenta', 'bike_red', 'bike_blue', 'bike_green', 'bike_yellow']);

/** #608 · Full House: a finished ride in each of these (L.modesFinished). */
export const FULL_HOUSE_MODES = Object.freeze(['grandma', 'daily', 'slingshot', 'coop', 'versus', 'tourist']);

// prettier-ignore
export const ACHIEVEMENTS = [
  // ── 1. First rides ────────────────────────────────────────
  { id: 'first_pedal',    section: 'first', name: 'Kick Off',            icon: '🦶', desc: 'Pedal for the first time',                         condition: (s, L) => !!L.pedalled },
  { id: 'tutorial_done',  section: 'first', name: "Learner's Permit",    icon: '🎓', desc: 'Finish the Tutorial',                              condition: (s, L) => n(L.tutorialDone) >= 1 },
  { id: 'tutorial_clean', section: 'first', name: 'Natural',             icon: '🌱', desc: 'Finish the Tutorial without a single retry',       condition: (s, L) => n(L.tutorialClean) >= 1 },
  { id: 'first_finish',   section: 'first', name: 'Made It',             icon: '🏁', desc: 'Finish any level',                                 condition: (s, L) => n(L.finishes) >= 1 },
  { id: 'first_crash',    section: 'first', name: 'Goose Down',          icon: '🪶', desc: 'Crash for the first time',                         condition: (s, L) => n(L.crashes) >= 1 },
  { id: 'first_remount',  section: 'first', name: 'Back in the Saddle',  icon: '🩹', desc: 'Crash, get back on, and finish that same ride',     condition: s => fin(s) && n(s.crashes) >= 1 },
  { id: 'first_boost',    section: 'first', name: 'Turbo Goose',         icon: '🚀', desc: 'Trigger a boost by grabbing a present or gem',     condition: (s, L) => n(L.boosts) >= 1 },

  // ── 2. Distance (all rides combined) ─────────────────────
  { id: 'first_500m',     section: 'distance', name: 'First 500m',       icon: '👟', desc: 'Ride 500 m in total',       ...km(500) },
  { id: 'first_km',       section: 'distance', name: '1K Club',          icon: '🏅', desc: 'Ride 1 km in total',        ...km(1000) },
  { id: 'five_k',         section: 'distance', name: '5K Champion',      icon: '🏆', desc: 'Ride 5 km in total',        ...km(5000) },
  { id: 'ten_k',          section: 'distance', name: 'Ten-K Tandem',     icon: '🔟', desc: 'Ride 10 km in total',                 ...km(10000) },
  { id: 'half_marathon',  section: 'distance', name: 'Half Marathon',    icon: '🎽', desc: 'Ride 21.1 km in total',               ...km(21100) },
  { id: 'marathon',       section: 'distance', name: 'Marathon Geese',   icon: '🏃', desc: 'Ride 42.2 km in total',               ...km(42200) },

  // ── 3. Coming back ───────────────────────────────────────
  { id: 'rides_10',       section: 'back', name: 'Regular Rider',        icon: '🚲', desc: 'Go on 10 rides of any kind',          ...count('rides', 10) },
  { id: 'days_3',         section: 'back', name: 'Coming Back',          icon: '📆', desc: 'Ride on 3 different days',            ...count('days', 3), unit: 'days' },
  { id: 'days_7',         section: 'back', name: 'Habit Forming',        icon: '🗓️', desc: 'Ride on 7 different days',           ...count('days', 7), unit: 'days' },
  { id: 'days_30',        section: 'back', name: 'Lifer',                icon: '🪺', desc: 'Go on 100 rides of any kind',         ...count('rides', 100) },   // #608: was 30 days; id kept for saves + Steam

  // ── 4. Levels and medals ─────────────────────────────────
  { id: 'home_sweet',     section: 'medals', name: 'Home Sweet Home',    icon: '🏠', desc: "Finish Grandma's",          condition: s => s.finishedLevel === 'grandma' },
  { id: 'perfect_1k',     section: 'medals', name: 'Flawless',           icon: '💮', desc: "Finish Grandma's with no crashes or restarts", condition: s => s.finishedLevel === 'grandma' && s.crashes === 0 && s.restarts === 0 },
  // Medals are times: a share of the road's clock (race-config.js MEDAL_FRACTION), so each
  // difficulty has its own. `medal` lets the detail card print the live times (lobby.js).
  { id: 'grandma_bronze', section: 'medals', name: 'Cookie',             icon: '🍪', desc: "Reach Grandma's inside the bronze time — the slowest of the three medal times; each difficulty has its own", medal: { level: 'grandma', rank: 'bronze' }, condition: s => s.finishedLevel === 'grandma' && rank(s.medal) >= 1 },
  { id: 'grandma_silver', section: 'medals', name: 'Tea and Biscuits',   icon: '🫖', desc: "Reach Grandma's inside the silver time — the middle of the three medal times; each difficulty has its own", medal: { level: 'grandma', rank: 'silver' }, condition: s => s.finishedLevel === 'grandma' && rank(s.medal) >= 2 },
  { id: 'grandma_gold',   section: 'medals', name: "Grandma's Favourite", icon: '🥇', desc: "Reach Grandma's inside the gold time — the fastest of the three medal times; each difficulty has its own", medal: { level: 'grandma', rank: 'gold' }, condition: s => s.finishedLevel === 'grandma' && rank(s.medal) >= 3 },
  { id: 'daily_gold',     section: 'medals', name: 'Road Scholar',       icon: '📜', desc: "Finish the Daily Ride inside its gold time, on any day; each difficulty has its own", medal: { level: 'daily', rank: 'gold' }, condition: s => s.finishedLevel === 'daily' && s.medal === 'gold' },
  { id: 'all_gold',       section: 'medals', name: 'Gilded Goose',       icon: '👑', desc: "Win gold on both timed roads: Grandma's and the Daily Ride",
    condition: (s, L) => MEDAL_LEVELS.every(id => (L.golds || []).includes(id)),
    progress: L => [MEDAL_LEVELS.filter(id => (L.golds || []).includes(id)).length, MEDAL_LEVELS.length] },
  { id: 'adventurer',     section: 'medals', name: 'Adventurer',         icon: '🧭', desc: 'Finish any level on Adventurous',     condition: s => fin(s) && s.difficulty === 'adventurous' },
  { id: 'daredevil',      section: 'medals', name: 'Daredevil',          icon: '😈', desc: 'Finish any level on Daredevil',       condition: s => fin(s) && s.difficulty === 'daredevil' },

  // ── 5. Clean riding ──────────────────────────────────────
  { id: 'steady_hands',   section: 'clean', name: 'Steady Hands',        icon: '🧘', desc: 'Ride 60 s without the bike shaking from leaning too far', condition: s => n(s.steadyBest) >= 60, ...best(60, 's', s => n(s.steadyBest)) },
  { id: 'centerline',     section: 'clean', name: 'On the Line',         icon: '🎯', desc: "Stay on the road's centre strip for 30 s straight",       condition: s => n(s.stripBest) >= 30, ...best(30, 's', s => n(s.stripBest)) },
  { id: 'no_offroad',     section: 'clean', name: 'Stayed on the Road',  icon: '🛤️', desc: 'Finish a level without going off-road',                 condition: s => fin(s) && s.offroadT === 0 },
  { id: 'no_trees_daily', section: 'clean', name: 'No Trees Were Harmed', icon: '🌳', desc: "Finish the Daily Ride without hitting a tree",           condition: s => s.finishedLevel === 'daily' && s.treeHits === 0 },
  { id: 'new_best',       section: 'clean', name: 'Personal Best',       icon: '⭐', desc: 'Set a new personal best',                              condition: (s, L) => s.newBest === true || n(L.personalBests) >= 1 },
  { id: 'assist_free',    section: 'clean', name: 'Did It Myself',       icon: '💪', desc: 'Crash three times at one checkpoint, then finish without the helping hand or the Royal Shortcut', condition: s => fin(s) && s.didItMyself === true },

  // ── 6. Speed and boost ───────────────────────────────────
  // #716 (Pete 2026-11-09): 50 and 65 km/h were 40 and 50 out of reach (adventurous tops out at 50 km/h,
  // 65 only on Daredevil). Now 40 (any difficulty but Chill's 43 cap is close) and 50.
  { id: 'speed_demon',    section: 'speed', name: 'Speed Demon',         icon: '⚡', desc: 'Hit 40 km/h on a ride',                     condition: s => s.speed >= 40 / 3.6, ...best(40, 'km/h', s => n(s.speed) * 3.6) },
  { id: 'terminal_goose', section: 'speed', name: 'Terminal Goose',      icon: '☄️', desc: 'Hit 50 km/h on a ride',                         condition: s => s.speed >= 50 / 3.6, ...best(50, 'km/h', s => n(s.speed) * 3.6) },
  { id: 'boost_25',       section: 'speed', name: 'Boost Junkie',        icon: '🔋', desc: 'Trigger 25 boosts',                   ...count('boosts', 25) },
  { id: 'afterburner',    section: 'speed', name: 'Afterburner',         icon: '🔥', desc: 'Chain pickups to keep boosting for 10 s straight', condition: s => n(s.boostBest) >= 10, ...best(10, 's', s => n(s.boostBest)) },

  // ── 7. Collecting ────────────────────────────────────────
  { id: 'collector',      section: 'collect', name: 'Collector',         icon: '🌟', desc: 'Collect 10 items in one ride', condition: s => s.collectibles >= 10, ...best(10, 'items', s => n(s.collectibles)) },
  { id: 'hoarder',        section: 'collect', name: 'Hoarder',           icon: '👑', desc: 'Collect every item in one ride', condition: s => s.collectibles > 0 && s.collectibles >= s.totalCollectibles, ...best(100, '% of a ride\'s items', s => (n(s.totalCollectibles) > 0 ? 100 * n(s.collectibles) / s.totalCollectibles : 0)) },
  { id: 'presents_100',   section: 'collect', name: 'Special Delivery',  icon: '🎁', desc: 'Collect 100 presents in total',       ...count('pickups', 100) },
  { id: 'daily_haul',     section: 'collect', name: 'Daily Haul',        icon: '🧺', desc: "Collect every present on the Daily Ride", condition: s => s.finishedLevel === 'daily' && s.totalCollectibles > 0 && s.collectibles >= s.totalCollectibles, ...best(100, '% of the presents', s => (s.finishedLevel === 'daily' && n(s.totalCollectibles) > 0 ? 100 * n(s.collectibles) / s.totalCollectibles : 0)) },

  // ── 8. Slingshot ─────────────────────────────────────────
  { id: 'sling_first',    section: 'sling', name: 'Fire!',               icon: '🪃', desc: 'Launch from the slingshot',            ...count('slingLaunches', 1) },
  { id: 'sling_stage1',   section: 'sling', name: 'Stage One',           icon: '1️⃣', desc: 'Clear Slingshot stage 1 (300 m)',     ...count('slingStage', 1), stage: 1 },
  { id: 'sling_stage3',   section: 'sling', name: 'Getting the Hang of It', icon: '3️⃣', desc: 'Clear Slingshot stage 3',       ...count('slingStage', 3), stage: 3 },
  // #716 (Pete 2026-11-09): stages 5 and 7 were too many stage goals; launch speeds instead.
  { id: 'sling_25',       section: 'sling', name: 'Flung',               icon: '💨', desc: 'Hit 25 km/h in a Slingshot launch',   ...count('slingTopSpeed', 25), unit: 'km/h' },
  { id: 'sling_40',       section: 'sling', name: 'Goose Cannonball',    icon: '🚀', desc: 'Hit 40 km/h in a Slingshot launch',   ...count('slingTopSpeed', 40), unit: 'km/h' },
  { id: 'sling_1000',     section: 'sling', name: 'Long Fling',          icon: '🛫', desc: '600 m in one launch',                 ...count('slingBest', 600), stage: stageForDistance(600), unit: 'm' },   // was 1,000 m (stage 7 only, out of reach); id kept for saves + Steam
  { id: 'big_air',        section: 'sling', name: 'Big Air',             icon: '🪂', desc: 'Land a Big Air off a ramp',           ...count('bigAirs', 1) },
  { id: 'frequent_flyer', section: 'sling', name: 'Frequent Flyer',      icon: '✈️', desc: 'Land 25 Big Airs',                    ...count('bigAirs', 25) },
  { id: 'jackpot',        section: 'sling', name: 'Pot of Gold',         icon: '💰', desc: 'Collect the pot of gold',             ...count('jackpots', 1) },   // #546: id kept for saves + Steam
  { id: 'double_down',    section: 'sling', name: 'Double Down',         icon: '🎲', desc: 'Collect the pot of gold on a run that also beats your best distance', ...count('doubleDowns', 1) },   // #546: the pot no longer ends the run, so stages 2-3 (the demo) can earn it too
  { id: 'full_trail',     section: 'sling', name: 'Full Trail',          icon: '🪙', desc: 'Grab all 5 coins in a trail',         ...count('fullTrails', 1) },
  { id: 'straight_shooter', section: 'sling', name: 'Straight Shooter',  icon: '📐', desc: 'Go 300 m without steering after launch', ...count('straightShots', 1) },
  { id: 'medal_key',      section: 'sling', name: 'Medal Key',           icon: '🗝️', desc: "Win the medal that opens a Slingshot stage: bronze on Grandma's for stage 4, gold for stage 7", ...count('medalKeys', 1) },
  { id: 'daily_launch',   section: 'sling', name: 'Daily Launch',        icon: '🌅', desc: "Fly the Daily Launch (the Slingshot's daily course)", ...countList('launchDays', 1) },
  { id: 'launch_week',    section: 'sling', name: 'Launch Week',         icon: '📅', desc: "Fly the Daily Launch on 7 different days", ...countList('launchDays', 7), unit: 'days' },

  // ── 9. Tandem Tokens ───────────────────────────────────────
  { id: 'coin_first',     section: 'coins', name: 'Pocket Change',       icon: '🪙', desc: 'Collect your first Tandem Token',          ...count('coinsEarned', 1) },
  { id: 'coins_1000',     section: 'coins', name: 'Token Purse',         icon: '👛', desc: 'Earn 1,000 Tandem Tokens in total',     ...count('coinsEarned', 1000) },
  { id: 'coins_10000',    section: 'coins', name: 'Goose Egg Nest',      icon: '🥚', desc: 'Earn 10,000 Tandem Tokens in total',    ...count('coinsEarned', 10000) },
  { id: 'payday',         section: 'coins', name: 'Payday',              icon: '💰', desc: 'Earn 200 Tandem Tokens from one regular (non-Slingshot) ride', ...count('bestRideCoins', 200) },
  { id: 'first_upgrade',  section: 'coins', name: 'Tinkerer',            icon: '🔧', desc: 'Buy your first garage upgrade',       ...count('upgrades', 1) },
  { id: 'max_upgrade',    section: 'coins', name: 'Fully Tuned',         icon: '🔩', desc: 'Max out any one upgrade',             condition: (s, L) => !!L.maxedAny, progress: (L, live) => upgradeProgressAny(live), unit: 'levels' },
  { id: 'garage_royalty', section: 'coins', name: 'Garage Royalty',      icon: '🏰', desc: 'Max out every upgrade',               condition: (s, L) => !!L.maxedAll, progress: (L, live) => upgradeProgressAll(live), unit: 'upgrades maxed' },
  { id: 'big_spender',    section: 'coins', name: 'Big Spender',         icon: '💸', desc: 'Spend 1,000 Tandem Tokens in the garage',     ...count('coinsSpent', 1000) },
  { id: 'rebuilt',        section: 'coins', name: 'Rebuilt',             icon: '♻️', desc: 'Rebuild the bike (prestige) for the first time', ...count('rebuilds', 1) },
  { id: 'ship_of_theseus', section: 'coins', name: 'Ship of Theseus',    icon: '⛵', desc: 'Rebuild the bike 3 times (the rebuild bonus is Slingshot pay)', ...count('rebuilds', 3) },

  // ── 10. Daily Ride ───────────────────────────────────────
  { id: 'daily_first',    section: 'daily', name: 'Daily Ride',          icon: '📅', desc: "Finish your first Daily Ride", condition: s => s.finishedLevel === 'daily' },
  { id: 'daily_streak_3', section: 'daily', name: 'Three in a Row',      icon: '🔁', desc: "Take the Daily Ride on 3 days running", condition: (s, L) => n(s.dailyStreak) >= 3 || n(L.dailyDayBest) >= 3,
    progress: streakProgress(3), unit: 'days' },
  { id: 'daily_streak_7', section: 'daily', name: 'A Week of Roads',     icon: '🔥', desc: "Take the Daily Ride 7 days running", condition: (s, L) => n(s.dailyStreak) >= 7 || n(L.dailyDayBest) >= 7,
    progress: streakProgress(7), unit: 'days' },
  { id: 'daily_share',    section: 'daily', name: 'Show-Off',            icon: '📣', desc: "Share a Daily Ride result",         ...count('shares', 1) },
  { id: 'daily_practice_10', section: 'daily', name: 'Practice Makes Perfect', icon: '🔂', desc: "Finish 10 Daily Rides", ...count('dailyPractice', 10) },

  // ── 11. Riding together ──────────────────────────────────
  // A-2: Perfect Sync is reachable by cooperation — each paired beat adds +0.10
  // to offsetScore against 5%/s decay, so two riders answering each other's
  // beat at ~1 beat/s cross 0.9 in about ten seconds.
  { id: 'perfect_sync',   section: 'together', name: 'Perfect Sync',     icon: '🤝', desc: 'Stay in sync for 10 s',     condition: s => s.offsetScore > 0.9 && s.syncDuration >= 10, ...best(10, 's', s => (n(s.offsetScore) > 0.9 ? n(s.syncDuration) : 0)) },
  { id: 'team_player',    section: 'together', name: 'Team Player',      icon: '🤜', desc: '80% or more safe-riding contribution in co-op', condition: s => s.isMultiplayer && s.safePct >= 80, ...best(80, '%', s => (s.isMultiplayer ? n(s.safePct) : 0)) },
  { id: 'pair_10_rides',  section: 'together', name: 'Regulars',         icon: '👫', desc: 'Ride 10 times with the same partner', condition: s => s.pairRides >= 10, ...best(10, 'rides', s => n(s.pairRides)) },
  { id: 'pair_100km',     section: 'together', name: '5K Together',      icon: '🛣️', desc: 'Ride 5 km with the same partner',   condition: s => s.pairDistanceKm >= 5, ...best(5000, 'm', s => n(s.pairDistanceKm) * 1000) },   // #608: was 100 km; id kept
  { id: 'coop_first',     section: 'together', name: 'The Two of Us',    icon: '💞', desc: 'Finish a co-op ride',                 ...count('coopFinishes', 1) },
  { id: 'social_goose',   section: 'together', name: 'Social Goose',     icon: '🦢', desc: 'Finish co-op rides with 3 different partners', ...countList('partners', 3) },

  // ── 12. Versus ───────────────────────────────────────────
  { id: 'versus_first',   section: 'versus', name: 'Rivals',             icon: '⚔️', desc: 'Finish a versus race',                ...count('versusRaces', 1) },
  { id: 'versus_win',     section: 'versus', name: 'Crown the Goose',    icon: '🏆', desc: 'Win a versus race',                   ...count('versusWins', 1) },
  { id: 'versus_2v2',     section: 'versus', name: 'Royal Court',        icon: '🤴', desc: 'Win a 2v2 versus race',               ...count('versus2v2Wins', 1) },
  { id: 'versus_comeback', section: 'versus', name: 'Comeback Geese',    icon: '↩️', desc: 'Win a versus race after trailing at halfway', ...count('versusComebacks', 1) },
  { id: 'versus_10',      section: 'versus', name: 'House Champion',     icon: '🏅', desc: 'Win 10 versus races',                 ...count('versusWins', 10) },
  { id: 'versus_underdog', section: 'versus', name: 'Underdog',          icon: '🐣', desc: 'Win a versus race riding alone against a two-goose tandem', ...count('versus1v2Wins', 1) },   // #608
  { id: 'versus_clean',   section: 'versus', name: 'Clean Sweep',        icon: '🧹', desc: 'Win a versus race without crashing',  ...count('versusClean', 1) },   // #608

  // ── 13. Chaos (hidden) ───────────────────────────────────
  { id: 'crashes_10',     section: 'chaos', hidden: true, name: 'Frequent Faller', icon: '🤕', desc: 'Crash 10 times in total',   ...count('crashes', 10) },
  { id: 'false_start',    section: 'chaos', hidden: true, name: 'False Start',     icon: '🚦', desc: 'Crash within 3 s of GO',    ...count('falseStarts', 1) },
  { id: 'so_close',       section: 'chaos', hidden: true, name: 'So Close',        icon: '🤏', desc: 'Crash within 10 m of the finish', ...count('soCloses', 1) },
  { id: 'weathered',      section: 'chaos', hidden: true, name: 'Weathered',       icon: '🌬️', desc: 'Ride through a gust without crashing', ...count('weathered', 1) },
  { id: 'gone_with_wind', section: 'chaos', hidden: true, name: 'Gone With the Wind', icon: '🌪️', desc: 'Get pushed by 10 gusts', ...count('gusts', 10) },

  // ── 14. Exploring ────────────────────────────────────────
  { id: 'distance_between_us', section: 'explore', name: 'The Distance Between Us', icon: '📍', desc: 'Finish a Tourist ride', condition: s => s.touristFinished === true },
  { id: 'grand_tour',     section: 'explore', name: 'Grand Tour',        icon: '🗺️', desc: 'Ride 5 km in total in Tourist',       ...count('touristDistance', 5000), unit: 'm' },
  // #608 · every mode needs co-op and versus, so it counts as multiplayer (js/rewards.js · MULTIPLAYER_IDS).
  { id: 'full_house',     section: 'explore', name: 'Full House',        icon: '🎪', desc: "Finish a ride in every mode: Grandma's, the Daily Ride, Slingshot, co-op, versus and Tourist",
    condition: (s, L) => FULL_HOUSE_MODES.every(m => (L.modesFinished || []).includes(m)),
    progress: L => [FULL_HOUSE_MODES.filter(m => (L.modesFinished || []).includes(m)).length, FULL_HOUSE_MODES.length] },

  // ── 15. Grandma's in every colour ────────────────────────
  // F-1 hid these (riding the same 250 m seven times); restored 2026-10-20
  // so all 100 show: a short, gentle goal and a ready-made reel series.
  { id: 'grandma_default', section: 'colours', name: "Grandma's Classic",   icon: '🚲', desc: "Finish Grandma's on the default bike", condition: grandmaBike('default') },
  { id: 'grandma_orange',  section: 'colours', name: 'Marmalade Delivery',  icon: '🍊', desc: "Finish Grandma's on the orange bike",  condition: grandmaBike('bike_orange') },
  { id: 'grandma_magenta', section: 'colours', name: 'Berry Special Visit', icon: '🫐', desc: "Finish Grandma's on the magenta bike", condition: grandmaBike('bike_magenta') },
  { id: 'grandma_red',     section: 'colours', name: 'Cherry on Top',       icon: '🍒', desc: "Finish Grandma's on the red bike",     condition: grandmaBike('bike_red') },
  { id: 'grandma_blue',    section: 'colours', name: "Ocean to Grandma's",  icon: '🌊', desc: "Finish Grandma's on the blue bike",    condition: grandmaBike('bike_blue') },
  { id: 'grandma_green',   section: 'colours', name: 'Jungle Express',      icon: '🌿', desc: "Finish Grandma's on the green bike",   condition: grandmaBike('bike_green') },
  { id: 'grandma_yellow',  section: 'colours', name: 'Banana Delivery',     icon: '🍌', desc: "Finish Grandma's on the yellow bike",  condition: grandmaBike('bike_yellow') },
  // #608 · any difficulty, like Grandma's Favourite.
  { id: 'rainbow_gold',    section: 'colours', name: 'Rainbow Gold',        icon: '🌈', desc: "Win gold on Grandma's on every bike colour (all 7)",
    condition: (s, L) => COLOUR_BIKES.every(k => (L.grandmaGoldBikes || []).includes(k)),
    progress: L => [COLOUR_BIKES.filter(k => (L.grandmaGoldBikes || []).includes(k)).length, COLOUR_BIKES.length] },

  // ── #500 · added after the first 100 (Clean riding section, last in the list); sling_500 Half a Klick was dropped to stay at Steam's 100 cap (stage 3 already needs 540 m) ──
  { id: 'look_no_thumbs', section: 'clean', name: 'Look, No Thumbs',     icon: '🎮', desc: 'Finish a ride steering only by tilting your controller', condition: s => fin(s) && s.gyroOnly === true },
].map(a => ({ hidden: false, ...a, demo: DEMO_ACHIEVEMENTS.includes(a.id) }));

/** The ids the demo never awards (#641: everything outside DEMO_ACHIEVEMENTS). */
export const DEMO_UNEARNABLE = ACHIEVEMENTS.filter(a => !a.demo).map(a => a.id);

export function getDefinition(id) {
  return ACHIEVEMENTS.find(a => a.id === id) || null;
}

/**
 * #575 · achievement ids renamed after players had started earning them
 * (old → new). The earned list in localStorage carries the old id until
 * migrateEarned runs (js/achievements.js, on load); the Steam API name is the
 * id in upper case, and scripts/sync-steam-achievements.js renames that row
 * in place so the stat bit — and every player's unlock — carries over.
 */
export const RENAMED_IDS = Object.freeze({ todays_launch: 'daily_launch' });

/**
 * One-time migration of the earned list ([{ id, name, icon, earnedAt }]).
 * An entry under an old id moves to its new id, taking the new name and
 * icon; when both ids are present (earned on two devices) the earlier unlock
 * wins. Anything else passes through untouched. Returns { list, changed }:
 * changed is true only when the stored list should be rewritten.
 */
export function migrateEarned(list) {
  if (!Array.isArray(list)) return { list: [], changed: false };
  let changed = false;
  const out = [];
  const at = new Map();   // id → index in out
  for (const a of list) {
    const to = a && typeof a.id === 'string' ? RENAMED_IDS[a.id] : undefined;
    let rec = a;
    if (to) {
      const def = getDefinition(to);
      rec = { ...a, id: to, name: def ? def.name : a.name, icon: def ? def.icon : a.icon };
      changed = true;
    }
    const id = rec && rec.id;
    if (id !== undefined && at.has(id)) {
      const i = at.get(id);
      if (Number(rec.earnedAt) < Number(out[i].earnedAt)) out[i] = rec;
      changed = true;
      continue;
    }
    if (id !== undefined) at.set(id, out.length);
    out.push(rec);
  }
  return { list: out, changed };
}

// ============================================================
// LIFETIME STATS — 'tandemonium_achievement_stats'
// ============================================================
//
// v1 (no `v`) was { cumulativeDistance } — metres from completed rides. v2
// keeps that number and adds every counter the 100 need. Distance now counts
// every metre of every regular ride (the payout ledger's new metres), so a
// crashed ride counts too; nothing already counted is lost.

export const STATS_VERSION = 2;

const NUMERIC = [
  'cumulativeDistance', 'rides', 'days', 'tutorialDone', 'tutorialClean', 'finishes',
  'crashes', 'boosts', 'pickups', 'personalBests', 'gusts', 'weathered', 'falseStarts', 'soCloses',
  'coinsEarned', 'coinsSpent', 'upgrades', 'rebuilds', 'rideCoins', 'bestRideCoins',
  'slingLaunches', 'slingBest', 'slingStage', 'slingTopSpeed', 'bigAirs', 'jackpots', 'doubleDowns', 'fullTrails',
  'straightShots', 'medalKeys', 'dailyPractice', 'shares', 'dailyDayRun', 'dailyDayBest',
  'coopFinishes', 'versusRaces', 'versusWins', 'versus2v2Wins', 'versusClose', 'versusComebacks',
  'versus1v2Wins', 'versusClean',
  'touristDistance',
];
const LISTS = ['dayList', 'golds', 'launchDays', 'partners', 'grandmaGoldBikes', 'modesFinished'];
const FLAGS = ['pedalled', 'maxedAny', 'maxedAll'];
const STRINGS = ['lastDay', 'lastDailyDay'];

export function emptyStats() {
  const L = { v: STATS_VERSION, bests: {}, bestsAt: {} };
  for (const k of NUMERIC) L[k] = 0;
  for (const k of LISTS) L[k] = [];
  for (const k of FLAGS) L[k] = false;
  for (const k of STRINGS) L[k] = null;
  return L;
}

/** Any stored object (v1, v2, junk) → a clean v2. Never throws, never loses a counter. */
/**
 * Fold the moment's best-so-far values into L.bests (pure). Returns the new stats, or the same object when
 * nothing improved. `earned` = ids already earned (their bests stop mattering).
 */
export function foldBests(L, state, earned = new Set(), now = Date.now()) {
  let out = null;
  const level = (state && (state.levelId || state.finishedLevel)) || null;
  for (const a of ACHIEVEMENTS) {
    if (!a.best || earned.has(a.id)) continue;
    let v = 0;
    try { v = a.best(state || {}, L); } catch (e) { v = 0; }
    if (!(Number.isFinite(v) && v > (L.bests[a.id] || 0) + 1e-6)) continue;
    if (!out) out = { ...L, bests: { ...L.bests }, bestsAt: { ...(L.bestsAt || {}) } };
    out.bests[a.id] = Math.round(Math.min(v, a.goal * 10) * 10) / 10;
    // Pete 2026-11-07: "record top speed, what ride and date time" — where and when each best was set
    out.bestsAt[a.id] = { level, at: now };
  }
  return out || L;
}

/** [best, goal] for a best-so-far achievement. */
export function bestProgress(a, L) {
  const b = (L && L.bests && L.bests[a.id]) || 0;
  return [Math.min(a.goal, Math.floor(b)), a.goal];
}

export function migrateStats(raw) {
  const L = emptyStats();
  if (!raw || typeof raw !== 'object') return L;
  for (const k of NUMERIC) if (Number.isFinite(raw[k]) && raw[k] > 0) L[k] = raw[k];
  for (const k of LISTS) {
    if (Array.isArray(raw[k])) L[k] = [...new Set(raw[k].filter(x => typeof x === 'string'))];
  }
  for (const k of FLAGS) L[k] = raw[k] === true;
  for (const k of STRINGS) L[k] = typeof raw[k] === 'string' ? raw[k] : null;
  if (raw.bests && typeof raw.bests === 'object') {
    for (const [k, v] of Object.entries(raw.bests)) if (Number.isFinite(v) && v > 0) L.bests[k] = v;
  }
  if (raw.bestsAt && typeof raw.bestsAt === 'object') {
    for (const [k, v] of Object.entries(raw.bestsAt)) {
      if (v && Number.isFinite(v.at) && L.bests[k]) L.bestsAt[k] = { level: typeof v.level === 'string' ? v.level : null, at: v.at };
    }
  }
  L.days = Math.max(L.days, L.dayList.length);
  return L;
}

const DAY_LIST_MAX = 60;

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function noteDay(L, today) {
  if (!today || L.dayList.includes(today)) return;
  L.days += 1;
  L.dayList = [...L.dayList, today].slice(-DAY_LIST_MAX);
  // #611 · after a time warp the real date can be behind the newest day ridden.
  if (!L.lastDay || today > L.lastDay) L.lastDay = today;
}

const addUnique = (list, v) => (v && !list.includes(v) ? [...list, v] : list);

/** #608 · the Full House modes one finish counts for (a co-op Daily Ride is both). */
export function finishModes(d) {
  const out = [];
  if (d.touristFinished) out.push('tourist');
  else if (d.finishedLevel === 'grandma' || d.finishedLevel === 'daily') out.push(d.finishedLevel);
  if (d.isCoop) out.push('coop');
  return out;
}

/** Does this finish's medal meet a Slingshot stage gate (js/slingshot.js · STAGE_GATES)? */
export function opensMedalGate(levelId, medal) {
  return Object.values(STAGE_GATES).some(g => g.medal && g.level === levelId && rank(medal) >= rank(g.medal));
}

/**
 * m21 · retroactive credit. A player whose stats predate v2 already has saves
 * that prove some of the 100: personal bests and medals (tandemonium_records),
 * Slingshot progress (tandemonium_slingshot), Daily Ride days
 * (tandemonium_daily) and the wallet. Fold them in as LOWER BOUNDS: every
 * counter only ever goes up, every list only gains, nothing is lost.
 *   saves: { records, sling, daily, wallet } — each the parsed save or null
 *   (sling and wallet already sanitized: js/slingshot.js · loadSave,
 *   js/wallet.js · sanitizeWallet).
 * Returns a NEW object.
 */
export function seedStats(prev, saves = {}) {
  const L = { ...prev, dayList: [...prev.dayList], golds: [...prev.golds], launchDays: [...prev.launchDays], partners: [...prev.partners],
    grandmaGoldBikes: [...(prev.grandmaGoldBikes || [])], modesFinished: [...(prev.modesFinished || [])] };
  const up = (k, v) => { if (Number.isFinite(v) && v > L[k]) L[k] = Math.floor(v); };
  const obj = o => (o && typeof o === 'object' ? o : null);

  // Personal bests and medals: one record = at least one finish and one new best.
  const records = obj(saves.records);
  let recordCount = 0;
  if (records) {
    const per = { coop: 0, versus: 0 };
    let tutorial = false, medalKey = false;
    for (const [k, rec] of Object.entries(records)) {
      if (!rec || typeof rec.timeMs !== 'number' || !(rec.timeMs > 0)) continue;
      recordCount += 1;
      const [rawLevel, difficulty, mode] = k.split('|');
      const levelId = String(rawLevel).startsWith('daily:') ? 'daily' : rawLevel;
      if (mode in per) per[mode] += 1;
      if (levelId === 'tutorial') tutorial = true;
      if (levelId === 'grandma' || levelId === 'daily') L.modesFinished = addUnique(L.modesFinished, levelId);
      const medal = MEDAL_RANK[rec.bestMedal] ? rec.bestMedal
        : capMedal(medalFor(rec.timeMs, getMedals(levelId, difficulty)), { helped: !!rec.helped });
      if (medal === 'gold' && MEDAL_LEVELS.includes(levelId) && !L.golds.includes(levelId)) L.golds.push(levelId);
      if (medal && opensMedalGate(levelId, medal)) medalKey = true;
    }
    up('finishes', recordCount);
    up('personalBests', recordCount);
    up('coopFinishes', per.coop);
    up('versusRaces', per.versus);
    if (per.coop > 0) L.modesFinished = addUnique(L.modesFinished, 'coop');
    if (per.versus > 0) L.modesFinished = addUnique(L.modesFinished, 'versus');
    if (tutorial) up('tutorialDone', 1);
    if (medalKey) up('medalKeys', 1);
  }

  // Slingshot: `stage` is the stage being played, so stage - 1 are cleared.
  const sling = obj(saves.sling);
  if (sling) {
    up('slingBest', n(sling.best));
    up('slingStage', n(sling.stage) - 1);
    up('slingLaunches', n(sling.runs));
    if (n(sling.runs) > 0) L.modesFinished = addUnique(L.modesFinished, 'slingshot');
    const d = obj(sling.daily);
    if (d && typeof d.key === 'string' && n(d.runs) > 0 && !L.launchDays.includes(d.key)) L.launchDays.push(d.key);
  }
  up('rides', recordCount + n(sling && sling.runs));

  // Daily Ride: the days ridden, practice finishes, partners, the day streak.
  const daily = obj(saves.daily);
  if (daily) {
    const finished = Object.keys(daily)
      .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && obj(daily[k]))
      .filter(k => n(daily[k].practice) > 0 || (obj(daily[k].ranked) && Object.keys(daily[k].ranked).length > 0))
      .sort();
    let practice = 0;
    for (const k of finished) {
      practice += n(daily[k].practice);
      for (const p of Array.isArray(daily[k].partners) ? daily[k].partners : []) {
        if (typeof p === 'string' && p && !L.partners.includes(p)) L.partners.push(p);
      }
      if (!L.dayList.includes(k) && (L.dayList.length < DAY_LIST_MAX || k > L.dayList[0])) {
        L.days += 1;
        L.dayList.push(k);
      }
    }
    L.dayList = L.dayList.sort().slice(-DAY_LIST_MAX);
    if (L.dayList.length && (!L.lastDay || L.dayList[L.dayList.length - 1] > L.lastDay)) L.lastDay = L.dayList[L.dayList.length - 1];
    up('dailyPractice', practice);
    let run = 0, best = 0;
    for (let i = 0; i < finished.length; i++) {
      run = i > 0 && daysBetween(finished[i - 1], finished[i]) === 1 ? run + 1 : 1;
      best = Math.max(best, run);
    }
    up('dailyDayBest', best);
    const newest = finished[finished.length - 1];
    if (newest && (!L.lastDailyDay || newest > L.lastDailyDay)) {
      L.lastDailyDay = newest;
      L.dailyDayRun = run;
    }
  }

  // The wallet: coins earned, upgrades bought, rebuilds.
  const w = obj(saves.wallet);
  if (w) {
    up('coinsEarned', n(w.earned));
    up('rebuilds', n(w.rebuilds));
    let levels = 0, spent = 0;
    for (const u of UPGRADES) {
      const lv = Math.min(u.max, Math.floor(n(w.lv && w.lv[u.id])));
      levels += lv;
      for (let l = 0; l < lv; l++) spent += upgradeCost(u, l);
      if (lv >= u.max) L.maxedAny = true;
    }
    // A rebuild needed every upgrade maxed, then reset them: count those too
    // (a lower bound: since #608 the Token multiplier survives a rebuild, so leave it out).
    const rebuilds = Math.floor(n(w.rebuilds));
    if (rebuilds > 0) {
      const reset = UPGRADES.filter(u => u.id !== 'magnet');
      let full = 0;
      for (const u of reset) for (let l = 0; l < u.max; l++) full += upgradeCost(u, l);
      spent += rebuilds * full;
      levels += rebuilds * reset.reduce((a, u) => a + u.max, 0);
    }
    up('upgrades', levels);
    up('coinsSpent', spent);
    if (UPGRADES.every(u => n(w.lv && w.lv[u.id]) >= u.max) || n(w.rebuilds) > 0) {
      L.maxedAny = true;
      L.maxedAll = true;
    }
  }
  return L;
}

/**
 * Fold one event into the lifetime stats. Returns a NEW object.
 *   today: the day key ('YYYY-MM-DD', js/daily-seed.js · dailyKey)
 * Types: see the switch. Economy types match js/economy-mode.js · _economyEvent.
 */
export function applyEvent(prev, type, d = {}, today = null) {
  const L = { ...prev };
  switch (type) {
    case 'pedal': L.pedalled = true; break;
    case 'crash':
      L.crashes += 1;
      if (d.falseStart) L.falseStarts += 1;
      if (d.soClose) L.soCloses += 1;
      break;
    case 'boost':
      L.boosts += 1;
      L.pickups += Math.max(1, Math.floor(d.count || 1));
      break;
    case 'gust': L.gusts += 1; break;
    case 'weathered': L.weathered += 1; break;
    case 'share': L.shares += 1; break;
    case 'tutorial':
      L.tutorialDone += 1;
      L.finishes += 1;
      if (d.clean) L.tutorialClean += 1;
      break;
    case 'finish': {
      L.finishes += 1;
      if (d.newBest) L.personalBests += 1;
      if (d.medal === 'gold' && d.finishedLevel) L.golds = addUnique(L.golds, d.finishedLevel);
      if (d.medal === 'gold' && d.finishedLevel === 'grandma' && COLOUR_BIKES.includes(d.bikeKey)) {
        L.grandmaGoldBikes = addUnique(L.grandmaGoldBikes || [], d.bikeKey);
      }
      for (const m of finishModes(d)) L.modesFinished = addUnique(L.modesFinished || [], m);
      if (d.medal && opensMedalGate(d.finishedLevel, d.medal)) L.medalKeys += 1;
      if (d.isCoop) {
        L.coopFinishes += 1;
        if (d.partnerKey) L.partners = addUnique(L.partners, d.partnerKey);
      }
      // #611 · a day behind the newest Daily day (the real date after a time
      // warp rode ahead) leaves the run alone: that run already counted the
      // days the warp rode, and the real date picks it up again the day after.
      if (d.finishedLevel === 'daily' && today && (!L.lastDailyDay || today > L.lastDailyDay)) {
        const gap = L.lastDailyDay ? daysBetween(L.lastDailyDay, today) : 0;
        L.dailyDayRun = gap === 1 ? L.dailyDayRun + 1 : 1;
        L.dailyDayBest = Math.max(L.dailyDayBest, L.dailyDayRun);
        L.lastDailyDay = today;
      }
      break;
    }
    // ── from _payoutRide: one per payout of a regular ride
    case 'ride': {
      if (d.newRide) {
        L.rides += 1;
        L.rideCoins = 0;
        noteDay(L, today);
      }
      const metres = Math.max(0, n(d.metres));
      if (d.mode !== 'slingshot' && d.mode !== 'dailyLaunch') {
        L.cumulativeDistance += metres;
        L.rideCoins += Math.max(0, Math.floor(n(d.earned)));
        L.bestRideCoins = Math.max(L.bestRideCoins, L.rideCoins);
      }
      if (d.mode === 'tourist') L.touristDistance += metres;
      if (d.mode === 'daily' && d.finished) L.dailyPractice += 1;
      break;
    }
    // ── economy events (js/economy-mode.js)
    case 'coins': L.coinsEarned += Math.max(0, Math.floor(n(d.amount))); break;
    case 'upgrade': {
      L.upgrades += 1;
      L.coinsSpent += Math.max(0, Math.floor(n(d.price)));
      const u = UPGRADES.find(x => x.id === d.id);
      if (u && n(d.level) >= u.max) L.maxedAny = true;
      if (d.allMaxed) L.maxedAll = true;
      break;
    }
    case 'rebuild':
      // A rebuild is only offered with every upgrade maxed.
      L.rebuilds = Math.max(L.rebuilds, Math.floor(n(d.rebuilds)));
      L.maxedAny = true;
      L.maxedAll = true;
      break;
    case 'slingLaunch':
      L.slingLaunches += 1;
      break;
    case 'slingRun':
      L.rides += 1;
      noteDay(L, today);
      L.slingBest = Math.max(L.slingBest, Math.floor(n(d.distance)));
      L.slingTopSpeed = Math.max(n(L.slingTopSpeed), Math.floor(n(d.topSpeed) * 3.6));   // #716: km/h, the run's fastest
      L.modesFinished = addUnique(L.modesFinished || [], 'slingshot');
      if (d.pot && d.record) L.doubleDowns += 1;
      if (n(d.fullTrails) > 0) L.fullTrails += Math.floor(n(d.fullTrails));
      if (d.straight) L.straightShots += 1;
      break;
    case 'stageCleared': L.slingStage = Math.max(L.slingStage, Math.floor(n(d.stage))); break;
    case 'bigAir': L.bigAirs += 1; break;
    case 'pot': L.jackpots += 1; break;   // #546: the pot of gold (the stat keeps its jackpot name)
    case 'dailyLaunch': L.launchDays = addUnique(L.launchDays, d.key); break;
    // ── versus (one device, both teams)
    case 'versus':
      L.versusRaces += 1;
      L.modesFinished = addUnique(L.modesFinished || [], 'versus');
      if (d.win) {
        L.versusWins += 1;
        if (d.twoVtwo) L.versus2v2Wins += 1;
        if (d.close) L.versusClose += 1;
        if (d.comeback) L.versusComebacks += 1;
        if (d.oneVtwo) L.versus1v2Wins += 1;
        if (d.clean) L.versusClean += 1;
      }
      break;
    default: break;
  }
  return L;
}

// ============================================================
// RIDE TRACKER — the per-ride numbers the frame and finish checks read
// ============================================================
//
// One per ride, keyed on the ride's RaceManager (a RESTART from a checkpoint
// keeps it, so the ride is one ride — same rule as the payout ledger).

export const STEADY_MIN_SPEED = 1;          // m/s: standing still is not riding
export const ROAD_HALF_WIDTH = 2.5;         // metres from the centre: off-road past this
export const FALSE_START_S = 3;
export const SO_CLOSE_M = 10;

export class RideTracker {
  constructor() {
    this.ref = undefined;
    this._goFresh = false;
    this.reset(null);
  }

  reset(ref) {
    this.ref = ref;
    this.sinceGo = this._goFresh ? 0 : null;   // a GO that came just before this ride counts
    this.offroadT = 0;
    this.stripRun = 0; this.stripBest = 0;
    this.boostRun = 0; this.boostBest = 0;
    this.steadyRun = 0; this.steadyBest = 0;
    this.crashes = 0;
    this.treeHits = 0;
    this.stuck = false;       // three crashes at one checkpoint (a Game Over), #716
    this.helpUsed = false;    // the helping hand or the Royal Shortcut, this ride
    this.gustActive = false;
    this.gustCrashed = false;
  }

  sync(ref) {
    if (ref !== this.ref) this.reset(ref);
  }

  /** GO (the countdown ended, or a quick recovery's countdown). */
  go() {
    this.sinceGo = 0;
    this._goFresh = true;
  }

  /**
   * One ride frame.
   * f: { ref, playing, fallen, speed, lateralOffset, onCenterStrip, boosting, shaking, helped }
   */
  frame(dt, f) {
    this.sync(f.ref);
    this._goFresh = false;
    if (!f.playing || !(dt > 0)) return this.snapshot();
    if (this.sinceGo != null) this.sinceGo += dt;
    if (Math.abs(f.lateralOffset || 0) > ROAD_HALF_WIDTH && !f.fallen) this.offroadT += dt;
    this.stripRun = f.onCenterStrip && !f.fallen ? this.stripRun + dt : 0;
    this.stripBest = Math.max(this.stripBest, this.stripRun);
    this.boostRun = f.boosting && !f.fallen ? this.boostRun + dt : 0;
    this.boostBest = Math.max(this.boostBest, this.boostRun);
    const steady = !f.fallen && !f.shaking && (f.speed || 0) >= STEADY_MIN_SPEED;
    if (f.fallen || f.shaking) this.steadyRun = 0;
    else if (steady) this.steadyRun += dt;
    this.steadyBest = Math.max(this.steadyBest, this.steadyRun);
    if (f.helped) this.helpUsed = true;
    return this.snapshot();
  }

  /**
   * A crash. c: { ref, cause, distance, raceDistance }
   * @returns {{ falseStart, soClose }}
   */
  crash(c = {}) {
    if (c.ref !== undefined) this.sync(c.ref);
    this._goFresh = false;                     // a GO is fresh only until the first frame or crash
    this.crashes += 1;
    if (c.cause === 'tree' || c.cause === 'unknown') this.treeHits += 1;   // 'unknown': the stoker isn't told the cause
    if (this.gustActive) this.gustCrashed = true;
    const falseStart = this.sinceGo != null && this.sinceGo <= FALSE_START_S;
    this.sinceGo = null;                       // only the first crash after a GO
    const left = n(c.raceDistance) - n(c.distance);
    const soClose = n(c.raceDistance) > 0 && left >= 0 && left <= SO_CLOSE_M;
    this.stripRun = 0; this.boostRun = 0; this.steadyRun = 0;
    return { falseStart, soClose };
  }

  /** A gust starts (true) or ends (false). Returns true when one was ridden out. */
  gust(starting) {
    if (starting) {
      this.gustActive = true;
      this.gustCrashed = false;
      return false;
    }
    const weathered = this.gustActive && !this.gustCrashed;
    this.gustActive = false;
    return weathered;
  }

  snapshot() {
    return {
      offroadT: this.offroadT,
      stripBest: this.stripBest,
      boostBest: this.boostBest,
      steadyBest: this.steadyBest,
      treeHits: this.treeHits,
      rideCrashes: this.crashes,
      didItMyself: this.stuck && !this.helpUsed,
    };
  }
}

/**
 * Versus (one device): was it a human win, 2v2, close, a comeback, a lone
 * rider beating a tandem (1v2, #608), a win without a crash (#608)?
 *   winner/loser: { id, members: [{type}], distance, speed, crashes }
 *   halfLeader: the id of the team ahead when the leader crossed halfway
 */
export function versusResult({ winner, loser, raceDistance, halfLeader }) {
  const humans = r => (r.members || []).some(m => m.type !== 'bot');
  const win = humans(winner);
  const twoVtwo = (winner.members || []).length === 2 && (loser.members || []).length === 2;
  const left = Math.max(0, n(raceDistance) - n(loser.distance));
  const marginS = left / Math.max(0.1, n(loser.speed));
  const oneVtwo = (winner.members || []).length === 1 && (loser.members || []).length === 2;
  const clean = n(winner.crashes) === 0;
  return { win, twoVtwo, oneVtwo, clean, close: marginS < 1, comeback: !!halfLeader && halfLeader !== winner.id, marginS };
}
