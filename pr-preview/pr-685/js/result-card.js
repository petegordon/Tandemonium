// ============================================================
// RESULT CARD — one image of a finished ride, for sharing (#657)
// ============================================================
// SHARE RESULT used to copy the strip to the clipboard, which is a dead end on
// a TV or in Steam with a controller. The card is the thing that leaves the
// game instead: drawn from the victory data (not a screenshot of the screen),
// big type, so it reads at Discord / Steam thumbnail size.
//
// Part 1 (this file + game.js): the Steam build writes it to the player's
// Steam screenshot library. Parts 2 and 3 (TV QR → phone page, the House
// Tandem Discord post) reuse the same two steps:
//
//   const model = buildResultCard({ ...victory data });   // pure, tested
//   const card  = await renderResultCard(model);           // { canvas, width, height, png(), rgb() }
//
// Everything about WHAT the card says lives in buildResultCard(); the drawing
// only lays it out. Always "Tandem Tokens", never coins.

import { shortDate, formatClock } from './daily-ride.js';

export const CARD_W = 1920;
export const CARD_H = 1080;

export const MEDAL_EMOJI = Object.freeze({ gold: '🥇', silver: '🥈', bronze: '🥉' });
const DIFFICULTY_NAMES = { chill: 'Chill', adventurous: 'Adventurous', daredevil: 'Daredevil', tutorial: 'Tutorial' };

/** Unlocked badges drawn on the card; any more are a "+n". */
export const CARD_BADGES_MAX = 15;
/** Up to this many badges show their names under the icons. */
export const CARD_BADGE_NAMES_MAX = 4;

/**
 * The road link out of a share strip: its last http(s) line. A strip built in
 * the desktop app before #657 could carry the app's own tandemonium:// origin;
 * that is no link for anyone else, so it is not returned.
 */
export function linkFromStrip(strip) {
  if (!strip) return null;
  const lines = String(strip).split('\n').map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^https?:\/\//.test(lines[i])) return lines[i];
  }
  return null;
}

/**
 * What the card says, from the victory data. Pure.
 *
 * @param {object} r
 *   levelName, levelIcon, isDaily, dayKey, headline (a tourist ride's line),
 *   difficulty ('chill' | 'adventurous' | 'daredevil'), mode ('solo' | 'pair'),
 *   partnerName, timeMs, bestMs (#641: the Daily Ride shows the day's best
 *   when it is faster), dnf, distance, medal, collectibles, collectiblesTotal,
 *   crashes, tokensEarned (Tandem Tokens this ride paid), badges [{icon,name}],
 *   link (the road link, as the share strip has it)
 */
