// ============================================================
// VERSUS HUD — per-team panels + winner banner + results overlay
// (issue #351). Built entirely in JS so the singleton HUD markup
// in index.html stays untouched; styling lives with the other
// versus CSS in index.html (`#versus-hud`, `.vh-*`).
// ============================================================

export class VersusHud {
  /** @param {TeamRig[]} rigs — [teamA, teamB], render order = screen order */
  constructor(rigs) {
    this.rigs = rigs;
    this.raceDistance = 0;
    this.checkpointFracs = [];

    this.root = document.createElement('div');
    this.root.id = 'versus-hud';

    this.panels = rigs.map((rig, i) => {
      const panel = document.createElement('div');
      panel.className = `vh-panel ${i === 0 ? 'vh-left' : 'vh-right'}`;
      panel.style.setProperty('--vh-color', rig.color.hex);
      panel.innerHTML = `
        <div class="vh-chip">${rig.color.name}</div>
        <div class="vh-stats"><span class="vh-speed">0</span><span class="vh-unit"> km/h</span> &middot; <span class="vh-dist">0m</span> &middot; <span class="vh-items">🎁 0</span></div>
        <div class="vh-progress">
          <div class="vh-prog-fill"></div>
          <div class="vh-ticks"></div>
          <div class="vh-marker vh-marker-a" title="Team Blue"></div>
          <div class="vh-marker vh-marker-b" title="Team Red"></div>
        </div>
        <div class="vh-tilt-row">
          <span class="vh-tilt-label">TILT</span>
          <div class="vh-tilt">
            <div class="vh-tilt-bike"></div>
            <div class="vh-tilt-center"></div>
            <div class="vh-tilt-needle vh-n1"></div>
            ${rig.isDuo ? '<div class="vh-tilt-needle vh-n2"></div>' : ''}
          </div>
        </div>
        ${rig.isDuo ? '<div class="vh-sync"><span class="vh-sync-dot"></span> PEDAL SYNC</div>' : ''}
        <div class="vh-crash">CRASHED!</div>`;
      this.root.appendChild(panel);
      return {
        el: panel,
        speed: panel.querySelector('.vh-speed'),
        dist: panel.querySelector('.vh-dist'),
        items: panel.querySelector('.vh-items'),
        fill: panel.querySelector('.vh-prog-fill'),
        ticks: panel.querySelector('.vh-ticks'),
        markerA: panel.querySelector('.vh-marker-a'),
        markerB: panel.querySelector('.vh-marker-b'),
        syncDot: panel.querySelector('.vh-sync-dot'),
        tiltBike: panel.querySelector('.vh-tilt-bike'),
        tiltN1: panel.querySelector('.vh-tilt-needle.vh-n1'),
        tiltN2: panel.querySelector('.vh-tilt-needle.vh-n2'),
        crash: panel.querySelector('.vh-crash'),
        _lastSpeed: -1,
        _lastDist: -1,
        _lastItems: -1,
        _crashVisible: false,
      };
    });

    this.banner = document.createElement('div');
    this.banner.id = 'versus-banner';
    this.banner.style.display = 'none';
    this.root.appendChild(this.banner);

    this.resultsEl = null;
    document.body.appendChild(this.root);
  }

  /** Call when a race (re)starts: sizes the progress bars to the level. */
  initProgress(level, checkpoints) {
    this.raceDistance = level.distance;
    this.checkpointFracs = (checkpoints || []).map((d) => d / level.distance);
    for (const p of this.panels) {
      p.ticks.innerHTML = this.checkpointFracs
        .map((f) => `<span class="vh-tick" style="left:${(f * 100).toFixed(1)}%"></span>`)
        .join('');
      p._lastSpeed = -1;
      p._lastDist = -1;
    }
    this.hideBanner();
    this.hideResults();
  }

