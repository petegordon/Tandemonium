// ============================================================
// "NEW BIKE!" — the celebration when a bike unlocks (#736)
// ============================================================
//
// Pete, 2026-11-09 (#736):
//  - every bike that unlocks is celebrated: colour, holiday and special;
//  - only at calm moments: the end-of-ride screen, the main menu, after a sign-in (never mid-ride);
//  - bikes earned together share one screen ("3 new bikes!"), and the player picks one to ride;
//  - the demo → full game jump (and a sign-in that brings in saved riding) is one welcome screen:
//    "Your demo riding earned you N achievements and M new bikes."
// What has been celebrated is kept per browser (STATE_KEY), so each bike is shown once.
// The rules (what is unlocked, what is new) are pure, in js/bike-unlocks.js.

import { pendingBikeCelebration, welcomeText, earnedLine, BIKE_NAMES, nextBikeGoal, nextBikeGoalText } from './bike-unlocks.js';
import { SPECIAL_BIKES } from './special-bikes.js';
import { GOOSE_OUTFITS } from './goose-outfits.js';
import { getP1Look } from './config.js';

export const STATE_KEY = 'tandemonium_bike_ladder';

/** The look of each bike's card: a colour and an icon. */
const BIKE_LOOK = {
  default: ['#44ff66', '🚲'], bike_orange: ['#fd892b', '🍊'], bike_magenta: ['#ff61f2', '🫐'], bike_red: ['#ff4444', '🍒'],
  bike_blue: ['#66aaff', '🌊'], bike_green: ['#22dd44', '🌿'], bike_yellow: ['#ffe14a', '🍌'],
  bike_christmas: ['#2eff46', '🎄'], bike_newyears: ['#fbff00', '🎆'], bike_birthday: ['#66ff00', '🎂'],
};

function lookFor(key) {
  const sp = SPECIAL_BIKES[key];
  if (sp) return [sp.color, sp.icon];
  return BIKE_LOOK[key] || ['#ffffff', '🚲'];
}

