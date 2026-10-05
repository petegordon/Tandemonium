// ============================================================
// ACHIEVEMENT DEFINITIONS — the 100, their stats, and the rules (#401)
// ============================================================
//
// Pure and DOM-free so the unit tests can import it. js/achievements.js holds
// the manager (persistence, toasts, Steam, server sync) and the game glue.
//
// 100 achievements in the 15 sections of issue #401:
//   - 23 existing ids, kept unchanged (anything already earned, and its Steam
//     id, carries over) — 16 visible + the 7 retired per-bike-colour ones;
//   - 77 new ones.
//
// A condition is (s, L) => boolean:
//   s  the state of the moment — a ride frame, a finish, or {} for an event;
//   L  the lifetime stats below (persisted in 'tandemonium_achievement_stats').
// Most conditions read L, so an event anywhere (a payout, a launch, a garage
// purchase) can earn them without a ride in progress.
//
// demo: false marks the 18 rows the spec's Demo column calls full-game only,
// plus sling_stage5: the spec marks it demo ✓, but DEMO_RULES caps the
// Slingshot at stage 3, so stage 5 can't be cleared in the demo; and
// double_down: only Today's Launch (full game) can pair a jackpot with a best;
// and daily_streak_3/7: the demo rides the weekly road, which feeds no day
// streak (22 in all).
// `full` says why: an edition rule (js/edition.js · DEMO_RULES) blocks it, or
// 'scope' — a long-haul goal kept for the full game. The demo never awards
// them; the stats keep counting, so they unlock on the full game's first check.

import { LEVELS } from './race-config.js';
import { STAGE_GATES, STAGE_GOALS, UPGRADES } from './slingshot.js';

export const SECTIONS = [
  { id: 'first',    title: 'First rides' },
  { id: 'distance', title: 'Distance' },
  { id: 'back',     title: 'Coming back' },
  { id: 'medals',   title: 'Levels and medals' },
  { id: 'clean',    title: 'Clean riding' },
  { id: 'speed',    title: 'Speed and boost' },
  { id: 'collect',  title: 'Collecting' },
  { id: 'sling',    title: 'Slingshot' },
  { id: 'coins',    title: 'Chaos Coins' },
  { id: 'daily',    title: "Today's Road" },
  { id: 'together', title: 'Riding together' },
  { id: 'versus',   title: 'Versus' },
  { id: 'chaos',    title: 'Chaos' },
  { id: 'explore',  title: 'Exploring' },
  { id: 'retired',  title: 'Retired bike colours' },
];

