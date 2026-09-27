// ============================================================
// room-qr — captain's shareable join QR + URL (with long-press copy)
// ============================================================
//
// Self-contained UI extracted from lobby.js _createRoom (#318 Step 3): build
// the join URL for a room code, render the QR into #room-qr, show the URL in
// #room-url, and wire long-press / right-click to copy. Logic is faithful to
// the previous inline block. `qrcode` is a global loaded via <script>.
// ============================================================

import { SITE_URL } from '../config.js';

/**
 * The shareable join URL for a room code. In Electron we use the production
 * web URL (localhost isn't reachable from a phone scanning the QR); on the web
 * we use the current origin + path.
 */
export function joinUrl(code) {
  const isDesktop = navigator.userAgent.includes('Electron');
  const baseUrl = isDesktop
    ? SITE_URL
    : window.location.origin + window.location.pathname;
  return baseUrl + '?room=' + code;
}

/** Render the room QR + URL and wire long-press-to-copy. Returns the URL. */
export function renderRoomQR(code) {
  const qrEl = document.getElementById('room-qr');
  const urlEl = document.getElementById('room-url');
  const url = joinUrl(code);
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    qrEl.innerHTML = qr.createSvgTag({ cellSize: 2, margin: 2 });
  } catch (_) {
    qrEl.style.display = 'none';
  }

  // Show full URL
  if (urlEl) urlEl.textContent = url;

  // Long-press to copy on both QR and URL
  const copyUrl = () => {
    navigator.clipboard.writeText(url).then(() => {
      if (urlEl) {
        const orig = urlEl.textContent;
        urlEl.textContent = 'Copied!';
        urlEl.classList.add('room-url-copied');
        setTimeout(() => { urlEl.textContent = orig; urlEl.classList.remove('room-url-copied'); }, 1500);
      }
    }).catch(() => {});
  };
  [qrEl, urlEl].forEach(el => {
    if (!el) return;
    let timer = null;
    const start = (e) => { e.preventDefault(); timer = setTimeout(copyUrl, 500); };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener('touchstart', start, { passive: false });
    el.addEventListener('touchend', cancel);
    el.addEventListener('touchcancel', cancel);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); copyUrl(); });
  });
  return url;
}
