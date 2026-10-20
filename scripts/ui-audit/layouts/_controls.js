// Proposal (#428): one "Controls" pill that names the controller in use, in place
// of the separate Stick steer / Gyro steer toggles; on the `controls` screen it
// also opens the Controls sheet it would lead to. Mock-only DOM (class mock-dom).
const pad = (navigator.getGamepads ? [...navigator.getGamepads()] : []).find(Boolean);
const m = /Vendor:\s*([0-9a-f]{4}).*Product:\s*([0-9a-f]{4})/i.exec(pad?.id || '') || [];
const NAMES = {
  '054c:0ce6': 'DualSense', '054c:0df2': 'DualSense Edge', '054c:09cc': 'DualShock 4', '054c:05c4': 'DualShock 4',
  '057e:2009': 'Switch Pro', '045e:0b13': 'Xbox', '28de:1304': 'Steam Controller',
};
const SONY = m[1] === '054c';
const name = NAMES[`${m[1]}:${m[2]}`] || (pad ? 'Controller' : 'Keyboard');
const l = window._game?.lobby || {};
const stick = l.joystickActive !== false, gyro = !!l.motionActive;
const mode = [stick && 'stick', gyro && 'gyro'].filter(Boolean).join(' + ') || 'buttons';
const icon = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9h12a4 4 0 0 1 3.9 4.9l-.8 3.4a2.5 2.5 0 0 1-4.3 1.1L15 16H9l-1.8 2.4a2.5 2.5 0 0 1-4.3-1.1l-.8-3.4A4 4 0 0 1 6 9z"/><path d="M8 12v3M6.5 13.5h3"/><circle cx="16" cy="12.5" r=".6" fill="currentColor"/><circle cx="17.8" cy="14.3" r=".6" fill="currentColor"/></svg>';

const rc = document.querySelector('.lobby-right-col');
if (rc) {
  const pill = document.createElement('button');
  pill.className = 'lobby-toggle mock-dom mock-ctl';
  pill.innerHTML = `${icon}<span><b>${name}</b> · ${mode}</span>`;
  rc.prepend(pill);
}

if (window.__mockScreen === 'controls') {
  const confirm = SONY ? '✕' : 'A', back = SONY ? '◯' : 'B';
  const sheet = document.createElement('div');
  sheet.className = 'mock-dom';
  sheet.id = 'mock-controls-sheet';
  sheet.innerHTML = `
    <div class="mcs-card" role="dialog" aria-label="Controls">
      <header><h2>Controls</h2><span class="mcs-close"><i>${back}</i> Close</span></header>
      <div class="mcs-seat"><span class="mcs-p">P1</span>${icon}<div><b>${name}</b><small>Player 1 · connected</small></div><span class="mcs-change">Change controller</span></div>
      <h3>Steering</h3>
      <div class="mcs-row focus"><div><b>Stick steering</b><small>Lean with the left stick</small></div><span class="mcs-switch ${stick ? 'on' : ''}">${stick ? 'On' : 'Off'}</span></div>
      <div class="mcs-row"><div><b>Gyro steering</b><small>Tilt the controller to lean</small></div><span class="mcs-switch ${gyro ? 'on' : ''}">${gyro ? 'On' : 'Off'}</span></div>
      <div class="mcs-row sub"><div><b>Steering feel</b></div><span class="mcs-slider"><em>Stable</em><span class="track"><span class="knob"></span></span><em>Responsive</em></span><span class="mcs-btn">Recalibrate</span></div>
      <h3>Buttons</h3>
      <div class="mcs-row"><div><b>Button prompts</b><small>${SONY ? '✕ ◯ □ △' : 'A B X Y'} · picked from your controller</small></div><span class="mcs-value">Automatic</span></div>
      <div class="mcs-row"><div><b>Use your phone instead</b><small>Scan a code to steer and pedal with your phone</small></div><span class="mcs-value">›</span></div>
      <footer><span><i>${confirm}</i> Change</span><span><i>${back}</i> Close</span></footer>
    </div>`;
  document.body.appendChild(sheet);
}
