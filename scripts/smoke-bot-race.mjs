#!/usr/bin/env node
// smoke:bot-race · VERSUS BOTS is the real couch race (Pete, 2026-11-21): two bikes, split screen, a bot team with
// real physics, paced to the tier's medal time.
//
//   BR-01  locked: VERSUS BOTS is shut and says what opens it
//   BR-02  unlocked: the screen has Bolt, Rivet, Sprocket, Nobody and Easy, Medium, Hard
//   BR-03  the race is split screen with two bikes; the rival bots really ride, on the road, and your back-seat bot
//          neither pedals nor steers for you
//   BR-04  an Easy 2v2 win: Rivals, Crown the Goose, Royal Court, Clean Sweep; it does not add to House Champion
//   BR-05  a loss is a race finished, not won
//   BR-06  Hard with the back seat empty: Underdog and Comeback Geese, no Clean Sweep credit after a crash
//   BR-07  each tier's bots finish close to its medal time
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeGamepads } from './lib/fake-gamepads.mjs';
import { soloAchievementIds } from '../js/rewards.js';

const h = await startHarness({ port: 8978, outDir: 'tandemonium-bot-race' });
const { check } = h;
const until = (page, fn, arg, timeout = 90000) => page.waitForFunction(fn, { timeout, polling: 100 }, arg).then(() => true, () => false);
const earned = (ids) => JSON.stringify(ids.map((id) => ({ id, earnedAt: 1 })));
const solo = soloAchievementIds();
const BASE = { tandemonium_tutorial_done: 'smoke', tandemonium_show_riders: 'on' };

const openVersusBots = async (page) => {
  await page.evaluate(() => window._game.lobby._showStep(window._game.lobby.modeStep));
  await page.evaluate(() => document.getElementById('btn-together').click());
  await until(page, () => document.getElementById('lobby-flow').current === 'lobby-role', null, 10000);
  await page.evaluate(() => document.getElementById('btn-versus-bots').click());
};

// ── BR-01 ──
const locked = await h.gamePage({ storage: { ...BASE, tandemonium_achievements: earned(solo.slice(2)) } });
await until(locked, () => window._game.lobby._presetKeys.length > 1);
await openVersusBots(locked);
await sleep(400);
const shut = await locked.evaluate(() => ({ step: document.getElementById('lobby-flow').current, desc: document.getElementById('versus-bots-desc')?.textContent || '' }));
check(shut.step === 'lobby-role' && /1 more solo achievement/.test(shut.desc), 'BR-01: VERSUS BOTS is shut and says what opens it', shut);
await locked.close();

// ── BR-02 ──
const page = await h.gamePage({ viewport: { width: 1920, height: 1080 }, before: (p) => installFakeGamepads(p),
  storage: { ...BASE, tandemonium_achievements: earned(solo.slice(1)) } });
await until(page, () => window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel);
await openVersusBots(page);
await until(page, () => document.getElementById('lobby-flow').current === 'lobby-versus-bots', null, 10000);
const rows = await page.evaluate(() => ({
  seats: [...document.querySelectorAll('#vb-seat-picks .bot-pick')].map((b) => b.textContent.trim()),
  races: [...document.querySelectorAll('#vb-race-picks .bot-pick')].map((b) => b.textContent.trim()),
}));
check(rows.seats.join() === 'Bolt,Rivet,Sprocket,Nobody' && rows.races.join() === 'Easy,Medium,Hard', 'BR-02: the seat and race rows', rows);

