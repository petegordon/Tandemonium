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
import { SPECIAL_BIKES, isSpecialBike } from './special-bikes.js';
import { GOOSE_OUTFITS, outfitForBike } from './goose-outfits.js';

/**
 * The outfit a bike brings (Pete, 2026-11-09 #736): the holiday bikes their own; the Solo Flight the Robot
 * (the outfit sharing its reward). Null for the rest: then the bike rolls in alone, no geese.
 */
export function giftOutfit(key) {
  const own = outfitForBike(key);
  if (own) return own;
  const sp = SPECIAL_BIKES[key];
  return sp ? (Object.keys(GOOSE_OUTFITS).find((k) => GOOSE_OUTFITS[k].reward === sp.reward) || null) : null;
}

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
  #new-bike-sheet .nb-cards.few:not(.one) { flex-wrap: nowrap; }
  #new-bike-sheet .nb-cards.few:not(.one) .nb-card { flex: 1 1 0; min-width: 0; width: auto; max-width: 26em; }
  #new-bike-sheet .nb-cards.few .nb-bike { aspect-ratio: 16 / 9; }
  /* the full-screen rewards (Solo Flight, Time Warp, Gold Standard) */
  #new-bike-sheet[data-hero] { inset: 0 !important; }
  #new-bike-sheet[data-hero] > .uf-sheet__card { width: 100%; height: 100dvh; max-height: none; border-radius: 0; border: none; }
  #new-bike-sheet[data-hero] .uf-sheet__title { font-size: calc(var(--uf-size-2xl) * 1.8); }
  #new-bike-sheet .nb-cards.hero .nb-card { width: min(100%, 90em); border: none; box-shadow: none; background: none; }
  #new-bike-sheet .nb-cards.hero .nb-bike { aspect-ratio: auto; height: min(50dvh, 46vw); }
  #new-bike-sheet .nb-cards.hero .nb-name { font-size: calc(var(--uf-size-2xl) * 1.4); }
  #new-bike-sheet .nb-cards.hero .nb-how, #new-bike-sheet .nb-cards.hero .nb-gift { font-size: var(--uf-size-lg); }
  #new-bike-sheet .nb-gift { font: 700 var(--uf-size-sm)/1.2 var(--uf-font-ui); color: var(--uf-color-accent-2); text-align: center; }
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
    const opts = { focus, onRide, onClose };
    // screens left over from last time (a ride started from one before the rest were seen)
    if (this._queue && this._queue.length) { this._next(opts); return { bikes: [], welcome: null, resumed: true }; }
    const r = pendingBikeCelebration(loadState(this._storage), earnedIds, rules, { signIn });
    saveState(this._storage, r.next);   // each bike is celebrated once, whether or not the screen is read
    if (!r.bikes.length && !(r.welcome && r.welcome.achievements > 0)) return null;
    const goal = nextBikeGoal(earnedIds, rules);
    // Pete, 2026-11-09: Solo Flight, Time Warp and Gold Standard are full-screen rewards, one each;
    // every other new bike shares the card screen after them.
    const heroes = r.bikes.filter(isSpecialBike);
    const rest = r.bikes.filter((k) => !isSpecialBike(k));
    this._queue = [];
    for (const k of heroes) this._queue.push({ bikes: [k], hero: true, welcome: null, goal });
    if (rest.length || (r.welcome && r.welcome.achievements > 0)) this._queue.push({ bikes: rest, hero: false, welcome: r.welcome, goal });
    if (heroes.length && r.welcome && !this._queue[this._queue.length - 1].welcome) this._queue[0].welcome = r.welcome;
    this._next(opts);
    const info = { bikes: r.bikes, welcome: r.welcome };
    if (this._onShown) try { this._onShown(info); } catch (e) {}
    return info;
  }

  /** Show the next queued screen. */
  _next(opts) {
    const screen = this._queue.shift();
    if (screen) this._show(screen, screen.goal, opts);
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
    sheet.toggleAttribute('data-hero', !!r.hero);   // a full-screen reward (the last three bikes)
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

    let riding = null;
    const done = (key) => {
      riding = key;
      sheet.close();   // (gives the pad back to the screen underneath on a microtask: the ride starts after it)
      if (key && onRide) setTimeout(() => onRide(key), 0);
    };

    if (n) {
      const cards = document.createElement('div');
      // one or two: wide pictures with the geese standing beside the bike; three or more: the geese ride
      cards.className = 'nb-cards' + (n >= 4 ? ' many' : '') + (n <= 2 ? ' few' : '') + (n === 1 ? ' one' : '') + (r.hero ? ' hero' : '');
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
        // #736 · a holiday bike brings its outfit: said on the card, and the geese wear it
        const gift = giftOutfit(key);
        if (gift) {
          pic.dataset.outfit = gift;
          const o = GOOSE_OUTFITS[gift];
          const g = document.createElement('div'); g.className = 'nb-gift'; g.textContent = `+ ${o.icon} ${o.label} outfit`;
          card.appendChild(g);
        }
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
    later.textContent = this._queue.length ? 'NEXT' : onRide && n ? 'LATER' : 'NICE!';
    later.addEventListener('click', () => done(null));
    actions.appendChild(later);
    sheet.appendChild(actions);

    if (n && this._makeShowcase) {
      try {
        this._showcase = this._showcase || this._makeShowcase();
        this._showcase.show([...body.querySelectorAll('canvas.nb-bike')].map((c) => ({ key: c.dataset.bike, canvas: c, outfit: c.dataset.outfit || null, hero: !!r.hero })));
      } catch (e) { console.warn('New bike pictures unavailable:', e); }
    }
    const closed = () => {
      sheet.removeEventListener('uf-sheet:close', closed);
      if (this._showcase) this._showcase.stop();
      // the next screen (unless a ride is starting: the rest wait for the next calm moment)
      if (!riding && this._queue.length) { setTimeout(() => this._next({ focus, onRide, onClose }), 0); return; }
      if (onClose) try { onClose(); } catch (e) {}
    };
    sheet.addEventListener('uf-sheet:close', closed);
    if (focus) sheet.attachFocus(focus);
    sheet.show();
  }

  /** Close it (a ride is starting some other way). */
  close() { if (this.isOpen) this._sheet.close(); }
}
