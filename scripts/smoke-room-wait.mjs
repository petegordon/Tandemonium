#!/usr/bin/env node
// smoke:room-wait · #694 every waiting message says WHO, HOW LONG and WHAT YOU CAN DO; a way
// out shows after a sensible delay, stays once shown, and the pad's focus starts on the waiting
// choice. The room transport is stubbed (enterRoom / retry recorded, relay events fired by
// hand) and the wait's clock is skewed instead of waiting 30 s for real. F over the real relay
// is in smoke:online (OC-F); the in-race pause (G) in smoke:disconnect.
//
//   RW-A   captain alone in a new room: "You're the only one in room ABCD", then "Waiting 0:35…"
//   RW-B   joined a code, nobody there: "No one else is in room WXYZ yet · 0:00" at once; after
//          0:15 Keep waiting (focused) + Try another code; A on the pad keeps waiting; Try
//          another code goes back to an empty code entry and forgets the room
//   RW-C   rejoin, partner seen 3 min ago: "Pat (your Stoker) was here 3 min ago …"; after 0:30
//          Keep waiting / New Room / Back; New Room opens a REAL fresh room, same seat (host step)
//   RW-D   rejoin, partner gone 2 h: "Pat hasn't been in room ABCD for 2 h" + New Room at once
//   RW-E   the room server never lets us in: "Can't reach the room server. Retrying in 5…",
//          Retry dials again; no partner wording
//   RW-F   idle partner (stub): silent for an old build that never pings; "Your Captain (Pat)
//          hasn't moved for 0:30" in 5 s steps once it does; clears when they act; this side's
//          own pings are throttled and only follow input
//   RJM    rejoin as captain matches create: host code, "Scan to join" QR + room QR, the old
//          partner's edition cleared
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const h = await startHarness({ port: 8939, outDir: 'tandemonium-room-wait' });
const { check } = h;
const now = Date.now();

const page = await h.gamePage({
  viewport: { width: 1920, height: 1080 },
  storage: { tandemonium_tutorial_done: 'smoke' },
  before: (p) => installFakeGamepads(p, { atBoot: ['xbox'] }),
});
const pads = fakePads(page);
const until = async (fn, arg, timeout = 15000) => {
  try { const hnd = await page.waitForFunction(fn, { timeout, polling: 50 }, arg); return await hnd.jsonValue(); } catch { return null; }
};
const stepIs = (id) => until((want) => document.getElementById('lobby-flow').current === want, id);
await until(() => window._game && window._game.input && window._game.input.gamepadConnected);

// Stub the room transport (record enterRoom / retries; the test fires relay events) and give
// the wait a skewable clock.
await page.evaluate(() => {
  const l = window._game.lobby;
  window.__entered = []; window.__retried = 0; window.__skew = 0; window.__pings = 0;
  l.auth.getRelayToken = async () => null;
  const orig = l._replaceNet.bind(l);
  l._replaceNet = () => {
    const n = orig();
    l.net.enterRoom = (code, role) => { l.net.roomCode = code; l.net.role = role; window.__entered.push([code, role]); };
    l.net.acquireLocalMedia = async () => {};
    l.net.retryWithToken = () => { window.__retried++; };
    return n;
  };
  const clock = () => Date.now() + window.__skew;
  l._roomSession.wait.now = clock;
  l._partnerIdle.now = clock;
  l._activity.now = clock;
});
const skew = (ms) => page.evaluate((m) => { window.__skew += m; window._game.lobby._roomSession.wait.tick(); }, ms);
const status = (seat) => page.evaluate((s) => {
  const el = document.getElementById(s === 'host' ? 'host-status' : 'join-status');
  const row = document.getElementById(s === 'host' ? 'host-wait-actions' : 'join-wait-actions');
  const btns = row && !row.hidden ? Array.from(row.querySelectorAll('uf-button')) : [];
  const f = document.querySelector('.gamepad-focus');
  return { text: el.textContent, kind: el.dataset.wait || null, buttons: btns.map((b) => b.textContent), focus: f ? (f.dataset.wait || f.id || f.tagName) : null, step: document.getElementById('lobby-flow').current };
}, seat);
const fire = (what) => page.evaluate((w) => { const n = window._game.lobby.net; if (w === 'open') n.onRoomJoined(); else if (w === 'waiting') n.onRoomWaiting(); }, what);
const reset = async () => {
  await page.evaluate(() => { const l = window._game.lobby; l._roomSession.leave(); l._rejoining = false; window.__skew = 0; window.__entered = []; window.__retried = 0; l._showStep(l.modeStep); });
  await stepIs('lobby-mode');
};
const setRooms = (rooms) => page.evaluate((r) => localStorage.setItem('tandemonium-rooms', JSON.stringify(r)), rooms);

