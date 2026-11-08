// #567: the music falls back to the AudioContext when the browser refuses <audio>.play().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MusicTrack } from '../../js/music-track.js';

const refusal = () => Object.assign(new Error('play() can only be initiated by a user gesture'), { name: 'NotAllowedError' });

function fakeElement({ allow = true } = {}) {
  const el = {
    loop: false, volume: 1, currentTime: 0, paused: true, allow, plays: 0,
    play() { el.plays++; if (!el.allow) return Promise.reject(refusal()); el.paused = false; return Promise.resolve(); },
    pause() { el.paused = true; },
    addEventListener() {},
  };
  return el;
}

function fakeCtx({ state = 'running', resumes = true } = {}) {
  const ctx = {
    state, currentTime: 10, sources: [], gains: [],
    resume() { if (resumes) ctx.state = 'running'; return resumes ? Promise.resolve() : new Promise(() => {}); },
    createGain() { const g = { gain: { value: 1 }, connect(to) { g.to = to; return to; } }; ctx.gains.push(g); return g; },
    createBufferSource() {
      const s = { started: null, stopped: false, connect(to) { s.to = to; }, disconnect() {}, start(when, off) { s.started = off; }, stop() { s.stopped = true; } };
      ctx.sources.push(s); return s;
    },
    decodeAudioData(data) { ctx.decoded = (ctx.decoded || 0) + 1; return Promise.resolve({ duration: 95, data }); },
  };
  return ctx;
}

function engineWith(ctx, { lazy = false } = {}) {
  const eng = { ctx: lazy ? null : ctx, musicBus: lazy ? null : { name: 'musicBus' } };
  eng.ensureContext = () => { eng.ctx = ctx; eng.musicBus = eng.musicBus || { name: 'musicBus' }; return ctx; };
  return eng;
}

const track = (el, eng, o = {}) => new MusicTrack('music.mp3', eng, { makeElement: () => el, load: async () => new ArrayBuffer(8), ...o });

test('the element plays when the browser lets it (no decode, no AudioContext)', async () => {
  const el = fakeElement(), ctx = fakeCtx(), t = track(el, engineWith(ctx, { lazy: true }));
  await t.play();
  assert.equal(t.mode, 'element');
  assert.equal(t.playing, true);
  assert.equal(t.blocked, null);
  assert.equal(ctx.decoded, undefined);
  t.pause();
  assert.equal(el.paused, true);
  assert.equal(t.playing, false);
});

test('refused element + a running AudioContext: the decoded track plays on the music bus (the TV)', async () => {
  const el = fakeElement({ allow: false }), ctx = fakeCtx(), eng = engineWith(ctx);
  const t = track(el, eng);
  t.loop = true; t.volume = 0.3;
  let states = 0; t.onstate = () => states++;
  await t.play();
  assert.equal(t.mode, 'webaudio');
  assert.equal(t.blocked, null);
  const s = ctx.sources[0];
  assert.equal(s.started, 0);
  assert.equal(s.buffer.duration, 95);
  assert.equal(s.loop, true);
  assert.equal(ctx.gains[0].gain.value, 0.3);
  assert.equal(ctx.gains[0].to, eng.musicBus, 'on the music bus (ducking, clip capture)');
  assert.ok(states >= 1);
  t.volume = 0.5;
  assert.equal(ctx.gains[0].gain.value, 0.5);
  // pause, then resume where it left off
  ctx.currentTime = 22;   // 12 s in
  t.pause();
  assert.equal(s.stopped, true);
  assert.equal(t.playing, false);
  await t.play();
  assert.equal(ctx.sources[1].started, 12);
  assert.equal(ctx.decoded, 1, 'decoded once');
  // back to the start (the lobby's currentTime = 0)
  t.currentTime = 0;
  assert.equal(ctx.sources[2].started, 0);
});

test('a TV may make the AudioContext itself; elsewhere the fallback waits for the gesture-made one', async () => {
  const ctx = fakeCtx();
  const tv = track(fakeElement({ allow: false }), engineWith(ctx, { lazy: true }), { makeContext: true });
  await tv.play();
  assert.equal(tv.mode, 'webaudio');

  const ctx2 = fakeCtx(), eng2 = engineWith(ctx2, { lazy: true });
  const desk = track(fakeElement({ allow: false }), eng2);
  await assert.rejects(desk.play(), { name: 'NotAllowedError' });
  assert.equal(eng2.ctx, null, 'no AudioContext made before a gesture');
  assert.equal(desk.blocked, 'NotAllowedError');
});

test('nothing may play yet: play() rejects and `blocked` says why; the next try (a real key) plays', async () => {
  const el = fakeElement({ allow: false }), ctx = fakeCtx({ state: 'suspended', resumes: false });
  const t = track(el, engineWith(ctx));
  await assert.rejects(t.play(), { name: 'NotAllowedError' });
  assert.equal(t.playing, false);
  assert.equal(t.blocked, 'NotAllowedError');
  el.allow = true;   // a keydown: user activation
  await t.play();
  assert.equal(t.mode, 'element');
  assert.equal(t.blocked, null);
});

test('paused while play() is pending: nothing starts, no rejection', async () => {
  let release;
  const el = fakeElement();
  el.play = () => new Promise((r) => { release = r; });
  const t = track(el, engineWith(fakeCtx()));
  const p = t.play();
  t.pause();
  release();
  await p;
  assert.equal(t.playing, false);
  assert.equal(el.paused, true);
});

test('a play() while one is pending shares it', async () => {
  const el = fakeElement({ allow: false }), ctx = fakeCtx();
  const t = track(el, engineWith(ctx));
  await Promise.all([t.play(), t.play()]);
  assert.equal(el.plays, 1);
  assert.equal(ctx.sources.length, 1);
});
