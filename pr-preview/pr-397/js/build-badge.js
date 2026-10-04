// ============================================================
// BUILD BADGE — which build is this phone actually running?
// ============================================================
//
// PR previews are stamped by .github/workflows/pr-preview.yml with the PR's
// head commit: window.__BUILD in index.html, a version.json beside it, and the
// same sha replaced into MODULE_SHA below. This module then:
//   - shows "PR #n · sha" in the corner, so a tester can match it to the PR;
//   - notices when index.html and the cached game modules disagree (stale JS);
//   - notices when a newer build has been deployed since the page loaded.
// Either mismatch offers a one-tap reload. Outside a preview it does nothing.

const MODULE_SHA = '7aa7492';

function banner(text) {
  if (document.getElementById('build-stale')) return;
  const b = document.createElement('button');
  b.id = 'build-stale';
  b.textContent = text;
  b.addEventListener('click', () => location.reload());
  document.body.appendChild(b);
}

(function showBuild() {
  const build = typeof window !== 'undefined' ? window.__BUILD : null;
  if (!build || !build.sha) return;
  const badge = document.createElement('div');
  badge.id = 'build-badge';
  badge.textContent = `PR #${build.pr} · ${build.sha}`;
  document.body.appendChild(badge);

  const stamped = !MODULE_SHA.startsWith('%%');
  if (stamped && MODULE_SHA !== build.sha) {
    banner(`Old game files cached (${MODULE_SHA}) — tap to reload`);
  }
  fetch('version.json', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(v => { if (v && v.sha && v.sha !== build.sha) banner(`New build ${v.sha} — tap to reload`); })
    .catch(() => { /* offline: nothing to compare */ });
})();