// ── RW-A ──
{
  await page.evaluate(() => document.getElementById('btn-together').click());
  await stepIs('lobby-role');
  await page.evaluate(() => document.getElementById('btn-captain').click());
  await stepIs('lobby-host');
  await page.evaluate(() => document.getElementById('btn-host-room-code').click());
  const entered = await until(() => window.__entered[0] || null);
  await fire('open');
  const code = entered && entered[0].slice(5);
  let s = await status('host');
  check(s.kind === 'A' && s.text.startsWith(`You're the only one in room ${code}.`) && s.buttons.length === 0, 'RW-A captain alone: "You\'re the only one in room CODE", no buttons', s);
  await skew(35000);
  s = await status('host');
  check(/Waiting 0:35…$/.test(s.text), 'RW-A after 0:30 it counts up ("Waiting 0:35…")', s.text);
  await h.shot(page, 'rw-a-host-alone');
  await reset();
}

// ── RW-B ──
{
  await page.evaluate(() => document.getElementById('btn-together').click());
  await stepIs('lobby-role');
  await page.evaluate(() => document.getElementById('btn-stoker').click());
  await stepIs('lobby-join');
  await page.evaluate(() => window._game.lobby._joinRoom('TNDM-WXYZ'));
  await until(() => window.__entered.length > 0);
  await fire('open');
  await fire('waiting');
  let s = await status('join');
  check(s.kind === 'B' && s.text === 'No one else is in room WXYZ yet · 0:00' && s.buttons.length === 0, 'RW-B joiner alone: "No one else is in room WXYZ yet · 0:00" at once, no way out yet', s);
  await skew(14000);
  s = await status('join');
  check(s.buttons.length === 0 && /· 0:10$/.test(s.text), 'RW-B still no way out at 0:14 (count-up in 5 s steps)', s);
  await skew(1000);
  s = await status('join');
  check(s.buttons.join('|') === 'Keep waiting|Try another code' && /0:15\. Check the code/.test(s.text), 'RW-B at 0:15: Keep waiting + Try another code', s);
  check(s.focus === 'keep', 'RW-B the pad starts on Keep waiting', s.focus);
  await h.shot(page, 'rw-b-join-empty');
  await pads.tap(0, 'A');
  s = await status('join');
  const stillIn = await page.evaluate(() => !!window._game.lobby.net);
  check(stillIn && s.kind === 'B' && s.buttons.length === 2, 'RW-B A on Keep waiting keeps waiting (the way out stays)', { stillIn, s });
  await page.evaluate(() => document.getElementById('btn-wait-join-other-code').click());
  await sleep(200);
  const after = await page.evaluate(() => ({
    step: document.getElementById('lobby-flow').current, net: !!window._game.lobby.net,
    rooms: JSON.parse(localStorage.getItem('tandemonium-rooms') || '[]').map((r) => r.roomCode),
    status: document.getElementById('join-status').textContent,
  }));
  check(after.step === 'lobby-join' && !after.net && !after.rooms.includes('TNDM-WXYZ') && after.status === '', 'RW-B Try another code: back to the code entry, room left and forgotten', after);
  await reset();
}

