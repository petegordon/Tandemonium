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
  daredevil: { seed: {}, difficulty: 'daredevil', cadence: 3.4, human: 0, bots: { sway: STILL, collect: false, dodge: true }, ...finish },

  // ── Clean riding ──
  steady_hands: { seed: {}, human: 0, bots: { sway: STILL, collect: false }, noPresents: true, maxSpeed: 3.5, pre: 2.5, post: 3 },   // Grandma's at a capped 3.5 m/s, no presents to boost off: > 60 s of calm riding   // Grandma's with the brakes dragged (the bike tops out at any cadence): > 60 s of calm riding
  centerline: { seed: {}, human: 0, bots: { sway: STILL, dodge: false, offset: 0, collect: false, steer: 2.0, gains: { kl: 0.16, kh: 0.55 } }, noPresents: true, maxSpeed: 6, pre: 2.5, post: 3 },   // Grandma's at a capped 6 m/s with a firmer hand, no presents to boost off, dead centre: 30 s on the strip   // Grandma's at a crawl, dead centre: 30 s on the strip
  no_offroad: { seed: {}, bots: { sway: STILL }, ...finish },
  no_trees_daily: { seed: {}, level: 'daily', bots: { sway: STILL }, ...finish },
  new_best: { seed: {}, storage: { tandemonium_records: JSON.stringify(slowRecord) }, ...finish },
  assist_free: { seed: {}, difficulty: 'adventurous', cadence: 3.4, human: 0, bots: { sway: STILL, collect: false }, assist: true, ...finish },   // three crashes in the first segment bring the ASSIST offer; RESTART without it, then finish

  // ── Speed and boost ──
  speed_demon: { seed: {}, difficulty: 'daredevil', cadence: 4.0, bots: { collect: true, sway: STILL }, pre: 2.5, post: 3 },
  terminal_goose: { seed: {}, difficulty: 'daredevil', cadence: 4.0, bots: { collect: true, sway: STILL }, pre: 2.5, post: 3 },
  boost_25: { seed: { boosts: 24, pickups: 24 }, bots: { collect: true }, pre: 2.0, post: 3 },
  afterburner: { seed: {}, cadence: 4.0, bots: { collect: true, sway: STILL }, pre: 2.5, post: 3 },

  // ── Collecting ──
  collector: { seed: {}, level: 'daily', human: 0, bots: { collect: true, sway: STILL }, pre: 2.0, post: 3 },
  hoarder: { seed: {}, bots: { collect: true, sway: STILL }, ...finish },
  presents_100: { seed: { pickups: 99, boosts: 30 }, bots: { collect: true }, pre: 2.0, post: 3 },
  daily_haul: { seed: {}, level: 'daily', human: 0, cadence: 3.4, bots: { collect: true, sway: STILL }, ...finish },   // the bot swerves round a pylon to the side its next present is on

  // ── Chaos Coins (the payout at the finish) ──
  coin_first: { seed: {}, ...finish },
  coins_1000: { seed: { coinsEarned: 990 }, ...finish },
  coins_10000: { seed: { coinsEarned: 9990 }, ...finish },
  payday: { seed: {}, cadence: 3.8, bots: { collect: true, sway: STILL }, ...finish },   // gold + no crashes + every present ≈ 227 coins
  first_upgrade: { kind: 'garage', seed: {}, wallet: { coins: 120 }, buy: 'sling' },
  max_upgrade: { kind: 'garage', seed: { upgrades: 9 }, wallet: { coins: 4000, lv: { sling: 9, wheels: 3 } }, buy: 'sling' },          // the tenth band
  garage_royalty: { kind: 'garage', seed: { upgrades: 27, maxedAny: true }, wallet: { coins: 4000, lv: { sling: 10, wheels: 10, magnet: 7 } }, buy: 'magnet' },
  big_spender: { kind: 'garage', seed: { upgrades: 12, coinsSpent: 980 }, wallet: { coins: 400, lv: { sling: 2 } }, buy: 'wheels' },   // 70 coins takes it past 1,000
  rebuilt: { kind: 'garage', seed: { upgrades: 28, maxedAny: true, maxedAll: true }, wallet: { coins: 4000, lv: { sling: 10, wheels: 10, magnet: 8 } }, rebuild: true },
  ship_of_theseus: { kind: 'garage', seed: { upgrades: 140, maxedAny: true, maxedAll: true, rebuilds: 4 }, wallet: { ...{ coins: 4000, lv: { sling: 10, wheels: 10, magnet: 8 } }, rebuilds: 4 }, rebuild: true },

  // ── Today's Road ──
  daily_first: { todo: 'a ranked Today\'s Road needs the server (the capture blocks the network)' },
  daily_streak_3: { seed: { dailyDayBest: 2, dailyDayRun: 2, lastDailyDay: 'rel:1' }, level: 'daily', ...finish },
  daily_streak_7: { seed: { dailyDayBest: 6, dailyDayRun: 6, lastDailyDay: 'rel:1' }, level: 'daily', ...finish },
  daily_streak_30: { seed: { dailyDayBest: 29, dailyDayRun: 29, lastDailyDay: 'rel:1' }, level: 'daily', cadence: 3.8, human: 0, bots: { sway: STILL }, ...finish },   // a metronome pair: the two passes agree
  daily_share: { seed: {}, level: 'daily', cadence: 3.8, human: 0, bots: { sway: STILL }, share: true, pre: 2.0, post: 3.0 },   // the Share button on the result sheet
  daily_practice_10: { seed: { dailyPractice: 9 }, level: 'daily', cadence: 3.8, human: 0, bots: { sway: STILL }, ...finish },

  // ── Riding together ──
  perfect_sync: { seed: {}, human: 0, pre: 2.5, post: 3 },                 // two riders answering each other's beat
  team_player: { seed: {}, atStart: true, pre: 0, post: 4.0 },        // 100% safe riding from the first frame: the toast is up at GO
  pair_10_rides: { seed: {}, pairRides: 9, ...finish },
  pair_100km: { seed: {}, pairDistance: 99900, ...finish },
  coop_first: { seed: {}, ...finish },
  social_goose: { seed: { partners: ['goose-a', 'goose-b'], coopFinishes: 2 }, ...finish },
  standing_date: { seed: {}, level: 'daily', cadence: 3.8, human: 0, bots: { sway: STILL }, pairWeeks: 3, ...finish },   // this week's Today's Road makes the 4th week in a row

  // ── Versus (its own rig) ──
  versus_first: { kind: 'versus', seed: {}, teams: [{ cadence: 3.6 }, { cadence: 3.0 }], ...finish },
  versus_win: { kind: 'versus', seed: { versusRaces: 3 }, teams: [{ cadence: 3.6 }, { cadence: 3.0 }], ...finish },
  versus_2v2: { kind: 'versus', seed: { versusRaces: 4, versusWins: 2 }, players: 4, teams: [{ cadence: 3.6 }, { cadence: 3.0 }], ...finish },
  versus_close: { kind: 'versus', seed: { versusRaces: 4, versusWins: 2 }, teams: [{ cadence: 3.45 }, { cadence: 3.4 }], ...finish },   // a wheel's width
  versus_comeback: { kind: 'versus', seed: { versusRaces: 4, versusWins: 2 }, teams: [{ cadence: 2.8 }, { cadence: 3.4 }], comeback: [4.4, 2.6], ...finish },   // behind at halfway, then the chase
  versus_10: { kind: 'versus', seed: { versusRaces: 12, versusWins: 9 }, teams: [{ cadence: 3.6 }, { cadence: 3.0 }], ...finish },

  // ── Chaos ──
  crashes_10: { seed: { crashes: 9 }, crash: 90, pre: 2.0, post: 3.5 },
  false_start: { seed: {}, difficulty: 'daredevil', cadence: 4.5, falseStart: true, pre: 1.5, post: 3.5 },   // lean out hard at GO (chill's safety clamp won't let a lean crash)
  so_close: { seed: {}, difficulty: 'daredevil', cadence: 3.4, human: 0, bots: { sway: STILL, collect: false }, leanOutAt: 236, pre: 2.5, post: 3.5 },   // both riders throw their weight out 14 m from the line (Daredevil lets a lean fall; no pylon or tree stands by the line)
  weathered: { seed: {}, gustAt: 70, difficulty: 'adventurous', cadence: 3.4, human: 0, bots: { sway: STILL, collect: false, steer: 1.3 }, pre: 3.0, post: 3 },   // one gust at 70 m (the game's own ?disrupt=gust road; Chill clears the road of gusts), ridden out
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
  sling_first: { kind: 'sling', seed: {}, wallet: { coins: 0 }, pull: 1, pre: 2.5, post: 3.5 },                                        // the bands let go
  sling_stage1: { kind: 'sling', seed: { slingLaunches: 2 }, wallet: { coins: 60 }, pull: 1, ...finish },                             // 300 m on stock bands (a full pull rolls ~340)
  sling_stage3: { kind: 'sling', seed: { slingLaunches: 9, slingStage: 2 }, sling: { stage: 3, best: 430, runs: 9 }, wallet: { coins: 300, lv: { sling: 4, wheels: 4 } }, pull: 1, ...finish },
  sling_stage5: { kind: 'sling', seed: { slingLaunches: 20, slingStage: 4 }, sling: { stage: 5, best: 680, runs: 20 }, records: { 'grandma|chill|solo': { timeMs: 90000, bestMedal: 'bronze', helped: false } }, wallet: { coins: 500, lv: { sling: 10, wheels: 10 } }, pull: 1, ...finish },   // 780 m takes the full bands (a stock-ish bike stalls near 670)
  sling_stage7: { kind: 'sling', seed: { slingLaunches: 40, slingStage: 6 }, sling: { stage: 7, best: 920, runs: 40 }, records: { 'grandma|chill|solo': { timeMs: 50000, bestMedal: 'gold', helped: false } }, wallet: { coins: 800, lv: { sling: 10, wheels: 10 } }, pull: 1, ...finish },   // NOT YET REACHED: the straight strip line stalls at 1,044 of the 1,050 (hills); ramps in other lanes cost more than they give   // 1,050 m: full bands and every ramp, lane changes gentle enough to stay off the edge (a straight roll stalls 6 m short)
  sling_500: { kind: 'sling', seed: { slingLaunches: 9, slingStage: 2, slingBest: 430 }, sling: { stage: 3, best: 430, runs: 9 }, wallet: { coins: 300, lv: { sling: 4, wheels: 4 } }, pull: 1, ...finish },   // stage 3's goal is 540 m
  sling_1000: { kind: 'sling', seed: { slingLaunches: 40, slingStage: 6, slingBest: 920 }, sling: { stage: 7, best: 920, runs: 40 }, records: { 'grandma|chill|solo': { timeMs: 50000, bestMedal: 'gold', helped: false } }, wallet: { coins: 800, lv: { sling: 10, wheels: 10 } }, pull: 1, ...finish },   // the straight strip line rolls ~1,044   // stage 7's goal is 1,050 m
  big_air: { kind: 'sling', seed: { slingLaunches: 5, slingStage: 1 }, sling: { stage: 2, best: 310, runs: 5 }, wallet: { coins: 200, lv: { sling: 6, wheels: 4 } }, pull: 1, target: 'ramp', pre: 2.5, post: 3.0 },   // the ramp before gate 2, at speed
  frequent_flyer: { kind: 'sling', seed: { slingLaunches: 60, slingStage: 3, bigAirs: 24 }, sling: { stage: 4, best: 600, runs: 60 }, records: { 'grandma|chill|solo': { timeMs: 90000, bestMedal: 'bronze', helped: false } }, wallet: { coins: 500, lv: { sling: 8, wheels: 6 } }, pull: 1, target: 'ramp', pre: 2.5, post: 3.0 },
  jackpot: { kind: 'sling', seed: { slingLaunches: 6, slingStage: 1 }, sling: { stage: 2, best: 310, runs: 6 }, wallet: { coins: 200, lv: { sling: 3, wheels: 2 } }, pull: 1, target: 'jackpot', pre: 2.5, post: 3.5 },   // the billboard past gate 2
  double_down: { kind: 'sling', seed: { slingLaunches: 30, slingStage: 4, jackpots: 2 }, sling: { stage: 5, best: 700, runs: 30 }, records: { 'grandma|chill|solo': { timeMs: 90000, bestMedal: 'bronze', helped: false } }, wallet: { coins: 500, lv: { sling: 6, wheels: 5 } }, daily: true, pull: 1, target: 'jackpot', ...finish },   // Today's Launch: the jackpot on a day's best
  full_trail: { kind: 'sling', seed: { slingLaunches: 4, slingStage: 1 }, sling: { stage: 2, best: 310, runs: 4 }, wallet: { coins: 200, lv: { sling: 5, wheels: 4 } }, pull: 1, target: 'trail', ...finish },   // the first trail past gate 2, all five
  straight_shooter: { kind: 'sling', seed: { slingLaunches: 3 }, wallet: { coins: 60 }, pull: 1, ...finish },                           // 300 m, hands off
  medal_key: { seed: {}, cadence: 3.8, bots: { sway: STILL }, ...finish },
  todays_launch: { kind: 'sling', seed: { slingLaunches: 12, slingStage: 3 }, sling: { stage: 4, best: 560, runs: 12 }, records: { 'grandma|chill|solo': { timeMs: 90000, bestMedal: 'bronze', helped: false } }, wallet: { coins: 300, lv: { sling: 5, wheels: 4 } }, daily: true, pull: 0.55, ...finish },   // a lazy pull: a short flight, the day's first launch
  launch_week: { kind: 'sling', seed: { slingLaunches: 40, slingStage: 3, launchDays: 'rel:6' }, sling: { stage: 4, best: 560, runs: 40 }, records: { 'grandma|chill|solo': { timeMs: 90000, bestMedal: 'bronze', helped: false } }, wallet: { coins: 300, lv: { sling: 5, wheels: 4 } }, daily: true, pull: 0.55, ...finish },
};

/** The six with hand-made shots in achievements.mjs (kickoff, learner, ...): not here. */
export const HAND_MADE = { first_pedal: 'kickoff', tutorial_done: 'learner', tutorial_clean: 'natural', first_finish: 'madeit', first_crash: 'goosedown', look_no_thumbs: 'nothumbs' };
