// ============================================================
// Steam Controller Test Bench - renderer
//
// Two independent panels:
//   - Steam Input: reads window.steamTest.getLatest() each frame
//     and renders handle state + per-controller action values.
//   - WebHID: navigator.hid.requestDevice() inside click handlers,
//     then opens the device and dumps raw input reports.
// ============================================================

// Known controller filters - filled out as we learn them.
// Steam Controller v1 USB: vendorId 0x28de, productId 0x1102 (wired) or 0x1142 (wireless dongle)
// DualSense: vendorId 0x054c, productId 0x0ce6
const HID_FILTERS = {
  'steam-controller': [{ vendorId: 0x28de }],
  'dualsense':        [{ vendorId: 0x054c, productId: 0x0ce6 }],
  'any':              [], // empty array means no filter (Chromium will show all)
};

// ---------- Steam Input panel ----------
const $ = id => document.getElementById(id);

function renderSteamInput() {
  const snap = window.steamTest.getLatest();
  $('si-ready').textContent = snap.ready ? '✓ initialized' : '✗ not initialized';
  $('si-ready').className = 'value ' + (snap.ready ? 'ok' : 'bad');

  const attempts = snap.manifestPathAttempts || [];
  const accepted = snap.manifestPathAccepted;
  const mprEl = $('si-manifest-result');
  if (mprEl) {
    if (attempts.length === 0) {
      mprEl.innerHTML = '<div class="hint">(not attempted yet)</div>';
    } else {
      const rows = attempts.map(a => {
        let status, cls;
        if (!a.fileExists)       { status = 'file missing'; cls = 'bad'; }
        else if (a.error)        { status = 'threw: ' + a.error; cls = 'bad'; }
        else if (a.returned === true)  { status = 'ACCEPTED'; cls = 'ok'; }
        else if (a.returned === false) { status = 'rejected (returned false)'; cls = 'bad'; }
        else                     { status = 'skipped'; cls = 'bad'; }
        return `<div class="row">
          <span class="value ${cls}">${cls === 'ok' ? '✓' : '✗'}</span>
          <code class="path">${a.path}</code>
          <span class="hint">${status}</span>
        </div>`;
      });
      const banner = accepted
        ? `<div class="row"><span class="value ok">✓ accepted</span> <code class="path">${accepted}</code></div>`
        : `<div class="row"><span class="value bad">✗ no candidate accepted</span> <span class="hint">Steam rejected every path we tried — action handles will stay 0.</span></div>`;
      mprEl.innerHTML = banner + '<div style="margin-top:8px;"><div class="block-title" style="font-size:11px;">All attempts:</div>' + rows.join('') + '</div>';
    }
  }

  const sc = snap.sessionConfig;
  const scEl = $('si-session-config');
  if (scEl) {
    if (sc === null || sc === undefined) {
      scEl.textContent = '?';
      scEl.className = 'value bad';
    } else {
      scEl.textContent = String(sc) + ' (0b' + Number(sc).toString(2) + ')';
      scEl.className = 'value ' + (sc !== 0 ? 'ok' : 'bad');
    }
  }

  const h = snap.handles || {};
  $('si-h-set').textContent = h.set || '0';
  $('si-h-set').className = 'value ' + ((h.set && h.set !== '0') ? 'ok' : 'bad');
  $('si-h-steer').textContent = h.steer || '0';
  $('si-h-steer').className = 'value ' + ((h.steer && h.steer !== '0') ? 'ok' : 'bad');
  $('si-h-confirm').textContent = h.confirm || '0';
  $('si-h-confirm').className = 'value ' + ((h.confirm && h.confirm !== '0') ? 'ok' : 'bad');

  // Gamepad-index probe — show all 4 slots, highlight non-zero hits.
  const gpProbe = snap.gamepadIndexProbe || {};
  const gpProbeEl = $('si-gp-probe');
  if (gpProbeEl) {
    const entries = [0, 1, 2, 3].map(i => {
      const val = gpProbe[i];
      const isHit = val && val !== '0' && !String(val).startsWith('error');
      return `<div class="row">
        <span class="value ${isHit ? 'ok' : 'bad'}">${isHit ? '✓' : '-'}</span>
        <span class="label">slot ${i}</span>
        <code>${val ?? '(no data)'}</code>
      </div>`;
    });
    gpProbeEl.innerHTML = entries.join('');
  }

  const ctrlsEl = $('si-controllers');
  const ctrls = snap.controllers || [];
  if (ctrls.length === 0) {
    ctrlsEl.innerHTML = '<div class="empty">No controllers captured by Steam Input yet.</div>';
  } else {
    ctrlsEl.innerHTML = ctrls.map((c, i) => {
      const motionRow = c.motion
        ? `<div>Motion: rotVel=<code>(${c.motion.rotVelX.toFixed(2)}, ${c.motion.rotVelY.toFixed(2)}, ${c.motion.rotVelZ.toFixed(2)})</code> posAccel=<code>(${c.motion.posAccelX.toFixed(2)}, ${c.motion.posAccelY.toFixed(2)}, ${c.motion.posAccelZ.toFixed(2)})</code></div>`
        : `<div>Motion: <code>not available</code> <span class="hint">(no gyro/accel for this controller, or pad doesn't expose it)</span></div>`;
      return `<div class="controller-row">
        <div><b>#${i}</b> handle <code>${c.handle}</code> &middot; type <code>${c.type}</code> &middot; src <code>${c.source || '?'}</code> &middot; gpIdx <code>${c.gamepadIndex}</code></div>
        <div>Steer: x=<code>${c.steerX.toFixed(3)}</code> y=<code>${c.steerY.toFixed(3)}</code></div>
        <div>Confirm: <code>${c.confirm ? 'PRESSED' : '-'}</code></div>
        ${motionRow}
        <div><button class="binding-panel-btn" data-handle="${c.handle}">Open Steam binding panel</button></div>
      </div>`;
    }).join('');
    // Bind any newly rendered buttons.
    ctrlsEl.querySelectorAll('.binding-panel-btn').forEach(btn => {
      btn.onclick = async () => {
        const res = await window.steamTest.showBindingPanel(btn.dataset.handle);
        if (!res || !res.ok) {
          btn.textContent = 'Failed: ' + (res && res.reason ? res.reason : 'unknown');
        } else {
          btn.textContent = 'Opened — check overlay';
        }
      };
    });
  }

  // Idle-time hints when Steam Input is ready but enumeration stays empty.
  const hintEl = $('si-hints');
  if (hintEl) {
    const idle = snap.secondsSinceReady || 0;
    const hints = [];
    if (snap.ready && ctrls.length === 0 && idle > 5) {
      hints.push(`No controllers in <code>${idle.toFixed(0)}s</code> since Steam Input init. Likely causes:`);
      const items = [];
      if (sc === 0 || sc === null) {
        items.push('Session config bitmask is 0 — Steam Input has NO controller types enabled for this app. Check Steam &rarr; Settings &rarr; Controller &rarr; per-type config support.');
      }
      items.push('Steam isn\'t running, OR this process wasn\'t launched through Steam (Steam Input only attaches bindings to Steam-launched processes — try adding the test bench as a "Non-Steam Game" or launch via <code>steam -applaunch 4510250</code>).');
      items.push('PlayStation/Switch/Xbox configuration support disabled. Toggle ON in Steam &rarr; Settings &rarr; Controller.');
      items.push('Controller paired but asleep — press any button to wake it.');
      hints.push('<ul>' + items.map(i => `<li>${i}</li>`).join('') + '</ul>');
    }
    hintEl.innerHTML = hints.join('');
  }

  // Probe results - highlight any non-zero entry so we can spot which name Steam actually has
  const probe = snap.probe || { sets: {}, analog: {}, digital: {} };
  const renderProbe = (group, label) => {
    const entries = Object.entries(group);
    if (!entries.length) return '';
    const rows = entries.map(([name, val]) => {
      const isHit = val && val !== '0' && !val.startsWith('error');
      return `<div class="row">
        <span class="value ${isHit ? 'ok' : 'bad'}">${isHit ? '✓' : '-'}</span>
        <span class="label">${label} "${name}"</span>
        <code>${val}</code>
      </div>`;
    });
    return rows.join('');
  };
  $('si-probe').innerHTML =
    renderProbe(probe.sets, 'ActionSet') +
    renderProbe(probe.analog, 'Analog') +
    renderProbe(probe.digital, 'Digital');
}
setInterval(renderSteamInput, 50); // ~20 Hz UI refresh is enough

