#!/usr/bin/env node
// smoke:lobby-layout · every lobby step, and the disconnect pause, at phone,
// landscape phone, 1080p and 4K (#472).
//
//   BL-10  each lobby step: every visible control can be reached (it, or the
//          scrolling box it lives in, is on screen) and no two controls'
//          visible parts overlap.
//   LY-02  the disconnect overlay in each of its button sets (Resume / Ride
//          on alone / Try Again / Return to Lobby): on screen, inside its box,
//          no overlaps, and lined up (a row shares its top and height; a
//          column shares its centre).
import { startHarness, sleep, clickId } from './lib/smoke-harness.mjs';

const h = await startHarness({ port: 8985, outDir: 'tandemonium-lobby-layout' });
const { check } = h;

const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const SIZES = [
  { name: 'phone 390x844', viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }, ua: PHONE_UA },
  { name: 'landscape phone 844x390', viewport: { width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true }, ua: PHONE_UA },
  { name: '1080p', viewport: { width: 1920, height: 1080 } },
  { name: '4K', viewport: { width: 3840, height: 2160 } },
];

/** Measure the controls inside `rootSel`: reachability and overlaps. Runs in the page. */
const MEASURE = (rootSel) => {
  const root = document.querySelector(rootSel);
  const vw = window.innerWidth, vh = window.innerHeight;
  const SEL = 'button, uf-button, input, select, a[href], [role="button"], .level-card, .difficulty-btn';
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let a = e; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    return true;
  };
  // The nearest box that scrolls this element. A fixed element below that box
  // (it, or an ancestor before the box) doesn't move when the box scrolls.
  const scrolls = (a) => {
    const cs = getComputedStyle(a);
    return ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && a.scrollHeight > a.clientHeight + 1) ||
           ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && a.scrollWidth > a.clientWidth + 1);
  };
  const scrollerOf = (e) => {
    if (getComputedStyle(e).position === 'fixed') return null;
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      if (scrolls(a)) return a;
      if (getComputedStyle(a).position === 'fixed') return null;
    }
    return null;
  };
  const clip = (r, c) => ({ left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) });
  const label = (e) => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(/\s+/)[0] : '')) +
    ' "' + (e.textContent || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 18) + '"';
  const all = root ? Array.from(root.querySelectorAll(SEL)).filter(visible) : [];
  // Outermost controls only: a button inside a card is part of the card.
  const ctrls = all.filter((e) => !all.some((o) => o !== e && o.contains(e)));
  const offscreen = [], overlaps = [];
  const items = ctrls.map((e) => {
    const r = e.getBoundingClientRect();
    const s = scrollerOf(e);
    // Reachable by scrolling only along the axis the box actually scrolls.
    let reach = r;
    if (s) {
      const sr = s.getBoundingClientRect(), cs = getComputedStyle(s);
      const sx = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && s.scrollWidth > s.clientWidth + 1;
      const sy = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && s.scrollHeight > s.clientHeight + 1;
      reach = { left: sx ? sr.left : r.left, right: sx ? sr.right : r.right, top: sy ? sr.top : r.top, bottom: sy ? sr.bottom : r.bottom };
    }
    if (reach.left < -1 || reach.top < -1 || reach.right > vw + 1 || reach.bottom > vh + 1) offscreen.push(label(e) + ' ' + JSON.stringify({ l: Math.round(reach.left), t: Math.round(reach.top), r: Math.round(reach.right), b: Math.round(reach.bottom) }));
    const seen = s ? clip(r, s.getBoundingClientRect()) : r;
    return { e, seen };
  });
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i].seen, b = items[j].seen;
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), hh = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w > 2 && hh > 2) overlaps.push(label(items[i].e) + ' × ' + label(items[j].e) + ` (${Math.round(w)}×${Math.round(hh)})`);
  }
  return { count: ctrls.length, offscreen, overlaps };
};

