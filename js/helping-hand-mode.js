// ============================================================
// HELPING HAND MODE — retries get easier, visibly (#403)
// ============================================================
//
// Game methods, installed like js/economy-mode.js, so game.js only holds
// one-line call sites. The schedule itself (failures → tier) is pure, in
// js/helping-hand.js; this file is the wiring:
//
//   _startCountdown        → _helpStartRide(keep)   new ride, or a retry of segment 1
//   _showGameOver / timeout → _helpOnFailure()       a failure at this checkpoint
//   checkpoint / skip      → _helpOnCheckpoint()    the count resets
//   _updateDisruptions     → this._helpGustScale    half gusts / no gusts
//   RaceManager budget     → raceManager.helpTimeScale (+25 % / +50 %)
//   end screens            → _helpFlags(), _helpMedal()  🛟 / no medal
//
// Co-op: the captain is authoritative. It counts the failures and sends one
// profile message, { type: 'helpingHand', tier, helped, skipped }, whenever any
// of those change; the stoker applies the same tier (gust banner and wind,
// timer bar total, safety, HUD badge) and the same flags for its end screen.
// The gust force itself only matters on the captain, which owns the physics.

import {
  helpingHandFor, helpTier, HELP_TIERS, SKIP_LABEL
} from './helping-hand.js';
import { capMedal, medalFor, HELPED_ICON } from './records.js';

export const HELP_PROFILE_TYPE = 'helpingHand';

class HelpingHandMode {
  /** Does this ride get the helping hand at all? */
  _helpEligible() {
    const level = this.lobby && this.lobby.selectedLevel;
    if (!level) return false;
    if (this.mode === 'versus' || this.isSlingshot) return false;
    if (level.isTutorial || this._tutorialActive) return false;
    if (level.timerEnabled === false || this._touristRoute || this.isTourist) return false;
    if (this._rankedRunActive) return false;   // ranked stays pure (D-2)
    // PR #397 M1: an old-build partner can't follow the tier (its timer would
    // run out first), so a room with one gets no helping hand at all.
    if (this._roomRules && !this._roomRules().helpingHand && (this.mode === 'captain' || this.mode === 'stoker')) return false;
    return true;
  }

  /** The help state, created on first use. */
  _helpState() {
    if (!this._help) this._help = { tier: 0, helped: false, skipped: false };
    return this._help;
  }

  /** { helped, skipped } for the end screens and the records. */
  _helpFlags() {
    const h = this._helpState();
    return { helped: !!h.helped, skipped: !!h.skipped };
  }

  /** The medal this ride keeps: medalFor(), capped by the helping hand. */
  _helpMedal(timeMs, thresholds) {
    return capMedal(medalFor(timeMs, thresholds), this._helpFlags());
  }

  /**
   * Called from _startCountdown once the RaceManager exists. `keep` is true
   * when this is a retry of the first segment (the DDA and its count survive):
   * the tier carries over, and the new run is a helped one if a tier is on.
   */
  _helpStartRide(keep) {
    const h = this._helpState();
    // The stoker's countdown runs on every captain countdown, so it never
    // decides anything here: it re-applies whatever the captain last sent.
    if (this.mode !== 'stoker') {
      if (!keep || !this._helpEligible()) {
        h.tier = 0;
        // m13: give safety back. _applySafetyDefault has already reset an
        // untouched choice to the difficulty's default; a player who pressed
        // SAFETY had it off before Sir Winston turned it on.
        if (this._helpSafetyPrev === false && this._safetyTouched) {
          this.safetyMode = false;
          if (this._updateSafetyBtn) this._updateSafetyBtn();
        }
        this._helpSafetyPrev = null;
      }
      h.helped = h.tier > 0;
      h.skipped = false;
    }
    this._applyHelpEffects();
    this._renderHelpAnnounce();
    this._sendHelpState();
  }

  /** Ride over (lobby / room): drop the badge and give safety back. */
  _helpEndRide() {
    const h = this._helpState();
    h.tier = 0;
    this._applyHelpEffects();
    this._renderHelpAnnounce();
  }

