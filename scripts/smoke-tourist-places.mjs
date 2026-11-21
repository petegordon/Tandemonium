#!/usr/bin/env node
// smoke-tourist-places.mjs — Map Tourist's start screen (Pete, 2026-11-17)
//
//   TP-01  the screen leads with the scenic rides and the player's own places: nothing to type
//   TP-02  the week's new places are said plainly, with what never counts
//   TP-03  a controller reaches every place, and picking a scenic ride starts it with its stored anchor
//          (no lookup of any kind)
//   TP-04  a typed address with a controller: an on-screen keyboard types into the field
//   TP-05  a place the player already has costs nothing; a new one counts; none left = said so, and the
//          scenic rides and own places still work
//   TP-06  the old screen's one remembered route is carried over as the first of "your places"
//
// Google is not reached: the tiles library and Google's hosts are answered or aborted here, and the
// geocoder is replaced with a table. The key is a dummy.
//   node scripts/smoke-tourist-places.mjs [screenshot dir]
import path from 'node:path';
import fs from 'node:fs';
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const shots = process.argv[2] || null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const h = await startHarness({ port: 8996, outDir: 'tandemonium-tourist-places' });
const { check } = h;

const before = async (page) => {
  await installFakeGamepads(page);
  await page.evaluateOnNewDocument(() => { window.__TOURIST_MAPS_KEY__ = 'test-key-not-real'; });
};
const ready = (page) => page.waitForFunction(() => window._game && window._game.lobby && window._game.lobby._presetKeys && window._game.lobby._presetKeys.length > 1, { timeout: 90000 });
const openTourist = async (page) => {
  // SOLO first, and its level list on screen, before the card is pressed (the list arrives a moment later)
  await page.evaluate(() => document.getElementById('btn-solo').click());
  await page.waitForFunction(() => { const c = document.querySelector('#level-cards .level-card[data-level-id="tourist"]'); return !!c && c.getBoundingClientRect().width > 0; }, { timeout: 15000 }).catch(() => {});
  await sleep(300);
  return page.evaluate(() => { const card = document.querySelector('#level-cards .level-card[data-level-id="tourist"]'); if (!card) return false; card.click(); return true; });
};
const screen = (page) => page.evaluate(() => {
  const vis = (el) => !!el && el.getBoundingClientRect().width > 0;
  const q = (s) => [...document.querySelectorAll(s)];
  const l = window._game.lobby;
  return {
    step: l._currentStep && l._currentStep.id,
    prompt: (document.querySelector('#lobby-tourist .lobby-prompt') || {}).textContent,
    scenic: q('#tourist-scenic .tourist-place').filter(vis).map((b) => b.querySelector('.tourist-place-name').textContent),
    subs: q('#tourist-scenic .tourist-place').filter(vis).map((b) => b.querySelector('.tourist-place-sub').textContent),
    yours: q('#tourist-yours .tourist-yours-place').filter(vis).map((b) => b.textContent),
    none: vis(document.querySelector('.tourist-yours-none')),
    fresh: { text: document.getElementById('btn-tourist-new').textContent, disabled: document.getElementById('btn-tourist-new').disabled, vis: vis(document.getElementById('btn-tourist-new')) },
    quota: (document.getElementById('tourist-quota') || {}).textContent,
    form: vis(document.getElementById('tourist-form')),
    osk: vis(document.getElementById('tourist-osk')),
    keys: q('#tourist-osk .tourist-osk-key').filter(vis).length,
    from: document.getElementById('tourist-from').value,
    to: document.getElementById('tourist-to').value,
    go: { text: document.getElementById('btn-tourist-ride').textContent, disabled: document.getElementById('btn-tourist-ride').disabled },
    error: document.getElementById('tourist-error').textContent,
    focus: l._stepFocus && l._stepFocus.focused ? (l._stepFocus.focused.id || l._stepFocus.focused.dataset.place || l._stepFocus.focused.dataset.key || l._stepFocus.focused.className) : null,
    wide: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
});
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, name + '.png') }); };

// ── TP-01 / TP-02 / TP-06 · mouse and keyboard, a wide screen ──
console.log('TP-01 the places come first');
const page = await h.gamePage({ viewport: { width: 1600, height: 900 }, before,
  storage: { tandemonium_tutorial_done: 'smoke', tandemonium_tourist_route: JSON.stringify({ from: { lat: 39.9612, lon: -82.9988, label: 'Columbus, OH, USA' }, to: { lat: 39.7392, lon: -104.9903, label: 'Denver, CO, USA' }, at: 1 }) } });