const stats = () => page.evaluate(() => {
  const a = window._game.achievements, s = a.getStats();
  return { races: s.versusRaces || 0, wins: s.versusWins || 0, easy: s.versusEasyWins || 0, earned: a.getEarnedIds().filter((id) => id.startsWith('versus_')) };
});
const race = async ({ bot, tier, difficulty = 'adventurous' }) => {
  await openVersusBots(page);
  await until(page, () => document.getElementById('lobby-flow').current === 'lobby-versus-bots', null, 10000);
  await page.evaluate((o) => { const l = window._game.lobby; l.pickBot(o.bot); l.pickRace(o.tier); l._syncVersusBots(); }, { bot, tier });
  await page.evaluate(() => document.getElementById('btn-versus-bots-next').click());
  await page.waitForFunction(() => !!document.querySelector('#level-cards .level-card[data-level-id="grandma"]'), { timeout: 20000 });
  await page.evaluate((d) => {
    document.querySelector('#level-cards .level-card[data-level-id="grandma"]').click();
    Array.from(document.querySelectorAll('.difficulty-btn')).find((x) => x.dataset.difficulty === d)?.click();
  }, difficulty);
  await sleep(300);
  await page.evaluate(() => Array.from(document.querySelectorAll('button, uf-button')).find((x) => x.offsetParent !== null && /start ride/i.test(x.textContent || ''))?.click());
  await until(page, () => window._game.state === 'instructions', null, 30000);
  await page.evaluate(() => document.getElementById('instructions')?.click());
  await page.keyboard.press('Space');
  return until(page, () => window._game.state === 'playing' && window._game.mode === 'versus', null, 120000);
};
/** Put a team just short of the line; it rolls across by itself. */
const finish = async (team) => {
  await page.evaluate((id) => {
    const g = window._game, r = g.versusRigs.find((x) => x.id === id);
    r.bike.distanceTraveled = r.raceManager.raceDistance - 0.3; r.bike.speed = 10;
  }, team);
  await until(page, () => ['versusCinematic', 'versusResults'].includes(window._game.state), null, 30000);
  await sleep(500);
};
const toLobby = async () => {
  await page.evaluate(() => window._game._returnToLobby());
  await until(page, () => window._game.state === 'lobby' || !!document.getElementById('btn-solo')?.offsetParent, null, 30000);
};

// ── BR-03 ──
console.log('BR-03 a real split-screen race');
check(await race({ bot: 'bolt', tier: 'easy' }), 'BR-03: the race starts in versus mode');
await page.evaluate(() => { const g = window._game, draw = g._renderVersusViews; g._renderVersusViews = () => {}; for (let i = 0; i < 60 * 8; i++) g._updateVersus(1 / 60); g._renderVersusViews = draw; });
const live = await page.evaluate(() => {
  const g = window._game, [a, b] = g.versusRigs, names = (r) => r.members.map((m) => m.botId || 'you');
  return { a: names(a), b: names(b), body: document.body.classList.contains('mode-versus'), aspect: +a.camera.aspect.toFixed(2),
    bD: b.bike.distanceTraveled, bSpeed: b.bike.speed, bLat: Math.abs(b.bike._lateralOffset || 0), aD: a.bike.distanceTraveled,
    aShares: a.sharesPedals, aBot: a.isBotRiders, bBot: b.isBotRiders, botStoker: a.bike.botStoker, cap: b.bike._botCaptain, sto: b.bike.botStoker };
});
check(live.body && Math.abs(live.aspect - 0.89) < 0.02, 'BR-03: split screen, each half its own camera', live);
check(live.a.join() === 'you,bolt' && live.b.join() === 'rivet,sprocket' && live.botStoker === 'bolt' && live.cap === 'rivet' && live.sto === 'sprocket', 'BR-03: you + Bolt against Rivet & Sprocket', live);
check(live.bBot && live.bSpeed > 1 && live.bLat < 2.5, 'BR-03: the rival bots ride on the road under their own power', live);
check(!live.aShares && !live.aBot && live.aD < 3, 'BR-03: your back-seat bot does not pedal for you', live);
// the selfie cams: each frames its own bike's captain
await page.evaluate(() => { for (const fv of window._game.versusFrontViews || []) fv.reset(); });
await sleep(2500);
const framed = await page.evaluate(() => (window._game.versusFrontViews || []).map((fv, i) => {
  const b = window._game.versusRigs[i].bike, p = b.position.clone(); p.y += 2;
  fv.update(b, 1 / 60); fv.camera.updateMatrixWorld(); const q = p.project(fv.camera);
  return Math.abs(q.x) < 1 && Math.abs(q.y) < 1 && q.z < 1;
}));
check(framed.length === 2 && framed.every(Boolean), 'BR-03: each selfie cam frames its own riders', framed);
await h.shot(page, 'br-split-screen-1080p');

