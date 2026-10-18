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
//   <uf-seat seat="Stoker" state="open"></uf-seat>
//   <uf-seat seat="Stoker" state="locked" who="LOCKED" dev="solo"></uf-seat>
//
// Replaces: the lab's .seat (+ .cap/.sto/.ta/.tb/.open/.joined/.ready/.locked).

import { UfElement, prop, esc } from '../uf-element.js';

export class UfSeat extends UfElement {
  /** @override */ static tag = 'uf-seat';

  /** @override */ static props = {
    seat: prop.string('Captain'),   // "role" would shadow HTMLElement.role (ARIA)
    who: prop.string('OPEN'),
    dev: prop.string(''),
    state: prop.enum(/** @type {const} */ (['open', 'joined', 'ready', 'locked']), 'open'),
    tone: prop.enum(/** @type {const} */ (['captain', 'stoker', 'team-a', 'team-b']), 'captain'),
    badge: prop.string(''),
  };

  /** @override */ static styles = `
    uf-seat {
      --_tone: var(--uf-color-captain);
      position: relative; box-sizing: border-box; min-height: 62px; border-radius: var(--uf-radius-md); padding: var(--uf-space-2) var(--uf-space-3);
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; text-align: center;
      background: var(--uf-color-surface-3); border: 1.5px solid var(--uf-color-line-soft); color: var(--uf-color-fg);
      font-family: var(--uf-font-ui); transition: border-color var(--uf-motion-base), box-shadow var(--uf-motion-base), opacity var(--uf-motion-base);
    }
    uf-seat[tone="stoker"] { --_tone: var(--uf-color-stoker); }
    uf-seat[tone="team-a"] { --_tone: var(--uf-color-team-a); }
    uf-seat[tone="team-b"] { --_tone: var(--uf-color-team-b); }
    uf-seat[state="joined"], uf-seat[state="ready"] { border-color: var(--_tone); }
    uf-seat[state="joined"] { animation: uf-seat-pop .34s cubic-bezier(.2,1.5,.4,1); }
    uf-seat[state="ready"] { box-shadow: 0 0 18px -4px var(--_tone); animation: uf-seat-bob 1.9s ease-in-out infinite; }
    uf-seat[state="open"] { opacity: .5; border-style: dashed; background: transparent; cursor: pointer; }
    uf-seat[state="locked"] { opacity: .3; border-style: dashed; background: repeating-linear-gradient(45deg, var(--uf-color-surface-3) 0 6px, transparent 6px 12px); }
    uf-seat .uf-seat__role { font: var(--uf-size-xs)/1.3 var(--uf-font-mono); letter-spacing: 1.4px; color: var(--uf-color-fg-muted); text-transform: uppercase; }
    uf-seat .uf-seat__who { font: 700 var(--uf-size-sm)/1.25 var(--uf-font-ui); letter-spacing: .4px; }
    uf-seat[state="joined"] .uf-seat__who, uf-seat[state="ready"] .uf-seat__who { color: var(--_tone); }
    uf-seat .uf-seat__dev { font: var(--uf-size-xs)/1.2 var(--uf-font-mono); color: var(--uf-color-fg-muted); }
    uf-seat .uf-seat__badge { position: absolute; top: 6px; right: 8px; font: 800 var(--uf-size-xs)/1 var(--uf-font-mono); padding: 2px 5px; border-radius: var(--uf-radius-sm); background: var(--uf-color-scrim); }
    uf-seat .uf-seat__check { font: 800 var(--uf-size-xs)/1 var(--uf-font-mono); letter-spacing: 1px; color: var(--uf-color-accent); margin-bottom: 1px; }
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

  /** @returns {'open' | 'joined' | 'ready' | 'locked'} */ get state() { return this.get('state'); }
  /** @param {'open' | 'joined' | 'ready' | 'locked'} v */ set state(v) { this.set('state', v); }

  /** @returns {'captain' | 'stoker' | 'team-a' | 'team-b'} */ get tone() { return this.get('tone'); }
  /** @param {'captain' | 'stoker' | 'team-a' | 'team-b'} v */ set tone(v) { this.set('tone', v); }

  /** @returns {string} */ get badge() { return this.get('badge'); }
  /** @param {string} v */ set badge(v) { this.set('badge', v); }

  /** @override */
  render() {
    return (this.badge ? `<span class="uf-seat__badge">${esc(this.badge)}</span>` : '') +
      (this.state === 'ready' ? `<span class="uf-seat__check">✓ READY</span>` : '') +
      `<span class="uf-seat__role">${esc(this.seat)}</span>` +
      `<span class="uf-seat__who">${esc(this.who)}</span>` +
      (this.dev ? `<span class="uf-seat__dev">${esc(this.dev)}</span>` : '');
  }
}

UfSeat.define();