await ready(page);
check(await openTourist(page), 'TP-01: the Tourist card is in the SOLO list');
await sleep(400);
let s = await screen(page);
check(s.step === 'lobby-tourist' && s.prompt === 'Tourist · Where will you ride?', 'TP-01: its screen asks where to ride', s.prompt);
check(s.scenic.length >= 10 && s.scenic.length <= 14 && !s.form, `TP-01: about a dozen scenic rides, and no form to fill (${s.scenic.length})`, s.scenic);
check(s.subs.every((t) => /·/.test(t)) && s.subs.some((t) => /km ride$/.test(t)) && s.subs.some((t) => /Open ride$/.test(t)), 'TP-01: each says where it is and what kind of ride', s.subs.slice(0, 3));
check(s.yours.length === 1 && /Columbus → Denver/.test(s.yours[0]) && !s.none, 'TP-06: the route the old screen remembered is the first of "your places"', s.yours);
check(/New places this week: 6 of 6 left/.test(s.quota) && /Scenic rides and places you have ridden before never count\./.test(s.quota), 'TP-02: the week\'s new places, and what never counts', s.quota);
check(s.fresh.vis && !s.fresh.disabled && s.fresh.text === '+ A NEW PLACE', 'TP-01: a new place is the third way in', s.fresh);
check(!s.wide, 'nothing wider than the screen');
await shot(page, 'places-desktop');

// ── TP-05 · typed places, with the geocoder replaced by a table ──
console.log('TP-05 new places count; known ones do not');
await page.evaluate(async () => {
  const C = await import('/js/tourist-config.js');
  window.__lookups = [];
  // the lobby calls these through its own imports, so stand in at the lobby's methods instead
  const l = window._game.lobby;
  const TABLE = { 'paris': { lat: 48.8566, lon: 2.3522, label: 'Paris, France' }, 'rome': { lat: 41.9028, lon: 12.4964, label: 'Rome, Italy' },
    'columbus, oh, usa': { lat: 39.9612, lon: -82.9988, label: 'Columbus, OH, USA' } };
  window.__geocodeStub = async (text) => { window.__lookups.push(text); const p = TABLE[String(text).trim().toLowerCase()]; if (!p) throw new Error(`could not find "${text}"`); return { ...p }; };
  l.onTouristReady = (opts) => { window.__started = opts.plan; };
  l._hideLobby = () => {};
});
// the lobby imported geocodeAddress / resolveOriginAt directly: reroute them through a test seam
const seam = await page.evaluate(() => typeof window._game.lobby._touristLookups === 'object');
check(seam, 'the lobby has a seam for the lookups (so this test never reaches Google)');
await page.evaluate(() => {
  const l = window._game.lobby;
  l._touristLookups.geocode = (t) => window.__geocodeStub(t);
  l._touristLookups.origin = async (pt) => { window.__lookups.push('height:' + pt.label); return { height: 400, anchored: true }; };
});
const type = async (id, text) => page.evaluate((id, text) => { const el = document.getElementById(id); el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); }, id, text);
await page.click('#btn-tourist-new');
await sleep(200);
s = await screen(page);
check(s.form && !s.osk && s.go.disabled, 'TP-05: the form opens; no on-screen keyboard without a controller', { form: s.form, osk: s.osk });
await type('tourist-from', 'Paris');
await page.click('#btn-tourist-ride');
await page.waitForFunction(() => !!window.__started, { timeout: 10000 }).catch(() => {});
let st = await page.evaluate(() => ({ started: window.__started && { explore: window.__started.explore, anchor: window.__started.anchor, kind: window.__started.kind, label: window.__started.from.label },
  lookups: window.__lookups.slice(), store: JSON.parse(localStorage.getItem('tandemonium_tourist_places') || '{}') }));
check(st.started && st.started.explore && st.started.label === 'Paris, France' && st.started.anchor && st.started.anchor.height === 400, 'TP-05: one address looked up, and ridden as an open ride with its height', st.started);
check(st.lookups.join('|') === 'Paris|height:Paris, France', 'TP-05: one geocode and one height lookup', st.lookups);
check(st.store.used === 1 && st.store.places[0].from.label === 'Paris, France' && st.store.places[0].height === 400, 'TP-05: it counts as one new place and is kept, with its height', { used: st.store.used, n: st.store.places.length });

