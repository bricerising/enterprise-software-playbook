import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { IntelResponse } from '../types.js';
import { ok } from '../util/envelope.js';
import { checkSqliteVersion, getLastPragmaVerifications } from '../db.js';

export interface StatsData {
  database: string;
  size_mb: number;
  sqlite_version: string;
  wal_reset_fixed: boolean;
  application_id: string;
  schema_version: number;
  wal_pages: number;
  wal_autocheckpoint: number;
  pragma_verified: boolean;
  events_total: number;
  events_24h: number;
  events_7d: number;
  sources: number;
  topics_active_7d: number;
  oldest_event: string | null;
  newest_event: string | null;
}

/**
 * Query database statistics and health overview.
 *
 * Returns:
 * - Database file size
 * - SQLite version and WAL-reset fix status
 * - application_id verification
 * - Schema version (user_version)
 * - WAL page count and autocheckpoint threshold
 * - Pragma verification status
 * - Event counts (total, 24h, 7d)
 * - Source and topic counts
 * - Event time range
 */
export function queryStats(
  db: Database.Database,
  dbPath: string,
): IntelResponse<StatsData> {
  // Database file size
  let sizeMb = 0;
  try {
    const stat = statSync(dbPath);
    sizeMb = Math.round((stat.size / (1024 * 1024)) * 10) / 10;
  } catch {
    // File may not exist yet or be inaccessible
  }

  // SQLite version
  const versionStr = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
  const versionCheck = checkSqliteVersion(versionStr);

  // Application ID
  const appId = db.pragma('application_id', { simple: true }) as number;
  const appIdStr = `0x${appId.toString(16).toUpperCase().padStart(8, '0')}`;

  // Schema version
  const schemaVersion = db.pragma('user_version', { simple: true }) as number;

  // WAL info
  const walAutocheckpoint = db.pragma('wal_autocheckpoint', { simple: true }) as number;

  // WAL page count via wal_checkpoint (PASSIVE mode, returns [busy, total, checkpointed])
  let walPages = 0;
  try {
    const checkpointResult = db.pragma('wal_checkpoint(PASSIVE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    if (checkpointResult.length > 0) {
      walPages = checkpointResult[0].log;
    }
  } catch {
    // Reader connections may not support checkpoint; fallback to 0
  }

  // Pragma verification
  const verifications = getLastPragmaVerifications();
  const pragmaVerified = verifications.length > 0 && verifications.every((v) => v.ok);

  // Event counts
  const eventsTotal = (
    db.prepare('SELECT COUNT(*) AS cnt FROM events').get() as { cnt: number }
  ).cnt;

  const events24h = (
    db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM events WHERE fetched_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')",
      )
      .get() as { cnt: number }
  ).cnt;

  const events7d = (
    db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM events WHERE fetched_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')",
      )
      .get() as { cnt: number }
  ).cnt;

  // Source count (distinct source+feed combinations in collector_health)
  const sourcesCount = (
    db.prepare('SELECT COUNT(*) AS cnt FROM collector_health').get() as { cnt: number }
  ).cnt;

  // Active topics in last 7 days
  const topicsActive7d = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT et.topic) AS cnt
         FROM event_topics et
         JOIN events e ON e.event_id = et.event_id
         WHERE e.fetched_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`,
      )
      .get() as { cnt: number }
  ).cnt;

  // Event time range
  const oldest = db.prepare('SELECT MIN(fetched_at) AS t FROM events').get() as {
    t: string | null;
  };
  const newest = db.prepare('SELECT MAX(fetched_at) AS t FROM events').get() as {
    t: string | null;
  };

  const stats: StatsData = {
    database: dbPath,
    size_mb: sizeMb,
    sqlite_version: versionCheck.version,
    wal_reset_fixed: versionCheck.walResetFixed,
    application_id: appIdStr,
    schema_version: schemaVersion,
    wal_pages: walPages,
    wal_autocheckpoint: walAutocheckpoint,
    pragma_verified: pragmaVerified,
    events_total: eventsTotal,
    events_24h: events24h,
    events_7d: events7d,
    sources: sourcesCount,
    topics_active_7d: topicsActive7d,
    oldest_event: oldest.t,
    newest_event: newest.t,
  };

  return ok(stats);
}
