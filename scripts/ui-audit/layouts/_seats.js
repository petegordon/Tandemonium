// Proposal (#428): one seat component everywhere. The captain's "ride on this
// screen" becomes a versus team box (Captain + Stoker seats); controllers that
// don't fit a seat get one "Also connected" line on both screens. The full
// controller list lives in the Controls sheet (_controls.js), not on each step.
// Mock-only DOM (class mock-dom), built from what the live step shows.
const txt = (el) => (el?.textContent || '').trim();
const pretty = (s) => s.replace(/\s*\(DIRECT USB-C\)/i, '').replace(/\s+/g, ' ');

const host = document.getElementById('lobby-host');
if (host?.hasAttribute('active')) {
  // Intended state: the controller driving the menu is the captain. (Today, with
  // several pads at boot, P1 is unclaimed: "Player 1: —" and every pad, the
  // captain's included, is offered as Player 2. Finding 2/3 in #428.)
  let captain = pretty(txt(document.getElementById('local-join-captain-name')));
  const cands = [...document.querySelectorAll('#local-join-candidates .btn-local-join-padname')].map((e) => pretty(txt(e)));
  if (!captain || captain === '—') captain = cands.shift() || 'Controller';
  const kb = document.getElementById('btn-local-join-kb');
  if (kb && getComputedStyle(kb).display !== 'none') cands.push('Keyboard');
  const [next, ...rest] = cands;
  const box = document.createElement('div');
  box.className = 'mock-dom';
  box.id = 'mock-coop';
  box.innerHTML = `
    <h3>Or ride on this screen</h3>
    <div class="versus-team versus-team-coop">
      <div class="versus-team-title">YOUR TANDEM</div>
      <div class="versus-team-slots">
        <div class="versus-player-card seat-captain"><span class="vp-role">CAPTAIN · FRONT SEAT</span><span class="vp-name">PLAYER 1</span><span class="vp-device">🎮 ${captain}</span></div>
        ${next
          ? `<div class="versus-player-card vp-join seat-stoker focus"><span class="vp-role">STOKER · BACK SEAT</span><span class="vp-name">${next}</span><span class="vp-device">press ✕ / A on it to join</span></div>`
          : `<div class="versus-player-card vp-empty seat-stoker"><span class="vp-role">STOKER · BACK SEAT</span><span class="vp-name">OPEN</span><span class="vp-device">connect a second controller</span></div>`}
      </div>
    </div>
    ${rest.length ? `<p class="mock-also"><b>Also connected:</b> ${rest.join(' · ')}. Press a button on one to take the back seat instead.</p>` : ''}`;
  host.appendChild(box);
}

const vs = document.getElementById('lobby-versus');
if (vs?.hasAttribute('active')) {
  // Today a controller beyond the four seats appears nowhere once teams are full,
  // so read the connected pads directly and list the ones not on a seat.
  const seatText = [...vs.querySelectorAll('.versus-player-card')].map(txt).join(' ').toUpperCase();
  const KNOWN = { '054c:0ce6': ['DualSense', 'DUALSENSE'], '057e:2009': ['Switch Pro', 'SWITCH'], '054c:09cc': ['DualShock 4', 'DUALSHOCK'], '045e:0b13': ['Xbox Wireless', 'XBOX'] };
  const extra = (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter(Boolean).map((g) => {
    const k = /Vendor:\s*([0-9a-f]{4}).*Product:\s*([0-9a-f]{4})/i.exec(g.id) || [];
    return KNOWN[`${k[1]}:${k[2]}`];
  }).filter((e) => e && !seatText.includes(e[1])).map((e) => e[0]);
  if (extra.length) {
    const p = document.createElement('p');
    p.className = 'mock-dom mock-also';
    p.innerHTML = `<b>Also connected:</b> ${extra.join(' · ')}. Teams are full; a player can leave their seat with ◯ / B to make room.`;
    vs.querySelector('.versus-teams')?.after(p);
  }
}
