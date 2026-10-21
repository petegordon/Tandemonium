// @ts-check
// @usersfirst/ui — typed, build-free Web Components for Tandemonium + the lab.
// Importing this module registers every element. tokens.css is loaded by the
// host page (<link rel="stylesheet" href=".../tokens.css">), not by JS, so a
// host can override tokens before any element paints.
export { UfElement, prop, coerce, esc, kebab } from './uf-element.js';
export { FocusController } from './focus-controller.js';
export { GamepadInput, ManualInput } from './inputs.js';
// uf:elements — the scaffolder appends one line per element below this marker.
export { UfQr, qrSvg } from './elements/uf-qr.js';
export { UfKeypad } from './elements/uf-keypad.js';
export { UfJoinCode, ROOM_CODE_ALPHABET } from './elements/uf-join-code.js';
export { UfCard } from './elements/uf-card.js';
export { UfSetting } from './elements/uf-setting.js';
export { UfSystemBar } from './elements/uf-system-bar.js';
export { UfSheet } from './elements/uf-sheet.js';
export { UfControllerRoster } from './elements/uf-controller-roster.js';
export { UfTeam } from './elements/uf-team.js';
export { UfControllerGlyph, resolveGlyph } from './elements/uf-controller-glyph.js';
export { UfChip } from './elements/uf-chip.js';
export { UfSeat } from './elements/uf-seat.js';
export { UfFlow } from './elements/uf-flow.js';
export { UfStep } from './elements/uf-step.js';
export { UfButton } from './elements/uf-button.js';