/** The drop overlay's visible buttons: on screen, in the box, no overlaps, lined up. Runs in the page. */
const MEASURE_DROP = () => {
  const vw = window.innerWidth, vh = window.innerHeight;
  // The kit sheet's card (#459: the overlay is on the result-screen shell).
  const box = document.querySelector('#disconnect-overlay .uf-sheet__card').getBoundingClientRect();
  const btns = ['btn-drop-resume', 'btn-ride-alone', 'btn-try-reconnect', 'btn-return-lobby']
    .map((id) => document.getElementById(id)).filter((b) => b && !b.hidden && b.getBoundingClientRect().width > 0)
    .map((b) => { const r = b.getBoundingClientRect(); return { id: b.id, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: (r.left + r.right) / 2 }; });
  const problems = [];
  for (const b of btns) {
    if (b.l < -1 || b.t < -1 || b.r > vw + 1 || b.b > vh + 1) problems.push(b.id + ' off screen');
    if (b.l < box.left - 1 || b.r > box.right + 1 || b.t < box.top - 1 || b.b > box.bottom + 1) problems.push(b.id + ' outside its box');
  }
  for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) {
    const a = btns[i], c = btns[j];
    const w = Math.min(a.r, c.r) - Math.max(a.l, c.l), hh = Math.min(a.b, c.b) - Math.max(a.t, c.t);
    if (w > 1 && hh > 1) problems.push(`${a.id} overlaps ${c.id}`);
    // Same row (vertical ranges overlap): same top and height.
    if (hh > 0 && (Math.abs(a.t - c.t) > 1.5 || Math.abs(a.h - c.h) > 1.5)) problems.push(`${a.id} / ${c.id} share a row but not a line (tops ${a.t.toFixed(1)} / ${c.t.toFixed(1)}, heights ${a.h.toFixed(1)} / ${c.h.toFixed(1)})`);
  }
  // Rows (buttons wrap on a narrow screen): each row is centred in the box.
  const rows = [];
  for (const b of [...btns].sort((x, y) => x.t - y.t)) {
    const row = rows.find((r) => r.some((o) => Math.min(o.b, b.b) - Math.max(o.t, b.t) > 0));
    if (row) row.push(b); else rows.push([b]);
  }
  const boxCx = (box.left + box.right) / 2;
  for (const r of rows) {
    const cx = (Math.min(...r.map((b) => b.l)) + Math.max(...r.map((b) => b.r))) / 2;
    if (Math.abs(cx - boxCx) > 2) problems.push(`row [${r.map((b) => b.id).join(', ')}] not centred in the box (${cx.toFixed(1)} vs ${boxCx.toFixed(1)})`);
  }
  return { buttons: btns.map((b) => b.id), rows: rows.length, problems };
};

/** Click `id` until the lobby moves to `want` (a click during a step change can be dropped). */
async function clickTo(p, id, want, tries = 4) {
  for (let i = 0; i < tries; i++) {
    if (!(await clickId(p, id))) return false;
    const ok = await p.waitForFunction((w) => document.getElementById('lobby-flow').current === w, { timeout: 5000 }, want).then(() => true).catch(() => false);
    if (ok) return true;
  }
  return false;
}

const STEPS = [
  { name: 'mode', go: async () => {} },
  { name: 'level', go: (p) => clickTo(p, 'btn-solo', 'lobby-level') },
  { name: 'role', go: (p) => clickTo(p, 'btn-together', 'lobby-role') },
  // Phones have no split screen: no VERSUS button there.
  { name: 'versus', go: async (p) => { await clickTo(p, 'btn-together', 'lobby-role');
    const shown = await p.evaluate(() => { const b = document.getElementById('btn-versus'); return !!b && b.getBoundingClientRect().width > 0 && getComputedStyle(b).display !== 'none'; });
    if (!shown) return false; return clickTo(p, 'btn-versus', 'lobby-versus'); }, optional: true },
  { name: 'host', go: async (p) => { await clickTo(p, 'btn-together', 'lobby-role'); await clickTo(p, 'btn-captain', 'lobby-host'); } },
  { name: 'join', go: async (p) => { await clickTo(p, 'btn-together', 'lobby-role'); await clickTo(p, 'btn-stoker', 'lobby-join'); } },
  { name: 'tourist', go: async (p) => { await clickTo(p, 'btn-solo', 'lobby-level'); await p.evaluate(() => { const l = window._game.lobby; l._showStep(l.touristStep); }); } },
];

const DROPS = [
  { name: 'solo pad (Resume, Return)', mode: 'solo', who: 'p1', ready: false, want: ['btn-drop-resume', 'btn-return-lobby'] },
  { name: 'local P2 after 20 s (Ride on alone, Return)', mode: 'local', who: 'p2', ready: true, want: ['btn-ride-alone', 'btn-return-lobby'] },
  { name: 'local P1 after 20 s (Resume, Take over, Return)', mode: 'local', who: 'p1', ready: true, want: ['btn-drop-resume', 'btn-ride-alone', 'btn-return-lobby'] },
  { name: 'online, connection gone (Ride on alone, Try Again, Return)', mode: 'captain', who: 'partner', ready: true, net: true, want: ['btn-ride-alone', 'btn-try-reconnect', 'btn-return-lobby'] },
];

