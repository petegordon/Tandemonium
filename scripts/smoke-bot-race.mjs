#!/usr/bin/env node
// smoke:bot-race · #644 step 2: on Solo Flight, race a bot ghost team (the two other player bots on a see-through
// Penny-Farthing, replaying a recorded ride stretched to the tier's medal time). Beating it is a versus race.
//
//   BR-01  locked (player bots not earned): no Race row, and a stored race choice races nothing
//   BR-02  unlocked: the Solo Flight card has a Race row (Off, Easy, Medium, Hard) and a "Nobody" back seat; the mouse
//          picks Medium, a pad walks the row (D-pad) and picks Hard with A; both saved
//   BR-03  a Medium race with Bolt on the back: the ghost team is Rivet (captain) + Sprocket (stoker), robot geese in
//          their colours, see-through, no collisions; it waits on the line in the countdown, then follows its line
//          (its road distance is the recording's at the race clock); the race line on the HUD names them and the gap
//   BR-04  a scripted win: Rivals, Crown the Goose, Royal Court (2v2), Clean Sweep, the versus mode for Full House;
//          the bot is still the ride's partner (pair stats); Tandem Tokens paid; the results say who was beaten
//   BR-05  a loss: a versus race finished (counted) but no win; the results say the bots won
//   BR-06  Hard, the back seat empty ("Nobody"): Bolt + Rivet race you; trailing at halfway then winning, with a
//          crash: Underdog (1v2) and Comeback Geese, not Clean Sweep; no partner credit
//   BR-07  Easy is a warm-up: a win counts no versus race
//   BR-08  the chase camera on the Penny-Farthing frames the captain clear of the bot's back (before/after shots)
// Screenshots (1920x1080): the card, the race start, mid-race, the results, the chase camera before/after.
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';
import { soloAchievementIds } from '../js/rewards.js';

const h = await startHarness({ port: 8979, outDir: 'tandemonium-bot-race' });
const { check } = h;
const until = (page, fn, arg, timeout = 90000) => page.waitForFunction(fn, { timeout, polling: 100 }, arg).then(() => true, () => false);
// (every bike already celebrated: #736's full-screen Solo Flight would cover the chooser)
const BASE = { tandemonium_tutorial_done: 'smoke', tandemonium_show_riders: 'on',
  tandemonium_bike_ladder: JSON.stringify({ bikes: ['default', 'bike_orange', 'bike_magenta', 'bike_red', 'bike_blue', 'bike_green', 'bike_yellow', 'bike_newyears', 'bike_christmas', 'bike_birthday', 'solo_flight', 'time_warp', 'gold_standard'], edition: 'full', count: 100 }) };
const earned = (ids) => JSON.stringify(ids.map(id => ({ id, earnedAt: 1 })));
const solo = soloAchievementIds();
const VERSUS = ['versus_first', 'versus_win', 'versus_2v2', 'versus_comeback', 'versus_10', 'versus_underdog', 'versus_clean'];
const toSoloFlight = (page) => page.evaluate(() => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('solo_flight'); l._applyPresetToPreview(); });
const card = (page) => page.evaluate(() => {
  const vis = (id) => { const e = document.getElementById(id); return !!e && e.getBoundingClientRect().width > 0; };
  return { picked: window._game.lobby.selectedPresetKey, race: window._game.lobby.selectedRace, bot: window._game.lobby.selectedBot,
    raceRow: vis('race-picker'), seats: [...document.querySelectorAll('#bot-picker .bot-pick')].map(b => b.textContent.trim()),
    races: [...document.querySelectorAll('#race-picker .race-pick')].map(b => ({ id: b.dataset.race, text: b.textContent.trim(), on: b.getAttribute('aria-checked') === 'true' })) };
});

// ── BR-01 locked ──
console.log('BR-01 locked: no Race row, no race');
const locked = await h.gamePage({ storage: { ...BASE, tandemonium_achievements: earned(solo.slice(2)), tandemonium_bot_race: 'hard' } });
await until(locked, () => window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel);
await toSoloFlight(locked);
let c = await card(locked);
check(!c.raceRow && c.picked === 'default', 'BR-01: locked Solo Flight shows no Race row and the ride stays on the default bike', c);
const lockedRace = await locked.evaluate(() => { const g = window._game; g.mode = 'solo'; g._applyBikeChoice(); return g._botRaceTier; });
check(!lockedRace, 'BR-01: a stored race choice races nothing on the default bike', lockedRace);
await locked.close();

