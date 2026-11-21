#!/usr/bin/env node
// smoke:tourist-note · the Tourist card reads "Tourist / ⚠️ Experimental", and pressing it shows the note first.
//   TN-01  the card's name and Experimental line, on a TV and on a phone
//   TN-02  a pad: HAVE FUN! has the first focus, the option is off; A opens the places
//   TN-03  a pad: B returns to the level list and the note comes back next press
//   TN-04  a pad: up reaches the option, A turns it on, HAVE FUN! goes on; the next press skips the note
import os from 'node:os';
import path from 'node:path';
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const h = await startHarness({ port: 8997 });
const { check } = h;
const SHOTS = process.env.TOURIST_NOTE_SHOTS || os.tmpdir();
const before = async (page) => {
  await installFakeGamepads(page, { atBoot: ['xbox'] });
  await page.evaluateOnNewDocument(() => { window.__TOURIST_MAPS_KEY__ = 'test-key-not-real'; });
};
const STORE = { tandemonium_tutorial_done: 'smoke', tandemonium_tourist_note_off: '' };
const ready = (p) => p.waitForFunction(() => window._game?.lobby?._presetKeys?.length > 1, { timeout: 60000 });
const toLevels = async (p) => {
  await p.evaluate(() => document.getElementById('btn-solo').click());
  await p.waitForFunction(() => { const c = document.querySelector('#level-cards .level-card[data-level-id="tourist"]'); return !!c && c.getBoundingClientRect().width > 0; }, { timeout: 20000 });
  await sleep(300);
};
const press = (p) => p.evaluate(() => document.querySelector('#level-cards .level-card[data-level-id="tourist"]').click());
const open = (p) => p.evaluate(() => document.getElementById('tourist-note-sheet').open);
const step = (p) => p.evaluate(() => document.getElementById('lobby-flow').current);
const focused = (p) => p.evaluate(() => window._game.lobby._stepFocus.focusedEl?.id || null);
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
const card = (p) => p.evaluate(() => {
  const c = document.querySelector('#level-cards .level-card[data-level-id="tourist"]');
  const x = c.querySelector('.level-card-experimental'), r = x.getBoundingClientRect(), b = c.getBoundingClientRect();
  return { name: c.querySelector('.level-card-name').textContent, tag: x.textContent, inside: r.width > 0 && r.right <= b.right + 1 && r.bottom <= b.bottom + 1 };
});

// phone
const phone = await h.gamePage({ viewport: { width: 844, height: 390 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
  before: (p) => p.evaluateOnNewDocument(() => { window.__TOURIST_MAPS_KEY__ = 'test-key-not-real'; }), storage: STORE });
await ready(phone);
await toLevels(phone);
const pc = await card(phone);
check(pc.name === 'Tourist' && /Experimental/.test(pc.tag) && pc.inside, 'TN-01: phone card reads Tourist / Experimental', pc);
await phone.screenshot({ path: path.join(SHOTS, 'tourist-card-phone.png') });
await press(phone);
await waitFor(() => open(phone));
await sleep(300);
await phone.screenshot({ path: path.join(SHOTS, 'tourist-note-phone.png') });
await phone.close();

// TV, by pad
const page = await h.gamePage({ viewport: { width: 1920, height: 1080 }, before, storage: STORE });
await ready(page);
const pads = fakePads(page);
await page.waitForFunction(() => window._game.lobby.input?.gamepadConnected, { timeout: 30000 });
await toLevels(page);
const tv = await card(page);
check(tv.name === 'Tourist' && /⚠️ Experimental/.test(tv.tag) && tv.inside, 'TN-01: TV card reads Tourist / ⚠️ Experimental', tv);
await page.screenshot({ path: path.join(SHOTS, 'tourist-card-tv.png') });

await press(page);
check(await waitFor(() => open(page)), 'TN-02: pressing the card shows the note');
await waitFor(async () => (await focused(page)) === 'tourist-note-fun');
check(await focused(page) === 'tourist-note-fun', 'TN-02: HAVE FUN! has the first focus', await focused(page));
check(await page.evaluate(() => !document.getElementById('tourist-note-never').checked), 'TN-02: the option is off by default');
await page.screenshot({ path: path.join(SHOTS, 'tourist-note-tv.png') });
await pads.press(0, 'B');
check(await waitFor(async () => !(await open(page))), 'TN-03: B closes it');
check(await step(page) === 'lobby-level' || (await step(page)) !== 'lobby-tourist', 'TN-03: B returns to the levels', await step(page));

await press(page);
await waitFor(() => open(page));
await waitFor(async () => (await focused(page)) === 'tourist-note-fun');
await pads.press(0, 'A');
check(await waitFor(async () => (await step(page)) === 'lobby-tourist'), 'TN-02: A on HAVE FUN! opens the places');
check(await page.evaluate(() => localStorage.getItem('tandemonium_tourist_note_off')) !== '1', 'TN-02: not opted out');

await page.evaluate(() => document.getElementById('btn-back-tourist').click());
await waitFor(async () => (await step(page)) !== 'lobby-tourist');
await sleep(400);
await press(page);
await waitFor(() => open(page));
await waitFor(async () => (await focused(page)) === 'tourist-note-fun');
await pads.press(0, 'UP');
await waitFor(async () => (await focused(page)) === 'tourist-note-never');
check(await focused(page) === 'tourist-note-never', 'TN-04: up reaches the option', await focused(page));
await pads.press(0, 'A');
await sleep(250);
check(await page.evaluate(() => document.getElementById('tourist-note-never').checked), 'TN-04: A turns it on');
await pads.press(0, 'DOWN');
await waitFor(async () => (await focused(page)) === 'tourist-note-fun');
await pads.press(0, 'A');
check(await waitFor(async () => (await step(page)) === 'lobby-tourist'), 'TN-04: HAVE FUN! goes on');
check(await page.evaluate(() => localStorage.getItem('tandemonium_tourist_note_off')) === '1', 'TN-04: the choice is saved');
await page.evaluate(() => document.getElementById('btn-back-tourist').click());
await waitFor(async () => (await step(page)) !== 'lobby-tourist');
await sleep(400);
await press(page);
check(await waitFor(async () => (await step(page)) === 'lobby-tourist') && !(await open(page)), 'TN-04: the next press skips the note');
await h.finish();