// ── BR-04 ──
console.log('BR-04 an Easy 2v2 win');
const s0 = await stats();
await finish('A');
const s1 = await stats();
check(['versus_first', 'versus_win', 'versus_2v2', 'versus_clean'].every((id) => s1.earned.includes(id)) && !s1.earned.includes('versus_underdog'),
  'BR-04: Rivals, Crown the Goose, Royal Court and Clean Sweep', s1.earned);
const pal = await page.evaluate(() => { const s = window._game.achievements.getStats(); return { partners: s.partners || [], coop: s.coopFinishes, rides: JSON.parse(localStorage.getItem('tandemonium_bot_pairs') || '{}').bolt?.rides }; });
check(pal.partners.includes('bot:bolt') && pal.coop >= 1 && pal.rides === 1, 'BR-04: Bolt counts as your co-op partner', pal);
check(s1.wins === s0.wins + 1 && s1.easy === s0.easy + 1 && !s1.earned.includes('versus_10'), 'BR-04: the Easy win is kept off House Champion', s1);
await until(page, () => window._game.state === 'versusResults', null, 30000);
await h.shot(page, 'br-results-win-1080p');

// ── BR-05 ──
console.log('BR-05 a loss');
await toLobby();
await race({ bot: 'bolt', tier: 'medium' });
await finish('B');
const s2 = await stats();
check(s2.races === s1.races + 1 && s2.wins === s1.wins, 'BR-05: a loss is a race finished, not won', s2);

// ── BR-06 ──
console.log('BR-06 Hard, alone, from behind, with a crash');
await toLobby();
await race({ bot: 'none', tier: 'hard' });
const alone = await page.evaluate(() => { const [a, b] = window._game.versusRigs; return { a: a.members.length, b: b.members.map((m) => m.botId) }; });
check(alone.a === 1 && alone.b.join() === 'bolt,rivet', 'BR-06: "Nobody": you alone against Bolt & Rivet', alone);
await page.evaluate(() => { const [a, b] = window._game.versusRigs; a.crashCount = 1; b.bike.distanceTraveled = b.raceManager.raceDistance * 0.55; });
await until(page, () => window._game.achievements._versus?.halfLeader === 'B', null, 10000);
await page.evaluate(() => { const b = window._game.versusRigs[1]; b.bike.speed = 0; });
await finish('A');
const s3 = await stats();
check(s3.earned.includes('versus_underdog') && s3.earned.includes('versus_comeback'), 'BR-06: Underdog and Comeback Geese', s3.earned);
check(s3.easy === s2.easy && s3.wins === s2.wins + 1, 'BR-06: a Hard win counts toward House Champion', s3);

// ── BR-07 ──
console.log('BR-07 the bots finish near their medal time');
for (const tier of ['easy', 'medium', 'hard']) {
  await toLobby();
  await race({ bot: 'bolt', tier });
  const r = await page.evaluate(async () => {
    // the real update at a steady 60 Hz, nothing drawn (headless WebGL runs at about 1 frame a second)
    const g = window._game, b = g.versusRigs[1], target = g._botVersus.targetMs, draw = g._renderVersusViews;
    g._renderVersusViews = () => {};
    let f = 0;
    for (; f < 60 * 200 && !b.finished; f++) { g._updateVersus(1 / 60); if (f % 240 === 0) await new Promise((r) => setTimeout(r)); }
    g._renderVersusViews = draw;
    return { target, ms: Math.round(b.botClockMs), crashes: b.crashCount };
  });
  check(r.ms > 0 && Math.abs(r.ms - r.target) <= r.target * 0.12, `BR-07: ${tier} bots finish within 12% of the medal time`, r);
}
await h.finish();
