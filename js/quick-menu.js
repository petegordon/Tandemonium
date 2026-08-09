// ============================================================
// QUICK MENU — the single in-ride control button + its sheet
// ============================================================
//
// Replaces the top-right D-pad disc and the two floating buttons that used to
// stack down the left edge (clip + music). Those elements still exist and still
// own all the behaviour; this is purely a front end for them:
//
//   * clicking a sheet entry forwards a click() to the real button, so every
//     handler, analytics call and network side effect runs exactly as before;
//   * the sheet reads its labels back off those same buttons when it opens, so
//     there is no second copy of "is safety on" to drift out of sync;
//   * availability follows their inline `style.display`, which Game and
//     GameRecorder already maintain (stoker loses the ride controls, the clip
//     entry only lights up once a recording is buffering).
//
// Two taps to reach anything: one to open, one to act. Nothing is on screen
// while riding except the button itself.

export class QuickMenu {
  /**
   * @param {object} [recenter]  the one entry with no button behind it:
   *   { available(): boolean, run(): void } — tilt recentring, which lost its
   *   on-screen affordance along with the YOU lean gauge.
   */
  constructor(recenter) {
    this.btn = document.getElementById('quick-menu-btn');
    this.overlay = document.getElementById('quick-menu-overlay');
    this.sheet = document.getElementById('quick-menu-sheet');
    if (!this.btn || !this.overlay) return;

    // The real controls. Everything here is a proxy for one of them.
    this.sideButtons = document.getElementById('side-buttons');
    this.safetyBtn = document.getElementById('safety-btn');
    this.speedBtn = document.getElementById('speed-btn');
    this.assistBtn = document.getElementById('assist-btn');
    this.resetBtn = document.getElementById('reset-btn');
    this.lobbyBtn = document.getElementById('lobby-btn');
    this.shareBtn = document.getElementById('share-btn');
    this.musicBtn = document.getElementById('music-btn');

    this.recenter = recenter || null;
    this.open = false;

    this.btn.addEventListener('click', () => this.toggle());
    document.getElementById('quick-menu-close').addEventListener('click', () => this.close());
    // Tapping the dimmed backdrop (anywhere outside the sheet) closes too.
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) {
        e.stopPropagation();
        this.close();
      }
    });

    // Toggles keep the sheet open so the new state is visible; actions close it.
    this._bind('qm-safety', this.safetyBtn, false);
    this._bind('qm-speed', this.speedBtn, false);
    this._bind('qm-assist', this.assistBtn, false);
    this._bind('qm-music', this.musicBtn, false);
    this._bind('qm-clip', this.shareBtn, true);
    this._bind('qm-reset', this.resetBtn, true);
    this._bind('qm-lobby', this.lobbyBtn, true);

    const recenterEl = document.getElementById('qm-recenter');
    if (recenterEl) {
      recenterEl.addEventListener('click', () => {
        if (this.recenter) this.recenter.run();
        this.close();
      });
    }
  }

  /** Show or hide the corner button — called when a ride starts and ends. */
  setVisible(visible) {
    if (!this.btn) return;
    this.btn.classList.toggle('visible', visible);
    if (!visible) this.close();
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    if (!this.overlay) return;
    this.sync();
    this.open = true;
    this.overlay.classList.add('visible');
    this.btn.setAttribute('aria-expanded', 'true');
  }

  close() {
    if (!this.overlay) return;
    this.open = false;
    this.overlay.classList.remove('visible');
    this.btn.setAttribute('aria-expanded', 'false');
  }

  /**
   * Pull every entry's label, on/off styling and enabled state from the button
   * it proxies. Runs on open and after each toggle, which is often enough —
   * nothing in the sheet can change while it is closed and unseen.
   */
  sync() {
    // Game hides #side-buttons for the stoker: only the captain owns safety,
    // speed and reset. Mirror that rather than handing the stoker controls the
    // D-pad never gave them.
    const rideControls = this.sideButtons && this.sideButtons.style.display !== 'none';
    this._show('qm-safety', rideControls);
    this._show('qm-speed', rideControls);
    this._show('qm-reset', rideControls);
    this._show('qm-lobby', rideControls);

    this._setState('qm-safety', this._isOn(this.safetyBtn, 'safety-on'));
    this._setState('qm-speed', this._isOn(this.speedBtn, 'speed-on'));

    // Assist only exists once the difficulty manager offers it.
    const assistOffered = this.assistBtn && this.assistBtn.style.display !== 'none';
    this._show('qm-assist', !!assistOffered);
    this._setState('qm-assist', this._isOn(this.assistBtn, 'assist-on'));

    // #music-btn carries `.muted` when the track is off.
    const musicOn = this.musicBtn && !this.musicBtn.classList.contains('muted');
    this._setState('qm-music', !!musicOn);

    // Recentring only means anything to a rider steering by tilt or gyro.
    this._show('qm-recenter', !!(this.recenter && this.recenter.available()));

    // The recorder shows #share-btn only while a clip is actually buffering.
    const clipReady = this.shareBtn && this.shareBtn.style.display !== 'none';
    const clip = document.getElementById('qm-clip');
    if (clip) {
      clip.disabled = !clipReady;
      clip.querySelector('.qm-state').textContent = clipReady ? '' : 'N/A';
    }
  }

  _bind(id, target, closeAfter) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', () => {
      if (el.disabled || !target) return;
      target.click();
      if (closeAfter) this.close();
      else this.sync();
    });
  }

  _show(id, visible) {
    const el = document.getElementById(id);
    if (el) el.hidden = !visible;
  }

  _isOn(btn, onClass) {
    return !!(btn && btn.classList.contains(onClass));
  }

  _setState(id, on) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('qm-on', on);
    const state = el.querySelector('.qm-state');
    if (state) state.textContent = on ? 'ON' : 'OFF';
  }
}
