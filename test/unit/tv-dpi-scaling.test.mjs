// #885 · 4K TV at Windows 300 %: reference-viewport zoom + physical render lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderPixelRatio, DESKTOP_TIER_LINES } from '../../js/quality.js';

const { uiZoomFor } = createRequire(import.meta.url)('../../electron/ui-zoom.js');

/** CSS viewport a zoom gives a w×h DIP window. */
const viewport = (w, h) => { const z = uiZoomFor(w, h); return [Math.round(w / z), Math.round(h / z)]; };

test('zoom lays every 16:9 screen out at 1920×1080, whatever the OS scale', () => {
  for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1440], [1536, 864], [3840, 2160]]) {
    assert.deepEqual(viewport(w, h), [1920, 1080], `${w}×${h}`);
  }
});

test('16:10 and 21:9 keep the extra side; the short side fits the reference', () => {
  assert.deepEqual(viewport(1280, 800), [1920, 1200]);       // Steam Deck class
  assert.deepEqual(viewport(1707, 1067), [1920, 1200]);      // 2560×1600 laptop @ 150 %
  assert.deepEqual(viewport(3440, 1440), [2580, 1080]);      // ultrawide
});

test('a tiny window stops at the 0.5 floor; nonsense sizes give 1', () => {
  assert.equal(uiZoomFor(640, 360), 0.5);
  assert.equal(uiZoomFor(0, 0), 1);
});

test('desktop app: a 4K TV renders the same buffer at 100 %, 200 % and 300 % scaling', () => {
  for (const tier of ['high', 'medium', 'low']) {
    const lines = new Set();
    for (const osScale of [1, 2, 3]) {
      const dip = [3840 / osScale, 2160 / osScale];
      const z = uiZoomFor(...dip);
      const innerHeight = Math.round(dip[1] / z), dpr = osScale * z;
      lines.add(Math.round(renderPixelRatio({ tier, dpr, innerHeight, desktopApp: true }) * innerHeight));
    }
    assert.deepEqual([...lines], [DESKTOP_TIER_LINES[tier]], tier);
  }
});

test('desktop app never renders more lines than the screen has', () => {
  // 1080p TV @ 100 %: zoom 1, DPR 1 → High is capped at 1080, not 1440.
  assert.equal(renderPixelRatio({ tier: 'high', dpr: 1, innerHeight: 1080, desktopApp: true }), 1);
  // 720p screen: zoom 0.667 → viewport 1080 @ 0.667 → every tier tops out at 720 lines.
  const r = renderPixelRatio({ tier: 'high', dpr: 2 / 3, innerHeight: 1080, desktopApp: true });
  assert.equal(Math.round(r * 1080), 720);
});

test('web tiers are unchanged', () => {
  assert.equal(renderPixelRatio({ tier: 'high', dpr: 3, innerHeight: 720 }), 2);
  assert.equal(renderPixelRatio({ tier: 'medium', dpr: 3, innerHeight: 720 }), 0.5);
  assert.equal(renderPixelRatio({ tier: 'low', dpr: 2, innerHeight: 720 }), 0.5);
  assert.equal(renderPixelRatio({ tier: 'low', dpr: 1, innerHeight: 400, linesOverride: 540 }), 1);
});