// ── BR-02 the Race row ──
console.log('BR-02 unlocked: the Race row by mouse and pad');
const page = await h.gamePage({ viewport: { width: 1920, height: 1080 }, before: (p) => installFakeGamepads(p, { atBoot: ['xbox'] }),
  storage: { ...BASE, tandemonium_achievements: earned(solo.slice(1)), tandemonium_bot_race: 'off' } });
await until(page, () => window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel);
await toSoloFlight(page);
await until(page, () => { const sp = (window._game.lobby._specialPreviews || {}).solo_flight; return !!(sp && sp.model && sp.model.visible && !sp.dark); });
c = await card(page);
check(c.raceRow && c.races.map(r => r.text).join(',') === 'Off,Easy,Medium,Hard' && c.race === 'off' && c.races.find(r => r.on).id === 'off',
  'BR-02: the Race row shows Off, Easy, Medium, Hard (Off by default)', c.races);
check(c.seats.join(',') === 'Bolt,Rivet,Sprocket,Nobody', 'BR-02: the back seat can be left empty ("Nobody")', c.seats);
const box = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
let b = await box('.race-pick[data-race="medium"]');
await page.mouse.click(b.x, b.y);
c = await card(page);
check(c.race === 'medium' && await page.evaluate(() => localStorage.getItem('tandemonium_bot_race')) === 'medium', 'BR-02: a mouse click picks Medium (saved)', c.race);
await h.shot(page, 'br-card-race-row-1080p');

const pads = fakePads(page);
await until(page, () => window._game.lobby.input && window._game.lobby.input.gamepadConnected, null, 30000);
await until(page, () => window._game.lobby._stepFocus.items.some(e => e.classList && e.classList.contains('race-pick')), null, 30000);
await sleep(800);
await page.evaluate(() => {
  const fc = window._game.lobby._stepFocus, el = document.querySelector('.race-pick[data-race="off"]');
  fc._clearSpatialFocus(); fc.focusedEl = el; el.classList.add(fc.focusClass);
});
// each press, then wait for the focus to move (no fixed sleeps)
for (const want of ['easy', 'medium', 'hard']) {
  await pads.press(0, 'RIGHT');
  await until(page, (w) => { const f = window._game.lobby._stepFocus.focusedEl; return !!(f && f.dataset && f.dataset.race === w); }, want, 5000);
}
const focused = await page.evaluate(() => { const f = window._game.lobby._stepFocus.focusedEl; return f && f.dataset ? f.dataset.race || f.dataset.bot || f.id : null; });
await pads.press(0, 'A');
await until(page, () => window._game.lobby.selectedRace === 'hard', null, 5000);
// up from the Race row reaches the back seat row
await pads.press(0, 'UP');
await until(page, () => { const f = window._game.lobby._stepFocus.focusedEl; return !!(f && f.dataset && f.dataset.bot); }, null, 5000);
const upTo = await page.evaluate(() => { const f = window._game.lobby._stepFocus.focusedEl; return f && f.dataset ? (f.dataset.bot ? 'seat' : f.dataset.race ? 'race' : f.id) : null; });
c = await card(page);
check(focused === 'hard' && c.race === 'hard', 'BR-02: a pad walks the Race row with the D-pad and A picks Hard', { focused, race: c.race });
check(upTo === 'seat', 'BR-02: D-pad up from the Race row reaches the back seat row', upTo);
await pads.unplug(0);

// ── rides ──
const lobbyRide = async ({ bot, race, difficulty = 'adventurous' }) => {
  await page.evaluate((o) => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('solo_flight'); l._applyPresetToPreview(); l.pickBot(o.bot); l.pickRace(o.race); }, { bot, race });
  await page.evaluate(() => document.getElementById('btn-solo').click());
  await page.waitForFunction(() => !!document.querySelector('#level-cards .level-card[data-level-id="grandma"]'), { timeout: 20000 });
  await page.evaluate((d) => {
    document.querySelector('#level-cards .level-card[data-level-id="grandma"]').click();
    const x = Array.from(document.querySelectorAll('.difficulty-btn')).find(e => e.dataset.difficulty === d); x && x.click();
  }, difficulty);
  await sleep(300);
  await page.evaluate(() => { const x = Array.from(document.querySelectorAll('button, uf-button')).find(e => e.offsetParent !== null && /start ride/i.test(e.textContent || '')); x && x.click(); });
};
const ghostReady = () => until(page, () => { const g = window._game; return !!(g._botRace && g._botGhost && g._botGhostReady); }, null, 180000);
const stats = () => page.evaluate((V) => {
  const a = window._game.achievements, s = a.getStats(), e = a.getEarnedIds();
  return { races: s.versusRaces, wins: s.versusWins, modes: s.modesFinished || [], partners: s.partners || [], earned: V.filter(id => e.includes(id)),
    coins: JSON.parse(localStorage.getItem('tandemonium_wallet') || '{"coins":0}').coins, pairs: JSON.parse(localStorage.getItem('tandemonium_bot_pairs') || '{}') };
}, VERSUS);
const toLobby = async () => {
  await page.evaluate(() => window._game._returnToLobby());
  await until(page, () => !!document.getElementById('btn-solo')?.offsetParent, null, 30000);
};
/** Cross the line now (elapsed = the race clock so far, plus `extraMs` pretended). */
const finishRide = async ({ extraMs = 0 } = {}) => {
  await page.evaluate((x) => { const g = window._game; g.raceManager.startTime -= x; g.bike.distanceTraveled = g.lobby.selectedLevel.distance - 0.5; g.bike.speed = 10; }, extraMs);
  const ok = await until(page, () => window._game?.state === 'victory', null, 240000);
  await sleep(1500);
  return ok;
};