// One-shot diagnostics
$('check-iga-btn').addEventListener('click', async () => {
  const rows = await window.steamTest.checkIGA();
  $('iga-paths').innerHTML = rows.map(r =>
    `<div class="row">
      <span class="value ${r.exists ? 'ok' : 'bad'}">${r.exists ? '✓' : '✗'}</span>
      <code class="path">${r.path}</code>
      ${r.exists ? `<span class="hint">${r.size} bytes</span>` : ''}
    </div>`
  ).join('');
});

$('check-log-btn').addEventListener('click', async () => {
  const lines = await window.steamTest.controllerLogTail();
  $('steam-log-tail').textContent = lines.length
    ? lines.join('\n')
    : '(no matching lines in C:\\Program Files (x86)\\Steam\\logs\\controller.txt)';
});

// ---------- WebHID panel ----------
const connectedDevices = new Map(); // deviceId -> { device, lastReports: [{ts, hex}] }
const MAX_REPORTS_PER_DEVICE = 5;

function deviceKey(d) {
  return `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}:${d.productName || ''}`;
}

function renderDevices() {
  const el = $('hid-devices');
  if (connectedDevices.size === 0) {
    el.innerHTML = '<div class="empty">No HID devices paired yet. Click a Connect button above.</div>';
    return;
  }
  const rows = [];
  for (const [key, entry] of connectedDevices) {
    const d = entry.device;
    rows.push(
      `<div class="device-row">
        <div><b>${d.productName || '(no name)'}</b></div>
        <div>vendor <code>0x${d.vendorId.toString(16).padStart(4, '0')}</code>
             product <code>0x${d.productId.toString(16).padStart(4, '0')}</code>
             opened <code>${d.opened}</code></div>
      </div>`
    );
  }
  el.innerHTML = rows.join('');
}