  /**
   * A failure was just recorded at `checkpointD` (captain / solo only). Works
   * out the next attempt's tier, applies it, and says so on the screen.
   * @returns the helpingHandFor() result, or null when not eligible
   */
  _helpOnFailure(checkpointD) {
    if (!this.ddaManager || this.mode === 'stoker' || !this._helpEligible()) return null;
    const hh = helpingHandFor(this.ddaManager.getFailureCount(checkpointD));
    // A failure ends the attempt: the next one gets its own three crashes
    // before the modal, so an "attempt" means the same thing every time.
    this._crashState = null;
    this._setHelpTier(hh.tier);
    this._renderHelpAnnounce();
    return hh;
  }

  /** The checkpoint was passed (or skipped): the count, and the tier, reset. */
  _helpOnCheckpoint() {
    if (this.mode === 'stoker') return;
    if (this._helpState().tier !== 0) this._setHelpTier(0);
    this._renderHelpAnnounce();
  }

  /** ASSIST was switched on: the ride counts as helped. */
  _helpMarkAssisted() {
    const h = this._helpState();
    if (h.helped || !this._helpEligible()) return;
    h.helped = true;
    this._sendHelpState();
  }

  /** The Royal Shortcut was taken: no medal, no best for this ride. */
  _helpMarkSkipped() {
    this._helpState().skipped = true;
    this._sendHelpState();
  }

  _setHelpTier(tier, fromRemote = false) {
    const h = this._helpState();
    h.tier = helpTier(tier);
    if (h.tier > 0) h.helped = true;
    this._applyHelpEffects();
    if (!fromRemote) this._sendHelpState();
  }

  /** Push the current tier onto the gusts, the clock, safety and the HUD. */
  _applyHelpEffects() {
    const h = this._helpState();
    const t = HELP_TIERS[h.tier] || HELP_TIERS[0];
    this._helpGustScale = t.gustScale;
    if (this.raceManager) this.raceManager.helpTimeScale = t.timeScale;
    if (t.safety && !this.safetyMode) {
      this._helpSafetyPrev = false;
      this.safetyMode = true;
      if (this._updateSafetyBtn) this._updateSafetyBtn();
    } else if (!t.safety && this._helpSafetyPrev === false) {
      this._helpSafetyPrev = null;
      this.safetyMode = false;
      if (this._updateSafetyBtn) this._updateSafetyBtn();
    }
    if (this.hud && this.hud.setHelpBadge) this.hud.setHelpBadge(h.tier, t.label);
  }

  /** The line on the crash and TOO SLOW screens, and the SKIP button's name. */
  _renderHelpAnnounce() {
    if (typeof document === 'undefined') return;
    const h = this._helpState();
    const t = HELP_TIERS[h.tier] || HELP_TIERS[0];
    for (const id of ['gameover-help', 'timeout-help']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = t.label;
      el.style.display = t.label ? '' : 'none';
    }
    const skip = document.getElementById('btn-skip-checkpoint');
    if (skip) skip.textContent = SKIP_LABEL;
  }

  _sendHelpState() {
    if (this.mode !== 'captain' || !this.net || !this.net.sendProfile) return;
    const h = this._helpState();
    try {
      this.net.sendProfile({ type: HELP_PROFILE_TYPE, tier: h.tier, helped: !!h.helped, skipped: !!h.skipped });
    } catch (_) { /* a dropped message only costs the badge */ }
  }

  /** Stoker: the captain's tier and flags. */
  _onHelpProfile(profile) {
    if (this.mode !== 'stoker') return;
    const h = this._helpState();
    h.helped = !!profile.helped;
    h.skipped = !!profile.skipped;
    this._setHelpTier(profile.tier, true);
    this._renderHelpAnnounce();
  }

  /** The 🛟 line for the victory screen, or '' for an unhelped ride. */
  _helpVictoryNote() {
    const { helped, skipped } = this._helpFlags();
    if (skipped) return '<div class="victory-stat">👑 Royal Shortcut taken — no medal or best this time</div>';
    if (helped) return '<div class="victory-stat">' + HELPED_ICON + ' Finished with a helping hand — bronze at most</div>';
    return '';
  }
}

/** Copy the methods onto Game's prototype (they run as Game methods). */
export function installHelpingHandMode(GameClass) {
  for (const key of Object.getOwnPropertyNames(HelpingHandMode.prototype)) {
    if (key === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(GameClass.prototype, key)) {
      throw new Error(`helping-hand-mode: Game already has ${key}`);
    }
    Object.defineProperty(GameClass.prototype, key, Object.getOwnPropertyDescriptor(HelpingHandMode.prototype, key));
  }
}
