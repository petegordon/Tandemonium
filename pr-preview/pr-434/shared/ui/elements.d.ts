// Tag-name → class map so DOM lookups are typed without a build step:
//   const b = document.createElement('uf-button');   // UfButton
//   document.querySelector('uf-button')?.variant;     // 'primary' | …
// Maintained by tools/ui-kit/new-element.mjs — one entry per element.

// uf:elements-imports
import type { UfQr } from './elements/uf-qr.js';
import type { UfKeypad } from './elements/uf-keypad.js';
import type { UfJoinCode } from './elements/uf-join-code.js';
import type { UfCard } from './elements/uf-card.js';
import type { UfSetting } from './elements/uf-setting.js';
import type { UfSystemBar } from './elements/uf-system-bar.js';
import type { UfSheet } from './elements/uf-sheet.js';
import type { UfControllerRoster } from './elements/uf-controller-roster.js';
import type { UfTeam } from './elements/uf-team.js';
import type { UfControllerGlyph } from './elements/uf-controller-glyph.js';
import type { UfChip } from './elements/uf-chip.js';
import type { UfSeat } from './elements/uf-seat.js';
import type { UfFlow } from './elements/uf-flow.js';
import type { UfStep } from './elements/uf-step.js';
import type { UfButton } from './elements/uf-button.js';

declare global {
  interface HTMLElementTagNameMap {
    // uf:elements-map
    'uf-qr': UfQr;
    'uf-keypad': UfKeypad;
    'uf-join-code': UfJoinCode;
    'uf-card': UfCard;
    'uf-setting': UfSetting;
    'uf-system-bar': UfSystemBar;
    'uf-sheet': UfSheet;
    'uf-controller-roster': UfControllerRoster;
    'uf-team': UfTeam;
    'uf-controller-glyph': UfControllerGlyph;
    'uf-chip': UfChip;
    'uf-seat': UfSeat;
    'uf-flow': UfFlow;
    'uf-step': UfStep;
    'uf-button': UfButton;
  }
}

export {};
