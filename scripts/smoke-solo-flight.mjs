#!/usr/bin/env node
// smoke:solo-flight · #644 step 1: Solo Flight (the Penny-Farthing tandem, the player-bots reward) rides, with a
// player bot on the back seat who just rides along and counts as the ride's partner.
//
//   SFB-01  locked (under 80 of the 81 solo achievements): a dark silhouette with "n of 80", no bot picker, and the
//           ride stays on the default bike
//   SFB-02  unlocked: Solo Flight in colour is the pick; the bot picker shows Bolt, Rivet and Sprocket; the mouse
//           picks one; a pad moves along the row (D-pad) and picks with A; the choice is saved
//   SFB-03  a solo ride loads solo_flight_tandem.glb sized like the goose tandem: the player's goose on Seat_Captain,
//           the picked bot (a robot goose, in its colour) on Seat_Stoker; the bike's Ride clip and both geese's
//           Pedal_PF clips turn with the crank (the stoker's reversed); the wheels/cranks are not merged into the frame
//   SFB-04  the bot only rides along: the stoker's lean stays 0 and Show Solo never hides it
//   SFB-05  finishing credits the bot as the partner: rides with Bolt, Rivet and Sprocket earn Social Goose (3
//           partners) and The Two of Us; each bot's pair stats count on this device; the ride pays Tandem Tokens
//   SFB-06  co-op modes ride the goose tandem with no bot; a paint preset rides the goose tandem again
// Screenshots at 1920x1080: the chooser with the bot picker, a ride from the side and from the chase camera.
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';
import { soloAchievementIds } from '../js/rewards.js';

const h = await startHarness({ port: 8977, outDir: 'tandemonium-solo-flight' });
const { check } = h;
const until = (page, fn, arg, timeout = 90000) => page.waitForFunction(fn, { timeout, polling: 100 }, arg).then(() => true, () => false);
const BASE = { tandemonium_tutorial_done: 'smoke', tandemonium_show_riders: 'on' };
const earned = (ids) => JSON.stringify(ids.map(id => ({ id, earnedAt: 1 })));
const solo = soloAchievementIds();

const chooser = (page) => page.evaluate(() => {
  const l = window._game.lobby, sp = (l._specialPreviews || {}).solo_flight, hint = document.getElementById('bike-hint');
  const picker = document.getElementById('bot-picker');
  return {
    key: l._presetKeys[l._presetIndex], picked: l.selectedPresetKey, bot: l.selectedBot,
    name: document.getElementById('bike-name').textContent,
    hint: hint && hint.style.display !== 'none' ? hint.textContent.replace(/\s+/g, ' ').trim() : '',
    shown: !!(sp && sp.model && sp.model.visible), dark: !!(sp && sp.dark),
    picker: !!picker && picker.getBoundingClientRect().width > 0,
    bots: [...document.querySelectorAll('#bot-picker .bot-pick')].map(b => ({ id: b.dataset.bot, text: b.textContent.trim(), on: b.getAttribute('aria-checked') === 'true' })),
  };
});
const toSoloFlight = (page) => page.evaluate(() => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('solo_flight'); l._applyPresetToPreview(); });

// ── SFB-01 locked ──
console.log('SFB-01 locked: silhouette, "n of 80", no picker');
const locked = await h.gamePage({ storage: { ...BASE, tandemonium_achievements: earned(solo.slice(2)) } });
await until(locked, () => window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel);
await toSoloFlight(locked);
await until(locked, () => { const sp = (window._game.lobby._specialPreviews || {}).solo_flight; return !!(sp && sp.model && sp.model.visible); });
let c = await chooser(locked);
check(c.name.startsWith('🔒') && c.dark && c.picked === 'default', 'SFB-01: locked Solo Flight is a dark silhouette; the ride stays on the default', c);
check(c.hint.replace(/\s+/g, '') === `${solo.length - 2}of${solo.length - 1}soloachievements`, 'SFB-01: "n of 80 solo achievements" over it', c.hint);
check(!c.picker, 'SFB-01: no bot picker while locked', c);
await locked.close();

