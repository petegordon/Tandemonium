// achievement-scenarios.mjs — how each achievement's reel is earned, for achievements-all.mjs (#506).
//
// One entry per achievement id. The reel is a RIDE TOGETHER (local co-op, both pads, both geese) unless
// `mode` says otherwise; the achievement fires for real and the game's own toast is what the reel shows.
//   seed      lifetime stats to start from (tandemonium_achievement_stats, v2): counters one short of the goal,
//             so the moment happens in a short ride (Century Ride shows the odometer passing 100 km, not 100 km of riding)
//   storage   other localStorage to start from (records, the daily save, the wallet)
//   level / difficulty / cadence / human   the ride (defaults: grandma, chill, 3.4, 1)
//   bots      patch for the rider bots once riding (sway, dodge, offset, path, collect)
//   prep      async (page) => {}: set-up before the ride starts (bike colour, ...)
//   pre / post   seconds of footage kept before / after the toast (defaults 2.5 / 3.0)
//   cam       a reel camera for the take (null: the game's own chase camera)
//   todo      not scripted yet (why)
import { STILL } from './achievements.mjs';

// Day keys follow the game's own rollover hour (js/daily-seed.js dailyKey): 'rel:k' is resolved in the page by
// achievements-all.mjs to the key k days ago; a dayList 'rel:n' is the n days ending yesterday.
const run = (n) => ({ days: n, dayList: 'rel:' + n, lastDay: 'rel:1' });

/** A slow personal best on Grandma's (chill, co-op), so the bots' finish beats it. */
const slowRecord = { 'grandma|chill|coop': { timeMs: 240000, bestMedal: null, helped: false } };

const finish = { pre: 3.0, post: 3.0 };            // the toast comes with the finish sheet
const start = { pre: 1.0, post: 3.5 };             // the toast comes at GO
const crashAt = (dist) => async (page) => { /* placeholder: the bot steers into the next pylon after `dist` */ page.__crashAt = dist; };