export function buildResultCard(r = {}) {
  const daily = !!r.isDaily;
  const date = daily && r.dayKey ? shortDate(r.dayKey) : '';
  const levelName = r.headline || r.levelName || 'Tandemonium';

  // The Daily Ride leads with the day's best, like the strip (#641).
  const useBest = daily && r.bestMs > 0 && (r.dnf || !(r.timeMs > 0) || r.bestMs < r.timeMs);
  const timeMs = useBest ? r.bestMs : r.timeMs;
  const time = r.dnf && !useBest ? 'DNF' : formatClock(timeMs);
  const timeLabel = useBest ? "TODAY'S BEST" : 'TIME';

  const medal = MEDAL_EMOJI[r.medal] ? r.medal : null;

  const difficulty = DIFFICULTY_NAMES[r.difficulty] || '';
  const tags = [];
  if (difficulty && r.difficulty !== 'tutorial') tags.push(difficulty);
  if (r.mode === 'pair') tags.push(r.partnerName ? 'with ' + r.partnerName : 'Two riders');

  const stats = [];
  if (r.collectiblesTotal > 0 || r.collectibles > 0) {
    stats.push({ kind: 'presents', icon: '🎁', value: r.collectiblesTotal > 0 ? `${r.collectibles || 0}/${r.collectiblesTotal}` : String(r.collectibles || 0), label: 'Presents' });
  }
  if (r.tokensEarned > 0) {
    stats.push({ kind: 'tokens', icon: null, value: '+' + Math.round(r.tokensEarned), label: 'Tandem Tokens' });
  }
  if (r.crashes > 0) stats.push({ kind: 'crashes', icon: '💥', value: String(r.crashes), label: r.crashes === 1 ? 'Crash' : 'Crashes' });
  else if (!r.dnf && timeMs > 0) stats.push({ kind: 'clean', icon: '⭐', value: '0', label: 'Crashes' });

  const all = Array.isArray(r.badges) ? r.badges.filter(b => b && (b.icon || b.name)) : [];
  const badges = all.slice(0, all.length > CARD_BADGES_MAX ? CARD_BADGES_MAX - 1 : CARD_BADGES_MAX)
    .map(b => ({ icon: b.icon || '🏅', name: b.name || '' }));
  const moreBadges = all.length - badges.length;
  const badgeHeading = all.length ? `${all.length} ${all.length === 1 ? 'BADGE' : 'BADGES'} UNLOCKED` : '';

  const link = r.link || null;
  const linkText = link ? link.replace(/^https?:\/\//, '') : 'tandemonium.housetandem.com';

  const kicker = daily ? (date ? `${levelName} · ${date}` : levelName) : levelName;

  return {
    kicker,                      // 'Daily Ride · Nov 7'
    icon: r.levelIcon || '',
    tags,                        // ['Adventurous', 'with Sam']
    time, timeLabel,
    medal,                       // 'gold' | 'silver' | 'bronze' | null
    stats,
    badges, moreBadges, badgeHeading,
    link, linkText,
    caption: shareCaption({ kicker, time, medal, mode: r.mode }),
  };
}

/**
 * The Steam screenshot caption (its "location"): "Daily Ride · Nov 7 · 1:48 · 🥉".
 * One line; Steam shows it under the picture.
 */
export function shareCaption({ kicker, time, medal, mode }) {
  const parts = ['Tandemonium', kicker];
  if (time && time !== '—') parts.push(mode === 'pair' ? '👥 ' + time : time);
  if (medal && MEDAL_EMOJI[medal]) parts.push(MEDAL_EMOJI[medal]);
  return parts.filter(Boolean).join(' · ').slice(0, 200);
}

/**
 * What SHARE RESULT says once the card is in the Steam screenshot library:
 * where it went, and how to open the overlay to share it (the Steam button
 * on a controller, Shift+Tab on a keyboard).
 */
export function steamSavedMessage({ pad = false } = {}) {
  return 'Saved to your Steam screenshots · ' + (pad ? 'Steam button to share' : 'Shift+Tab to share');
}

// ── Drawing ────────────────────────────────────────────────────────────

const FONT = '"Arial Black", "Segoe UI Black", "Helvetica Neue", Arial, sans-serif';
const FONT_UI = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
const EMOJI = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const C = {
  bgTop: '#2a1638', bgBottom: '#120a1c',
  cream: '#fff4dc', dim: '#cdb9d9', gold: '#ffd23f', panel: 'rgba(255,255,255,0.07)', line: 'rgba(255,255,255,0.14)',
  green: '#2ef33c', purple: '#934ef1', blue: '#118ae9',
};
const MEDAL_COLORS = {
  gold: { face: '#ffd23f', edge: '#b8860b', ink: '#5a3d00' },
  silver: { face: '#e4e8ee', edge: '#8a94a3', ink: '#3b4250' },
  bronze: { face: '#e09a5b', edge: '#8c4f1f', ink: '#4a2408' },
};

let _logo = null;
/** The Tandemonium wordmark (images/logo.png), loaded once; null if it will not load. */
function loadLogo(src = 'images/logo.png') {
  if (_logo) return _logo;
  _logo = new Promise((resolve) => {
    if (typeof Image === 'undefined') return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  return _logo;
}

/**
 * The wordmark band cut out of logo.png, with its edges faded out — the crop
 * goes through the dust cloud behind the letters, which would otherwise end
 * in a hard box.
 */
function featheredLogo(logo, sx, sy, sw, sh, dw, dh) {
  const c = document.createElement('canvas');
  c.width = dw; c.height = dh;
  const g = c.getContext('2d');
  g.drawImage(logo, sx, sy, sw, sh, 0, 0, dw, dh);
  g.globalCompositeOperation = 'destination-in';
  const h = g.createLinearGradient(0, 0, dw, 0);
  h.addColorStop(0, 'rgba(0,0,0,0)'); h.addColorStop(0.1, '#000'); h.addColorStop(0.9, '#000'); h.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = h; g.fillRect(0, 0, dw, dh);
  const v = g.createLinearGradient(0, 0, 0, dh);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(0.12, '#000'); v.addColorStop(0.7, '#000'); v.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = v; g.fillRect(0, 0, dw, dh);
  return c;
}

/** The House Tandem controller mark (remote/img/housetandem-controller.svg, viewBox ±400×260), centred at 0,0. */
function drawControllerMark(g, colors = {}) {
  const ring = colors.ring || C.green;
  g.save();
  g.lineWidth = 37;
  g.strokeStyle = ring;
  g.beginPath(); g.roundRect(-339.5, -208.5, 679, 417, 208.5); g.stroke();
  g.fillStyle = colors.bumper || ring;
  g.beginPath();
  g.moveTo(-95, -227); g.lineTo(95, -227); g.lineTo(95, -156);
  g.arc(61, -156, 34, 0, Math.PI / 2);
  g.lineTo(-61, -122);
  g.arc(-61, -156, 34, Math.PI / 2, Math.PI);
  g.closePath(); g.fill();
  g.fillStyle = colors.button || C.purple;
  g.beginPath(); g.arc(-127, 3, 70, 0, Math.PI * 2); g.fill();
  g.strokeStyle = colors.dpad || C.blue;
  g.lineWidth = 42; g.lineCap = 'round';
  g.beginPath(); g.moveTo(127, -51); g.lineTo(127, 57); g.moveTo(73, 3); g.lineTo(181, 3); g.stroke();
  g.restore();
}

/** A Tandem Token: a gold disc stamped with the controller mark (as js/token-face.js). */
function drawToken(g, x, y, r) {
  g.save();
  g.translate(x, y);
  g.fillStyle = '#b8860b';
  g.beginPath(); g.arc(0, r * 0.06, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = C.gold;
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#a8875a'; g.lineWidth = r * 0.08;
  g.beginPath(); g.arc(0, 0, r * 0.84, 0, Math.PI * 2); g.stroke();
  const ink = '#8a6a2a';
  g.scale(r / 560, r / 560);
  drawControllerMark(g, { ring: ink, bumper: ink, button: ink, dpad: ink });
  g.restore();
}

function drawMedal(g, x, y, r, medal) {
  const m = MEDAL_COLORS[medal];
  g.save();
  // Ribbon
  g.fillStyle = '#c0392b';
  g.beginPath(); g.moveTo(x - r * 0.55, y - r * 1.9); g.lineTo(x - r * 0.05, y - r * 0.6); g.lineTo(x - r * 0.45, y - r * 0.5); g.lineTo(x - r * 0.95, y - r * 1.8); g.closePath(); g.fill();
  g.fillStyle = '#2e86de';
  g.beginPath(); g.moveTo(x + r * 0.55, y - r * 1.9); g.lineTo(x + r * 0.05, y - r * 0.6); g.lineTo(x + r * 0.45, y - r * 0.5); g.lineTo(x + r * 0.95, y - r * 1.8); g.closePath(); g.fill();
  // Disc
  g.fillStyle = m.edge;
  g.beginPath(); g.arc(x, y + r * 0.05, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = m.face;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = m.edge; g.lineWidth = r * 0.06;
  g.beginPath(); g.arc(x, y, r * 0.82, 0, Math.PI * 2); g.stroke();
  g.fillStyle = m.ink;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  fitText(g, medal.toUpperCase(), r * 1.4, Math.round(r * 0.42), FONT);
  g.fillText(medal.toUpperCase(), x, y + r * 0.03);
  g.restore();
}

/** Shrink the font until `text` fits `maxW`; sets g.font and returns the size used. */
function fitText(g, text, maxW, size, family, weight = '') {
  let s = size;
  for (; s > 10; s -= 2) {
    g.font = `${weight ? weight + ' ' : ''}${s}px ${family}`;
    if (g.measureText(text).width <= maxW) break;
  }
  return s;
}

function pill(g, x, y, text, size, fg, bg) {
  g.font = `${size}px ${FONT}`;
  const w = g.measureText(text).width + size * 1.2;
  const h = size * 1.6;
  g.fillStyle = bg;
  g.beginPath(); g.roundRect(x, y, w, h, h / 2); g.fill();
  g.fillStyle = fg;
  g.textBaseline = 'middle'; g.textAlign = 'left';
  g.fillText(text, x + size * 0.6, y + h / 2 + 1);
  return w;
}

/**
 * Draw the card into a 2D context of CARD_W × CARD_H (scaled for other sizes).
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ TANDEMONIUM (wordmark)              🎗 medal  │
 *   │ 📅 Daily Ride · Nov 7                         │
 *   │ [ADVENTUROUS] [WITH SAM]          🏆 badges   │
 *   │ TIME                                ○ ○ ○ ○ ○ │
 *   │ 1:48                                ○ ○ ○ ○ ○ │
 *   │ [🎁 5/8] [🪙 +142] [⭐ 0]                      │
 *   │ Ride the same road → link        HOUSE TANDEM │
 *   └──────────────────────────────────────────────┘
 *
 * @param {CanvasRenderingContext2D} g
 * @param {ReturnType<typeof buildResultCard>} m
 * @param {{ logo?: HTMLImageElement|null, width?: number, height?: number }} opts
 */
export function drawResultCard(g, m, opts = {}) {
  const W = opts.width || CARD_W, H = opts.height || CARD_H;
  g.save();
  g.scale(W / CARD_W, H / CARD_H);

  // Background: a dusk gradient, a warm glow behind the time, the road's dashes.
  const bg = g.createLinearGradient(0, 0, 0, CARD_H);
  bg.addColorStop(0, C.bgTop); bg.addColorStop(1, C.bgBottom);
  g.fillStyle = bg; g.fillRect(0, 0, CARD_W, CARD_H);
  const glow = g.createRadialGradient(560, 600, 40, 560, 600, 900);
  glow.addColorStop(0, 'rgba(255,190,80,0.20)'); glow.addColorStop(1, 'rgba(255,190,80,0)');
  g.fillStyle = glow; g.fillRect(0, 0, CARD_W, CARD_H);
  g.fillStyle = 'rgba(255,210,63,0.10)';
  for (let x = -40; x < CARD_W; x += 160) g.fillRect(x, CARD_H - 26, 90, 10);

  // Header: the Tandemonium wordmark.
  const logo = opts.logo;
  if (logo && logo.naturalWidth) {
    // images/logo.png: the wordmark is the top band (the pedals below are left out).
    const sx = 0.06 * logo.naturalWidth, sy = 0.02 * logo.naturalHeight;
    const sw = 0.88 * logo.naturalWidth, sh = 0.42 * logo.naturalHeight;
    const dw = 760, dh = Math.round(dw * sh / sw);
    g.drawImage(featheredLogo(logo, sx, sy, sw, sh, dw, dh), 70, 34);
  } else {
    g.fillStyle = C.gold; g.textAlign = 'left'; g.textBaseline = 'top';
    g.font = `110px ${FONT}`;
    g.fillText('TANDEMONIUM', 90, 50);
  }

  // Left column: the ride, the time, the stats.
  const left = 100, colW = 1000;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillStyle = C.cream;
  const kicker = (m.icon ? m.icon + ' ' : '') + m.kicker;
  fitText(g, kicker, colW, 84, `${FONT}, ${EMOJI}`);
  g.fillText(kicker, left, 318);
  let y = 352;
  let px = left;
  for (const t of m.tags) px += pill(g, px, y, t.toUpperCase(), 38, '#1b0f26', C.gold) + 18;
  y = m.tags.length ? 492 : 430;

  g.textBaseline = 'alphabetic';
  g.fillStyle = C.dim; g.font = `42px ${FONT}`;
  g.fillText(m.timeLabel, left + 6, y);
  g.fillStyle = '#ffffff';
  fitText(g, m.time, colW, 270, FONT);
  g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 24; g.shadowOffsetY = 8;
  g.fillText(m.time, left - 10, y + 236);
  g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;

  const statsY = y + 290;
  const n = Math.min(3, m.stats.length);
  const gap = 24, cw = n ? Math.min(420, (colW - gap * (n - 1)) / n) : 0, ch = 140;
  let sx = left;
  for (const s of m.stats.slice(0, 3)) {
    g.fillStyle = C.panel;
    g.beginPath(); g.roundRect(sx, statsY, cw, ch, 28); g.fill();
    if (s.kind === 'tokens') drawToken(g, sx + 66, statsY + ch / 2, 42);
    else { g.font = `74px ${EMOJI}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff'; g.fillText(s.icon, sx + 66, statsY + ch / 2 + 4); }
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = '#fff';
    fitText(g, s.value, cw - 140, 72, FONT);
    g.fillText(s.value, sx + 124, statsY + 76);
    g.fillStyle = C.dim;
    fitText(g, s.label.toUpperCase(), cw - 140, 28, FONT);
    g.fillText(s.label.toUpperCase(), sx + 126, statsY + 116);
    sx += cw + gap;
  }

  // Right column: the medal, then the badges unlocked this ride.
  const rc = 1510;          // its centre line
  let ry = 70;
  if (m.medal) { drawMedal(g, rc, 310, 155, m.medal); ry = 530; }
  if (m.badges.length) {
    g.fillStyle = C.gold; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    fitText(g, '🏆 ' + m.badgeHeading, 680, 44, `${FONT}, ${EMOJI}`);
    g.fillText('🏆 ' + m.badgeHeading, rc, ry + 30);
    const cells = m.badges.length + (m.moreBadges ? 1 : 0);
    const badge = (bx, by, r, icon) => {
      g.fillStyle = 'rgba(255,210,63,0.18)';
      g.beginPath(); g.arc(bx, by, r, 0, Math.PI * 2); g.fill();
      g.strokeStyle = C.gold; g.lineWidth = 4;
      g.beginPath(); g.arc(bx, by, r, 0, Math.PI * 2); g.stroke();
      g.font = `${Math.round(r * 1.12)}px ${EMOJI}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
      g.fillText(icon, bx, by + 4);
    };
    if (cells <= CARD_BADGE_NAMES_MAX) {
      // A list: icon and name.
      let by = ry + 110;
      for (const b of m.badges) {
        badge(1210, by, 44, b.icon);
        g.fillStyle = C.cream; g.textAlign = 'left'; g.textBaseline = 'middle';
        fitText(g, b.name, 560, 44, FONT);
        g.fillText(b.name, 1280, by + 2);
        by += 104;
      }
    } else {
      // A grid of icons, five across.
      const cols = 5, step = 120, r = 46;
      const x0 = rc - step * (cols - 1) / 2;
      m.badges.forEach((b, i) => badge(x0 + (i % cols) * step, ry + 100 + Math.floor(i / cols) * step, r, b.icon));
      if (m.moreBadges) {
        const i = m.badges.length;
        const bx = x0 + (i % cols) * step, by = ry + 100 + Math.floor(i / cols) * step;
        g.fillStyle = C.gold; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = `44px ${FONT}`;
        g.fillText('+' + m.moreBadges, bx, by + 2);
      }
    }
  } else if (!m.medal) {
    // Nothing for the right column: the House Tandem mark, faint.
    g.save(); g.globalAlpha = 0.18; g.translate(rc, 520); g.scale(0.7, 0.7); drawControllerMark(g); g.restore();
  }

  // Footer: the road link (left), House Tandem (right).
  const fy = 1018;
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  g.fillStyle = C.dim;
  g.font = `bold 38px ${FONT_UI}`;
  const cta = m.link && /daily=/.test(m.link) ? 'Ride the same road  →  ' : 'Ride with me  →  ';
  g.fillText(cta, left, fy);
  const ctaW = g.measureText(cta).width;
  g.fillStyle = C.cream;
  fitText(g, m.linkText, 1340 - ctaW - left, 42, FONT_UI, 'bold');
  g.fillText(m.linkText, left + ctaW, fy);

  g.fillStyle = C.cream; g.textAlign = 'right'; g.font = `40px ${FONT}`;
  g.fillText('HOUSE TANDEM', CARD_W - 80, fy);
  const htW = g.measureText('HOUSE TANDEM').width;
  g.save();
  g.translate(CARD_W - 80 - htW - 60, fy - 15);
  g.scale(0.1, 0.1);
  drawControllerMark(g);
  g.restore();

  g.restore();
}

/**
 * Render the card to a canvas. Returns the canvas and two encoders: png() for
 * files and uploads, rgb() for Steam's WriteScreenshot (3 bytes a pixel).
 */
export async function renderResultCard(model, opts = {}) {
  const width = opts.width || CARD_W, height = opts.height || CARD_H;
  const logo = opts.logo !== undefined ? opts.logo : await loadLogo(opts.logoSrc);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const g = canvas.getContext('2d');
  drawResultCard(g, model, { logo, width, height });
  return {
    canvas, width, height,
    png: () => new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png')),
    rgb: () => {
      const px = g.getImageData(0, 0, width, height).data;
      const out = new Uint8Array(width * height * 3);
      for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { out[j] = px[i]; out[j + 1] = px[i + 1]; out[j + 2] = px[i + 2]; }
      return out;
    },
  };
}