// ── BR-03 Medium with Bolt ──
console.log('BR-03 a Medium race with Bolt on the back');
await page.evaluate(() => { localStorage.removeItem('tandemonium_bot_pairs'); });
await lobbyRide({ bot: 'bolt', race: 'medium' });
await until(page, () => window._game.state === 'countdown' || window._game.state === 'playing', null, 120000);
const ready = await ghostReady();
check(ready, 'BR-03: the ghost team\'s tandem is built and its bots seated');
const look = await page.evaluate(async () => {
  const { BOTS } = await import('/js/player-bots.js');
  const g = window._game, gh = g._botGhost, r = g._botRace;
  const tint = (root) => { let plate = null; root.traverse(o => { if (o.isMesh) for (const m of [].concat(o.material)) if (/^robot_white/.test(m.name)) plate = '#' + m.color.getHexString(); }); return plate; };
  let opaque = 0, see = 0;
  gh.group.traverse(o => { if (o.isMesh) for (const m of [].concat(o.material)) { if (m.transparent && m.opacity < 0.7) see++; else opaque++; } });
  return { team: r.team, tier: r.tier, counts: r.counts, path: gh._modelPath === undefined ? null : gh._gooseRiderPaths,
    cap: tint(gh.goose.riders.Captain.root), sto: tint(gh.goose.riders.Stoker.root), want: { cap: BOTS.rivet.plate, sto: BOTS.sprocket.plate },
    playerSto: tint(g.bike.goose.riders.Stoker.root), wantPlayer: BOTS.bolt.plate, see, opaque,
    hud: document.getElementById('bot-race-hud')?.textContent || '', hudShown: !document.getElementById('bot-race-hud')?.hidden };
});
check(look.team.join('+') === 'rivet+sprocket' && look.tier === 'medium' && look.counts, 'BR-03: Bolt on your back seat: Rivet and Sprocket ride the ghost tandem (Medium counts)', look.team);
check(/robot_f/.test(look.path.Captain) && /robot_m/.test(look.path.Stoker) && look.cap === look.want.cap && look.sto === look.want.sto,
  'BR-03: the ghost\'s geese are robot geese in Rivet\'s and Sprocket\'s colours', { path: look.path, cap: look.cap, sto: look.sto, want: look.want });
check(look.playerSto === look.wantPlayer, 'BR-03: your own bike keeps Bolt in his colours (the ghost\'s tint does not leak)', look.playerSto);
check(look.see > 0 && look.opaque === 0, 'BR-03: the ghost is see-through everywhere', { see: look.see, opaque: look.opaque });
check(look.hudShown && /Rivet & Sprocket/.test(look.hud) && /Medium/.test(look.hud), 'BR-03: the race line names the ghost team and the tier', look.hud);
const atLine = await page.evaluate(() => { const g = window._game; return { state: g.state, d: g._botGhost.distanceTraveled, vis: g._botGhost.group.visible }; });
if (atLine.state === 'countdown') {
  check(atLine.d < 1 && atLine.vis, 'BR-03: in the countdown the ghost waits on the line beside you', atLine);
  await h.shot(page, 'br-race-start-1080p');
}
await until(page, () => window._game.state === 'playing', null, 60000);
if (atLine.state !== 'countdown') await h.shot(page, 'br-race-start-1080p');
// ride a little: pedal the player so the ghost pulls away and the gap reads
await page.evaluate(() => { const g = window._game; g.bike.speed = 4; });
await until(page, () => window._game.raceManager.getElapsedMs() > 4000, null, 60000);
const follow = await page.evaluate(() => {
  const g = window._game, r = g._botRace, s = g.raceManager.getElapsedMs() / 1000, at = r.at(s);
  const gh = g._botGhost, path = g.world.roadPath, pt = path.getPointAtDistance(gh.distanceTraveled % path.loopLength);
  const off = Math.hypot(gh.group.position.x - pt.x, gh.group.position.z - pt.z);
  return { s: +s.toFixed(2), d: +gh.distanceTraveled.toFixed(2), want: +at.roadD.toFixed(2), off: +off.toFixed(2), lane: +at.lateral.toFixed(2),
    vis: gh.group.visible, hud: document.querySelector('#bot-race-hud .brh-gap')?.textContent };
});
check(follow.d > 3 && Math.abs(follow.d - follow.want) < 3 && follow.vis, 'BR-03: the ghost follows its recorded line on the race clock', follow);
check(Math.abs(follow.off - Math.abs(follow.lane)) < 0.5, 'BR-03: it rides its own lane, off the road\'s centre', follow);
check(/\d+ m (ahead|behind)|Neck and neck/.test(follow.hud || ''), 'BR-03: the race line shows the gap', follow.hud);
await page.evaluate(() => { const g = window._game; g.bike.speed = 0; });
await sleep(1500);
await h.shot(page, 'br-mid-race-1080p');