// ── RW-C ──
{
  await setRooms([{ roomCode: 'TNDM-ABCD', role: 'captain', timestamp: now, partnerName: 'Pat', partnerSeenAt: Date.now() - 3 * 60000 - 5000 }]);
  await page.evaluate(() => window._game.lobby._rejoinRoom(JSON.parse(localStorage.getItem('tandemonium-rooms'))[0]));
  await stepIs('lobby-host');
  await until(() => window.__entered.length > 0);
  await fire('open');
  let s = await status('host');
  check(s.kind === 'C' && /^Pat \(your Stoker\) was here 3 min ago\. Waiting for them to come back · 0:00$/.test(s.text) && s.buttons.length === 0, 'RW-C rejoin, seen 3 min ago: names them, says how long, no way out yet', s);
  await skew(30000);
  s = await status('host');
  check(s.buttons.join('|') === 'Keep waiting|New Room|Back' && s.focus === 'keep' && /· 0:30$/.test(s.text), 'RW-C after 0:30: Keep waiting (focused) / New Room / Back', s);
  await h.shot(page, 'rw-c-rejoin-recent');
  await page.evaluate(() => { window.__entered = []; document.getElementById('btn-wait-host-new-room').click(); });
  const fresh = await until(() => window.__entered[0] || null);
  await fire('open');
  const n = await page.evaluate(() => ({
    step: document.getElementById('lobby-flow').current, code: window._game.lobby._hostRoomCode,
    rooms: JSON.parse(localStorage.getItem('tandemonium-rooms') || '[]').map((r) => r.roomCode),
    status: document.getElementById('host-status').textContent,
  }));
  check(fresh && fresh[1] === 'captain' && fresh[0] !== 'TNDM-ABCD' && n.step === 'lobby-host' && n.code === fresh[0] && !n.rooms.includes('TNDM-ABCD') && /only one in room/.test(n.status),
    'RW-C New Room opens a REAL fresh room as captain on the host step (old room forgotten)', { fresh, n });
  await reset();
}

// ── RW-D ──
{
  await setRooms([{ roomCode: 'TNDM-ABCD', role: 'captain', timestamp: Date.now(), partnerName: 'Pat', partnerSeenAt: Date.now() - 2 * 3600000 - 60000 }]);
  await page.evaluate(() => window._game.lobby._rejoinRoom(JSON.parse(localStorage.getItem('tandemonium-rooms'))[0]));
  await stepIs('lobby-host');
  await until(() => window.__entered.length > 0);
  await fire('open');
  const s = await status('host');
  check(s.kind === 'D' && /^Pat hasn't been in room ABCD for 2 h\. Waiting 0:00$/.test(s.text) && s.buttons.join('|') === 'Keep waiting|New Room' && s.focus === 'keep',
    'RW-D rejoin, gone 2 h: says so, New Room offered at once, focus on Keep waiting', s);
  await h.shot(page, 'rw-d-rejoin-gone');
  await reset();
}

// ── RW-E ──
{
  await setRooms([{ roomCode: 'TNDM-ABCD', role: 'stoker', timestamp: Date.now(), partnerName: 'Pat', partnerSeenAt: Date.now() - 60000 }]);
  await page.evaluate(() => window._game.lobby._rejoinRoom(JSON.parse(localStorage.getItem('tandemonium-rooms'))[0]));
  await stepIs('lobby-join');
  await until(() => window.__entered.length > 0);
  await skew(5000);
  let s = await status('join');
  check(s.kind === 'E' && s.text === "Can't reach the room server. Retrying in 5…" && s.buttons.join('|') === 'Retry|Back' && !/Pat|partner|Captain/i.test(s.text),
    'RW-E the room server never opened: "Can\'t reach the room server. Retrying in 5…" + Retry / Back, no partner wording', s);
  await h.shot(page, 'rw-e-unreachable');
  await page.evaluate(() => document.getElementById('btn-wait-join-retry').click());
  const r1 = await page.evaluate(() => window.__retried);
  await skew(5000);
  const r2 = await page.evaluate(() => window.__retried);
  check(r1 === 1 && r2 === 2, 'RW-E Retry dials at once, and it retries on its own every 5 s', { r1, r2 });
  await fire('open');
  s = await status('join');
  check(s.kind === 'C', 'RW-E in the room: back to the partner wait (C)', s);
  await reset();
}

