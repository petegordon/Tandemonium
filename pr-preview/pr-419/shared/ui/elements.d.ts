// Tag-name → class map so DOM lookups are typed without a build step:
//   const b = document.createElement('uf-button');   // UfButton
//   document.querySelector('uf-button')?.variant;     // 'primary' | …
// Maintained by tools/ui-kit/new-element.mjs — one entry per element.

// uf:elements-imports
import type { UfChip } from './elements/uf-chip.js';
import type { UfSeat } from './elements/uf-seat.js';
import type { UfFlow } from './elements/uf-flow.js';
import type { UfStep } from './elements/uf-step.js';
import type { UfButton } from './elements/uf-button.js';

declare global {
  interface HTMLElementTagNameMap {
    // uf:elements-map
    'uf-chip': UfChip;
    'uf-seat': UfSeat;
    'uf-flow': UfFlow;
    'uf-step': UfStep;
    'uf-button': UfButton;
  }
}

export {};