// ── BR-08 the chase camera on the Penny-Farthing ──
console.log('BR-08 the chase camera frames the captain');
/** The two geese's heads on screen (px at 1920x1080) after the chase camera settles, with the camera lift given. */
const frame = (lift) => page.evaluate(async (L) => {
  const g = window._game, b = g.bike;
  const keep = b.chaseLift;
  if (L != null) b.chaseLift = L;
  g.chaseCamera.initialized = false;
  // at riding speed (the camera pulls back and down as the bike speeds up)
  const t0 = performance.now();
  await new Promise((done) => { const step = () => { b.speed = 6; if (performance.now() - t0 > 1500) done(); else requestAnimationFrame(step); }; step(); });
  const V = b.group.position.constructor, cam = g.camera;
  const head = (seat) => { const p = new V(); const r = b.goose.riders[seat].root, hd = r.getObjectByName('Head') || r; hd.getWorldPosition(p); return p; };
  const px = (p) => { const q = p.clone().project(cam); return { x: (q.x + 1) * 960, y: (1 - q.y) * 540 }; };
  const cap = px(head('Captain')), sto = px(head('Stoker'));
  const out = { lift: b.chaseLift, cap, sto, apart: Math.round(Math.hypot(cap.x - sto.x, cap.y - sto.y)), capAbove: Math.round(sto.y - cap.y) };
  if (L != null) b.chaseLift = keep;
  return out;
}, lift);
const before = await frame(0);
await h.shot(page, 'br-chase-before-1080p');
const after = await frame(null);
await h.shot(page, 'br-chase-after-1080p');
check(after.lift > 0 && after.capAbove > before.capAbove + 40 && after.capAbove > 60,
  'BR-08: the lifted chase camera shows the captain\'s head well clear above the bot\'s', { before, after });

// ── BR-04 the win ──
console.log('BR-04 a scripted win');
const s0 = await stats();
check(await finishRide(), 'BR-04: the ride finishes');
const s1 = await stats();
const out1 = await page.evaluate(() => ({ title: document.getElementById('victory-title').textContent, line: document.querySelector('.bot-race-result')?.textContent || '',
  o: window._game._botRaceOutcome, ghostGone: !window._game._botGhost || !window._game._botGhost.group.visible }));
check(out1.o && out1.o.won && out1.o.twoVtwo && out1.o.clean, 'BR-04: the race is won, 2v2, clean', out1.o);
check(['versus_first', 'versus_win', 'versus_2v2', 'versus_clean'].every(id => s1.earned.includes(id)) && !s1.earned.includes('versus_underdog'),
  'BR-04: Rivals, Crown the Goose, Royal Court and Clean Sweep (not Underdog)', s1.earned);
check(s1.races === (s0.races || 0) + 1 && s1.wins === (s0.wins || 0) + 1 && s1.modes.includes('versus'), 'BR-04: one versus race won; Full House sees the versus mode', { races: s1.races, wins: s1.wins, modes: s1.modes });
check(s1.partners.includes('bot:bolt') && s1.pairs.bolt && s1.pairs.bolt.rides === 1, 'BR-04: Bolt is still the ride\'s partner (pair stats on this device)', { partners: s1.partners, pairs: s1.pairs });
check(s1.coins > s0.coins, 'BR-04: the race pays Tandem Tokens', [s0.coins, s1.coins]);
check(/WON THE RACE/.test(out1.title) && /You beat Rivet & Sprocket by/.test(out1.line), 'BR-04: the results say who you beat', { title: out1.title, line: out1.line });
const board = await page.evaluate(() => { const g = window._game; return { race: !!g._botRace }; });
check(out1.ghostGone, 'BR-04: the ghost is gone at the line', { ghostGone: out1.ghostGone, board });
await h.shot(page, 'br-results-win-1080p');