function loadState(storage) {
  try { const raw = storage.getItem(STATE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

function saveState(storage, state) {
  try { storage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { /* storage off: shown again next time */ }
}

const STYLE = `
  #new-bike-sheet .nb-welcome { margin: 0; text-align: center; font-size: var(--uf-size-lg); color: var(--uf-color-fg); }
  #new-bike-sheet .nb-cards { display: flex; flex-wrap: wrap; gap: var(--uf-space-4); justify-content: center; }
  #new-bike-sheet .nb-card { display: grid; justify-items: center; gap: var(--uf-space-2); width: 12em; padding: var(--uf-space-4);
    border-radius: var(--uf-radius-lg); background: var(--uf-color-surface-2, rgba(255,255,255,0.05));
    border: 2px solid var(--nb-colour); box-shadow: 0 0 24px color-mix(in srgb, var(--nb-colour) 40%, transparent);
    animation: nb-roll-in 700ms cubic-bezier(.2,.9,.3,1.2) both; animation-delay: calc(var(--nb-i) * 220ms); }
  #new-bike-sheet .nb-card { width: 15em; }
  #new-bike-sheet .nb-bike { display: block; width: 100%; aspect-ratio: 3 / 2; }
  #new-bike-sheet .nb-cards.few .nb-card { width: 24em; }
  #new-bike-sheet .nb-cards.one .nb-card { width: 32em; }
  #new-bike-sheet .nb-cards.few .nb-bike { aspect-ratio: 16 / 9; }
  #new-bike-sheet .nb-outfit { margin: 0; text-align: center; font-size: var(--uf-size-sm); color: var(--uf-color-fg-muted); }
  #new-bike-sheet .nb-cards.many { flex-wrap: nowrap; }
  #new-bike-sheet .nb-cards.many .nb-card { flex: 1 1 0; min-width: 0; width: auto; max-width: 13em; padding: var(--uf-space-3); }
  #new-bike-sheet .nb-cards.many .nb-name { font-size: var(--uf-size-md); }
  #new-bike-sheet .nb-name { font: 800 var(--uf-size-lg)/1.15 var(--uf-font-ui); color: var(--nb-colour); text-align: center; }
  #new-bike-sheet .nb-how { font-size: var(--uf-size-sm); color: var(--uf-color-fg-muted); text-align: center; }
  #new-bike-sheet .nb-next { margin: 0; text-align: center; font-size: var(--uf-size-sm); color: var(--uf-color-fg-muted); }
  @keyframes nb-roll-in { from { transform: translateX(-120vw) rotate(-8deg); opacity: 0; } 70% { transform: translateX(4%) rotate(2deg); opacity: 1; } to { transform: none; } }
  @media (prefers-reduced-motion: reduce) { #new-bike-sheet .nb-card { animation: none; } }
`;

export class BikeCelebration {
  /** @param {{ storage?: Storage, onShown?: (info: object) => void, showcase?: () => ({show: Function, stop: Function}) }} [opts] */
  constructor(opts = {}) {
    this._storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this._onShown = opts.onShown || null;
    this._makeShowcase = opts.showcase || null;   // the turning bikes (js/bike-showcase.js), made on first use
    this._showcase = null;
    this._sheet = null;
  }

  /** Is the screen up? */
  get isOpen() { return !!(this._sheet && this._sheet.open); }

  /**
   * Celebrate anything new. Returns what was shown (or null).
   * @param {object} args
   * @param {string[]} args.earnedIds
   * @param {object} args.rules           js/edition.js rules
   * @param {boolean} [args.signIn]       right after a sign-in brought in saved riding
   * @param {object} [args.focus]         the pad's FocusController for the screen underneath
   * @param {((key: string) => void) | null} [args.onRide]  "Ride it now" (null = no ride from here: just OK)
   * @param {() => void} [args.onClose]
   */
  check({ earnedIds, rules, signIn = false, focus = null, onRide = null, onClose = null }) {
    if (!this._storage || this.isOpen) return null;
    const r = pendingBikeCelebration(loadState(this._storage), earnedIds, rules, { signIn });
    saveState(this._storage, r.next);   // each bike is celebrated once, whether or not the screen is read
    if (!r.bikes.length && !(r.welcome && r.welcome.achievements > 0)) return null;
    const goal = nextBikeGoal(earnedIds, rules);
    this._show(r, goal, { focus, onRide, onClose });
    const info = { bikes: r.bikes, welcome: r.welcome };
    if (this._onShown) try { this._onShown(info); } catch (e) {}
    return info;
  }

  _ensureSheet() {
    if (this._sheet) return this._sheet;
    if (!document.getElementById('new-bike-style')) {
      const st = document.createElement('style');
      st.id = 'new-bike-style';
      st.textContent = STYLE;
      document.head.appendChild(st);
    }
    const sheet = /** @type {any} */ (document.createElement('uf-sheet'));
    sheet.id = 'new-bike-sheet';
    sheet.setAttribute('size', 'lg');
    sheet.setAttribute('tone', 'gold');
    sheet.setAttribute('headline', '');
    document.body.appendChild(sheet);
    this._sheet = sheet;
    return sheet;
  }

  _show(r, goal, { focus, onRide, onClose }) {
    const sheet = this._ensureSheet();
    const n = r.bikes.length;
    sheet.heading = n === 0 ? 'Welcome to the full game!' : n === 1 ? 'New bike!' : `${n} new bikes!`;
    if (r.welcome && r.welcome.kind === 'demo' && n === 0) sheet.heading = 'Welcome to the full game!';
    const body = sheet.body;
    body.replaceChildren();
    // the old actions row goes too (a new one below)
    sheet.querySelectorAll('.nb-actions').forEach((el) => el.remove());

    if (r.welcome && r.welcome.achievements > 0) {
      const p = document.createElement('p');
      p.className = 'nb-welcome';
      p.textContent = welcomeText(r.welcome, n);
      body.appendChild(p);
    }

    const done = (key) => {
      sheet.close();   // (gives the pad back to the screen underneath on a microtask: the ride starts after it)
      if (key && onRide) setTimeout(() => onRide(key), 0);
    };

    if (n) {
      const cards = document.createElement('div');
      // one or two: wide pictures with the geese standing beside the bike; three or more: the geese ride
      cards.className = 'nb-cards' + (n >= 4 ? ' many' : '') + (n <= 2 ? ' few' : '') + (n === 1 ? ' one' : '');
      r.bikes.forEach((key, i) => {
        const [colour, icon] = lookFor(key);
        const card = document.createElement('div');
        card.className = 'nb-card';
        card.dataset.bike = key;
        card.style.setProperty('--nb-colour', colour);
        card.style.setProperty('--nb-i', String(i));
        // Pete, 2026-11-09: the bike turning, then its name with the icon in front
        const pic = document.createElement('canvas'); pic.className = 'nb-bike'; pic.dataset.bike = key;
        const nm = document.createElement('div'); nm.className = 'nb-name'; nm.textContent = icon + ' ' + (BIKE_NAMES[key] || key);
        const how = document.createElement('div'); how.className = 'nb-how'; how.textContent = earnedLine(key);
        card.append(pic, nm, how);
        if (onRide) {
          const btn = /** @type {any} */ (document.createElement('uf-button'));
          btn.setAttribute('variant', i === 0 ? 'accent' : 'primary');
          btn.className = 'nb-ride';
          btn.dataset.bike = key;
          btn.textContent = n === 1 ? 'RIDE IT NOW' : n >= 4 ? 'RIDE' : 'RIDE THIS ONE';
          btn.addEventListener('click', () => done(key));
          card.appendChild(btn);
        }
        cards.appendChild(card);
      });
      body.appendChild(cards);
    }

    // whose geese these are: the player's outfit, its icon first
    let outfit = null;
    try { outfit = GOOSE_OUTFITS[getP1Look().outfit]; } catch (e) { outfit = null; }
    if (n && outfit) {
      const p = document.createElement('p');
      p.className = 'nb-outfit';
      p.textContent = `With your ${outfit.icon} ${outfit.label} geese`;
      body.appendChild(p);
    }

    if (goal) {
      const p = document.createElement('p');
      p.className = 'nb-next';
      p.textContent = 'Next: ' + nextBikeGoalText(goal);
      body.appendChild(p);
    }

    const actions = document.createElement('div');
    actions.className = 'nb-actions';
    actions.setAttribute('slot', 'actions');
    const later = /** @type {any} */ (document.createElement('uf-button'));
    later.id = 'new-bike-later';
    if (!onRide || !n) later.setAttribute('variant', 'accent');
    later.textContent = onRide && n ? 'LATER' : 'NICE!';
    later.addEventListener('click', () => done(null));
    actions.appendChild(later);
    sheet.appendChild(actions);

    if (n && this._makeShowcase) {
      try {
        this._showcase = this._showcase || this._makeShowcase();
        this._showcase.show([...body.querySelectorAll('canvas.nb-bike')].map((c) => ({ key: c.dataset.bike, canvas: c })));
      } catch (e) { console.warn('New bike pictures unavailable:', e); }
    }
    const closed = () => {
      sheet.removeEventListener('uf-sheet:close', closed);
      if (this._showcase) this._showcase.stop();
      if (onClose) try { onClose(); } catch (e) {}
    };
    sheet.addEventListener('uf-sheet:close', closed);
    if (focus) sheet.attachFocus(focus);
    sheet.show();
  }

  /** Close it (a ride is starting some other way). */
  close() { if (this.isOpen) this._sheet.close(); }
}
