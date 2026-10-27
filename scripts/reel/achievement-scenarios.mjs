// achievement-scenarios.mjs — how each achievement's reel is earned, for achievements-all.mjs (#506).
//
// One entry per achievement id. The reel is a RIDE TOGETHER (local co-op, both pads, both geese) unless
// `kind` says otherwise; the achievement fires for real and the game's own toast is what the reel shows.
//   moment    one line on what the reel shows (unique per reel; the plan table in the trailers README is built from it)
//   seed      lifetime stats to start from (tandemonium_achievement_stats, v2): counters one short of the goal,
//             so the moment happens in a short ride (Century Ride shows the odometer passing 100 km, not 100 km of riding)
//   storage   other localStorage to start from (records, the daily save, the wallet)
//   level / difficulty / cadence / human   the ride (defaults: grandma, chill, 3.4, 1; a finish reel defaults to adventurous)
//   bots      patch for the rider bots once riding (sway, dodge, offset, path, collect)
//   prep      async (page) => {}: set-up before the ride starts
//   bike / outfit / salt   the bike colour preset, the goose outfit (victorian | cyclists | fancy | georgian), the placement salt
//   cam       a reel camera for the ride: a name (side, sideR, quarter, front, high, orbit) or a shot object; null = the chase camera
//   pre / post   seconds of footage kept before / after the toast (defaults 2.5 / 3.0)
//   over      a finish reel: the toast is raised over the last `pre` seconds of the ride (`toastLead` s before the line),
//             then the finish cinematic, out before the result sheet. `from: { mark: 'crash' | 'assist', hold }` opens on
//             that mark instead, holds it, then jumps to the line.
//   noGusts   no Adventurous gust disruptions (a slow ride, or one that must keep every wheel on the road)
//   todo      not scripted yet (why)
import { STILL } from './achievements.mjs';

// Day keys follow the game's own rollover hour (js/daily-seed.js dailyKey): 'rel:k' is resolved in the page by
// achievements-all.mjs to the key k days ago; a dayList 'rel:n' is the n days ending yesterday.
const run = (n) => ({ days: n, dayList: 'rel:' + n, lastDay: 'rel:1' });

/** A slow personal best on Grandma's (adventurous, co-op), so the bots' finish beats it. */
const slowRecord = { 'grandma|adventurous|coop': { timeMs: 240000, bestMedal: null, helped: false } };

const finish = { over: true, pre: 7.5, toastLead: 2.6 };   // a finish reel: the ride to the line, the toast over it, the sweep
const tally = { pre: 3.0, post: 3.0 };                     // the toast comes with a result sheet (Slingshot, versus)
const start = { pre: 1.0, post: 3.5 };                     // the toast comes at GO
const crashAt = (dist) => async (page) => { /* placeholder: the bot steers into the next pylon after `dist` */ page.__crashAt = dist; };
const WOBBLE = { amp: 0.45, freq: 0.32, phase: 0 };        // a bigger sway than the default human (0.25): visible lean and wobble

