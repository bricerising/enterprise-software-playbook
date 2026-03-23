import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { IntelResponse } from '../types.js';
import { ok } from '../util/envelope.js';
import { checkSqliteVersion, getLastPragmaVerifications } from '../db.js';
import { computeDataSpan } from './shared.js';

/* ── Spec 015: Health metric constants ─────────────────────────────── */

/** Warn when >20% of events have no topic. */
const UNCLASSIFIED_WARNING_THRESHOLD = 0.20;
/** Escalate unclassified warning to critical above 50%. */
const UNCLASSIFIED_CRITICAL_THRESHOLD = 0.50;
/** Warn when one source exceeds 30% of events. */
const SOURCE_CONCENTRATION_THRESHOLD = 0.30;
/** Escalate concentration warning to critical above 60%. */
const CONCENTRATION_CRITICAL_THRESHOLD = 0.60;
/** Warn when data spans fewer than 90 days. Aligned with spec 014's MIN_LIFECYCLE_DAYS. */
const MIN_DATA_AGE_DAYS = 90;
/** Escalate data_age warning to critical below 30 days. */
const DATA_AGE_CRITICAL_THRESHOLD = 30;
/** Per-event topic count threshold for over-classification detection. */
const MIN_OVER_CLASSIFICATION_TOPICS = 4;
/** Warn when >10% of events are assigned to 4+ topics. */
const MULTI_TOPIC_WARNING_THRESHOLD = 0.10;
/** Escalate over_classification warning to critical above 25%. */
const OVER_CLASSIFICATION_CRITICAL_THRESHOLD = 0.25;

/* ── Types ──────────────────────────────────────────────────────────── */

export type HealthWarningType = 'unclassified' | 'concentration' | 'data_age' | 'over_classification';
export type HealthWarningSeverity = 'warning' | 'critical';

export interface HealthWarning {
  type: HealthWarningType;
  severity: HealthWarningSeverity;
  message: string;
}

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
  unclassified_events: number;
  unclassified_pct: number;
  multi_topic_events: number;
  multi_topic_pct: number;
  top_source_name: string;
  top_source_pct: number;
  data_age_days: number;
  health_warnings: HealthWarning[];
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

  // Spec 015 §B: Health metrics

  // Unclassified events (no entry in event_topics)
  const unclassifiedResult = db.prepare(`
    SELECT COUNT(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1 FROM event_topics et WHERE et.event_id = e.event_id
      )
    ) AS unclassified
    FROM events e
  `).get() as { unclassified: number };
  const unclassifiedEvents = unclassifiedResult.unclassified;
  const unclassifiedPct = eventsTotal > 0
    ? Math.round((unclassifiedEvents / eventsTotal) * 1000) / 1000
    : 0;

  // Multi-topic events (assigned to 4+ topics — possible over-classification)
  const multiTopicResult = db.prepare(`
    SELECT COUNT(*) AS multi_topic_events
    FROM (
      SELECT et.event_id
      FROM event_topics et
      GROUP BY et.event_id
      HAVING COUNT(*) >= ?
    )
  `).get(MIN_OVER_CLASSIFICATION_TOPICS) as { multi_topic_events: number };
  const multiTopicEvents = multiTopicResult.multi_topic_events;
  const multiTopicPct = eventsTotal > 0
    ? Math.round((multiTopicEvents / eventsTotal) * 1000) / 1000
    : 0;

  // Top source concentration
  const topSourceRow = db.prepare(`
    SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS cnt
    FROM events
    GROUP BY source
    ORDER BY cnt DESC
    LIMIT 1
  `).get() as { source: string; cnt: number } | undefined;

  const topSourceName = topSourceRow?.source ?? '';
  const topSourcePct = eventsTotal > 0 && topSourceRow
    ? Math.round((topSourceRow.cnt / eventsTotal) * 1000) / 1000
    : 0;

  // Data age (all-time scope via shared utility)
  const dataAgeDays = computeDataSpan(db);

  // Generate health warnings
  const healthWarnings = computeHealthWarnings(
    unclassifiedPct, topSourcePct, topSourceName, dataAgeDays, multiTopicPct,
  );

  // One-time diagnostic: log topic count distribution when over_classification warning fires
  if (healthWarnings.some(w => w.type === 'over_classification')) {
    logTopicCountDistribution(db);
  }

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
    unclassified_events: unclassifiedEvents,
    unclassified_pct: unclassifiedPct,
    multi_topic_events: multiTopicEvents,
    multi_topic_pct: multiTopicPct,
    top_source_name: topSourceName,
    top_source_pct: topSourcePct,
    data_age_days: dataAgeDays,
    health_warnings: healthWarnings,
  };

  return ok(stats);
}