const MEDAL_RANK = { bronze: 1, silver: 2, gold: 3 };
const rank = m => MEDAL_RANK[m] || 0;

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
  { id: 'century',        section: 'distance', name: 'Century Ride',     icon: '💯', desc: 'Ride 100 km in total',                ...km(100000), demo: false, full: 'scope' },

  // ── 3. Coming back ───────────────────────────────────────
  { id: 'rides_10',       section: 'back', name: 'Regular Rider',        icon: '🚲', desc: 'Go on 10 rides of any kind',          ...count('rides', 10) },
  { id: 'days_3',         section: 'back', name: 'Coming Back',          icon: '📆', desc: 'Ride on 3 different days',            ...count('days', 3), unit: 'days' },
  { id: 'days_7',         section: 'back', name: 'Habit Forming',        icon: '🗓️', desc: 'Ride on 7 different days',           ...count('days', 7), unit: 'days' },
  { id: 'days_30',        section: 'back', name: 'Lifer',                icon: '🪺', desc: 'Ride on 30 different days',           ...count('days', 30), unit: 'days', demo: false, full: 'scope' },

  // ── 4. Levels and medals ─────────────────────────────────
  { id: 'home_sweet',     section: 'medals', name: 'Home Sweet Home',    icon: '🏠', desc: "Finish Grandma's",          condition: s => s.finishedLevel === 'grandma' },
  { id: 'perfect_1k',     section: 'medals', name: 'Flawless',           icon: '💮', desc: "Finish Grandma's with no crashes or restarts", condition: s => s.finishedLevel === 'grandma' && s.crashes === 0 && s.restarts === 0 },
  { id: 'grandma_bronze', section: 'medals', name: 'Cookie',             icon: '🍪', desc: "Win bronze on Grandma's",             condition: s => s.finishedLevel === 'grandma' && rank(s.medal) >= 1 },
  { id: 'grandma_silver', section: 'medals', name: 'Tea and Biscuits',   icon: '🫖', desc: "Win silver on Grandma's",             condition: s => s.finishedLevel === 'grandma' && rank(s.medal) >= 2 },
  { id: 'grandma_gold',   section: 'medals', name: "Grandma's Favourite", icon: '🥇', desc: "Win gold on Grandma's",              condition: s => s.finishedLevel === 'grandma' && rank(s.medal) >= 3 },
  { id: 'daily_gold',     section: 'medals', name: 'Road Scholar',       icon: '📜', desc: "Win gold on any day's Today's Road (practice counts)", condition: s => s.finishedLevel === 'daily' && s.medal === 'gold' },
  { id: 'all_gold',       section: 'medals', name: 'Gilded Goose',       icon: '👑', desc: 'Win gold on every level',
    condition: (s, L) => MEDAL_LEVELS.every(id => (L.golds || []).includes(id)),
    progress: L => [MEDAL_LEVELS.filter(id => (L.golds || []).includes(id)).length, MEDAL_LEVELS.length], demo: false, full: 'scope' },
  { id: 'adventurer',     section: 'medals', name: 'Adventurer',         icon: '🧭', desc: 'Finish any level on Adventurous',     condition: s => fin(s) && s.difficulty === 'adventurous' },
  { id: 'daredevil',      section: 'medals', name: 'Daredevil',          icon: '😈', desc: 'Finish any level on Daredevil',       condition: s => fin(s) && s.difficulty === 'daredevil' },

  // ── 5. Clean riding ──────────────────────────────────────
  { id: 'steady_hands',   section: 'clean', name: 'Steady Hands',        icon: '🧘', desc: 'Ride 60 s without the bike shaking from leaning too far', condition: s => n(s.steadyBest) >= 60 },
  { id: 'centerline',     section: 'clean', name: 'On the Line',         icon: '🎯', desc: "Stay on the road's centre strip for 30 s straight",       condition: s => n(s.stripBest) >= 30 },
  { id: 'no_offroad',     section: 'clean', name: 'Stayed on the Road',  icon: '🛤️', desc: 'Finish a level without going off-road',                 condition: s => fin(s) && s.offroadT === 0 },
  { id: 'no_trees_daily', section: 'clean', name: 'No Trees Were Harmed', icon: '🌳', desc: "Finish Today's Road without hitting a tree",           condition: s => s.finishedLevel === 'daily' && s.treeHits === 0 },
  { id: 'new_best',       section: 'clean', name: 'Personal Best',       icon: '⭐', desc: 'Set a new personal best',                              condition: (s, L) => s.newBest === true || n(L.personalBests) >= 1 },
  { id: 'assist_free',    section: 'clean', name: 'Did It Myself',       icon: '💪', desc: "Turn down ASSIST when it's offered, then finish",       condition: s => fin(s) && s.assistDeclined === true },

  // ── 6. Speed and boost ───────────────────────────────────
  { id: 'speed_demon',    section: 'speed', name: 'Speed Demon',         icon: '⚡', desc: 'Hit 50 km/h',                     condition: s => s.speed >= 13.9 },
  { id: 'terminal_goose', section: 'speed', name: 'Terminal Goose',      icon: '☄️', desc: 'Hit 65 km/h',                         condition: s => s.speed >= 65 / 3.6 },
  { id: 'boost_25',       section: 'speed', name: 'Boost Junkie',        icon: '🔋', desc: 'Trigger 25 boosts',                   ...count('boosts', 25) },
  { id: 'afterburner',    section: 'speed', name: 'Afterburner',         icon: '🔥', desc: 'Chain pickups to keep boosting for 10 s straight', condition: s => n(s.boostBest) >= 10 },

  // ── 7. Collecting ────────────────────────────────────────
  { id: 'collector',      section: 'collect', name: 'Collector',         icon: '🌟', desc: 'Collect 10 items in one ride', condition: s => s.collectibles >= 10 },
  { id: 'hoarder',        section: 'collect', name: 'Hoarder',           icon: '👑', desc: 'Collect every item in one ride', condition: s => s.collectibles > 0 && s.collectibles >= s.totalCollectibles },
  { id: 'presents_100',   section: 'collect', name: 'Special Delivery',  icon: '🎁', desc: 'Collect 100 presents in total',       ...count('pickups', 100) },
  { id: 'daily_haul',     section: 'collect', name: 'Daily Haul',        icon: '🧺', desc: "Collect every present on Today's Road", condition: s => s.finishedLevel === 'daily' && s.totalCollectibles > 0 && s.collectibles >= s.totalCollectibles },

  // ── 8. Slingshot ─────────────────────────────────────────
  { id: 'sling_first',    section: 'sling', name: 'Fire!',               icon: '🪃', desc: 'Launch from the slingshot',            ...count('slingLaunches', 1) },
  { id: 'sling_stage1',   section: 'sling', name: 'Stage One',           icon: '1️⃣', desc: 'Clear Slingshot stage 1 (300 m)',     ...count('slingStage', 1), stage: 1 },
  { id: 'sling_stage3',   section: 'sling', name: 'Getting the Hang of It', icon: '3️⃣', desc: 'Clear Slingshot stage 3',       ...count('slingStage', 3), stage: 3 },
  { id: 'sling_stage5',   section: 'sling', name: 'Long Shot',           icon: '5️⃣', desc: 'Clear Slingshot stage 5',             ...count('slingStage', 5), stage: 5, demo: false, full: 'slingStage' },   // spec says demo ✓, but the demo stops at stage 3 (edition.js)
  { id: 'sling_stage7',   section: 'sling', name: 'Slingshot Royalty',   icon: '7️⃣', desc: 'Clear Slingshot stage 7 (1,050 m)',   ...count('slingStage', 7), stage: 7, demo: false, full: 'slingStage' },
  { id: 'sling_500',      section: 'sling', name: 'Half a Klick',        icon: '📏', desc: '500 m in one launch',                 ...count('slingBest', 500), stage: stageForDistance(500), unit: 'm' },
  { id: 'sling_1000',     section: 'sling', name: 'Kilometre Fling',     icon: '🛫', desc: '1,000 m in one launch',               ...count('slingBest', 1000), stage: stageForDistance(1000), unit: 'm', demo: false, full: 'slingStage' },
  { id: 'big_air',        section: 'sling', name: 'Big Air',             icon: '🪂', desc: 'Land a Big Air off a ramp',           ...count('bigAirs', 1) },
  { id: 'frequent_flyer', section: 'sling', name: 'Frequent Flyer',      icon: '✈️', desc: 'Land 25 Big Airs',                    ...count('bigAirs', 25) },
  { id: 'jackpot',        section: 'sling', name: 'Jackpot!',            icon: '🎰', desc: 'Hit the jackpot billboard',           ...count('jackpots', 1) },
  { id: 'double_down',    section: 'sling', name: 'Double Down',         icon: '🎲', desc: 'Hit the jackpot on a run that also beats your best distance', ...count('doubleDowns', 1), demo: false, full: 'todaysLaunch' },   // spec says demo ✓, but a stage-mode jackpot (≈118 m) can't beat a stage-2+ best; only Today's Launch can
  { id: 'full_trail',     section: 'sling', name: 'Full Trail',          icon: '🪙', desc: 'Grab all 5 coins in a trail',         ...count('fullTrails', 1) },
  { id: 'straight_shooter', section: 'sling', name: 'Straight Shooter',  icon: '📐', desc: 'Go 300 m without steering after launch', ...count('straightShots', 1) },
  { id: 'medal_key',      section: 'sling', name: 'Medal Key',           icon: '🗝️', desc: 'Win a regular-ride medal that unlocks a Slingshot stage', ...count('medalKeys', 1) },
  { id: 'todays_launch',  section: 'sling', name: "Today's Launch",      icon: '🌅', desc: "Fly Today's Launch (the daily Slingshot course)", ...countList('launchDays', 1), demo: false, full: 'todaysLaunch' },
  { id: 'launch_week',    section: 'sling', name: 'Launch Week',         icon: '📅', desc: "Fly Today's Launch on 7 different days", ...countList('launchDays', 7), unit: 'days', demo: false, full: 'todaysLaunch' },

  // ── 9. Chaos Coins ───────────────────────────────────────
  { id: 'coin_first',     section: 'coins', name: 'Pocket Change',       icon: '🪙', desc: 'Earn your first Chaos Coin',          ...count('coinsEarned', 1) },
  { id: 'coins_1000',     section: 'coins', name: 'Coin Purse',          icon: '👛', desc: 'Earn 1,000 Chaos Coins in total',     ...count('coinsEarned', 1000) },
  { id: 'coins_10000',    section: 'coins', name: 'Goose Egg Nest',      icon: '🥚', desc: 'Earn 10,000 Chaos Coins in total',    ...count('coinsEarned', 10000), demo: false, full: 'scope' },
  { id: 'payday',         section: 'coins', name: 'Payday',              icon: '💰', desc: 'Earn 200 coins from one regular (non-Slingshot) ride', ...count('bestRideCoins', 200) },
  { id: 'first_upgrade',  section: 'coins', name: 'Tinkerer',            icon: '🔧', desc: 'Buy your first garage upgrade',       ...count('upgrades', 1) },
  { id: 'max_upgrade',    section: 'coins', name: 'Fully Tuned',         icon: '🔩', desc: 'Max out any one upgrade',             condition: (s, L) => !!L.maxedAny, demo: false, full: 'scope' },
  { id: 'garage_royalty', section: 'coins', name: 'Garage Royalty',      icon: '🏰', desc: 'Max out every upgrade',               condition: (s, L) => !!L.maxedAll, demo: false, full: 'scope' },
  { id: 'big_spender',    section: 'coins', name: 'Big Spender',         icon: '💸', desc: 'Spend 1,000 coins in the garage',     ...count('coinsSpent', 1000) },
  { id: 'rebuilt',        section: 'coins', name: 'Rebuilt',             icon: '♻️', desc: 'Rebuild the bike (prestige) for the first time', ...count('rebuilds', 1), demo: false, full: 'scope' },
  { id: 'ship_of_theseus', section: 'coins', name: 'Ship of Theseus',    icon: '⛵', desc: 'Rebuild the bike 5 times',            ...count('rebuilds', 5), demo: false, full: 'scope' },

  // ── 10. Today's Road ─────────────────────────────────────
  { id: 'daily_first',    section: 'daily', name: "Today's Road",        icon: '📅', desc: "Do your first ranked Today's Road", condition: s => s.dailyRanked === true, demo: false, full: 'ranked' },
  { id: 'daily_streak_3', section: 'daily', name: 'Three in a Row',      icon: '🔁', desc: "Ride Today's Road on 3 days running", condition: (s, L) => n(s.dailyStreak) >= 3 || n(L.dailyDayBest) >= 3,
    progress: streakProgress(3), unit: 'days', demo: false, full: 'weeklyRoad' },
  { id: 'daily_streak_7', section: 'daily', name: 'A Week of Roads',     icon: '🔥', desc: "Ride Today's Road 7 days running", condition: (s, L) => n(s.dailyStreak) >= 7 || n(L.dailyDayBest) >= 7,
    progress: streakProgress(7), unit: 'days', demo: false, full: 'weeklyRoad' },
  { id: 'daily_streak_30', section: 'daily', name: 'A Month of Roads',   icon: '☄️', desc: "Ride Today's Road 30 days running", condition: (s, L) => n(s.dailyStreak) >= 30 || n(L.dailyDayBest) >= 30,
    progress: streakProgress(30), unit: 'days', demo: false, full: 'scope' },
  { id: 'daily_share',    section: 'daily', name: 'Show-Off',            icon: '📣', desc: "Share a Today's Road result",         ...count('shares', 1) },
  { id: 'daily_practice_10', section: 'daily', name: 'Practice Makes Perfect', icon: '🔂', desc: "Finish 10 practice rides on Today's Road", ...count('dailyPractice', 10) },

  // ── 11. Riding together ──────────────────────────────────
  // A-2: Perfect Sync is reachable by cooperation — each paired beat adds +0.10
  // to offsetScore against 5%/s decay, so two riders answering each other's
  // beat at ~1 beat/s cross 0.9 in about ten seconds.
  { id: 'perfect_sync',   section: 'together', name: 'Perfect Sync',     icon: '🤝', desc: 'Stay in sync for 10 s',     condition: s => s.offsetScore > 0.9 && s.syncDuration >= 10 },
  { id: 'team_player',    section: 'together', name: 'Team Player',      icon: '🤜', desc: '80% or more safe-riding contribution in co-op', condition: s => s.isMultiplayer && s.safePct >= 80 },
  { id: 'pair_10_rides',  section: 'together', name: 'Regulars',         icon: '👫', desc: 'Ride 10 times with the same partner', condition: s => s.pairRides >= 10 },
  { id: 'pair_100km',     section: 'together', name: 'A Hundred Together', icon: '🛣️', desc: 'Ride 100 km with the same partner', condition: s => s.pairDistanceKm >= 100, demo: false, full: 'scope' },
  { id: 'coop_first',     section: 'together', name: 'The Two of Us',    icon: '💞', desc: 'Finish a co-op ride',                 ...count('coopFinishes', 1) },
  { id: 'social_goose',   section: 'together', name: 'Social Goose',     icon: '🦢', desc: 'Finish co-op rides with 3 different partners', ...countList('partners', 3) },
  { id: 'standing_date',  section: 'together', name: 'Standing Date',    icon: '💐', desc: 'Keep a 4-week pair streak',           condition: s => n(s.pairWeekStreak) >= 4, demo: false, full: 'scope' },

  // ── 12. Versus ───────────────────────────────────────────
  { id: 'versus_first',   section: 'versus', name: 'Rivals',             icon: '⚔️', desc: 'Finish a versus race',                ...count('versusRaces', 1) },
  { id: 'versus_win',     section: 'versus', name: 'Crown the Goose',    icon: '🏆', desc: 'Win a versus race',                   ...count('versusWins', 1) },
  { id: 'versus_2v2',     section: 'versus', name: 'Royal Court',        icon: '🤴', desc: 'Win a 2v2 versus race',               ...count('versus2v2Wins', 1) },
  { id: 'versus_close',   section: 'versus', name: 'Neck and Beak',      icon: '📸', desc: 'Win a versus race by less than 1 s',  ...count('versusClose', 1) },
  { id: 'versus_comeback', section: 'versus', name: 'Comeback Geese',    icon: '↩️', desc: 'Win a versus race after trailing at halfway', ...count('versusComebacks', 1) },
  { id: 'versus_10',      section: 'versus', name: 'House Champion',     icon: '🏅', desc: 'Win 10 versus races',                 ...count('versusWins', 10) },

  // ── 13. Chaos (hidden) ───────────────────────────────────
  { id: 'crashes_10',     section: 'chaos', hidden: true, name: 'Frequent Faller', icon: '🤕', desc: 'Crash 10 times in total',   ...count('crashes', 10) },
  { id: 'false_start',    section: 'chaos', hidden: true, name: 'False Start',     icon: '🚦', desc: 'Crash within 3 s of GO',    ...count('falseStarts', 1) },
  { id: 'so_close',       section: 'chaos', hidden: true, name: 'So Close',        icon: '🤏', desc: 'Crash within 10 m of the finish', ...count('soCloses', 1) },
  { id: 'weathered',      section: 'chaos', hidden: true, name: 'Weathered',       icon: '🌬️', desc: 'Ride through a gust without crashing', ...count('weathered', 1) },
  { id: 'gone_with_wind', section: 'chaos', hidden: true, name: 'Gone With the Wind', icon: '🌪️', desc: 'Get pushed by 10 gusts', ...count('gusts', 10) },

  // ── 14. Exploring ────────────────────────────────────────
  { id: 'distance_between_us', section: 'explore', name: 'The Distance Between Us', icon: '📍', desc: 'Finish a Tourist ride', condition: s => s.touristFinished === true, demo: false, full: 'tourist' },
  { id: 'grand_tour',     section: 'explore', name: 'Grand Tour',        icon: '🗺️', desc: 'Ride 5 km in total in Tourist',       ...count('touristDistance', 5000), unit: 'm', demo: false, full: 'tourist' },

  // ── 15. Retired bike colours (F-1) ───────────────────────
  // Hidden from the lobby (RETIRED_IDS) but still defined, so anyone who
  // earned one keeps it and Steam still recognises it.
  { id: 'grandma_default', section: 'retired', name: "Grandma's Classic",   icon: '🚲', desc: "Finish Grandma's on the default bike", condition: grandmaBike('default') },
  { id: 'grandma_orange',  section: 'retired', name: 'Marmalade Delivery',  icon: '🍊', desc: "Finish Grandma's on the orange bike",  condition: grandmaBike('bike_orange') },
  { id: 'grandma_magenta', section: 'retired', name: 'Berry Special Visit', icon: '🫐', desc: "Finish Grandma's on the magenta bike", condition: grandmaBike('bike_magenta') },
  { id: 'grandma_red',     section: 'retired', name: 'Cherry on Top',       icon: '🍒', desc: "Finish Grandma's on the red bike",     condition: grandmaBike('bike_red') },
  { id: 'grandma_blue',    section: 'retired', name: "Ocean to Grandma's",  icon: '🌊', desc: "Finish Grandma's on the blue bike",    condition: grandmaBike('bike_blue') },
  { id: 'grandma_green',   section: 'retired', name: 'Jungle Express',      icon: '🌿', desc: "Finish Grandma's on the green bike",   condition: grandmaBike('bike_green') },
  { id: 'grandma_yellow',  section: 'retired', name: 'Banana Delivery',     icon: '🍌', desc: "Finish Grandma's on the yellow bike",  condition: grandmaBike('bike_yellow') },
].map(a => ({ demo: true, hidden: false, ...a }));

