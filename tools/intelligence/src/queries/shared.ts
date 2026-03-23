import type Database from 'better-sqlite3';

/**
 * Compute the span (in days) between the oldest and newest event timestamps.
 *
 * @param db - Database connection
 * @param windowStart - Optional ISO timestamp to scope the query to an analysis window.
 *   Omit for all-time scope (stats), pass for window-scoped (forecast).
 * @returns data_age_days (0 when no events or timestamps are NULL)
 */
export function computeDataSpan(
  db: Database.Database,
  windowStart?: string,
): number {
  const whereClause = windowStart ? 'WHERE e.fetched_at >= ?' : '';
  const sql = `
    SELECT
      MIN(
        CASE
          WHEN published_at IS NOT NULL
               AND julianday(fetched_at) - julianday(published_at) > 365
          THEN fetched_at
          ELSE COALESCE(published_at, fetched_at)
        END
      ) AS min_ts,
      MAX(COALESCE(published_at, fetched_at)) AS max_ts
    FROM events e
    ${whereClause}
  `;
  const params = windowStart ? [windowStart] : [];
  const row = db.prepare(sql).get(...params) as { min_ts: string | null; max_ts: string | null };

  if (row.min_ts == null || row.max_ts == null) return 0;

  const minTime = new Date(row.min_ts).getTime();
  const maxTime = new Date(row.max_ts).getTime();
  if (isNaN(minTime) || isNaN(maxTime)) return 0;

  return Math.floor((maxTime - minTime) / (1000 * 60 * 60 * 24));
}

/**
 * Compute per-topic event counts within an analysis window.
 *
 * @param db - Database connection
 * @param windowStart - ISO timestamp for the start of the analysis window
 * @returns Map from topic name to event count
 */
export function computeTopicCounts(
  db: Database.Database,
  windowStart: string,
): Map<string, number> {
  const sql = `
    SELECT et.topic, COUNT(*) AS event_count
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE e.fetched_at >= ?
    GROUP BY et.topic
  `;
  const rows = db.prepare(sql).all(windowStart) as Array<{ topic: string; event_count: number }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.topic, row.event_count);
  }
  return counts;
}