function renderReports() {
  const all = [];
  for (const [key, entry] of connectedDevices) {
    for (const r of entry.lastReports) {
      all.push({ key, ...r });
    }
  }
  all.sort((a, b) => b.ts - a.ts);
  $('hid-reports').textContent = all.slice(0, 5).map(r =>
    `[${new Date(r.ts).toISOString().slice(11, 23)}] ${r.key}  rid=${r.reportId}  (${r.bytes}b)\n  ${r.hex}`
  ).join('\n\n') || '(waiting for input reports - press a button on your controller)';
}

async function attachDevice(device) {
  const key = deviceKey(device);
  if (connectedDevices.has(key)) return; // already attached
  if (!device.opened) {
    try { await device.open(); }
    catch (e) { console.warn('open failed:', e.message); return; }
  }
  connectedDevices.set(key, { device, lastReports: [] });
  device.addEventListener('inputreport', (e) => {
    const data = new Uint8Array(e.data.buffer);
    const hex = Array.from(data).slice(0, 32).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const entry = connectedDevices.get(key);
    if (!entry) return;
    entry.lastReports.unshift({
      ts: Date.now(),
      reportId: e.reportId,
      bytes: data.length,
      hex,
    });
    while (entry.lastReports.length > MAX_REPORTS_PER_DEVICE) entry.lastReports.pop();
  });
  renderDevices();
}

document.querySelectorAll('.connect-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const target = btn.dataset.target;
    try {
      const filters = HID_FILTERS[target] || [];
      const devs = await navigator.hid.requestDevice({ filters });
      for (const d of devs) await attachDevice(d);
    } catch (e) {
      console.warn('requestDevice failed:', e.message);
    }
  });
});

// On boot, hook up any already-permitted devices (subsequent launches)
navigator.hid.getDevices().then(devs => {
  for (const d of devs) attachDevice(d);
});

navigator.hid.addEventListener('connect',    e => attachDevice(e.device));
navigator.hid.addEventListener('disconnect', e => {
  const key = deviceKey(e.device);
  connectedDevices.delete(key);
  renderDevices();
});

setInterval(renderReports, 100); // 10 Hz report-feed refresh