/**
 * F-1 · the seven per-bike-colour Grandma's achievements are retired from the
 * VISIBLE list. They rewarded riding the same 250 m seven times to see seven
 * colours. The ids stay defined (earned ones are kept; Steam knows them).
 */
export const RETIRED_IDS = new Set([
  'grandma_default', 'grandma_orange', 'grandma_magenta', 'grandma_red',
  'grandma_blue', 'grandma_green', 'grandma_yellow'
]);

/** The ids the demo never awards (the spec's Demo column "—"). */
export const DEMO_UNEARNABLE = ACHIEVEMENTS.filter(a => !a.demo).map(a => a.id);

export function getDefinition(id) {
  return ACHIEVEMENTS.find(a => a.id === id) || null;
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
  'slingLaunches', 'slingBest', 'slingStage', 'bigAirs', 'jackpots', 'doubleDowns', 'fullTrails',
  'straightShots', 'medalKeys', 'dailyPractice', 'shares', 'dailyDayRun', 'dailyDayBest',
  'coopFinishes', 'versusRaces', 'versusWins', 'versus2v2Wins', 'versusClose', 'versusComebacks',
  'touristDistance',
];
const LISTS = ['dayList', 'golds', 'launchDays', 'partners'];
const FLAGS = ['pedalled', 'maxedAny', 'maxedAll'];
const STRINGS = ['lastDay', 'lastDailyDay'];