export const SCENARIOS = {
  // ── First rides ──
  first_remount: { seed: {}, crash: 90, ...finish },                       // crash on a pylon, ride on, finish
  first_boost: { seed: {}, bots: { collect: true }, pre: 2.0, post: 3.0 },  // the first present

  // ── Distance (the odometer passes the mark during the ride) ──
  first_500m: { seed: { cumulativeDistance: 380 }, pre: 2.5, post: 3 },
  first_km: { seed: { cumulativeDistance: 880 }, pre: 2.5, post: 3 },
  five_k: { seed: { cumulativeDistance: 4880 }, pre: 2.5, post: 3 },
  ten_k: { seed: { cumulativeDistance: 9880 }, pre: 2.5, post: 3 },
  half_marathon: { seed: { cumulativeDistance: 20980 }, pre: 2.5, post: 3 },
  marathon: { seed: { cumulativeDistance: 42080 }, pre: 2.5, post: 3 },
  century: { seed: { cumulativeDistance: 99880 }, pre: 2.5, post: 3 },

  // ── Coming back (the ride itself is the 10th / the 3rd day) ──
  rides_10: { seed: { rides: 9, ...run(4) }, ...start },
  days_3: { seed: { rides: 5, ...run(2) }, ...start },
  days_7: { seed: { rides: 12, ...run(6) }, ...start },
  days_30: { seed: { rides: 40, ...run(29) }, ...start },

  // ── Levels and medals (Grandma's, 250 m) ──
  home_sweet: { seed: {}, ...finish },
  perfect_1k: { seed: {}, bots: { sway: STILL }, ...finish },
  grandma_bronze: { seed: {}, difficulty: 'chill', ...finish },
  grandma_silver: { seed: {}, difficulty: 'chill', cadence: 3.6, ...finish },
  grandma_gold: { seed: {}, difficulty: 'chill', cadence: 3.8, bots: { sway: STILL }, ...finish },
  daily_gold: { seed: {}, level: 'daily', cadence: 3.8, bots: { sway: STILL }, ...finish },
  all_gold: { seed: { golds: ['daily'] }, cadence: 3.8, bots: { sway: STILL }, ...finish },   // Grandma's gold completes the set
  adventurer: { seed: {}, difficulty: 'adventurous', bots: { sway: STILL }, ...finish },
  daredevil: { seed: {}, difficulty: 'daredevil', cadence: 2.6, human: 0, bots: { sway: STILL, collect: false, steer: 0.7 }, ...finish },

  // ── Clean riding ──
  steady_hands: { seed: {}, level: 'daily', cadence: 2.0, human: 0, bots: { sway: STILL, steer: 0.5, collect: false }, pre: 2.5, post: 3 },   // 500 m gently: > 60 s, small leans
  centerline: { seed: {}, level: 'daily', cadence: 2.2, human: 0, bots: { sway: STILL, dodge: false, offset: 0, collect: false, steer: 1.3 }, pre: 2.5, post: 3 },
  no_offroad: { seed: {}, bots: { sway: STILL }, ...finish },
  no_trees_daily: { seed: {}, level: 'daily', bots: { sway: STILL }, ...finish },
  new_best: { seed: {}, storage: { tandemonium_records: JSON.stringify(slowRecord) }, ...finish },
  assist_free: { todo: 'ASSIST is offered after repeated crashes in one segment; the decline is a UI step (not scripted yet)' },

  // ── Speed and boost ──
  speed_demon: { seed: {}, difficulty: 'daredevil', cadence: 4.0, bots: { collect: true, sway: STILL }, pre: 2.5, post: 3 },
  terminal_goose: { seed: {}, difficulty: 'daredevil', cadence: 4.0, bots: { collect: true, sway: STILL }, pre: 2.5, post: 3 },
  boost_25: { seed: { boosts: 24, pickups: 24 }, bots: { collect: true }, pre: 2.0, post: 3 },
  afterburner: { seed: {}, cadence: 4.0, bots: { collect: true, sway: STILL }, pre: 2.5, post: 3 },

  // ── Collecting ──
  collector: { seed: {}, level: 'daily', human: 0, bots: { collect: true, sway: STILL }, pre: 2.0, post: 3 },
  hoarder: { seed: {}, bots: { collect: true, sway: STILL }, ...finish },
  presents_100: { seed: { pickups: 99, boosts: 30 }, bots: { collect: true }, pre: 2.0, post: 3 },
  daily_haul: { seed: {}, level: 'daily', human: 0, cadence: 3.0, bots: { collect: true, sway: STILL, dodge: false }, ...finish },

  // ── Chaos Coins (the payout at the finish) ──
  coin_first: { seed: {}, ...finish },
  coins_1000: { seed: { coinsEarned: 990 }, ...finish },
  coins_10000: { seed: { coinsEarned: 9990 }, ...finish },
  payday: { seed: {}, cadence: 3.8, bots: { collect: true, sway: STILL }, ...finish },   // gold + no crashes + every present ≈ 227 coins
  first_upgrade: { todo: 'the garage (Slingshot) UI: buy an upgrade' },
  max_upgrade: { todo: 'the garage UI: max one upgrade' },
  garage_royalty: { todo: 'the garage UI: max every upgrade' },
  big_spender: { todo: 'the garage UI: spend 1,000 coins' },
  rebuilt: { todo: 'the garage UI: rebuild (prestige)' },
  ship_of_theseus: { todo: 'the garage UI: rebuild 5 times' },

  // ── Today's Road ──
  daily_first: { todo: 'a ranked Today\'s Road needs the server (the capture blocks the network)' },
  daily_streak_3: { seed: { dailyDayBest: 2, dailyDayRun: 2, lastDailyDay: 'rel:1' }, level: 'daily', ...finish },
  daily_streak_7: { seed: { dailyDayBest: 6, dailyDayRun: 6, lastDailyDay: 'rel:1' }, level: 'daily', ...finish },
  daily_streak_30: { seed: { dailyDayBest: 29, dailyDayRun: 29, lastDailyDay: 'rel:1' }, level: 'daily', ...finish },
  daily_share: { seed: {}, level: 'daily', share: true, pre: 2.0, post: 3.0 },         // the Share button on the result sheet
  daily_practice_10: { seed: { dailyPractice: 9 }, level: 'daily', ...finish },

  // ── Riding together ──
  perfect_sync: { seed: {}, human: 0, pre: 2.5, post: 3 },                 // two riders answering each other's beat
  team_player: { seed: {}, atStart: true, pre: 0, post: 4.0 },        // 100% safe riding from the first frame: the toast is up at GO
  pair_10_rides: { seed: {}, pairRides: 9, ...finish },
  pair_100km: { seed: {}, pairDistance: 99900, ...finish },
  coop_first: { seed: {}, ...finish },
  social_goose: { seed: { partners: ['goose-a', 'goose-b'], coopFinishes: 2 }, ...finish },
  standing_date: { seed: {}, level: 'daily', pairWeeks: 3, ...finish },   // this week's Today's Road makes the 4th week in a row

  // ── Versus (its own rig) ──
  versus_first: { todo: 'versus rig' }, versus_win: { todo: 'versus rig' }, versus_2v2: { todo: 'versus rig' },
  versus_close: { todo: 'versus rig' }, versus_comeback: { todo: 'versus rig' }, versus_10: { todo: 'versus rig' },

  // ── Chaos ──
  crashes_10: { seed: { crashes: 9 }, crash: 90, pre: 2.0, post: 3.5 },
  false_start: { seed: {}, difficulty: 'daredevil', cadence: 4.5, falseStart: true, pre: 1.5, post: 3.5 },   // lean out hard at GO (chill's safety clamp won't let a lean crash)
  so_close: { seed: {}, difficulty: 'daredevil', leanOutAt: 243, pre: 2.0, post: 3.5 },   // over they go within 10 m of the line
  weathered: { seed: {}, difficulty: 'adventurous', cadence: 3.0, human: 0, bots: { sway: STILL, collect: false }, pre: 3.0, post: 3 },
  gone_with_wind: { seed: { gusts: 9 }, difficulty: 'adventurous', bots: { sway: STILL }, pre: 2.0, post: 3 },

  // ── Exploring ──
  distance_between_us: { todo: 'Tourist needs Google 3D Tiles (network + key)' },
  grand_tour: { todo: 'Tourist needs Google 3D Tiles (network + key)' },

  // ── Grandma's in every colour ──
  grandma_default: { seed: {}, bike: 'default', ...finish },
  grandma_orange: { seed: {}, bike: 'bike_orange', ...finish },
  grandma_magenta: { seed: {}, bike: 'bike_magenta', ...finish },
  grandma_red: { seed: {}, bike: 'bike_red', ...finish },
  grandma_blue: { seed: {}, bike: 'bike_blue', ...finish },
  grandma_green: { seed: {}, bike: 'bike_green', ...finish },
  grandma_yellow: { seed: {}, bike: 'bike_yellow', ...finish },

  // ── Slingshot (its own mode: the garage, a drag, the flight) ──
  sling_first: { todo: 'slingshot rig' }, sling_stage1: { todo: 'slingshot rig' }, sling_stage3: { todo: 'slingshot rig' },
  sling_stage5: { todo: 'slingshot rig' }, sling_stage7: { todo: 'slingshot rig' }, sling_500: { todo: 'slingshot rig' },
  sling_1000: { todo: 'slingshot rig' }, big_air: { todo: 'slingshot rig' }, frequent_flyer: { todo: 'slingshot rig' },
  jackpot: { todo: 'slingshot rig' }, double_down: { todo: 'slingshot rig' }, full_trail: { todo: 'slingshot rig' },
  straight_shooter: { todo: 'slingshot rig' }, medal_key: { seed: {}, cadence: 3.8, bots: { sway: STILL }, ...finish },
  todays_launch: { todo: 'slingshot rig' }, launch_week: { todo: 'slingshot rig' },
};

/** The six with hand-made shots in achievements.mjs (kickoff, learner, ...): not here. */
export const HAND_MADE = { first_pedal: 'kickoff', tutorial_done: 'learner', tutorial_clean: 'natural', first_finish: 'madeit', first_crash: 'goosedown', look_no_thumbs: 'nothumbs' };
