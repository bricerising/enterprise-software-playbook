import type Database from 'better-sqlite3';
import { formatISO } from './util/time.js';
import { classify, loadTopics } from './collector/topic-classifier.js';

export interface CheckpointResult {
  busy: boolean;
  total: number;
  checkpointed: number;
}

export interface PruneResult {
  deleted: number;
}

export interface QuickCheckResult {
  ok: boolean;
  errors: string[];
}

/**
 * Force a WAL checkpoint.
 * Modes: PASSIVE (default), FULL, RESTART, TRUNCATE
 */
export function checkpoint(
  db: Database.Database,
  mode: 'passive' | 'full' | 'restart' | 'truncate' = 'passive',
): CheckpointResult {
  const modeMap = {
    passive: 'PASSIVE',
    full: 'FULL',
    restart: 'RESTART',
    truncate: 'TRUNCATE',
  };
  const result = db.pragma(`wal_checkpoint(${modeMap[mode]})`) as Array<{
    busy: number;
    checkpointed: number;
    log: number;
  }>;
  const row = result[0];
  return {
    busy: row.busy === 1,
    total: row.log,
    checkpointed: row.checkpointed,
  };
}

/**
 * Prune events older than retentionDays. Runs in batches.
 */
export function prune(
  db: Database.Database,
  retentionDays: number,
  batchSize = 1000,
): PruneResult {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  let totalDeleted = 0;

  const deleteStmt = db.prepare(`
    DELETE FROM events WHERE id IN (
      SELECT id FROM events
      WHERE fetched_at < ?
      LIMIT ?
    )
  `);

  while (true) {
    const result = deleteStmt.run(cutoff, batchSize);
    totalDeleted += result.changes;
    if (result.changes < batchSize) break;
  }

  return { deleted: totalDeleted };
}

/**
 * Run INCREMENTAL auto_vacuum to reclaim free pages.
 */
export function incrementalVacuum(db: Database.Database, pages?: number): void {
  if (pages !== undefined) {
    db.pragma(`incremental_vacuum(${pages})`);
  } else {
    db.pragma('incremental_vacuum');
  }
}

/**
 * Create an online backup using better-sqlite3's backup API.
 */
export async function backup(db: Database.Database, targetPath: string): Promise<void> {
  await db.backup(targetPath);
}

/**
 * Create a defragmented archival snapshot via VACUUM INTO.
 */
export function vacuumInto(db: Database.Database, targetPath: string): void {
  db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
}

/**
 * Rebuild FTS index from events table.
 */
export function rebuildFts(db: Database.Database): void {
  db.exec("INSERT INTO events_fts(events_fts) VALUES('rebuild')");
}

/**
 * Rebuild event_topics from events.topics JSON. Runs in batches.
 */
export function rebuildTopicIndex(db: Database.Database, batchSize = 1000): number {
  // Clear existing
  db.exec('DELETE FROM event_topics');

  let total = 0;
  let offset = 0;

  const selectStmt = db.prepare(`
    SELECT event_id, topics FROM events
    LIMIT ? OFFSET ?
  `);
  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO event_topics (event_id, topic) VALUES (?, ?)',
  );

  while (true) {
    const rows = selectStmt.all(batchSize, offset) as Array<{
      event_id: string;
      topics: string;
    }>;
    if (rows.length === 0) break;

    const insertBatch = db.transaction(() => {
      for (const row of rows) {
        try {
          const topics = JSON.parse(row.topics) as string[];
          for (const topic of topics) {
            insertStmt.run(row.event_id, topic);
            total++;
          }
        } catch {
          // Skip rows with invalid JSON
        }
      }
    });
    insertBatch();

    offset += batchSize;
    if (rows.length < batchSize) break;
  }

  return total;
}

/**
 * Reclassify all events through the current topic classifier.
 * Updates both events.topics JSON and event_topics table.
 */
export function reclassifyTopics(db: Database.Database, batchSize = 500): { events_processed: number; topic_rows: number } {
  loadTopics(undefined, db);

  db.exec('DELETE FROM event_topics');

  let eventsProcessed = 0;
  let topicRows = 0;
  let offset = 0;

  const selectStmt = db.prepare(`
    SELECT event_id, title, content FROM events
    LIMIT ? OFFSET ?
  `);
  const updateStmt = db.prepare(
    'UPDATE events SET topics = ? WHERE event_id = ?',
  );
  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO event_topics (event_id, topic, confidence) VALUES (?, ?, ?)',
  );

  while (true) {
    const rows = selectStmt.all(batchSize, offset) as Array<{
      event_id: string;
      title: string;
      content: string | null;
    }>;
    if (rows.length === 0) break;

    const batch = db.transaction(() => {
      for (const row of rows) {
        const classified = classify(row.title, row.content);
        const topicIds = classified.map((t) => t.id);
        updateStmt.run(JSON.stringify(topicIds), row.event_id);
        for (const t of classified) {
          insertStmt.run(row.event_id, t.id, t.confidence);
          topicRows++;
        }
        eventsProcessed++;
      }
    });
    batch();

    offset += batchSize;
    if (rows.length < batchSize) break;
  }

  return { events_processed: eventsProcessed, topic_rows: topicRows };
}

/**
 * Optimize FTS index (merge segments).
 */
export function optimizeFts(db: Database.Database): void {
  db.exec("INSERT INTO events_fts(events_fts) VALUES('optimize')");
}

/**
 * Quick integrity check.
 */
export function quickCheck(db: Database.Database): QuickCheckResult {
  const results = db.pragma('quick_check') as Array<{ quick_check: string }>;
  const errors = results
    .map((r) => r.quick_check)
    .filter((r) => r !== 'ok');

  return {
    ok: errors.length === 0,
    errors,
  };
}
