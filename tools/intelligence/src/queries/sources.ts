import type Database from 'better-sqlite3';
import type { IntelResponse } from '../types.js';
import { ok } from '../util/envelope.js';

export type SourceStatus = 'healthy' | 'stale' | 'error';

export interface SourceHealthItem {
  source: string;
  feed: string;
  last_polled_at: string;
  last_success_at: string | null;
  last_error: string | null;
  events_in_last_poll: number;
  events_24h: number;
  events_total: number;
  status: SourceStatus;
}

export interface QuerySourcesOpts {
  /** Only show sources that have not been seen in this duration (ISO 8601 timestamp threshold) */
  stale?: string;
}

/**
 * Default poll interval assumption (seconds) for status derivation.
 * If a source hasn't reported in 2x this, it's stale.
 */
const DEFAULT_POLL_INTERVAL_S = 300;

/**
 * Query source health from collector_health joined with event counts.
 *
 * Status derivation:
 * - "error" if last_error is non-null
 * - "stale" if last_success_at is older than 2x the poll interval
 * - "healthy" otherwise
 *
 * Supports --stale filter: only return sources with status "stale" or "error",
 * or where last_success_at is older than the provided threshold.
 */
export function querySources(
  db: Database.Database,
  opts: QuerySourcesOpts = {},
): IntelResponse<SourceHealthItem[]> {
  // Query collector_health with event count aggregation
  const sql = `
    SELECT
      ch.source,
      ch.feed,
      ch.last_polled_at,
      ch.last_success_at,
      ch.last_error,
      ch.events_in_poll AS events_in_last_poll,
      COALESCE(e24.cnt, 0) AS events_24h,
      COALESCE(etotal.cnt, 0) AS events_total
    FROM collector_health ch
    LEFT JOIN (
      SELECT source, feed, COUNT(*) AS cnt
      FROM events
      WHERE fetched_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
      GROUP BY source, feed
    ) e24 ON e24.source = ch.source AND e24.feed = ch.feed
    LEFT JOIN (
      SELECT source, feed, COUNT(*) AS cnt
      FROM events
      GROUP BY source, feed
    ) etotal ON etotal.source = ch.source AND etotal.feed = ch.feed
    ORDER BY ch.source, ch.feed
  `;

  const rows = db.prepare(sql).all() as Array<{
    source: string;
    feed: string;
    last_polled_at: string;
    last_success_at: string | null;
    last_error: string | null;
    events_in_last_poll: number;
    events_24h: number;
    events_total: number;
  }>;

  const now = Date.now();
  const staleThresholdMs = DEFAULT_POLL_INTERVAL_S * 2 * 1000;

  const items: SourceHealthItem[] = rows.map((row) => {
    const status = deriveStatus(row.last_success_at, row.last_error, now, staleThresholdMs);

    return {
      source: row.source,
      feed: row.feed,
      last_polled_at: row.last_polled_at,
      last_success_at: row.last_success_at,
      last_error: row.last_error,
      events_in_last_poll: row.events_in_last_poll,
      events_24h: row.events_24h,
      events_total: row.events_total,
      status,
    };
  });

  // Apply stale filter if requested
  if (opts.stale) {
    const staleThreshold = new Date(opts.stale).getTime();
    return ok(
      items.filter((item) => {
        if (item.status === 'error') return true;
        if (!item.last_success_at) return true;
        return new Date(item.last_success_at).getTime() < staleThreshold;
      }),
    );
  }

  return ok(items);
}

/**
 * Derive source status from health data.
 *
 * - "error" if last_error is non-null
 * - "stale" if last_success_at is null or older than 2x poll interval
 * - "healthy" otherwise
 */
function deriveStatus(
  lastSuccessAt: string | null,
  lastError: string | null,
  nowMs: number,
  staleThresholdMs: number,
): SourceStatus {
  if (lastError) {
    return 'error';
  }

  if (!lastSuccessAt) {
    return 'stale';
  }

  const successAge = nowMs - new Date(lastSuccessAt).getTime();
  if (successAge > staleThresholdMs) {
    return 'stale';
  }

  return 'healthy';
}