export const SCENARIOS = {
  // ── First rides ──
  first_remount: { moment: 'Over the bars on a pylon, back in the saddle, and the last stretch to Grandma\'s line in the Fancy outfits', seed: {}, crash: 90, outfit: 'fancy', salt: 431111, from: { mark: 'crash', hold: 4.5 }, ...finish },
  first_boost: { moment: 'The first present grabbed off the road: the chime, the boost, the pair pulling away', seed: {}, bots: { collect: true }, pre: 2.0, post: 3.0 },

  // ── Distance (the odometer passes the mark during the ride) ──
  first_500m: { moment: 'The lifetime odometer ticking over 500 m mid-ride on Grandma\'s', seed: { cumulativeDistance: 380 }, pre: 2.5, post: 3 },
  first_km: { moment: 'The odometer passing 1 km, a present or two on the way', seed: { cumulativeDistance: 880 }, pre: 2.5, post: 3 },
  five_k: { moment: 'The odometer passing 5 km in the Cyclists\' outfits', seed: { cumulativeDistance: 4880 }, outfit: 'cyclists', pre: 2.5, post: 3 },
  ten_k: { moment: 'The odometer passing 10 km from beside the riders', seed: { cumulativeDistance: 9880 }, cam: 'side', pre: 2.5, post: 3 },
  half_marathon: { moment: 'The odometer passing 21.1 km in the Georgian outfits', seed: { cumulativeDistance: 20980 }, outfit: 'georgian', pre: 2.5, post: 3 },
  marathon: { moment: 'The odometer passing 42.2 km, the geese coming at the lens', seed: { cumulativeDistance: 42080 }, cam: 'front', pre: 2.5, post: 3 },
  century: { moment: 'The odometer passing 100 km in the Fancy outfits, high and wide over the road', seed: { cumulativeDistance: 99880 }, outfit: 'fancy', cam: 'high', pre: 2.5, post: 3 },

  // ── Coming back (the ride itself is the 10th / the 3rd day) ──
  rides_10: { moment: 'GO on the tenth ride: the countdown and the first push', seed: { rides: 9, ...run(4) }, ...start },
  days_3: { moment: 'GO on the third day in a row, in the Cyclists\' outfits', seed: { rides: 5, ...run(2) }, outfit: 'cyclists', ...start },
  days_7: { moment: 'GO on the seventh day running, Georgian outfits', seed: { rides: 12, ...run(6) }, outfit: 'georgian', ...start },
  days_30: { moment: 'GO on day thirty, the Fancy outfits, from the front', seed: { rides: 40, ...run(29) }, outfit: 'fancy', cam: 'front', ...start },

  // ── Levels and medals (Grandma's, 250 m) ──
  home_sweet: { moment: 'Grandma\'s last 100 m from beside the riders, over the line, the presents flying onto her pile', seed: {}, outfit: 'cyclists', cam: 'side', salt: 432222, ...finish },
  perfect_1k: { moment: 'A clean run: no crash, no restart, the Fancy pair steady to the line and the finish sweep', seed: {}, bots: { sway: STILL }, outfit: 'fancy', salt: 433333, ...finish },
  grandma_bronze: { moment: 'A gentle pace to Grandma\'s line (inside 90% of the clock), the Georgian pair, high and wide', seed: {}, human: 0, bots: { sway: STILL, collect: false }, noGusts: true, outfit: 'georgian', cam: 'high', noPresents: true, maxSpeed: 3.8, salt: 434444, ...finish },   // a slow tandem tips over on Adventurous if the riders sway: still riders, no gusts
  grandma_silver: { moment: 'A brisker pace to the line (inside 72%), from behind the stoker\'s shoulder', seed: {}, human: 0, bots: { sway: STILL, collect: false }, noGusts: true, cam: 'quarter', noPresents: true, maxSpeed: 4.8, salt: 435555, ...finish },
  grandma_gold: { moment: 'Flat out to Grandma\'s line (inside 55% of the clock), the Cyclists sprinting, a slow swing from beside to behind', seed: {}, cadence: 3.8, bots: { sway: STILL }, outfit: 'cyclists', cam: 'orbit', salt: 436677, ...finish },
  daily_gold: { moment: 'Today\'s Road at a gold pace, the Fancy pair, the geese coming at the lens', seed: {}, level: 'daily', cadence: 3.8, bots: { sway: STILL }, outfit: 'fancy', cam: 'front', ...finish },
  all_gold: { moment: 'Today\'s Road already gold: Grandma\'s gold completes the set, the Georgian pair, from the right', seed: { golds: ['daily'] }, cadence: 3.8, bots: { sway: STILL }, outfit: 'georgian', cam: 'sideR', salt: 437777, ...finish },
  adventurer: { moment: 'Adventurous: the pair leaning and wobbling through the last pylons to the line, chase camera', seed: {}, difficulty: 'adventurous', bots: { sway: WOBBLE }, salt: 438888, ...finish },
  daredevil: { moment: 'Daredevil: a hard lean through the last gate, the Cyclists holding it to the line, from beside', seed: {}, difficulty: 'daredevil', cadence: 3.4, human: 0.5, bots: { sway: { amp: 0.3, freq: 0.3, phase: 0 }, collect: false, dodge: true }, outfit: 'cyclists', cam: 'side', salt: 439999, ...finish },

  // ── Clean riding ──
  steady_hands: { moment: 'Sixty calm seconds at a capped pace, no lean past the shake, the toast mid-ride', seed: {}, human: 0, bots: { sway: STILL, collect: false }, noPresents: true, maxSpeed: 3.5, pre: 2.5, post: 3 },   // Grandma's at a capped 3.5 m/s, no presents to boost off: > 60 s of calm riding
  centerline: { moment: 'Thirty seconds dead on the centre strip, the Fancy pair, the toast mid-ride', seed: {}, human: 0, bots: { sway: STILL, dodge: false, offset: 0, collect: false, steer: 2.0, gains: { kl: 0.16, kh: 0.55 } }, noPresents: true, maxSpeed: 6, outfit: 'fancy', pre: 2.5, post: 3 },   // Grandma's at a capped 6 m/s with a firmer hand, no presents to boost off, dead centre: 30 s on the strip
  no_offroad: { moment: 'Never a wheel on the grass: the Georgian pair threading the last pylons to the line, high and wide', seed: {}, bots: { sway: STILL, steer: 1.3 }, noGusts: true, outfit: 'georgian', cam: 'high', salt: 441122, ...finish },
  no_trees_daily: { moment: 'Today\'s Road between the roadside trees, none touched, from the right, to the line', seed: {}, level: 'daily', bots: { sway: STILL }, outfit: 'fancy', cam: 'sideR', ...finish },
  new_best: { moment: 'A slow old record on the books: the Cyclists beat it, the toast over the last stretch', seed: {}, storage: { tandemonium_records: JSON.stringify(slowRecord) }, outfit: 'cyclists', salt: 442222, ...finish },
  assist_free: { moment: 'The game-over sheet offers ASSIST; RESTART without it, then the clean run to the line', seed: {}, difficulty: 'adventurous', cadence: 3.4, human: 0, bots: { sway: STILL, collect: false }, assist: true, outfit: 'georgian', from: { mark: 'assist', before: 1.0, hold: 3.5 }, ...finish },   // three crashes in the first segment bring the ASSIST offer; RESTART without it, then finish

  // ── Speed and boost ──
  speed_demon: { moment: 'Daredevil, every present taken: the speedo hitting 50 km/h', seed: {}, difficulty: 'daredevil', cadence: 4.0, bots: { collect: true, sway: STILL }, pre: 2.5, post: 3 },
  terminal_goose: { moment: 'Daredevil, presents chained: the speedo hitting 65 km/h, the Cyclists flat out', seed: {}, difficulty: 'daredevil', cadence: 4.0, bots: { collect: true, sway: STILL }, outfit: 'cyclists', pre: 2.5, post: 3 },
  boost_25: { moment: 'The 25th present: the boost that makes the count', seed: { boosts: 24, pickups: 24 }, bots: { collect: true }, pre: 2.0, post: 3 },
  afterburner: { moment: 'Ten seconds of boost held by chaining presents, the Fancy pair, from beside', seed: {}, cadence: 4.0, bots: { collect: true, sway: STILL }, outfit: 'fancy', cam: 'side', pre: 2.5, post: 3 },

  // ── Collecting ──
  collector: { moment: 'Today\'s Road: the tenth present of the ride, snatched from beside a pylon', seed: {}, level: 'daily', human: 0, bots: { collect: true, sway: STILL }, pre: 2.0, post: 3 },
  hoarder: { moment: 'Every present on Grandma\'s taken, the last one by the gate, and the line, a slow swing round the pair', seed: {}, bots: { collect: true, sway: STILL }, cam: 'orbit', salt: 443333, ...finish, pre: 4.0, post: 7.0 },   // the toast comes at the last present (~40 m before the line): the window runs on through the line and the sweep
  presents_100: { moment: 'The hundredth present, lifetime, in the Georgian outfits', seed: { pickups: 99, boosts: 30 }, bots: { collect: true }, outfit: 'georgian', pre: 2.0, post: 3 },
  daily_haul: { moment: 'Today\'s Road swept clean at a careful pace: the Cyclists swerving round a pylon for the last present, then the line', seed: {}, level: 'daily', human: 0, cadence: 3.4, maxSpeed: 5.5, bots: { collect: true, sway: STILL }, outfit: 'cyclists', ...finish },   // capped at 5.5 m/s so a present tucked behind a pylon is reachable (the bot skips one within a speed's worth of metres)

  // ── Chaos Coins (the payout at the finish; #512 decides what coins become) ──
  coin_first: { moment: 'A clean first ride collecting as it goes, the Fancy pair, from behind the stoker: the first coins paid at the line', seed: {}, bots: { sway: STILL, collect: true }, outfit: 'fancy', cam: 'quarter', salt: 444455, ...finish },
  coins_1000: { moment: 'The thousandth coin, lifetime: the Georgian pair high and wide to the line', seed: { coinsEarned: 990 }, human: 0.5, bots: { sway: { amp: 0.3, freq: 0.3, phase: 0 } }, outfit: 'georgian', cam: 'high', salt: 445555, ...finish },   // coins pay at a crash too, so the ride must be clean: a lighter sway
  coins_10000: { moment: 'Ten thousand coins, lifetime: the geese coming at the lens on the last stretch', seed: { coinsEarned: 9990 }, human: 0.5, bots: { sway: { amp: 0.3, freq: 0.3, phase: 0 } }, cam: 'front', salt: 446666, ...finish },
  payday: { moment: 'Two hundred coins from one ride: gold pace, no crash, every present, the Cyclists from beside', seed: {}, cadence: 3.8, bots: { collect: true, sway: STILL }, outfit: 'cyclists', cam: 'side', salt: 447777, ...finish },   // gold + no crashes + every present ≈ 227 coins
  first_upgrade: { moment: 'The garage: 120 coins, the first band bought', kind: 'garage', seed: {}, wallet: { coins: 120 }, buy: 'sling' },
  max_upgrade: { moment: 'The garage: the tenth band, one upgrade maxed', kind: 'garage', seed: { upgrades: 9 }, wallet: { coins: 4000, lv: { sling: 9, wheels: 3 } }, buy: 'sling' },          // the tenth band
  garage_royalty: { moment: 'The garage: the last magnet level, every upgrade maxed', kind: 'garage', seed: { upgrades: 27, maxedAny: true }, wallet: { coins: 4000, lv: { sling: 10, wheels: 10, magnet: 7 } }, buy: 'magnet' },
  big_spender: { moment: 'The garage: a wheels upgrade takes the lifetime spend past 1,000', kind: 'garage', seed: { upgrades: 12, coinsSpent: 980 }, wallet: { coins: 400, lv: { sling: 2 } }, buy: 'wheels' },   // 70 coins takes it past 1,000
  rebuilt: { moment: 'The garage, everything maxed: REBUILD pressed twice, the bike reborn', kind: 'garage', seed: { upgrades: 28, maxedAny: true, maxedAll: true }, wallet: { coins: 4000, lv: { sling: 10, wheels: 10, magnet: 8 } }, rebuild: true },
  ship_of_theseus: { moment: 'The fifth rebuild', kind: 'garage', seed: { upgrades: 140, maxedAny: true, maxedAll: true, rebuilds: 4 }, wallet: { ...{ coins: 4000, lv: { sling: 10, wheels: 10, magnet: 8 } }, rebuilds: 4 }, rebuild: true },

  // ── Today's Road ──
  daily_first: { todo: 'a ranked Today\'s Road needs the server (the capture blocks the network)' },
  daily_streak_3: { moment: 'Today\'s Road, the third day running: the Fancy pair\'s last stretch and the line', seed: { dailyDayBest: 2, dailyDayRun: 2, lastDailyDay: 'rel:1' }, level: 'daily', outfit: 'fancy', ...finish },
  daily_streak_7: { moment: 'Today\'s Road, a week straight: the Georgian pair from the right, over the line', seed: { dailyDayBest: 6, dailyDayRun: 6, lastDailyDay: 'rel:1' }, level: 'daily', human: 0.5, bots: { sway: { amp: 0.3, freq: 0.3, phase: 0 } }, outfit: 'georgian', cam: 'sideR', ...finish },
  daily_streak_30: { moment: 'Today\'s Road, thirty days straight: a metronome pair, a slow swing round them to the line', seed: { dailyDayBest: 29, dailyDayRun: 29, lastDailyDay: 'rel:1' }, level: 'daily', cadence: 3.8, human: 0, bots: { sway: STILL }, cam: 'orbit', ...finish },   // a metronome pair: the two passes agree
  daily_share: { moment: 'The result sheet\'s Share button pressed after Today\'s Road', seed: {}, level: 'daily', cadence: 3.8, human: 0, bots: { sway: STILL }, share: true, pre: 2.0, post: 3.0 },   // the Share button on the result sheet
  daily_practice_10: { moment: 'The tenth practice run of Today\'s Road, the Cyclists high and wide to the line', seed: { dailyPractice: 9 }, level: 'daily', cadence: 3.8, human: 0, bots: { sway: STILL }, outfit: 'cyclists', cam: 'high', ...finish },

  // ── Riding together ──
  perfect_sync: { moment: 'Two riders answering each other\'s beat: the sync meter full, the toast mid-ride', seed: {}, human: 0, pre: 2.5, post: 3 },                 // two riders answering each other's beat
  team_player: { moment: 'Safe riding from the first frame: the toast is up at GO', seed: {}, atStart: true, pre: 0, post: 4.0 },        // 100% safe riding from the first frame: the toast is up at GO
  pair_10_rides: { moment: 'The pair\'s tenth ride together: the Fancy outfits from beside, the line', seed: {}, pairRides: 9, outfit: 'fancy', cam: 'side', salt: 448899, ...finish },
  pair_100km: { moment: 'A hundred kilometres as a pair: the Georgian outfits from behind the stoker, the line', seed: {}, pairDistance: 99900, outfit: 'georgian', cam: 'quarter', salt: 449999, ...finish },
  coop_first: { moment: 'The first finish as a pair: the geese coming at the lens, then the sweep', seed: {}, cam: 'front', salt: 451111, ...finish },
  social_goose: { moment: 'A third partner: the Cyclists, a slow swing round them, the line', seed: { partners: ['goose-a', 'goose-b'], coopFinishes: 2 }, outfit: 'cyclists', cam: 'orbit', salt: 452222, ...finish },
  standing_date: { moment: 'Today\'s Road with the same partner for the fourth week running: the Fancy pair high and wide', seed: {}, level: 'daily', cadence: 3.8, human: 0, bots: { sway: STILL }, pairWeeks: 3, outfit: 'fancy', cam: 'high', ...finish },   // this week's Today's Road makes the 4th week in a row

  // ── Versus (its own rig) ──
  versus_first: { moment: 'Split screen: the first race, blue pulls clear', kind: 'versus', seed: {}, teams: [{ cadence: 3.6 }, { cadence: 3.0 }], ...tally },
  versus_win: { moment: 'Split screen: blue takes the win', kind: 'versus', seed: { versusRaces: 3 }, teams: [{ cadence: 3.6 }, { cadence: 3.0 }], ...tally },
  versus_2v2: { moment: 'Split screen, four pads: two tandems a side', kind: 'versus', seed: { versusRaces: 4, versusWins: 2 }, players: 4, teams: [{ cadence: 3.6 }, { cadence: 3.0 }], ...tally },
  versus_close: { moment: 'Split screen: a wheel\'s width at the line', kind: 'versus', seed: { versusRaces: 4, versusWins: 2 }, teams: [{ cadence: 3.45 }, { cadence: 3.4 }], ...tally },   // a wheel's width
  versus_comeback: { moment: 'Split screen: behind at halfway, then the chase and the win', kind: 'versus', seed: { versusRaces: 4, versusWins: 2 }, teams: [{ cadence: 2.8 }, { cadence: 3.4 }], comeback: [4.4, 2.6], ...tally },   // behind at halfway, then the chase
  versus_10: { moment: 'Split screen: the tenth win', kind: 'versus', seed: { versusRaces: 12, versusWins: 9 }, teams: [{ cadence: 3.6 }, { cadence: 3.0 }], ...tally },

  // ── Chaos ──
  crashes_10: { moment: 'The tenth crash, lifetime: a pylon, the tumble, the toast as they get up', seed: { crashes: 9 }, crash: 90, pre: 2.0, post: 3.5 },
  false_start: { moment: 'Daredevil: a hard lean at GO and over before the first pedal', seed: {}, difficulty: 'daredevil', cadence: 4.5, falseStart: true, pre: 1.5, post: 3.5 },   // lean out hard at GO (chill's safety clamp won't let a lean crash)
  so_close: { moment: 'Daredevil: both riders throw their weight out 14 m from the line, and down they go in sight of it', seed: {}, difficulty: 'daredevil', cadence: 3.4, human: 0, bots: { sway: STILL, collect: false }, leanOutAt: 236, pre: 2.5, post: 3.5 },   // both riders throw their weight out 14 m from the line (Daredevil lets a lean fall; no pylon or tree stands by the line)
  weathered: { moment: 'A gust telegraphed and hits at 70 m; the pair rides it out', seed: {}, gustAt: 70, difficulty: 'adventurous', cadence: 3.4, human: 0, bots: { sway: STILL, collect: false, steer: 1.3 }, pre: 3.0, post: 3 },   // one gust at 70 m (the game's own ?disrupt=gust road; Chill clears the road of gusts), ridden out
  gone_with_wind: { moment: 'The tenth gust, lifetime: the telegraph, the push, the Georgian pair shoved sideways', seed: { gusts: 9 }, gustAt: 70, difficulty: 'adventurous', cadence: 3.4, human: 0, bots: { sway: STILL, collect: false, steer: 1.3 }, outfit: 'georgian', pre: 3.0, post: 3 },

  // ── Exploring ──
  distance_between_us: { todo: 'Tourist needs Google 3D Tiles (network + key)' },
  grand_tour: { todo: 'Tourist needs Google 3D Tiles (network + key)' },

  // ── Grandma's in every colour (the bike is the point: cameras that show it) ──
  grandma_default: { moment: 'The stock tandem on Grandma\'s last stretch, chase camera, the line', seed: {}, bike: 'default', salt: 453333, ...finish },
  grandma_orange: { moment: 'The orange tandem from beside, the Cyclists aboard, the line', seed: {}, bike: 'bike_orange', outfit: 'cyclists', cam: 'side', salt: 454444, ...finish },
  grandma_magenta: { moment: 'The magenta tandem from the right, the Fancy pair aboard, the line', seed: {}, bike: 'bike_magenta', outfit: 'fancy', cam: 'sideR', salt: 455555, ...finish },
  grandma_red: { moment: 'The red tandem from behind the stoker\'s shoulder, the Georgian pair, the line', seed: {}, bike: 'bike_red', outfit: 'georgian', cam: 'quarter', salt: 456666, ...finish },
  grandma_blue: { moment: 'The blue tandem coming at the lens, the line', seed: {}, bike: 'bike_blue', cam: 'front', salt: 457777, ...finish },
  grandma_green: { moment: 'The green tandem, a slow swing from beside to behind, the Cyclists aboard, the line', seed: {}, bike: 'bike_green', outfit: 'cyclists', cam: 'orbit', salt: 458888, ...finish },
  grandma_yellow: { moment: 'The yellow tandem high and wide on the road, the Fancy pair, the line', seed: {}, bike: 'bike_yellow', outfit: 'fancy', cam: 'high', salt: 459999, ...finish },

  // ── Slingshot (its own mode: the garage, a drag, the flight) ──
  sling_first: { moment: 'The Slingshot: a finger drag, the bands let go, the launch past Your Home', kind: 'sling', seed: {}, wallet: { coins: 0 }, pull: 1, pre: 2.5, post: 3.5 },                                        // the bands let go
  sling_stage1: { moment: 'The Slingshot: the 300 m flag reached on stock bands', kind: 'sling', seed: { slingLaunches: 2 }, wallet: { coins: 60 }, pull: 1, ...tally },                             // 300 m on stock bands (a full pull rolls ~340)
  sling_stage3: { moment: 'The Slingshot: stage 3\'s 540 m flag on upgraded bands', kind: 'sling', seed: { slingLaunches: 9, slingStage: 2 }, sling: { stage: 3, best: 430, runs: 9 }, wallet: { coins: 300, lv: { sling: 4, wheels: 4 } }, pull: 1, ...tally },
  sling_stage5: { moment: 'The Slingshot: stage 5\'s 780 m flag on full bands', kind: 'sling', seed: { slingLaunches: 20, slingStage: 4 }, sling: { stage: 5, best: 680, runs: 20 }, records: { 'grandma|chill|solo': { timeMs: 90000, bestMedal: 'bronze', helped: false } }, wallet: { coins: 500, lv: { sling: 10, wheels: 10 } }, pull: 1, ...tally },   // 780 m takes the full bands (a stock-ish bike stalls near 670)
  sling_stage7: { moment: 'The Slingshot: stage 7\'s 1,050 m flag (not yet reached: the hills stop a straight roll 6 m short)', kind: 'sling', seed: { slingLaunches: 40, slingStage: 6 }, sling: { stage: 7, best: 920, runs: 40 }, records: { 'grandma|chill|solo': { timeMs: 50000, bestMedal: 'gold', helped: false } }, wallet: { coins: 800, lv: { sling: 10, wheels: 10 } }, pull: 1, ...tally },   // NOT YET REACHED: the straight strip line stalls at 1,044 of the 1,050 (hills); ramps in other lanes cost more than they give   // 1,050 m: full bands and every ramp, lane changes gentle enough to stay off the edge (a straight roll stalls 6 m short)
  sling_500: { moment: 'The Slingshot: the 500 m marker passed in one flight', kind: 'sling', seed: { slingLaunches: 9, slingStage: 2, slingBest: 430 }, sling: { stage: 3, best: 430, runs: 9 }, wallet: { coins: 300, lv: { sling: 4, wheels: 4 } }, pull: 1, ...tally },   // stage 3's goal is 540 m
  sling_1000: { moment: 'The Slingshot: 1,000 m in one flight (rolls to ~1,044)', kind: 'sling', seed: { slingLaunches: 40, slingStage: 6, slingBest: 920 }, sling: { stage: 7, best: 920, runs: 40 }, records: { 'grandma|chill|solo': { timeMs: 50000, bestMedal: 'gold', helped: false } }, wallet: { coins: 800, lv: { sling: 10, wheels: 10 } }, pull: 1, ...tally },   // the straight strip line rolls ~1,044   // stage 7's goal is 1,050 m
  big_air: { moment: 'The Slingshot: the ramp before gate 2 taken at speed, the bike in the air', kind: 'sling', seed: { slingLaunches: 5, slingStage: 1 }, sling: { stage: 2, best: 310, runs: 5 }, wallet: { coins: 200, lv: { sling: 6, wheels: 4 } }, pull: 1, target: 'ramp', pre: 2.5, post: 3.0 },   // the ramp before gate 2, at speed
  frequent_flyer: { moment: 'The Slingshot: the 25th big air, lifetime, off the gate-2 ramp', kind: 'sling', seed: { slingLaunches: 60, slingStage: 3, bigAirs: 24 }, sling: { stage: 4, best: 600, runs: 60 }, records: { 'grandma|chill|solo': { timeMs: 90000, bestMedal: 'bronze', helped: false } }, wallet: { coins: 500, lv: { sling: 8, wheels: 6 } }, pull: 1, target: 'ramp', pre: 2.5, post: 3.0 },
  jackpot: { moment: 'The Slingshot: the jackpot billboard past gate 2, hit square', kind: 'sling', seed: { slingLaunches: 6, slingStage: 1 }, sling: { stage: 2, best: 310, runs: 6 }, wallet: { coins: 200, lv: { sling: 3, wheels: 2 } }, pull: 1, target: 'jackpot', pre: 2.5, post: 3.5 },   // the billboard past gate 2
  double_down: { moment: 'Today\'s Launch: the jackpot on the day\'s best run', kind: 'sling', seed: { slingLaunches: 30, slingStage: 4, jackpots: 2 }, sling: { stage: 5, best: 700, runs: 30 }, records: { 'grandma|chill|solo': { timeMs: 90000, bestMedal: 'bronze', helped: false } }, wallet: { coins: 500, lv: { sling: 6, wheels: 5 } }, daily: true, pull: 1, target: 'jackpot', ...tally },   // Today's Launch: the jackpot on a day's best
  full_trail: { moment: 'The Slingshot: all five coins of the first trail past gate 2', kind: 'sling', seed: { slingLaunches: 4, slingStage: 1 }, sling: { stage: 2, best: 310, runs: 4 }, wallet: { coins: 200, lv: { sling: 5, wheels: 4 } }, pull: 1, target: 'trail', ...tally },   // the first trail past gate 2, all five
  straight_shooter: { moment: 'The Slingshot: 300 m with the hands off, a dead-straight roll', kind: 'sling', seed: { slingLaunches: 3 }, wallet: { coins: 60 }, pull: 1, ...tally },                           // 300 m, hands off
  medal_key: { moment: 'A medal on Grandma\'s unlocks the Slingshot: the Georgian pair\'s finish', seed: {}, cadence: 3.8, bots: { sway: STILL }, outfit: 'georgian', salt: 461111, ...finish },
  todays_launch: { moment: 'Today\'s Launch: a lazy pull, a short first flight of the day', kind: 'sling', seed: { slingLaunches: 12, slingStage: 3 }, sling: { stage: 4, best: 560, runs: 12 }, records: { 'grandma|chill|solo': { timeMs: 90000, bestMedal: 'bronze', helped: false } }, wallet: { coins: 300, lv: { sling: 5, wheels: 4 } }, daily: true, pull: 0.55, ...tally },   // a lazy pull: a short flight, the day's first launch
  launch_week: { moment: 'Today\'s Launch on the seventh day in a row', kind: 'sling', seed: { slingLaunches: 40, slingStage: 3, launchDays: 'rel:6' }, sling: { stage: 4, best: 560, runs: 40 }, records: { 'grandma|chill|solo': { timeMs: 90000, bestMedal: 'bronze', helped: false } }, wallet: { coins: 300, lv: { sling: 5, wheels: 4 } }, daily: true, pull: 0.55, ...tally },
};

/** The six with hand-made shots in achievements.mjs (kickoff, learner, ...): not here. */
export const HAND_MADE = { first_pedal: 'kickoff', tutorial_done: 'learner', tutorial_clean: 'natural', first_finish: 'madeit', first_crash: 'goosedown', look_no_thumbs: 'nothumbs' };
