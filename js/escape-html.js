// Text made safe to put into HTML: between tags, or inside a quoted attribute (either quote).

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** @param {any} text  null and undefined give '' */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}