// ── RJM ──
{
  await setRooms([{ roomCode: 'TNDM-QRST', role: 'captain', timestamp: Date.now(), partnerName: null }]);
  await page.evaluate(() => { const l = window._game.lobby; l._partnerRoom = { demo: true, edition: 'demo' }; l._hostRoomCode = null; });
  await page.evaluate(() => window._game.lobby._rejoinRoom(JSON.parse(localStorage.getItem('tandemonium-rooms'))[0]));
  await stepIs('lobby-host');
  await until(() => window.__entered.length > 0);
  await fire('open');
  const m = await until(() => {
    const l = window._game.lobby;
    const qr = document.getElementById('host-join-qr');
    const out = { code: l._hostRoomCode, display: document.getElementById('room-code-display').textContent, roomQr: document.getElementById('room-qr').innerHTML.length > 0,
      caption: qr && qr.caption, qrValue: !!(qr && qr.value), partnerRoom: l._partnerRoom, wait: document.getElementById('host-status').dataset.wait };
    return out.code === 'TNDM-QRST' ? out : null;
  }, null, 8000);
  check(m && m.display === 'TNDM-QRST' && m.roomQr && /type this code/.test(m.caption || '') && m.partnerRoom === null,
    'RJM rejoin as captain matches create: host code set, "Scan to join" offers the code, room QR drawn, old partner edition cleared', m);
  check(m && m.wait === 'D', 'RJM a room nobody ever joined says so ("No one else has been in room …")', m && m.wait);
  await h.shot(page, 'rjm-rejoin-captain');
  await reset();
}

// ── RW-F (stub partner) ──
{
  const enter = await page.evaluate(() => {
    const l = window._game.lobby;
    l._replaceNet();
    const n = l.net;
    n.connected = true; n.roomCode = 'TNDM-IDLE';
    n.sendProfile = (p) => { if (p && p.type === 'activity') window.__pings++; };
    l._roomPartnerName = 'Pat';
    l._showRoomStep('stoker');   // the stoker waits on the room's level screen
    return document.getElementById('lobby-flow').current;
  });
  await stepIs('lobby-level');
  const note = () => page.evaluate(() => { const e = document.getElementById('room-idle-note'); return e && !e.hidden ? e.textContent : ''; });
  // An old build never pings: no "hasn't moved", however long.
  await page.evaluate(() => { window.__skew += 120000; });
  await sleep(700);
  check((await note()) === '', 'RW-F an old build (no activity pings) never shows "hasn\'t moved"', { enter, note: await note() });
  await page.evaluate(() => window._game.lobby._handleRoomMessage({ type: 'activity' }));
  await page.evaluate(() => { window.__skew += 30000; });
  const t30 = await until(() => { const e = document.getElementById('room-idle-note'); return e && !e.hidden && e.textContent; });
  check(t30 === "Your Captain (Pat) hasn't moved for 0:30", 'RW-F 0:30 without a move: "Your Captain (Pat) hasn\'t moved for 0:30"', t30);
  await h.shot(page, 'rw-f-idle');
  await page.evaluate(() => { window.__skew += 5000; });
  const t35 = await until(() => /0:35$/.test(document.getElementById('room-idle-note').textContent) && document.getElementById('room-idle-note').textContent);
  check(!!t35, 'RW-F it counts up in 5 s steps (0:35)', t35);
  await page.evaluate(() => window._game.lobby._handleRoomMessage({ type: 'activity' }));
  check((await note()) === '', 'RW-F the partner acts: the line clears at once');
  // This side's pings: one soon after a key press, none without input.
  const p0 = await page.evaluate(() => { window.__pings = 0; window._game.lobby._activity.lastSent = -Infinity; return 0; });
  await page.keyboard.press('Shift');
  const p1 = await until(() => window.__pings >= 1 && window.__pings, null, 3000);
  await page.evaluate(() => { window.__skew += 60000; });
  await sleep(1200);
  const p2 = await page.evaluate(() => window.__pings);
  check(p0 === 0 && p1 === 1 && p2 === 1, 'RW-F a key press sends one activity ping; no input, no more pings', { p1, p2 });
  await page.evaluate(() => { const l = window._game.lobby; l.net.connected = false; l._roomSession.leave(); });
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