// ── SFB-02 unlocked: the picker, by mouse and by pad ──
console.log('SFB-02 unlocked: the bot picker by mouse and pad');
const page = await h.gamePage({ viewport: { width: 1920, height: 1080 }, before: installFakeGamepads,
  storage: { ...BASE, tandemonium_achievements: earned(solo.slice(1)) } });
await until(page, () => window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel);
await toSoloFlight(page);
await until(page, () => { const sp = (window._game.lobby._specialPreviews || {}).solo_flight; return !!(sp && sp.model && sp.model.visible && !sp.dark); });
c = await chooser(page);
check(c.picked === 'solo_flight' && !c.dark && !c.name.startsWith('🔒') && !/Coming soon/.test(c.hint), 'SFB-02: unlocked, Solo Flight in colour is the pick', c);
check(c.picker && c.bots.map(b => b.text).join(',') === 'Bolt,Rivet,Sprocket' && c.bots.filter(b => b.on).length === 1 && c.bot === 'bolt',
  'SFB-02: the bot picker shows Bolt, Rivet and Sprocket (Bolt by default)', c.bots);
const rivetBox = await page.evaluate(() => { const r = document.querySelector('.bot-pick[data-bot="rivet"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.click(rivetBox.x, rivetBox.y);
c = await chooser(page);
const saved = await page.evaluate(() => localStorage.getItem('tandemonium_player_bot'));
check(c.bot === 'rivet' && c.bots.find(b => b.on).id === 'rivet' && saved === 'rivet' && c.picked === 'solo_flight', 'SFB-02: a mouse click picks Rivet (saved)', { bot: c.bot, saved });
await h.shot(page, 'sf-chooser-bot-picker-1080p');

const pads = fakePads(page);
const pi = await pads.plug('xbox');
// the pad's hot-connect hands the mode step's focusables (the bot buttons among them) to the spatial focus
const padReady = await until(page, () => window._game.lobby._stepFocus.items.some(e => e.classList && e.classList.contains('bot-pick')), null, 30000);
if (!padReady) console.log('  (pad focus)', await page.evaluate(() => { const l = window._game.lobby, fc = l._stepFocus;
  return JSON.stringify({ step: l._currentStep && l._currentStep.id, gp: l.input.gamepadConnected, items: fc.items.map(e => e.id || (e.dataset && e.dataset.bot) || e.tagName), modal: l._activeModal }); }));
await sleep(800);
// start on Bolt, D-pad right twice, A
await page.evaluate(() => {
  const fc = window._game.lobby._stepFocus, el = document.querySelector('.bot-pick[data-bot="bolt"]');
  fc._clearSpatialFocus(); fc.focusedEl = el; el.classList.add(fc.focusClass);
});
const inFocus = await page.evaluate(() => window._game.lobby._stepFocus.items.filter(e => e.classList.contains('bot-pick')).length);
await pads.press(pi, 'RIGHT');
await sleep(250);
await pads.press(pi, 'RIGHT');
await sleep(250);
const focused = await page.evaluate(() => { const f = window._game.lobby._stepFocus.focusedEl; return f && f.dataset ? f.dataset.bot || f.id : null; });
await pads.press(pi, 'A');
await until(page, () => window._game.lobby.selectedBot === 'sprocket', null, 5000);
c = await chooser(page);
check(inFocus === 3 && focused === 'sprocket' && c.bot === 'sprocket', 'SFB-02: a pad walks the row with the D-pad and A picks Sprocket', { inFocus, focused, bot: c.bot });
await pads.press(pi, 'LB');   // LB / RB still cycle the bikes from here
await sleep(300);
const afterLb = await page.evaluate(() => window._game.lobby._presetKeys[window._game.lobby._presetIndex]);
check(afterLb !== 'solo_flight' && !(await chooser(page)).picker, 'SFB-02: LB moves off Solo Flight and the picker goes', afterLb);
await pads.unplug(pi);
await toSoloFlight(page);

// ── SFB-03 a ride ──
const lobbyRide = async (bot) => {
  await page.evaluate((b) => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('solo_flight'); l._applyPresetToPreview(); l.pickBot(b); }, bot);
  await page.evaluate(() => document.getElementById('btn-solo').click());
  await page.waitForFunction(() => !!document.querySelector('#level-cards .level-card[data-level-id="grandma"]'), { timeout: 20000 });
  await page.evaluate(() => {
    document.querySelector('#level-cards .level-card[data-level-id="grandma"]').click();
    const d = Array.from(document.querySelectorAll('.difficulty-btn')).find(x => x.dataset.difficulty === 'chill'); d && d.click();
  });
  await sleep(300);
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button, uf-button')).find(x => x.offsetParent !== null && /start ride/i.test(x.textContent || '')); b && b.click(); });
  await page.waitForFunction(() => window._game?.state === 'playing', { timeout: 120000 });
};
const seated = (bot) => until(page, (b) => {
  const k = window._game.bike, g = k.goose;
  if (!(k._modelPath.endsWith('solo_flight_tandem.glb') && k.modelLoaded && g && g.riders.Stoker && g.riders.Captain && k._botStoker === b)) return false;
  let robot = false;   // the seated stoker is the robot goose (a swap to the bot may still be landing)
  g.riders.Stoker.root.traverse(o => { if (o.isMesh && [].concat(o.material).some(m => /^robot_white/.test(m.name))) robot = true; });
  return robot;
}, bot, 180000);

console.log('SFB-03 a solo ride on Solo Flight with Rivet on the back');
await page.evaluate(() => { localStorage.removeItem('tandemonium_bot_pairs'); });
await lobbyRide('rivet');
check(await seated('rivet'), 'SFB-03: the ride loads the Penny-Farthing with a robot goose on the back', await page.evaluate(() => ({ path: window._game.bike._modelPath, stoker: (window._game.bike._gooseRiderPaths || {}).Stoker })));
const ride = await page.evaluate(async () => {
  const { BOTS } = await import('/js/player-bots.js');
  const k = window._game.bike, g = k.goose, model = k.group.children[0];
  const sto = g.riders.Stoker, cap = g.riders.Captain;
  let plate = null, light = null;
  sto.root.traverse(o => { if (!o.isMesh) return; for (const m of [].concat(o.material)) {
    if (/^robot_white/.test(m.name)) plate = '#' + m.color.getHexString();
    if (/^robot_light/.test(m.name)) light = '#' + m.emissive.getHexString(); } });
  const want = { plate: BOTS.rivet.plate, light: BOTS.rivet.light };
  // the crank drives everything: bike Ride clip, the captain forwards, the stoker reversed
  g.setCrank(Math.PI / 2); g.update();
  const t = { bike: +g.pf.time.toFixed(3), bikeDur: +g.pf.getClip().duration.toFixed(3), cap: +cap.pedal.time.toFixed(3), sto: +sto.pedal.time.toFixed(3), dur: +cap.pedal.getClip().duration.toFixed(3),
    capPF: cap.pedalPF, stoPF: sto.pedalPF, capClip: cap.pedal.getClip().name, stoClip: sto.pedal.getClip().name };
  const merged = [];
  model.traverse(o => { if (o.userData && o.userData.bikeBatch) merged.push(o.parent && o.parent.name); });
  return { seats: { Captain: cap.root.parent && cap.root.parent.name, Stoker: sto.root.parent && sto.root.parent.name },
    scale: +model.scale.x.toFixed(4), plate, light, want, t, movers: k._rigMovers.map(o => o.name).sort(), merged, stokerPath: k._gooseRiderPaths.Stoker,
    visible: sto.root.visible, botRide: window._game._botRideId() };
});
check(ride.seats.Captain === 'Seat_Captain' && ride.seats.Stoker === 'Seat_Stoker', 'SFB-03: the player on Seat_Captain, the bot on Seat_Stoker', ride.seats);
check(Math.abs(ride.scale - 4.4 / 2.466) < 0.002, 'SFB-03: sized like the goose tandem (the geese keep their size)', ride.scale);
check(/goose_stoker_robot_f\.glb$/.test(ride.stokerPath) && ride.plate === ride.want.plate && ride.light === ride.want.light && ride.botRide === 'rivet',
  'SFB-03: the bot is Rivet, a robot goose in her own colours', { path: ride.stokerPath, plate: ride.plate, light: ride.light, want: ride.want });
const q = ride.t;
check(q.capPF && q.stoPF && q.capClip === 'Pedal_PF' && Math.abs(q.cap - q.dur / 4) < 0.01 && Math.abs(q.sto - 3 * q.dur / 4) < 0.01 && Math.abs(q.bike - q.bikeDur / 4) < 0.01,
  'SFB-03: a quarter crank turn: the bike\'s Ride clip and the captain\'s Pedal_PF a quarter in, the stoker\'s reversed', q);
check(['Crank_F', 'Crank_R', 'Wheel_F', 'Wheel_R', 'Wheel_SF', 'Wheel_SR'].every(n => ride.movers.includes(n)), 'SFB-03: wheels and cranks are kept apart from the merged frame', ride.movers);

// side + chase screenshots, riding
await page.evaluate(() => { const g = window._game; g.bike.speed = 6; });
await sleep(1200);
await h.shot(page, 'sf-ride-chase-1080p');
// the side view: render once from beside the bike and read the canvas in the same task (the game's loop owns the camera)
const sideUrl = await page.evaluate(() => {
  const g = window._game, b = g.bike, model = b.group.children[0];
  model.updateMatrixWorld(true);
  const THREE_V = b.group.position.constructor;
  const cap = new THREE_V(), sto = new THREE_V();
  model.getObjectByName('Seat_Captain').getWorldPosition(cap);
  model.getObjectByName('Seat_Stoker').getWorldPosition(sto);
  const mid = cap.clone().add(sto).multiplyScalar(0.5);
  const fwd = cap.clone().sub(sto); fwd.y = 0; fwd.normalize();
  const side = fwd.clone().cross(new THREE_V(0, 1, 0)).normalize();
  const cam = g.camera.clone();
  const r = g.renderer, size = new THREE_V(); r.getSize(size); const pr = r.getPixelRatio();
  r.setPixelRatio(1); r.setSize(1920, 1080, false);   // full 1080p for the review shot
  cam.aspect = 1920 / 1080; cam.fov = 40;
  cam.position.copy(mid).addScaledVector(side, 9).add(new THREE_V(0, 0.4, 0));
  cam.lookAt(mid.x, mid.y - 0.9, mid.z); cam.updateProjectionMatrix();
  r.render(g.scene, cam);
  const url = r.domElement.toDataURL('image/png');
  r.setPixelRatio(pr); r.setSize(size.x, size.y, false);
  return url;
});
if (h.out) (await import('node:fs')).writeFileSync((await import('node:path')).join(h.out, 'sf-ride-side-1080p.png'), Buffer.from(sideUrl.split(',')[1], 'base64'));

// ── SFB-04 the bot only rides along ──
console.log('SFB-04 the bot only rides along');
const along = await page.evaluate(() => {
  const g = window._game, k = g.bike;
  k.setSoloRider(true);
  const vis = k.goose.riders.Stoker.root.visible;
  k.setSoloRider(false);
  // steady alternate strokes: the bot answers on the beat, the sync row fills (Perfect Sync is the player's steadiness)
  for (let i = 0; i < 12; i++) { g._botSync.feed([{ kind: 'solo', gap: 0.5 }]); g._botSync.update(0.5); }
  return { stokerLean: k._stokerLeanTarget, vis, sync: +g._botSync.offsetScore.toFixed(2) };
});
await sleep(300);
const row = await page.evaluate(() => ({ shown: document.getElementById('sync-row').classList.contains('visible'),
  fill: parseFloat(document.querySelector('#sync-row .sync-bar-fill, #sync-bar-fill')?.style.width || '0') }));
const midEarned = await page.evaluate(() => window._game.achievements.getEarnedIds());
check(!midEarned.includes('team_player'), 'SFB-04: Team Player is not handed out mid-ride (a bot ride counts it at the finish)', midEarned.includes('team_player'));
check(along.stokerLean === 0 && along.vis, 'SFB-04: the bot does not lean (no input) and Show Solo never hides it', along);
check(along.sync > 0.9 && row.shown, 'SFB-04: steady strokes build the bot sync, shown on the sync row', { sync: along.sync, row });

// ── SFB-05 finish: partner credit + Tandem Tokens ──
console.log('SFB-05 finishing with Rivet, Bolt and Sprocket');
const stats = () => page.evaluate(() => {
  const s = window._game.achievements.getStats();
  return { partners: s.partners || [], coop: s.coopFinishes, coins: JSON.parse(localStorage.getItem('tandemonium_wallet') || '{"coins":0}').coins,
    pairs: JSON.parse(localStorage.getItem('tandemonium_bot_pairs') || '{}'), earned: window._game.achievements.getEarnedIds() };
});
const finishRide = async () => {
  await page.evaluate(() => { const g = window._game; g.bike.distanceTraveled = g.lobby.selectedLevel.distance - 0.5; g.bike.speed = 10; });
  await page.waitForFunction(() => window._game?.state === 'victory', { timeout: 240000, polling: 100 });
  await sleep(1500);
};
const s0 = await stats();
await finishRide();
const s1 = await stats();
check(s1.partners.includes('bot:rivet') && s1.coop === (s0.coop || 0) + 1 && s1.pairs.rivet && s1.pairs.rivet.rides === 1 && s1.pairs.rivet.distance > 100,
  'SFB-05: the finish credits Rivet as the partner (co-op finish, her pair stats on this device)', { partners: s1.partners, coop: s1.coop, pairs: s1.pairs });
check(s1.coins > s0.coins, 'SFB-05: the ride pays Tandem Tokens', [s0.coins, s1.coins]);
check(s1.earned.includes('coop_first'), 'SFB-05: The Two of Us (a co-op finish) with a bot', s1.earned.includes('coop_first'));
const board = await page.evaluate(() => { const g = window._game; return { mode: g._dailyRunMode(), partner: g._partnerKey() }; });
check(board.partner === 'bot:rivet' && board.mode === 'solo', 'SFB-05: the partner key is bot:rivet; the Daily board would see a solo ride (and a bot ride posts none)', board);
await h.shot(page, 'sf-victory');

for (const bot of ['bolt', 'sprocket']) {
  await page.evaluate(() => window._game._returnToLobby());
  await until(page, () => window._game.state === 'lobby' || !!document.getElementById('btn-solo')?.offsetParent, null, 30000);
  await lobbyRide(bot);
  check(await seated(bot), `SFB-05: ${bot} rides the back seat`, await page.evaluate(() => window._game.bike._botStoker));
  await finishRide();
}
const s3 = await stats();
check(['bot:rivet', 'bot:bolt', 'bot:sprocket'].every(k => s3.partners.includes(k)) && s3.earned.includes('social_goose'),
  'SFB-05: Rivet, Bolt and Sprocket are three partners: Social Goose', { partners: s3.partners, social: s3.earned.includes('social_goose') });
check(s3.pairs.bolt?.rides === 1 && s3.pairs.sprocket?.rides === 1 && s3.pairs.rivet?.rides === 1, 'SFB-05: each bot keeps its own pair stats', s3.pairs);

// ── SFB-06 other modes: the goose tandem, no bot ──
console.log('SFB-06 co-op rides the goose tandem; a paint preset rides the tandem');
const other = await page.evaluate(() => {
  const g = window._game;
  g.mode = 'local'; g._applyBikeChoice();
  const r = { path: g.bike._modelPath, bot: g.bike._botStoker, ride: g._botRideId() };
  g.mode = 'solo';
  const l = g.lobby; l._presetIndex = l._presetKeys.indexOf('bike_red'); l._applyPresetToPreview(); g._applyBikeChoice();
  return { ...r, preset: g.bike._modelPath, presetBot: g.bike._botStoker };
});
check(/goose_tandem\.glb$/.test(other.path) && other.bot === null && other.ride === null, 'SFB-06: local co-op with Solo Flight picked rides the goose tandem, no bot', other);
check(/goose_tandem\.glb$/.test(other.preset) && other.presetBot === null, 'SFB-06: a paint preset rides the goose tandem again', other);
await h.finish();