for (const size of SIZES) {
  console.log(size.name);
  const page = await h.gamePage({ viewport: size.viewport, userAgent: size.ua || null, storage: { tandemonium_tutorial_done: 'smoke' } });
  await page.waitForFunction(() => document.getElementById('lobby-flow')?.current === 'lobby-mode', { timeout: 60000 }).catch(() => {});

  // The measure itself: a planted overlap and an off-screen button are caught.
  if (size === SIZES[0]) {
    const probe = await page.evaluate((MEASURE_SRC) => {
      const lobby = document.getElementById('lobby');
      const mk = (id, css) => { const b = document.createElement('button'); b.id = id; b.textContent = id; b.style.cssText = 'position:fixed;z-index:9999;width:80px;height:30px;' + css; lobby.appendChild(b); return b; };
      const a = mk('probe-a', 'left:40px;top:300px;'), b = mk('probe-b', 'left:70px;top:310px;'), c = mk('probe-c', 'left:-500px;top:300px;');
      const m = (0, eval)('(' + MEASURE_SRC + ')')('#lobby');
      a.remove(); b.remove(); c.remove();
      return { overlap: m.overlaps.some((o) => o.includes('probe-a') && o.includes('probe-b')), off: m.offscreen.some((o) => o.includes('probe-c')) };
    }, MEASURE.toString());
    check(probe.overlap && probe.off, 'BL-10 the measure catches a planted overlap and an off-screen control', probe);
  }

  // ── BL-10 ──
  for (const st of STEPS) {
    // A host step visit saves a recent room; with one saved, TOGETHER asks
    // "rejoin?" instead of opening the role step (by design). Start each step clean.
    await page.evaluate(() => { try { localStorage.removeItem('tandemonium-rooms'); localStorage.removeItem('tandemonium-room'); } catch {} const l = window._game.lobby; l._showStep(l.modeStep); });
    await page.waitForFunction(() => document.getElementById('lobby-flow').current === 'lobby-mode', { timeout: 10000 }).catch(() => {});
    await sleep(500);   // let the step change settle before the next click
    const went = await st.go(page);
    const id = 'lobby-' + st.name;
    const reached = await page.waitForFunction((want) => document.getElementById('lobby-flow').current === want, { timeout: 15000 }, id).then(() => true).catch(() => false);
    if (!reached) {
      if (st.optional && went === false) { console.log(`  (no ${st.name} step on ${size.name})`); continue; }
      check(false, `BL-10 ${size.name} ${st.name}: step reached`, await page.evaluate(() => document.getElementById('lobby-flow').current));
      continue;
    }
    await sleep(600);   // the step's own layout settles (carousel, fonts)
    const m = await page.evaluate(MEASURE, '#lobby');
    check(m.count > 0 && m.offscreen.length === 0, `BL-10 ${size.name} ${st.name}: all ${m.count} controls reachable`, m.offscreen.length ? m.offscreen : undefined);
    check(m.overlaps.length === 0, `BL-10 ${size.name} ${st.name}: no controls overlap`, m.overlaps.length ? m.overlaps : undefined);
    if (m.offscreen.length || m.overlaps.length) await h.shot(page, `bl10-${size.name.replace(/\W+/g, '-')}-${st.name}`);
  }
  await page.evaluate(() => { const l = window._game.lobby; l._showStep(l.modeStep); });

  // ── LY-02 ──
  for (const d of DROPS) {
    const res = await page.evaluate((d, MEASURE_DROP_SRC) => {
      const g = window._game;
      const saved = { mode: g.mode, net: g.net, netLost: g._netLost };
      g.mode = d.mode;
      if (d.net) { g.net = { connected: false, transport: 'relay', roomCode: 'TNDM-TEST', sendState() {}, sendEvent() {}, retryConnection() {}, destroy() {} }; g._netLost = true; }
      g._startDropPause(d.who);
      g._drop.takeoverReady = d.ready;
      g._renderDropOverlay();
      const out = (0, eval)('(' + MEASURE_DROP_SRC + ')')();
      window.__restoreDrop = () => { g._endDropPause(); g.mode = saved.mode; g.net = saved.net; g._netLost = saved.netLost; };
      return out;
    }, d, MEASURE_DROP.toString());
    check(JSON.stringify(res.buttons) === JSON.stringify(d.want), `LY-02 ${size.name} ${d.name}: the right buttons`, res.buttons);
    check(res.problems.length === 0, `LY-02 ${size.name} ${d.name}: on screen, in the box, no overlaps, lined up`, res.problems.length ? res.problems : undefined);
    if (res.problems.length) await h.shot(page, `ly02-${size.name.replace(/\W+/g, '-')}-${d.who}`);
    await page.evaluate(() => window.__restoreDrop());
  }
  await page.close();
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
