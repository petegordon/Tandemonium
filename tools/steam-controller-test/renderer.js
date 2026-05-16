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

  const h = snap.handles || {};
  $('si-h-set').textContent = h.set || '0';
  $('si-h-set').className = 'value ' + ((h.set && h.set !== '0') ? 'ok' : 'bad');
  $('si-h-steer').textContent = h.steer || '0';
  $('si-h-steer').className = 'value ' + ((h.steer && h.steer !== '0') ? 'ok' : 'bad');
  $('si-h-confirm').textContent = h.confirm || '0';
  $('si-h-confirm').className = 'value ' + ((h.confirm && h.confirm !== '0') ? 'ok' : 'bad');

  const ctrlsEl = $('si-controllers');
  const ctrls = snap.controllers || [];
  if (ctrls.length === 0) {
    ctrlsEl.innerHTML = '<div class="empty">No controllers captured by Steam Input yet.</div>';
  } else {
    ctrlsEl.innerHTML = ctrls.map((c, i) =>
      `<div class="controller-row">
        <div><b>#${i}</b> handle <code>${c.handle}</code> &middot; type <code>${c.type}</code></div>
        <div>Steer: x=<code>${c.steerX.toFixed(3)}</code> y=<code>${c.steerY.toFixed(3)}</code></div>
        <div>Confirm: <code>${c.confirm ? 'PRESSED' : '-'}</code></div>
      </div>`
    ).join('');
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
  const report = [
    '# Steam Controller Test Bench diagnostic snapshot',
    `Timestamp: ${new Date().toISOString()}`,
    '',
    '## Steam Input',
    `SDK ready: ${snap.ready}`,
    `Handles: ${JSON.stringify(snap.handles, null, 2)}`,
    `Captured controllers (${snap.controllers.length}):`,
    JSON.stringify(snap.controllers, null, 2),
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