// the same place again: free
await page.evaluate(() => { window.__started = null; window.__lookups.length = 0; window._game.lobby._openTouristStep(); });
await sleep(200);
s = await screen(page);
check(/5 of 6 left/.test(s.quota) && /^📍 Paris/.test(s.yours[0]), 'TP-05: 5 of 6 left, and Paris is now one of your places', { quota: s.quota, yours: s.yours });
await page.click('#btn-tourist-new');
await type('tourist-from', '  paris ');
await page.click('#btn-tourist-ride');
await page.waitForFunction(() => !!window.__started, { timeout: 10000 }).catch(() => {});
st = await page.evaluate(() => ({ ok: !!window.__started, lookups: window.__lookups.slice(), used: JSON.parse(localStorage.getItem('tandemonium_tourist_places')).used }));
check(st.ok && st.lookups.filter((x) => !x.startsWith('height:')).length === 0 && st.used === 1, 'TP-05: typing a place you already have looks nothing up and does not count', st);

// a route: one known end, one new
await page.evaluate(() => { window.__started = null; window.__lookups.length = 0; window._game.lobby._openTouristStep(); });
await page.click('#btn-tourist-new');
await type('tourist-from', 'Paris');
await page.click('#btn-tourist-add-to');
await type('tourist-to', 'Rome');
await page.click('#btn-tourist-ride');
await page.waitForFunction(() => /RIDE IT/.test(document.getElementById('btn-tourist-ride').textContent), { timeout: 10000 }).catch(() => {});
s = await screen(page);
st = await page.evaluate(() => ({ lookups: window.__lookups.slice(), used: JSON.parse(localStorage.getItem('tandemonium_tourist_places')).used, preview: document.getElementById('tourist-preview').textContent, started: !!window.__started }));
check(s.go.text === 'RIDE IT' && !st.started && /Paris, France/.test(st.preview) && /Rome, Italy/.test(st.preview) && /km of real streets/.test(st.preview) && /you ride the first and last 2\.5 km/.test(st.preview),
  'TP-05: a route shows its distance first (the reveal), and says the middle is skipped', st.preview);
check(st.lookups[0] === 'Rome' && st.used === 2, 'TP-05: only the new end was looked up: 2 used', st);
await page.click('#btn-tourist-ride');
await page.waitForFunction(() => !!window.__started, { timeout: 10000 }).catch(() => {});
st = await page.evaluate(() => ({ capped: window.__started && window.__started.route.capped, toAnchor: window.__started && window.__started.toAnchor }));
check(st.capped && st.toAnchor && st.toAnchor.height === 400, 'TP-05: a long ride carries the height of its last stretch, looked up once', st);

// a place nobody can find: said plainly, and it still counted nothing
await page.evaluate(() => { window.__started = null; window.__lookups.length = 0; window._game.lobby._openTouristStep(); });
await page.click('#btn-tourist-new');
await type('tourist-from', 'Xyzzyville');
await page.click('#btn-tourist-ride');
await page.waitForFunction(() => !!document.getElementById('tourist-error').textContent, { timeout: 10000 }).catch(() => {});
s = await screen(page);
st = await page.evaluate(() => JSON.parse(localStorage.getItem('tandemonium_tourist_places')).used);
check(/Could not find “Xyzzyville”\. Try a city, or a full address\./.test(s.error) && st === 2, 'TP-05: a place that can\'t be found is said plainly and does not count', { error: s.error, used: st });

// the week used up
await page.evaluate(async () => {
  const P = await import('/js/tourist-places.js');
  const l = window._game.lobby;
  l._touristStoreSave(P.countNewPlaces(l._touristStore, 6));
  l._openTouristStep();
});
await sleep(200);
s = await screen(page);
check(s.fresh.disabled && /NO NEW PLACES LEFT THIS WEEK/.test(s.fresh.text) && /You have looked up this week’s 6 new places/.test(s.quota) && /More (on \w+|tomorrow|today)\. Scenic rides and your own places are still open\./.test(s.quota),
  'TP-05: none left: the button says so, and when more come', { fresh: s.fresh, quota: s.quota });
check(s.scenic.length >= 10 && s.yours.length >= 2, 'TP-05: the scenic rides and your places are still there');
await shot(page, 'places-none-left');
await page.close();

