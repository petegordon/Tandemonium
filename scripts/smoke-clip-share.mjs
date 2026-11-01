#!/usr/bin/env node
// smoke:clip-share · test-script SR-09i (#408): on an iPhone, SHARE in the
// clip preview first offers FULL CLIP (20 s) and SHORT CLIP (10 s, FOR
// MESSAGES); the short one is cut from the same chunk buffer, opens on a
// keyframe and is at most 10 s; after the share sheet closes a "Save Video,
// then send it from Photos" hint shows, once per session. The pad walks the
// choice row and B steps back out of it. On desktop nothing changes: no
// SHARE, no choice.
//
// The harness serves only this checkout, so mp4-muxer (a CDN import) cannot
// load and no H.264 encode runs headlessly. The recorder is handed a stand-in
// muxer that keeps mp4-muxer's contract (first chunk a keyframe, decoderConfig
// on it) and a synthetic 20 s chunk buffer (20 fps, a keyframe every 2 s), so
// the real preview UI, cut, mux call and share flow run end to end; the real
// mux is covered by test/unit/clip-short-cut and a device.
import { startHarness, sleep, clickId } from './lib/smoke-harness.mjs';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const h = await startHarness({ port: 8987, outDir: 'tandemonium-clip-share' });
const { check } = h;

const until = (page, fn, timeout = 15000) =>
  page.waitForFunction(fn, { timeout, polling: 100 }).then(() => true).catch(() => false);
const shown = (page, id) => page.evaluate((i) => {
  const e = document.getElementById(i);
  return !!e && e.style.display !== 'none' && e.getBoundingClientRect().width > 0;
}, id);

/** Fake share sheet (records what it was handed) — installed before any game script. */
const fakeShare = (p) => p.evaluateOnNewDocument(() => {
  window.__shares = [];
  navigator.canShare = () => true;
  navigator.share = async (data) => {
    window.__shares.push({ files: (data.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })) });
  };
});

/**
 * Put a clip in the preview the way _assembleWebCodecsClip does, from a
 * synthetic buffer: `seconds` of 20 fps chunks, a keyframe (bigger) every 2 s.
 */
const loadSyntheticClip = (page, seconds) => page.evaluate(async (secs) => {
  const r = window._game.recorder;
  r._wcMp4Muxer = {
    ArrayBufferTarget: class { constructor() { this.buffer = null; this._parts = []; } },
    Muxer: class {
      constructor({ target }) { this.target = target; this.n = 0; }
      addVideoChunk(chunk, meta) {
        if (this.n === 0 && chunk.type !== 'key') throw new Error('first chunk must be a keyframe');
        if (this.n === 0 && !(meta && meta.decoderConfig)) throw new Error('decoderConfig missing on first chunk');
        const u8 = new Uint8Array(chunk.byteLength); chunk.copyTo(u8);
        this.target._parts.push(u8); this.n++;
      }
      finalize() {
        const total = this.target._parts.reduce((a, p) => a + p.length, 0);
        const out = new Uint8Array(total); let o = 0;
        for (const p of this.target._parts) { out.set(p, o); o += p.length; }
        this.target.buffer = out.buffer;
      }
    },
  };
  const fps = r._wcTargetFps, frameUs = 1_000_000 / fps;
  r._wcEncodedChunks = [];
  for (let i = 0; i < secs * fps; i++) {
    const key = i % (2 * fps) === 0;
    r._wcEncodedChunks.push({ type: key ? 'key' : 'delta', timestamp: i * frameUs, duration: frameUs,
      data: new ArrayBuffer(key ? 30000 : 10000), wallTime: performance.now() });
  }
  r._wcLastDecoderConfig = { decoderConfig: { codec: 'avc1.4d0028', codedWidth: 390, codedHeight: 844, description: new Uint8Array(8).buffer } };
  r.compCanvas.width = 390; r.compCanvas.height = 844;
  await r._assembleWebCodecsClip();
  return { preview: document.getElementById('clip-preview-modal').classList.contains('visible'), size: r._clipBlob?.size || 0, chunks: r._clipChunks?.length || 0 };
}, seconds);

