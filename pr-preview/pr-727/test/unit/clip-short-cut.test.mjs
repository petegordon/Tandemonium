// #408 · the short share cut (js/game-recorder.js cutShortWindow): the last
// SHORT_CLIP_SECONDS of the WebCodecs chunk buffer, opening on a keyframe and
// never longer than the asked-for seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// game-recorder.js touches navigator/window at import time (iOS sniff, debug
// flag); give it just enough of a browser to load under node.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node', platform: 'node', maxTouchPoints: 0 }, configurable: true,
});
globalThis.window ??= { location: { search: '' }, addEventListener() {} };
globalThis.document ??= { getElementById: () => null, createElement: () => ({ getContext: () => null, style: {} }) };
globalThis.Image ??= class { };

const { cutShortWindow, CLIP_SECONDS, SHORT_CLIP_SECONDS } = await import('../../js/game-recorder.js');

const FPS = 20;
const FRAME_US = 1_000_000 / FPS;

/** A buffer like the recorder's: `seconds` of chunks, a keyframe every `gop` s, from t0 (s). */
function buffer(seconds, { gop = 2, t0 = 0 } = {}) {
  const out = [];
  const n = Math.round(seconds * FPS);
  for (let i = 0; i < n; i++) {
    out.push({
      type: i % (gop * FPS) === 0 ? 'key' : 'delta',
      timestamp: Math.round((t0 * FPS + i) * FRAME_US),
      duration: FRAME_US,
    });
  }
  return out;
}
const spanSeconds = (chunks) => {
  const a = chunks[0], z = chunks[chunks.length - 1];
  return (z.timestamp + z.duration - a.timestamp) / 1_000_000;
};

test('the constants: a 20 s buffer and a 10 s cut, short enough for messages', () => {
  assert.equal(CLIP_SECONDS, 20);
  assert.equal(SHORT_CLIP_SECONDS, 10);
  assert.ok(SHORT_CLIP_SECONDS < 12);
});

test('the cut starts on a keyframe and spans at most 10 s', () => {
  const full = buffer(CLIP_SECONDS);
  const cut = cutShortWindow(full, SHORT_CLIP_SECONDS, FPS);
  assert.equal(cut[0].type, 'key');
  assert.ok(spanSeconds(cut) <= SHORT_CLIP_SECONDS, `spans ${spanSeconds(cut)} s`);
  // Keyframes land on the cut point exactly here: the whole 10 s.
  assert.equal(spanSeconds(cut), SHORT_CLIP_SECONDS);
  // It is the tail of the buffer, the very same records.
  assert.equal(cut[cut.length - 1], full[full.length - 1]);
  assert.equal(cut.length, SHORT_CLIP_SECONDS * FPS);
});

test('a cut point between keyframes moves forward to the next one, never back', () => {
  // Buffer starts half a second into a GOP, so (end - 10 s) is 0.5 s after a keyframe.
  const full = buffer(19.5, { t0: 0.5 }).map((c, i) => ({ ...c, type: i % (2 * FPS) === 0 ? 'key' : 'delta' }));
  const cut = cutShortWindow(full, SHORT_CLIP_SECONDS, FPS);
  assert.equal(cut[0].type, 'key');
  const span = spanSeconds(cut);
  assert.ok(span <= SHORT_CLIP_SECONDS, `spans ${span} s`);
  assert.ok(span >= SHORT_CLIP_SECONDS - 2, `spans ${span} s, more than one GOP short`);
  assert.equal(cut[cut.length - 1], full[full.length - 1]);
});

test('every chunk after the opening keyframe is kept in order', () => {
  const full = buffer(CLIP_SECONDS);
  const cut = cutShortWindow(full, SHORT_CLIP_SECONDS, FPS);
  const start = full.indexOf(cut[0]);
  assert.deepEqual(cut, full.slice(start));
  for (let i = 1; i < cut.length; i++) assert.ok(cut[i].timestamp > cut[i - 1].timestamp);
});

test('a buffer shorter than the cut is returned whole, from its first keyframe', () => {
  const short = buffer(6);
  const cut = cutShortWindow(short, SHORT_CLIP_SECONDS, FPS);
  assert.equal(cut.length, short.length);
  assert.equal(cut[0].type, 'key');
  // ...and a buffer whose first chunks are deltas (pruned mid-GOP) drops them.
  const pruned = short.slice(5);
  const cut2 = cutShortWindow(pruned, SHORT_CLIP_SECONDS, FPS);
  assert.equal(cut2[0].type, 'key');
  assert.equal(cut2.length, pruned.length - (2 * FPS - 5));
});

test('no keyframe inside the window: falls back to the latest one before it', () => {
  // One keyframe at the start, then 15 s of deltas (a GOP longer than the cut).
  const full = buffer(15, { gop: 30 });
  const cut = cutShortWindow(full, SHORT_CLIP_SECONDS, FPS);
  assert.equal(cut[0], full[0]);
  assert.equal(cut.length, full.length);
});

test('nothing to cut: no chunks, or no keyframe at all', () => {
  assert.deepEqual(cutShortWindow([], SHORT_CLIP_SECONDS, FPS), []);
  assert.deepEqual(cutShortWindow(null, SHORT_CLIP_SECONDS, FPS), []);
  const deltas = buffer(5).map((c) => ({ ...c, type: 'delta' }));
  assert.deepEqual(cutShortWindow(deltas, SHORT_CLIP_SECONDS, FPS), []);
});

test('chunks without a duration use the frame interval for the end time', () => {
  const full = buffer(CLIP_SECONDS).map((c) => ({ type: c.type, timestamp: c.timestamp }));
  const cut = cutShortWindow(full, SHORT_CLIP_SECONDS, FPS);
  assert.equal(cut[0].type, 'key');
  assert.equal(cut.length, SHORT_CLIP_SECONDS * FPS);
});
