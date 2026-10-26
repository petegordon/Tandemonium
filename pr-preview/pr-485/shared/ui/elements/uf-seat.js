// @ts-check
// ============================================================
// <uf-seat> — a seat in the lobby: who sits here, on what controller, and whether they are ready.
// ============================================================
//
// Owns its DOM (render() returns markup). Pure function of its props, so the
// lab's seat-select app and the game's versus / co-op lobbies can both drive
// it from state without touching its internals.
//
//   <uf-seat seat="Captain" who="P1" dev="DualSense" state="ready" tone="team-a" badge="P1"></uf-seat>
//   <uf-seat seat="Stoker" state="open" hint="press <uf-controller-glyph button=confirm></uf-controller-glyph> on any controller"></uf-seat>
//   <uf-seat seat="Stoker" state="candidate" who="Switch Pro" hint="press <uf-controller-glyph button=confirm family=nintendo></uf-controller-glyph> to join"></uf-seat>
//   <uf-seat seat="Stoker" state="locked" who="LOCKED" dev="solo"></uf-seat>
//
// States: open (empty) · candidate (a connected, unseated controller offered
// for this seat) · joined · ready · locked. `hint` is authored HTML (so it can
// hold a <uf-controller-glyph>) and replaces `dev` when set. Open and candidate
// seats are focusable (FocusController picks them up via uf-step.focusables()).
//
// Replaces: the lab's .seat (+ .cap/.sto/.ta/.tb/.open/.joined/.ready/.locked);
// the game's .versus-player-card (+ .vp-join / .vp-empty) and the
// "JOIN AS PLAYER 2" buttons (docs/UI-KIT-TV-COMPONENTS.md §5).

import { UfElement, prop, esc } from '../uf-element.js';

export class UfSeat extends UfElement {
  /** @override */ static tag = 'uf-seat';

  /** @override */ static props = {
    seat: prop.string('Captain'),   // "role" would shadow HTMLElement.role (ARIA)
    who: prop.string('OPEN'),
    dev: prop.string(''),
    hint: prop.string(''),
    state: prop.enum(/** @type {const} */ (['open', 'candidate', 'joined', 'ready', 'locked']), 'open'),
    tone: prop.enum(/** @type {const} */ (['captain', 'stoker', 'team-a', 'team-b']), 'captain'),
    badge: prop.string(''),
  };

  /** @override */ static styles = `
    uf-seat {
      --_tone: var(--uf-color-captain);
      position: relative; box-sizing: border-box; min-height: calc(var(--uf-size-lg) * 3.6); border-radius: var(--uf-radius-md); padding: var(--uf-space-2) var(--uf-space-3);
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; text-align: center;
      background: var(--uf-color-surface-3); border: 1.5px solid var(--uf-color-line-soft); color: var(--uf-color-fg);
      font-family: var(--uf-font-ui); transition: border-color var(--uf-motion-base), box-shadow var(--uf-motion-base), opacity var(--uf-motion-base);
    }
    uf-seat[tone="stoker"] { --_tone: var(--uf-color-stoker); }
    uf-seat[tone="team-a"] { --_tone: var(--uf-color-team-a); }
    uf-seat[tone="team-b"] { --_tone: var(--uf-color-team-b); }
    uf-seat[state="joined"], uf-seat[state="ready"] { border-color: var(--_tone); }
    uf-seat[state="joined"] { animation: uf-seat-pop .34s cubic-bezier(.2,1.5,.4,1); }
    uf-seat[state="ready"] { box-shadow: 0 0 18px -4px var(--_tone); animation: uf-seat-bob 1.9s ease-in-out infinite; }
    uf-seat[state="open"] { border-style: dashed; border-color: color-mix(in srgb, var(--_tone) 55%, transparent); background: color-mix(in srgb, var(--_tone) 5%, transparent); cursor: pointer; }
    uf-seat[state="open"] .uf-seat__who { color: var(--uf-color-fg-muted); }
    uf-seat[state="candidate"] { border-color: color-mix(in srgb, var(--_tone) 70%, transparent); background: color-mix(in srgb, var(--_tone) 14%, transparent); cursor: pointer; }
    uf-seat[state="locked"] { opacity: .3; border-style: dashed; background: repeating-linear-gradient(45deg, var(--uf-color-surface-3) 0 6px, transparent 6px 12px); }
    uf-seat .uf-seat__role { font: 700 var(--uf-size-xs)/1.3 var(--uf-font-mono); letter-spacing: 1.4px; color: var(--_tone); text-transform: uppercase; }
    uf-seat .uf-seat__who { font: 700 var(--uf-size-lg)/1.2 var(--uf-font-ui); letter-spacing: .3px; }
    uf-seat[state="joined"] .uf-seat__who, uf-seat[state="ready"] .uf-seat__who { color: var(--_tone); }
    uf-seat .uf-seat__dev { font: var(--uf-size-sm)/1.3 var(--uf-font-ui); color: var(--uf-color-fg-muted); }
    uf-seat .uf-seat__dev uf-controller-glyph { margin: 0 .15em; }
    uf-seat .uf-seat__badge { position: absolute; top: 6px; right: 8px; font: 800 var(--uf-size-xs)/1 var(--uf-font-mono); padding: 3px 6px; border-radius: var(--uf-radius-sm); background: var(--_tone); color: var(--uf-color-bg); }
    uf-seat .uf-seat__check { font: 800 var(--uf-size-xs)/1 var(--uf-font-mono); letter-spacing: 1px; color: var(--uf-color-accent); margin-bottom: 1px; }
    uf-seat.gamepad-focus, uf-seat:focus-visible { outline: none; box-shadow: var(--uf-focus-ring); }
    @keyframes uf-seat-pop { 0% { transform: scale(.86); } 60% { transform: scale(1.04); } 100% { transform: scale(1); } }
    @keyframes uf-seat-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
    @media (prefers-reduced-motion: reduce) { uf-seat { animation: none !important; } }
  `;

