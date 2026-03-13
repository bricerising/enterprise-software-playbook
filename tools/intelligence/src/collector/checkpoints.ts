import type Database from 'better-sqlite3';
import type { SourceType } from '../types.js';
import { formatISO } from '../util/time.js';

export interface Checkpoint {
  cursor: string;
  updated_at: string;
}

/**
 * Load the polling checkpoint for a given source and feed.
 * Returns null if no checkpoint exists yet.
 */
export function loadCheckpoint(
  db: Database.Database,
  source: SourceType,
  feed: string,
): Checkpoint | null {
  const row = db
    .prepare('SELECT cursor, updated_at FROM checkpoints WHERE source = ? AND feed = ?')
    .get(source, feed) as { cursor: string; updated_at: string } | undefined;

  if (!row) return null;

  return {
    cursor: row.cursor,
    updated_at: row.updated_at,
  };
}

/**
 * Save or update the polling checkpoint for a given source and feed.
 * Uses INSERT OR REPLACE (upsert) on the (source, feed) primary key.
 */
export function saveCheckpoint(
  db: Database.Database,
  source: SourceType,
  feed: string,
  cursor: string,
): void {
  const now = formatISO();

  db.prepare(
    `INSERT INTO checkpoints (source, feed, cursor, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(source, feed) DO UPDATE SET
       cursor = excluded.cursor,
       updated_at = excluded.updated_at`,
  ).run(source, feed, cursor, now);
}

/**
 * Update the collector_health row for a given source and feed.
 * Tracks last poll time, success/error status, event counts,
 * and HTTP conditional GET headers (ETag, Last-Modified).
 */
export function updateCollectorHealth(
  db: Database.Database,
  source: SourceType,
  feed: string,
  eventsInPoll: number,
  error?: string | null,
  httpEtag?: string | null,
  httpLastModified?: string | null,
): void {
  const now = formatISO();
  const lastSuccessAt = error ? null : now;
  const lastError = error ?? null;
  const etag = httpEtag ?? null;
  const lastModified = httpLastModified ?? null;

  db.prepare(
    `INSERT INTO collector_health
       (source, feed, last_polled_at, last_success_at, last_error, events_in_poll, http_etag, http_last_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, feed) DO UPDATE SET
       last_polled_at = excluded.last_polled_at,
       last_success_at = CASE
         WHEN excluded.last_error IS NULL THEN excluded.last_polled_at
         ELSE collector_health.last_success_at
       END,
       last_error = excluded.last_error,
       events_in_poll = excluded.events_in_poll,
       http_etag = COALESCE(excluded.http_etag, collector_health.http_etag),
       http_last_modified = COALESCE(excluded.http_last_modified, collector_health.http_last_modified)`,
  ).run(source, feed, now, lastSuccessAt, lastError, eventsInPoll, etag, lastModified);
}