// ── BR-05 a loss ──
console.log('BR-05 a loss');
await toLobby();
check(!(await page.evaluate(() => !!window._game._botGhost)), 'BR-05: back in the lobby, no ghost left in the scene');
await lobbyRide({ bot: 'bolt', race: 'medium' });
await until(page, () => window._game.state === 'playing', null, 120000);
const target = await page.evaluate(() => window._game._botRace.targetMs);
await finishRide({ extraMs: target + 2000 });
const s2 = await stats();
const out2 = await page.evaluate(() => ({ title: document.getElementById('victory-title').textContent, line: document.querySelector('.bot-race-result')?.textContent || '', o: window._game._botRaceOutcome }));
check(out2.o && !out2.o.won && s2.races === s1.races + 1 && s2.wins === s1.wins, 'BR-05: a loss is a versus race finished, not won', { o: out2.o && out2.o.won, races: s2.races, wins: s2.wins });
check(/BOTS WON/.test(out2.title) && /Rivet & Sprocket won by/.test(out2.line), 'BR-05: the results say the bots won', { title: out2.title, line: out2.line });
await h.shot(page, 'br-results-loss-1080p');

// ── BR-06 Hard, alone: Underdog + Comeback ──
console.log('BR-06 Hard with the back seat empty: Underdog and Comeback Geese');
await toLobby();
await lobbyRide({ bot: 'none', race: 'hard' });
await until(page, () => window._game.state === 'playing', null, 120000);
const alone = await page.evaluate(() => { const g = window._game; return { team: g._botRace.team, solo: g._botRace.solo, bot: g._botRideId(), empty: g.bike._emptySeat,
  stoVis: !!(g.bike.goose && g.bike.goose.riders.Stoker && g.bike.goose.riders.Stoker.root.visible) }; });
check(alone.team.join('+') === 'bolt+rivet' && alone.solo && !alone.bot && alone.empty && !alone.stoVis, 'BR-06: "Nobody": the back seat is empty and Bolt + Rivet ride the ghost', alone);
// the ghost leads at halfway (pretend 60% of its time has gone with you near the start), then you win with a crash
await page.evaluate(() => { const g = window._game; g.raceManager.startTime -= g._botRace.targetMs * 0.6; });
await until(page, () => window._game._botRace && window._game._botRace.halfLeader === 'ghost', null, 20000);
await page.evaluate(() => { window._game.raceManager.crashCount = 1; });
await finishRide();
const s3 = await stats();
const o3 = await page.evaluate(() => window._game._botRaceOutcome);
check(o3 && o3.won && o3.oneVtwo && o3.comeback && !o3.clean, 'BR-06: won alone, after trailing at halfway, with a crash', o3);
check(s3.earned.includes('versus_underdog') && s3.earned.includes('versus_comeback'), 'BR-06: Underdog and Comeback Geese', s3.earned);
check(JSON.stringify(s3.pairs) === JSON.stringify(s2.pairs) && s3.partners.length === s2.partners.length, 'BR-06: no partner credit with the back seat empty', { before: s2.pairs, after: s3.pairs });

// ── BR-07 Easy is a warm-up ──
console.log('BR-07 Easy counts no versus race');
await toLobby();
await lobbyRide({ bot: 'sprocket', race: 'easy' });
await until(page, () => window._game.state === 'playing', null, 120000);
await finishRide();
const s4 = await stats();
const o4 = await page.evaluate(() => ({ o: window._game._botRaceOutcome, line: document.querySelector('.bot-race-result')?.textContent || '' }));
check(o4.o && o4.o.won && !o4.o.counts && s4.races === s3.races && s4.wins === s3.wins, 'BR-07: an Easy win is no versus race', { races: [s3.races, s4.races] });
check(/warm-up/.test(o4.line) && s4.pairs.sprocket && s4.pairs.sprocket.rides === 1, 'BR-07: the results say so; Sprocket still rode as the partner', { line: o4.line, pairs: s4.pairs });

// screenshots into the review folder too, when asked
const review = process.env.BR_SHOTS;
if (review && h.out) for (const f of fs.readdirSync(h.out)) if (f.startsWith('br-')) fs.copyFileSync(path.join(h.out, f), path.join(review, f));
await h.finish();