// ---------- Gamepad API panel ----------
// Independent of Steam Input. Shows what the browser/OS sees, so we can tell
// "OS sees pad, Steam doesn't" apart from "no pad at all".
//
// IMPORTANT: Chromium's Gamepad API has TWO privacy requirements before it
// returns anything:
//   1. The page must have received a user gesture (any click in the window).
//   2. The pad must have sent at least one input event WHILE THE WINDOW HAS
//      FOCUS. Background-window button presses don't count.
// We surface this explicitly so an empty list doesn't get misread as
// "controller isn't plugged in."
let pageGestureSeen = false;
window.addEventListener('click', () => { pageGestureSeen = true; }, { capture: true });
window.addEventListener('keydown', () => { pageGestureSeen = true; }, { capture: true });
function isWindowFocused() {
  return document.hasFocus && document.hasFocus();
}
function renderGamepads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const present = [];
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (!p) continue;
    const axes = p.axes.map(a => a.toFixed(2)).join(', ');
    const buttons = p.buttons.map((b, bi) => b.pressed ? bi : null).filter(x => x !== null).join(', ') || '-';
    present.push(
      `<div class="device-row">
        <div><b>#${p.index}</b> <code>${p.id}</code></div>
        <div>mapping <code>${p.mapping || '(none)'}</code> &middot; connected <code>${p.connected}</code></div>
        <div>axes [${p.axes.length}]: <code>${axes}</code></div>
        <div>buttons pressed: <code>${buttons}</code></div>
      </div>`
    );
  }
  const el = $('gp-list');
  if (!el) return;
  if (present.length) {
    el.innerHTML = present.join('');
    return;
  }
  // Empty state: explain WHY it might be empty rather than just saying it is.
  const focused = isWindowFocused();
  const checks = [
    { ok: pageGestureSeen, label: 'Click anywhere in this window (any single click counts as the page user-gesture Chromium requires).' },
    { ok: focused,         label: 'Keep THIS window focused while pressing the controller — Chromium ignores background pad input.' },
    { ok: false,           label: 'Press any button on the controller. Gamepad API only fires after the first input event reaches the focused page.' },
  ];
  el.innerHTML = `
    <div class="empty">No gamepads visible to Chromium yet.</div>
    <ul class="hint-banner">
      ${checks.map(c => `<li><span class="value ${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '○'}</span> ${c.label}</li>`).join('')}
    </ul>
    <div class="hint">
      If you've done all three and still see nothing here: (a) Steam Input may be capturing the pad as a virtual XInput device that needs the focused-window button press to show up;
      (b) Steam Controller v1 won't appear at all unless Steam is running and applies a desktop config that exposes it as XInput — it has no native Windows gamepad driver;
      (c) try the <b>Connect Any HID</b> button on the right — WebHID has a different permission model and will show the raw device even if Gamepad API ignores it.
    </div>
  `;
}
setInterval(renderGamepads, 100);
window.addEventListener('gamepadconnected', renderGamepads);
window.addEventListener('gamepaddisconnected', renderGamepads);

// ---------- Copy repro snapshot ----------
$('copy-repro-btn').addEventListener('click', async () => {
  const snap = window.steamTest.getLatest();
  const iga = await window.steamTest.checkIGA();
  const log = await window.steamTest.controllerLogTail();
  const devs = [];
  for (const [key, entry] of connectedDevices) {
    devs.push({
      key,
      productName: entry.device.productName,
      lastReport: entry.lastReports[0] || null,
    });
  }
  const pads = (navigator.getGamepads ? navigator.getGamepads() : [])
    .filter(p => p)
    .map(p => ({ index: p.index, id: p.id, mapping: p.mapping, connected: p.connected, axes: p.axes.length, buttons: p.buttons.length }));
  const report = [
    '# Steam Controller Test Bench diagnostic snapshot',
    `Timestamp: ${new Date().toISOString()}`,
    '',
    '## Steam Input',
    `SDK ready: ${snap.ready}`,
    `Seconds since init: ${(snap.secondsSinceReady || 0).toFixed(1)}`,
    `Session config bitmask: ${snap.sessionConfig}`,
    `Handles: ${JSON.stringify(snap.handles, null, 2)}`,
    `Gamepad-index probe: ${JSON.stringify(snap.gamepadIndexProbe, null, 2)}`,
    `Captured controllers (${snap.controllers.length}):`,
    JSON.stringify(snap.controllers, null, 2),
    '',
    '## Gamepad API (OS-level)',
    pads.length ? JSON.stringify(pads, null, 2) : '(no gamepads visible to the OS)',
    '',
    '## IGA file presence',
    iga.map(r => `${r.exists ? 'OK' : 'MISSING'}  ${r.path}${r.exists ? '  (' + r.size + 'b)' : ''}`).join('\n'),
    '',
    '## Steam controller.txt tail',
    log.join('\n'),
    '',
    '## WebHID devices',
    JSON.stringify(devs, null, 2),
  ].join('\n');
  try {
    await navigator.clipboard.writeText(report);
    $('copy-status').textContent = 'Copied!';
    setTimeout(() => { $('copy-status').textContent = ''; }, 2000);
  } catch (e) {
    $('copy-status').textContent = 'Copy failed: ' + e.message;
  }
});