/* ── Spec 015 §B: Health warning generation ────────────────────────── */

function computeHealthWarnings(
  unclassifiedPct: number,
  topSourcePct: number,
  topSourceName: string,
  dataAgeDays: number,
  multiTopicPct: number,
): HealthWarning[] {
  const warnings: HealthWarning[] = [];

  if (unclassifiedPct > UNCLASSIFIED_WARNING_THRESHOLD) {
    warnings.push({
      type: 'unclassified',
      severity: unclassifiedPct > UNCLASSIFIED_CRITICAL_THRESHOLD ? 'critical' : 'warning',
      message:
        `${(unclassifiedPct * 100).toFixed(1)}% of events are unclassified ` +
        `(threshold: ${UNCLASSIFIED_WARNING_THRESHOLD * 100}%). ` +
        'Review topic classifier coverage — unclassified events are invisible to trends and forecasts.',
    });
  }

  if (topSourcePct > SOURCE_CONCENTRATION_THRESHOLD) {
    warnings.push({
      type: 'concentration',
      severity: topSourcePct > CONCENTRATION_CRITICAL_THRESHOLD ? 'critical' : 'warning',
      message:
        `Source "${topSourceName}" accounts for ${(topSourcePct * 100).toFixed(1)}% of events ` +
        `(threshold: ${SOURCE_CONCENTRATION_THRESHOLD * 100}%). ` +
        'High concentration biases trend scoring and chain detection toward one source\'s editorial choices.',
    });
  }

  if (dataAgeDays < MIN_DATA_AGE_DAYS) {
    warnings.push({
      type: 'data_age',
      severity: dataAgeDays < DATA_AGE_CRITICAL_THRESHOLD ? 'critical' : 'warning',
      message:
        `Data spans only ${dataAgeDays} days (threshold: ${MIN_DATA_AGE_DAYS}). ` +
        'Lifecycle classification and chain detection need ≥90 days of data for reliable results.',
    });
  }

  if (multiTopicPct > MULTI_TOPIC_WARNING_THRESHOLD) {
    warnings.push({
      type: 'over_classification',
      severity: multiTopicPct > OVER_CLASSIFICATION_CRITICAL_THRESHOLD ? 'critical' : 'warning',
      message:
        `${(multiTopicPct * 100).toFixed(1)}% of events are assigned to 4+ topics ` +
        `(threshold: ${MULTI_TOPIC_WARNING_THRESHOLD * 100}%). ` +
        'High over-classification rates may inflate chain co-occurrence counts — review classifier precision.',
    });
  }

  return warnings;
}

/* ── Spec 015 §B: Topic count distribution diagnostic ──────────────── */

let hasLoggedTopicDistribution = false;

function logTopicCountDistribution(db: Database.Database): void {
  if (hasLoggedTopicDistribution) return;
  hasLoggedTopicDistribution = true;

  try {
    const rows = db.prepare(`
      SELECT topic_count, COUNT(*) AS event_count
      FROM (
        SELECT event_id, COUNT(*) AS topic_count
        FROM event_topics
        GROUP BY event_id
      )
      GROUP BY topic_count
      ORDER BY topic_count
    `).all() as Array<{ topic_count: number; event_count: number }>;

    const total = rows.reduce((sum, r) => sum + r.event_count, 0);
    const parts = rows.map(r =>
      `${r.topic_count}→${r.event_count} (${((r.event_count / total) * 100).toFixed(1)}%)`,
    );
    console.debug(`Topic count distribution: ${parts.join(', ')}`);
  } catch {
    // Diagnostic only — failure is non-critical
  }
}