  /** @returns {string} */ get seat() { return this.get('seat'); }
  /** @param {string} v */ set seat(v) { this.set('seat', v); }

  /** @returns {string} */ get who() { return this.get('who'); }
  /** @param {string} v */ set who(v) { this.set('who', v); }

  /** @returns {string} */ get dev() { return this.get('dev'); }
  /** @param {string} v */ set dev(v) { this.set('dev', v); }

  /** Authored HTML under the name (may hold a uf-controller-glyph); wins over `dev`. @returns {string} */
  get hint() { return this.get('hint'); }
  /** @param {string} v */ set hint(v) { this.set('hint', v); }

  /** @returns {'open' | 'candidate' | 'joined' | 'ready' | 'locked'} */ get state() { return this.get('state'); }
  /** @param {'open' | 'candidate' | 'joined' | 'ready' | 'locked'} v */ set state(v) { this.set('state', v); }

  /** @returns {'captain' | 'stoker' | 'team-a' | 'team-b'} */ get tone() { return this.get('tone'); }
  /** @param {'captain' | 'stoker' | 'team-a' | 'team-b'} v */ set tone(v) { this.set('tone', v); }

  /** @returns {string} */ get badge() { return this.get('badge'); }
  /** @param {string} v */ set badge(v) { this.set('badge', v); }

  /** Open and candidate seats take focus; the rest are read-only. */
  #syncFocusable() {
    const focusable = this.state === 'open' || this.state === 'candidate';
    this.toggleAttribute('data-focusable', focusable);
    if (focusable) this.setAttribute('tabindex', '0'); else this.removeAttribute('tabindex');
    this.setAttribute('role', focusable ? 'button' : 'group');
    this.setAttribute('aria-label', `${this.seat}: ${this.who}`);
  }

  /** @override */
  render() {
    const sub = this.hint
      ? `<span class="uf-seat__dev">${this.hint}</span>`
      : (this.dev ? `<span class="uf-seat__dev">${esc(this.dev)}</span>` : '');
    return (this.badge ? `<span class="uf-seat__badge">${esc(this.badge)}</span>` : '') +
      (this.state === 'ready' ? `<span class="uf-seat__check">✓ READY</span>` : '') +
      `<span class="uf-seat__role">${esc(this.seat)}</span>` +
      `<span class="uf-seat__who">${esc(this.who)}</span>` + sub;
  }

  /** @override @param {Set<string>} _changed */
  afterRender(_changed) { this.#syncFocusable(); }
}

UfSeat.define();
