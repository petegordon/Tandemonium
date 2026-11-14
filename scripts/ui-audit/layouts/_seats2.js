// Proposal (#428), round 5: seats show who is playing; a controller strip under
// them shows every connected controller and its state, always visible (no
// expander), on both the captain's room and versus. The captain's room is split
// into "Online multiplayer" (code + QR) and "Local multiplayer" (team box), each
// with its own "Waiting for partner". Mock-only DOM (class mock-dom).
const txt = (el) => (el?.textContent || '').trim();
const KNOWN = {
  '054c:0ce6': ['DualSense', 'DUALSENSE'], '057e:2009': ['Switch Pro', 'SWITCH'], '054c:09cc': ['DualShock 4', 'DUALSHOCK'],
  '045e:0b13': ['Xbox Wireless', 'XBOX'], '0079:0011': ['USB Gamepad', 'USB GAMEPAD'],
};
const pads = (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter(Boolean).map((g) => {
  const k = /Vendor:\s*([0-9a-f]{4}).*Product:\s*([0-9a-f]{4})/i.exec(g.id) || [];
  const [name, token] = KNOWN[`${k[1]}:${k[2]}`] || ['Controller', '§'];
  return { name, token };
});
(window.__fake?.state().hid || []).forEach(() => pads.push({ name: 'Steam Controller', token: 'STEAM CONTROLLER' }));
pads.push({ name: 'Keyboard', token: 'KEYBOARD' });
// Two of the same model: number them so each chip is one controller.
const seen = {};
pads.forEach((p) => { seen[p.name] = (seen[p.name] || 0) + 1; if (seen[p.name] > 1) p.label = `${p.name} ${seen[p.name]}`; });
const chip = (p) => p.seat
  ? `<span class="tray-chip seated ${p.team || ''}"><b>${p.seat}</b>${p.label || p.name}</span>`
  : `<span class="tray-chip"><i></i>${p.label || p.name}<em>${p.full ? 'seats full' : p.kb ? 'press Enter' : 'press ✕ / A'}</em></span>`;
const order = (list) => [...list].sort((a, b) => (a.seat ? 0 : 1) - (b.seat ? 0 : 1) || String(a.seat).localeCompare(String(b.seat)));
const tray = (list, seats) => `
  <div class="tray mock-dom">
    <div class="tray-head"><b>Connected controllers · ${list.length}</b><span>${seats}</span></div>
    <div class="tray-chips">${order(list).map(chip).join('')}</div>
  </div>`;

const host = document.getElementById('lobby-host');
if (host?.hasAttribute('active')) {
  // Intended state: the controller that pressed START A RIDE is the captain.
  pads[0].seat = 'Captain'; pads[0].team = 'captain';
  pads.forEach((p) => { if (p.name === 'Keyboard') p.kb = true; });
  const online = document.createElement('div');
  online.className = 'mock-dom mock-online-head';
  online.innerHTML = '<h3>Online multiplayer</h3><p>Your partner enters this code, or scans the QR code, on their own device.</p>';
  host.prepend(online);
  const box = document.createElement('div');
  box.className = 'mock-dom';
  box.id = 'mock-coop';
  box.innerHTML = `
    <h3>Local multiplayer</h3>
    <p class="mock-sub">Two controllers on this screen, one bike.</p>
    <div class="versus-team versus-team-coop">
      <div class="versus-team-title">YOUR TANDEM</div>
      <div class="versus-team-slots">
        <div class="versus-player-card seat-captain"><span class="vp-role">CAPTAIN · FRONT SEAT</span><span class="vp-name">PLAYER 1</span><span class="vp-device">🎮 ${pads[0].name}</span></div>
        <div class="versus-player-card vp-empty seat-stoker"><span class="vp-role">STOKER · BACK SEAT</span><span class="vp-name">Waiting for partner…</span><span class="vp-device">press ✕ / A on any controller</span></div>
      </div>
    </div>
    ${tray(pads, '1 of 2 seats taken')}`;
  host.appendChild(box);
}

const vs = document.getElementById('lobby-versus');
if (vs?.hasAttribute('active')) {
  let taken = 0;
  for (const card of vs.querySelectorAll('.versus-player-card:not(.vp-join):not(.vp-empty)')) {
    const t = txt(card).toUpperCase();
    const n = /PLAYER\s*(\d)/.exec(t)?.[1];
    const team = card.closest('.versus-team-a') ? 'team-a' : 'team-b';
    const p = pads.find((x) => !x.seat && t.includes(x.token));
    if (p && n) { p.seat = `P${n}`; p.team = team; taken++; }
  }
  pads.forEach((p) => { if (p.name === 'Keyboard') p.kb = true; if (taken >= 4) p.full = true; });
  vs.querySelector('.versus-teams')?.insertAdjacentHTML('afterend', tray(pads, `${taken} of 4 seats taken`));
}