export function emptyStats() {
  const L = { v: STATS_VERSION };
  for (const k of NUMERIC) L[k] = 0;
  for (const k of LISTS) L[k] = [];
  for (const k of FLAGS) L[k] = false;
  for (const k of STRINGS) L[k] = null;
  return L;
}

/** Any stored object (v1, v2, junk) → a clean v2. Never throws, never loses a counter. */
export function migrateStats(raw) {
  const L = emptyStats();
  if (!raw || typeof raw !== 'object') return L;
  for (const k of NUMERIC) if (Number.isFinite(raw[k]) && raw[k] > 0) L[k] = raw[k];
  for (const k of LISTS) {
    if (Array.isArray(raw[k])) L[k] = [...new Set(raw[k].filter(x => typeof x === 'string'))];
  }
  for (const k of FLAGS) L[k] = raw[k] === true;
  for (const k of STRINGS) L[k] = typeof raw[k] === 'string' ? raw[k] : null;
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
  L.lastDay = today;
}

const addUnique = (list, v) => (v && !list.includes(v) ? [...list, v] : list);

/** Does this finish's medal meet a Slingshot stage gate (js/slingshot.js · STAGE_GATES)? */
export function opensMedalGate(levelId, medal) {
  return Object.values(STAGE_GATES).some(g => g.medal && g.level === levelId && rank(medal) >= rank(g.medal));
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
      if (d.medal && opensMedalGate(d.finishedLevel, d.medal)) L.medalKeys += 1;
      if (d.isCoop) {
        L.coopFinishes += 1;
        if (d.partnerKey) L.partners = addUnique(L.partners, d.partnerKey);
      }
      // The demo's weekly road (d.weekly) is one road a week: it feeds no day streak.
      if (d.finishedLevel === 'daily' && !d.weekly && today && L.lastDailyDay !== today) {
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
      if (d.mode !== 'slingshot' && d.mode !== 'todaysLaunch') {
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
      if (d.jackpot && d.record) L.doubleDowns += 1;
      if (n(d.fullTrails) > 0) L.fullTrails += Math.floor(n(d.fullTrails));
      if (d.straight) L.straightShots += 1;
      break;
    case 'stageCleared': L.slingStage = Math.max(L.slingStage, Math.floor(n(d.stage))); break;
    case 'bigAir': L.bigAirs += 1; break;
    case 'jackpot': L.jackpots += 1; break;
    case 'todaysLaunch': L.launchDays = addUnique(L.launchDays, d.key); break;
    // ── versus (one device, both teams)
    case 'versus':
      L.versusRaces += 1;
      if (d.win) {
        L.versusWins += 1;
        if (d.twoVtwo) L.versus2v2Wins += 1;
        if (d.close) L.versusClose += 1;
        if (d.comeback) L.versusComebacks += 1;
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
    this.assistOffered = false;
    this.assistUsed = false;
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
   * f: { ref, playing, fallen, speed, lateralOffset, onCenterStrip, boosting, shaking, assistOn }
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
    if (f.assistOn && this.assistOffered) this.assistUsed = true;
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
      assistDeclined: this.assistOffered && !this.assistUsed,
    };
  }
}

/**
 * Versus (one device): was it a human win, 2v2, close, a comeback?
 *   winner/loser: { id, members: [{type}], distance, speed }
 *   halfLeader: the id of the team ahead when the leader crossed halfway
 */
export function versusResult({ winner, loser, raceDistance, halfLeader }) {
  const humans = r => (r.members || []).some(m => m.type !== 'bot');
  const win = humans(winner);
  const twoVtwo = (winner.members || []).length === 2 && (loser.members || []).length === 2;
  const left = Math.max(0, n(raceDistance) - n(loser.distance));
  const marginS = left / Math.max(0.1, n(loser.speed));
  return { win, twoVtwo, close: marginS < 1, comeback: !!halfLeader && halfLeader !== winner.id, marginS };
}
