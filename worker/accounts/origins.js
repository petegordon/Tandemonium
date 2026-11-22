// Which sites the API serves (CORS_ORIGIN, a comma-separated list).
// An entry may hold one `*`, standing for a PR number and nothing else, so staging can
// serve its numbered PR previews: https://pr-*-example.workers.dev
const NUMBERED = /^https:\/\/pr-\*-[a-z0-9-]+\.[a-z0-9.-]+$/;

export function originList(setting) {
  return (setting || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Is this exact origin on the list? A bare `*` is not honoured here. */
export function originListed(origin, setting) {
  if (typeof origin !== 'string' || !origin) return false;
  for (const entry of originList(setting)) {
    if (entry === origin) return true;
    if (NUMBERED.test(entry)) {
      const [before, after] = entry.split('*');
      if (origin.startsWith(before) && origin.endsWith(after)
        && /^[0-9]{1,6}$/.test(origin.slice(before.length, origin.length - after.length))) return true;
    }
  }
  return false;
}