// ── TP-03 / TP-04 · a controller ──
console.log('TP-03 a controller picks a scenic ride');
// (the pages share one browser profile: this player starts the week afresh)
const tv = await h.gamePage({ viewport: { width: 1920, height: 1080 }, before, storage: { tandemonium_tutorial_done: 'smoke', tandemonium_tourist_places: '{}', tandemonium_tourist_route: '' } });
await ready(tv);
const pads = fakePads(tv);
const pad = await pads.plug('xbox');
await sleep(600);
await tv.evaluate(() => { const l = window._game.lobby; l.onTouristReady = (opts) => { window.__started = opts.plan; }; l._hideLobby = () => {}; });
await openTourist(tv);
await sleep(500);
s = await screen(tv);
check(!!s.focus && s.scenic.length >= 10, 'TP-03: the controller starts on the first scenic ride', s.focus);
const firstId = s.focus;
await pads.press(pad, 'RIGHT');
await sleep(150);
const second = (await screen(tv)).focus;
await pads.press(pad, 'DOWN');
await sleep(150);
const below = (await screen(tv)).focus;
check(second && second !== firstId && below && below !== second, 'TP-03: left/right and up/down move across the grid', { firstId, second, below });
await shot(tv, 'places-tv');
// down to the bottom reaches "your places" / a new place
let reached = null;
for (let i = 0; i < 8 && reached !== 'btn-tourist-new'; i++) { await pads.press(pad, 'DOWN'); await sleep(120); reached = (await screen(tv)).focus; }
check(reached === 'btn-tourist-new', 'TP-03: down reaches + A NEW PLACE', reached);

console.log('TP-04 typing with a controller');
await pads.press(pad, 'A');
await sleep(400);
s = await screen(tv);
check(s.form && s.osk && s.keys >= 40, `TP-04: the address form shows an on-screen keyboard (${s.keys} keys)`, { form: s.form, osk: s.osk });
check(/^tourist-key-/.test(s.focus || ''), 'TP-04: the controller starts on a key', s.focus);
// type "R", "O", "M", "E" by moving to each key
const keyTo = async (ch) => {
  await tv.evaluate((ch) => { const l = window._game.lobby; const k = document.querySelector(`#tourist-osk .tourist-osk-key[data-key="${ch}"]`); l._stepFocus.setSpatial(l._stepNavItems(), k); }, ch);
  await pads.press(pad, 'A');
  await sleep(120);
};
for (const ch of 'ROME') await keyTo(ch);
s = await screen(tv);
check(s.from === 'Rome' && !s.go.disabled && s.go.text === 'EXPLORE HERE', 'TP-04: keys type into the field, in sentence case, and the button wakes up', { from: s.from, go: s.go });
await keyTo('Backspace');
s = await screen(tv);
check(s.from === 'Rom', 'TP-04: DELETE takes one off', s.from);
await shot(tv, 'form-tv');
// B goes back to the places, not out of the mode
await pads.press(pad, 'B');
await sleep(400);
s = await screen(tv);
check(!s.form && s.scenic.length >= 10 && s.step === 'lobby-tourist', 'TP-04: B goes back to the places', { form: s.form, step: s.step });

// pick a scenic ride with A
await tv.evaluate(() => { const l = window._game.lobby; l._stepFocus.setSpatial(l._stepNavItems(), document.querySelector('#tourist-scenic .tourist-place')); });
await pads.press(pad, 'A');
await tv.waitForFunction(() => !!window.__started, { timeout: 10000 }).catch(() => {});
st = await tv.evaluate(() => { const p = window.__started; return p && { kind: p.kind, title: p.title, anchor: p.anchor, headline: p.headline, hasTo: !!p.to }; });
check(st && st.kind === 'scenic' && st.anchor && st.anchor.anchored && Number.isFinite(st.anchor.height) && st.title, 'TP-03: A on a scenic ride starts it with its stored anchor', st);
await tv.close();

// ── a phone ──
console.log('a phone');
const phone = await h.gamePage({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }, before, storage: { tandemonium_tutorial_done: 'smoke', tandemonium_tourist_places: '{}', tandemonium_tourist_route: '' } });
await ready(phone);
await openTourist(phone);
await sleep(500);
s = await screen(phone);
check(s.scenic.length >= 10 && !s.wide, 'a phone shows the places without a sideways scroll', { n: s.scenic.length, wide: s.wide });
await shot(phone, 'places-phone');
await phone.close();

await h.finish();
