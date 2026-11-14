/**
 * Steamworks achievement CSVs (pure — no browser).
 *
 * Steamworks' "Bulk Import/Export" (Stats & Achievements → Achievements) hands
 * out two CSVs and takes them back:
 *
 *   definitions:  api_name, setid, permission, spoiler, archived, progress_stat_name, …
 *   localization: api_name, field (name | description), english[, other languages]
 *
 * The sync exports both, plans against js/achievement-defs.js, writes corrected
 * copies and uploads them. Steamworks shows the result as Pending Changes and
 * applies nothing until Save, so these functions only ever describe a change.
 */

/** RFC 4180-ish: quoted fields, "" escapes, CRLF or LF. Strips a leading BOM. */
function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

function csvField(v) {
  const t = v == null ? '' : String(v);
  return /[",\r\n]|^\s|\s$/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** Rows back to CSV text, with the BOM Steamworks writes (keeps Excel happy). */
function toCsv(rows) {
  return '﻿' + rows.map(r => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

const API = 0;
const DEF = { spoiler: 3, archived: 4 };
const LOC = { field: 1, english: 2 };

/** What Steamworks has now: Map apiName → { displayName, description, hidden, archived }. */
function readSteam(defRows, locRows) {
  const out = new Map();
  for (const r of defRows.slice(1)) {
    out.set(r[API], {
      apiName: r[API],
      displayName: '',
      description: '',
      hidden: String(r[DEF.spoiler]).trim().toLowerCase() === 'true',
      archived: String(r[DEF.archived]).trim().toLowerCase() === 'true',
    });
  }
  for (const r of locRows.slice(1)) {
    const a = out.get(r[API]);
    if (!a) continue;
    if (r[LOC.field] === 'name') a.displayName = r[LOC.english] || '';
    if (r[LOC.field] === 'description') a.description = r[LOC.english] || '';
  }
  return out;
}

const same = (a, b) => String(a || '').trim() === String(b || '').trim();

/**
 * Plan a sync.
 *   code:  [{ apiName, displayName, description, hidden }]
 *   defRows / locRows: parsed exports (header row first)
 * Returns { add, update, remove, renamed, defRows, locRows, defsChanged, locChanged }:
 * new CSV rows with every change applied (rows for achievements not in code are
 * left exactly as they are — the import does not delete them).
 */
function planSync(code, defRows, locRows, { renames = {} } = {}) {
  const steam = readSteam(defRows, locRows);
  const codeMap = new Map(code.map(a => [a.apiName, a]));
  const add = code.filter(a => !steam.has(a.apiName));
  const update = [];
  for (const a of code) {
    const s = steam.get(a.apiName);
    if (!s) continue;
    const parts = [];
    if (!same(s.displayName, a.displayName)) parts.push(`name "${s.displayName}" -> "${a.displayName}"`);
    if (!same(s.description, a.description)) parts.push(`desc "${s.description}" -> "${a.description}"`);
    if (s.hidden !== !!a.hidden) parts.push(`hidden ${s.hidden} -> ${!!a.hidden}`);
    if (parts.length) update.push({ ...a, parts, hiddenChanged: s.hidden !== !!a.hidden });
  }
  const remove = [...steam.values()].filter(s => !codeMap.has(s.apiName) && !s.archived);
  // An API name can't be changed by import; a pending rename is a person's call.
  const renamed = Object.entries(renames)
    .filter(([from, to]) => steam.has(from) && !steam.has(to) && codeMap.has(to))
    .map(([from, to]) => ({ from, to }));

  const width = defRows[0].length;
  const newDefs = defRows.map(r => r.slice());
  for (const r of newDefs.slice(1)) {
    const a = codeMap.get(r[API]);
    if (a && update.some(u => u.apiName === a.apiName && u.hiddenChanged)) r[DEF.spoiler] = a.hidden ? 'true' : 'false';
  }
  for (const a of add) {
    const r = new Array(width).fill('');
    r[API] = a.apiName; r[2] = 'Client'; r[DEF.spoiler] = a.hidden ? 'true' : 'false'; r[DEF.archived] = 'false';
    if (width > 6) { r[6] = '0'; r[7] = '0'; }
    newDefs.push(r);
  }

  const locWidth = locRows[0].length;
  const newLoc = locRows.map(r => r.slice());
  const seen = new Set();
  for (const r of newLoc.slice(1)) {
    const a = codeMap.get(r[API]);
    if (!a) continue;
    if (r[LOC.field] === 'name') { r[LOC.english] = a.displayName; seen.add(a.apiName + ':name'); }
    if (r[LOC.field] === 'description') { r[LOC.english] = a.description; seen.add(a.apiName + ':description'); }
  }
  for (const a of code) {
    for (const [field, value] of [['name', a.displayName], ['description', a.description]]) {
      if (seen.has(`${a.apiName}:${field}`)) continue;
      const r = new Array(locWidth).fill('');
      r[API] = a.apiName; r[LOC.field] = field; r[LOC.english] = value;
      newLoc.push(r);
    }
  }

  const textChanged = add.length > 0 || update.some(u => u.parts.some(p => !p.startsWith('hidden')));
  return {
    add, update, remove, renamed,
    defRows: newDefs, locRows: newLoc,
    defsChanged: add.length > 0 || update.some(u => u.hiddenChanged),
    locChanged: textChanged,
  };
}

module.exports = { parseCsv, toCsv, readSteam, planSync };
