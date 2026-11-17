// ============================================================
// CLIP → GIF for the House Tandem Discord's #daily-ride-clips
// ============================================================
//
// Discord plays a GIF by itself in the channel; a video waits for a tap.
// The GIF is the last GIF_SECONDS of the saved clip, read back frame by frame
// from the clip itself (MP4 on iOS, WebM elsewhere: the same path for both),
// drawn small, and encoded with gifenc. If it comes out over the upload
// limit, the next, smaller step of GIF_STEPS is tried.

export const GIF_SECONDS = 8;
/** Under the Worker's CLIP_GIF_MAX_BYTES (9.5 MB), which is under Discord's 10 MB. */
export const GIF_MAX_BYTES = 9_000_000;
/** Long side in px, frames a second, seconds: biggest first. */
export const GIF_STEPS = [
  { long: 480, fps: 12, seconds: GIF_SECONDS },
  { long: 400, fps: 10, seconds: GIF_SECONDS },
  { long: 320, fps: 10, seconds: GIF_SECONDS },
  { long: 320, fps: 8, seconds: 6 },
];

/** The GIF's size for a clip of w × h: the long side at `long`, even numbers. */
export function gifSize(w, h, long) {
  const s = Math.min(1, long / Math.max(w, h));
  return { w: Math.max(2, Math.round(w * s / 2) * 2), h: Math.max(2, Math.round(h * s / 2) * 2) };
}

/** The frame times (s) for the last `seconds` of a clip `duration` s long. */
export function frameTimes(duration, seconds, fps) {
  const start = Math.max(0, duration - seconds);
  const n = Math.max(1, Math.floor((duration - start) * fps));
  const out = [];
  for (let i = 0; i < n; i++) out.push(+(start + i / fps).toFixed(4));
  return out;
}

let _gifenc = null;
async function loadGifenc() {
  if (!_gifenc) _gifenc = import('gifenc').catch(() => import('https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js'));
  return _gifenc;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function once(el, ev, ms = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { el.removeEventListener(ev, on); reject(new Error(ev + ' timed out')); }, ms);
    function on() { clearTimeout(t); el.removeEventListener(ev, on); resolve(); }
    el.addEventListener(ev, on);
  });
}

/** A hidden video on the clip, metadata loaded, with a finite duration. */
async function openClip(url) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';
  v.src = url;
  await once(v, 'loadedmetadata', 8000);
  if (!Number.isFinite(v.duration)) {
    // MediaRecorder WebM carries no duration: seeking past the end finds it.
    v.currentTime = 1e7;
    await once(v, 'durationchange', 8000).catch(() => {});
    v.currentTime = 0;
    await once(v, 'seeked').catch(() => {});
  }
  if (!Number.isFinite(v.duration) || v.duration <= 0) throw new Error('clip has no duration');
  return v;
}

async function encodeStep(video, step, onProgress) {
  const { GIFEncoder, quantize, applyPalette } = await loadGifenc();
  const { w, h } = gifSize(video.videoWidth, video.videoHeight, step.long);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const gif = GIFEncoder();
  const times = frameTimes(video.duration, step.seconds, step.fps);
  const delay = Math.round(1000 / step.fps);
  for (let i = 0; i < times.length; i++) {
    video.currentTime = times[i];
    await once(video, 'seeked');
    ctx.drawImage(video, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const palette = quantize(data, 256, { format: 'rgb444' });
    const index = applyPalette(data, palette, 'rgb444');
    gif.writeFrame(index, w, h, { palette, delay });
    if (onProgress) onProgress((i + 1) / times.length);
    await tick();   // keep the button's words moving
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

/**
 * The clip at `url` as a GIF under GIF_MAX_BYTES. Resolves a Blob, or throws.
 * onProgress(0..1) follows the current step.
 */
export async function clipToGif(url, { onProgress, maxBytes = GIF_MAX_BYTES, steps = GIF_STEPS } = {}) {
  const video = await openClip(url);
  try {
    for (const step of steps) {
      const blob = await encodeStep(video, step, onProgress);
      if (blob.size <= maxBytes) return blob;
    }
    throw new Error('gif too big');
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