  /** Per-frame update. Cheap: writes only on value change. */
  update() {
    if (!this.raceDistance) return;
    const progA = Math.min(1, this.rigs[0].bike.distanceTraveled / this.raceDistance);
    const progB = Math.min(1, this.rigs[1].bike.distanceTraveled / this.raceDistance);

    for (let i = 0; i < this.panels.length; i++) {
      const p = this.panels[i];
      const rig = this.rigs[i];
      const speed = Math.round(rig.bike.speed * 3.6);
      if (speed !== p._lastSpeed) {
        p._lastSpeed = speed;
        p.speed.textContent = speed;
      }
      const dist = Math.floor(rig.bike.distanceTraveled);
      if (dist !== p._lastDist) {
        p._lastDist = dist;
        p.dist.textContent = `${dist}m`;
      }
      // Own progress fills the bar; both team markers ride on every bar so
      // each side sees the gap at a glance. Keyed on EITHER team moving —
      // the rival's marker must advance even while this bike is stopped.
      const barKey = `${(progA * 1000) | 0}|${(progB * 1000) | 0}`;
      if (barKey !== p._lastBarKey) {
        p._lastBarKey = barKey;
        const own = i === 0 ? progA : progB;
        p.fill.style.width = `${(own * 100).toFixed(1)}%`;
        p.markerA.style.left = `${(progA * 100).toFixed(1)}%`;
        p.markerB.style.left = `${(progB * 100).toFixed(1)}%`;
      }
      if (rig.collectibles !== p._lastItems) {
        p._lastItems = rig.collectibles;
        p.items.textContent = `🎁 ${rig.collectibles}`;
      }
      if (p.syncDot) {
        // offsetScore 0-1 → red→yellow→green sync dot
        const s = rig.pedalCtrl.offsetScore ?? 0.5;
        const hue = Math.round(s * 120);
        p.syncDot.style.background = `hsl(${hue}, 90%, 55%)`;
      }
      // Tilt gauge: bar fill = actual bike lean, needle(s) = each rider's
      // live steering input (gyro/stick/keys, pre-merge) so players get
      // immediate feedback that their tilt is registering.
      if (p.tiltBike) {
        const leanPct = Math.max(-1, Math.min(1, (rig.bike.lean || 0) / 0.6));
        if (leanPct >= 0) {
          p.tiltBike.style.left = '50%';
          p.tiltBike.style.width = `${(leanPct * 50).toFixed(1)}%`;
        } else {
          p.tiltBike.style.left = `${(50 + leanPct * 50).toFixed(1)}%`;
          p.tiltBike.style.width = `${(-leanPct * 50).toFixed(1)}%`;
        }
        const leans = rig.hudLeans || [0, 0];
        p.tiltN1.style.left = `${(50 + Math.max(-1, Math.min(1, leans[0])) * 48).toFixed(1)}%`;
        if (p.tiltN2) {
          p.tiltN2.style.left = `${(50 + Math.max(-1, Math.min(1, leans[1])) * 48).toFixed(1)}%`;
        }
      }
      const crashed = rig.bike.fallen;
      if (crashed !== p._crashVisible) {
        p._crashVisible = crashed;
        p.crash.style.display = crashed ? 'block' : 'none';
      }
    }
  }

  showBanner(text, colorHex) {
    this.banner.textContent = text;
    this.banner.style.color = colorHex || '#ffffff';
    this.banner.style.display = 'block';
  }

  hideBanner() {
    this.banner.style.display = 'none';
  }

  /**
   * Full-screen results overlay. Returns { rematchBtn, lobbyBtn } so the
   * game can wire click handlers + gamepad overlay navigation.
   */
  showResults(winner, loser) {
    this.hideResults();
    const el = document.createElement('div');
    el.id = 'versus-results';
    const line = (rig, outcome) => `
      <div class="vr-team" style="--vh-color:${rig.color.hex}">
        <div class="vr-team-name">${rig.color.name}</div>
        <div class="vr-outcome">${outcome}</div>
        <div class="vr-detail">${rig.crashCount} crash${rig.crashCount === 1 ? '' : 'es'} &middot; 🎁 ${rig.collectibles}</div>
      </div>`;
    el.innerHTML = `
      <div class="vr-card">
        <div class="vr-title" style="color:${winner.color.hex}">${winner.color.name} WINS!</div>
        <div class="vr-teams">
          ${line(winner, winner.raceManager.getElapsedFormatted())}
          ${line(loser, `DNF &mdash; ${Math.floor(loser.bike.distanceTraveled)}m`)}
        </div>
        <button class="lobby-btn lobby-btn-accent" id="vr-rematch">REMATCH</button>
        <button class="lobby-btn" id="vr-lobby">LOBBY</button>
      </div>`;
    document.body.appendChild(el);
    this.resultsEl = el;
    return {
      rematchBtn: el.querySelector('#vr-rematch'),
      lobbyBtn: el.querySelector('#vr-lobby'),
    };
  }

  hideResults() {
    if (this.resultsEl) {
      this.resultsEl.remove();
      this.resultsEl = null;
    }
  }

  destroy() {
    this.hideResults();
    this.root.remove();
  }
}
