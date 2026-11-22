// ============================================================
// RETENTION — gameplay analytics are kept for 24 months
// ============================================================
//
// The privacy policy says so, and this is what makes it true: once a day (the Worker's cron
// trigger, wrangler-api.toml) analytics records older than 24 months are deleted. Only the
// analytics tables are touched: sessions, events, rides, ride_events, ride_seats, rooms and
// conversions. Accounts, scores, achievements, daily results and consent answers are not
// analytics and are never removed here.
//
// Each run removes a bounded number of rows per table (the oldest first), so one run cannot
// take long; a backlog is worked off over the following days. Children go before parents
// (the database enforces the links), and a session row goes only when nothing points at it.

export const ANALYTICS_RETENTION_MONTHS = 24;
const BATCH = 2000;

/** The moment 24 months before `now`, as the ISO text the analytics tables store. */
export function retentionCutoff(now = Date.now()) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - ANALYTICS_RETENTION_MONTHS);
  return d.toISOString();
}

// [what it is called in the result, the statement]. `?1` is the cutoff, `?2` the batch size.
const STEPS = [
  ['ride_events', `DELETE FROM ride_events WHERE id IN (
     SELECT e.id FROM ride_events e JOIN rides r ON r.id = e.ride_id WHERE r.started_at < ?1 ORDER BY r.started_at LIMIT ?2)`],
  ['ride_seats', `DELETE FROM ride_seats WHERE ride_id IN (
     SELECT id FROM rides WHERE started_at < ?1 ORDER BY started_at LIMIT ?2)`],
  ['rides', `DELETE FROM rides WHERE id IN (
     SELECT r.id FROM rides r WHERE r.started_at < ?1
       AND NOT EXISTS (SELECT 1 FROM ride_events e WHERE e.ride_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM ride_seats s WHERE s.ride_id = r.id)
     ORDER BY r.started_at LIMIT ?2)`],
  ['events', `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at < ?1 ORDER BY created_at LIMIT ?2)`],
  ['conversions', `DELETE FROM conversions WHERE id IN (SELECT id FROM conversions WHERE created_at < ?1 ORDER BY created_at LIMIT ?2)`],
  ['rooms', `DELETE FROM rooms WHERE code IN (SELECT code FROM rooms WHERE created_at < ?1 ORDER BY created_at LIMIT ?2)`],
  ['sessions', `DELETE FROM sessions WHERE id IN (
     SELECT s.id FROM sessions s WHERE s.started_at < ?1
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM rides r WHERE r.session_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM rooms m WHERE m.captain_session_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM conversions c WHERE c.session_id = s.id)
     ORDER BY s.started_at LIMIT ?2)`],
];

/**
 * Delete analytics older than 24 months. → { cutoff, removed: { table: rows }, errors: [] }.
 * A step that fails is reported and the rest still run: the next day's run tries again.
 */
export async function pruneAnalytics(env, { now = Date.now(), batch = BATCH } = {}) {
  const cutoff = retentionCutoff(now);
  const removed = {};
  const errors = [];
  for (const [name, sql] of STEPS) {
    try {
      const res = await env.DB.prepare(sql).bind(cutoff, batch).run();
      removed[name] = (res && res.meta && res.meta.changes) || 0;
    } catch (e) {
      errors.push(`${name}: ${(e && e.message) || e}`);
    }
  }
  return { cutoff, removed, errors };
}