// ── iPhone ──
console.log('iPhone: the share choice');
{
  const page = await h.gamePage({ viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA, storage: { tandemonium_tutorial_done: 'smoke' }, before: fakeShare });
  await sleep(500);
  const clip = await loadSyntheticClip(page, 20);
  check(clip.preview && clip.size > 0 && clip.chunks === 400, 'SR-09i a 20 s clip opens the preview (synthetic WebCodecs buffer)', clip);
  check(await shown(page, 'clip-share-btn') && !(await shown(page, 'clip-share-options')), 'SR-09i preview opens on SHARE / SAVE / DISCARD, the choice hidden');
  check(await page.evaluate(() => window._game.recorder.canShareShort()), 'SR-09i the clip can be cut short');

  // SHARE → the choice, labels driven by the recorder's seconds.
  await clickId(page, 'clip-share-btn');
  check(await until(page, () => document.getElementById('clip-share-options').style.display !== 'none'), 'SR-09i SHARE shows the choice before any sheet opens');
  const labels = await page.evaluate(() => ['clip-share-full', 'clip-share-short', 'clip-share-back'].map((i) => document.getElementById(i).textContent));
  check(labels[0] === 'FULL CLIP (20 s)' && labels[1] === 'SHORT CLIP (10 s, FOR MESSAGES)', 'SR-09i choice labels: FULL CLIP (20 s) and SHORT CLIP (10 s, FOR MESSAGES)', labels);
  check(await page.evaluate(() => window.__shares.length) === 0 && !(await shown(page, 'clip-actions')), 'SR-09i no share yet; the action row is swapped out', labels);
  await h.shot(page, 'iphone-share-choice');
  const padRow = await page.evaluate(() => window._game.recorder._previewFocus.items.map((e) => e.id));
  check(padRow.join() === 'clip-share-full,clip-share-short,clip-share-back', 'SR-09i pad focus walks the choice row', padRow);

  // B steps back to the action row, not out of the preview.
  await page.evaluate(() => window._game.recorder._previewFocus.back());
  check(await until(page, () => document.getElementById('clip-share-options').style.display === 'none' && document.getElementById('clip-preview-modal').classList.contains('visible')), 'SR-09i B steps back to SHARE / SAVE / DISCARD, preview still open');
  const padMain = await page.evaluate(() => window._game.recorder._previewFocus.items.map((e) => e.id));
  check(padMain.join() === 'clip-share-btn,clip-save-btn,clip-discard-btn', 'SR-09i pad focus is back on the action row', padMain);

  // SHORT CLIP: a cut of the same buffer, on a keyframe, at most 10 s, smaller.
  await clickId(page, 'clip-share-btn');
  await until(page, () => document.getElementById('clip-share-options').style.display !== 'none');
  await clickId(page, 'clip-share-short');
  check(await until(page, () => window.__shares.length === 1), 'SR-09i SHORT CLIP opens the share sheet with one file');
  const short = await page.evaluate(async () => {
    const r = window._game.recorder;
    const { cutShortWindow, SHORT_CLIP_SECONDS } = await import('/js/game-recorder.js');
    const cut = cutShortWindow(r._clipChunks, SHORT_CLIP_SECONDS, r._wcTargetFps);
    const span = (cut[cut.length - 1].timestamp + cut[cut.length - 1].duration - cut[0].timestamp) / 1e6;
    return { share: window.__shares[0].files[0], full: r._clipBlob.size, cached: r._shortClipBlob?.size || 0, first: cut[0].type, span, chunks: cut.length };
  });
  check(short.share && short.share.type === 'video/mp4' && short.share.name === 'tandemonium-clip.mp4', 'SR-09i the shared file is an MP4', short.share);
  check(short.share.size === short.cached && short.share.size < short.full, 'SR-09i the short clip is the cut, smaller than the full clip', { short: short.share.size, full: short.full });
  check(short.first === 'key' && short.span <= 10 && short.chunks === 200, 'SR-09i the cut opens on a keyframe and spans at most 10 s', { first: short.first, span: short.span, chunks: short.chunks });

  // The hint, after the sheet closed, once per session.
  check(await until(page, () => document.getElementById('clip-share-tip').style.display === 'block'), 'SR-09i after the sheet closes: "Save Video, then send it from Photos" hint');
  const tip = await page.evaluate(() => document.getElementById('clip-share-tip').textContent.trim());
  check(tip === "Didn't send? Choose Save Video, then send it from Photos.", 'SR-09i hint wording', tip);
  await page.evaluate(() => window._game.recorder._hideShareHint());

  // FULL CLIP shares the whole clip; the hint does not come back this session.
  await clickId(page, 'clip-share-full');
  check(await until(page, () => window.__shares.length === 2), 'SR-09i FULL CLIP opens the share sheet');
  const full = await page.evaluate(() => ({ size: window.__shares[1].files[0].size, blob: window._game.recorder._clipBlob.size }));
  check(full.size === full.blob, 'SR-09i FULL CLIP shares the whole clip', full);
  await sleep(300);
  check(!(await shown(page, 'clip-share-tip')), 'SR-09i the hint shows once per session');

  // Discard clears the cut; a fresh preview opens on the action row again.
  await clickId(page, 'clip-discard-btn');
  check(await until(page, () => !document.getElementById('clip-preview-modal').classList.contains('visible') && !window._game.recorder._clipChunks), 'SR-09i DISCARD closes the preview and drops the chunks');
  const again = await loadSyntheticClip(page, 20);
  check(again.preview && await shown(page, 'clip-actions') && !(await shown(page, 'clip-share-options')), 'SR-09i the next preview opens on the action row');
  await page.evaluate(() => window._game.recorder._discardClip());
  await page.close();
}

// ── desktop ──
console.log('desktop: no SHARE, no choice');
{
  const page = await h.gamePage({ storage: { tandemonium_tutorial_done: 'smoke' }, before: fakeShare });
  await sleep(500);
  const clip = await loadSyntheticClip(page, 20);
  check(clip.preview, 'SR-09i desktop preview opens', clip);
  check(!(await shown(page, 'clip-share-btn')) && !(await shown(page, 'clip-share-options')), 'SR-09i desktop: SHARE hidden, no choice (SAVE downloads as before)');
  const pad = await page.evaluate(() => window._game.recorder._previewFocus.items.map((e) => e.id));
  check(pad.join() === 'clip-save-btn,clip-discard-btn', 'SR-09i desktop pad focus: SAVE / DISCARD', pad);
  await page.evaluate(() => window._game.recorder._discardClip());
  await page.close();
}

await h.finish();
