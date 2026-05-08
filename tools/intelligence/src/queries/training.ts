/**
 * Training data infrastructure for classifier evaluation and evolution.
 *
 * Provides reservoir sampling from the main events database, standalone
 * training SQLite databases, labeling operations, and evaluation metrics.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, error } from '../util/envelope.js';
import { loadTopics, classify, mulberry32, loadStatModel, hasStatModel } from '../collector/topic-classifier.js';
import type { IntelResponse } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Constants (§G) ---

export const DEFAULT_SAMPLE_RATE = 0.1;
export const MIN_SAMPLE_SIZE = 100;
export const MAX_SAMPLE_RATE = 1.0;
export const MAX_NEXT_LIMIT = 50;
export const MIN_TOPIC_SAMPLES = 30;
export const TRAINING_APP_ID = 0x54524E47; // "TRNG"
export const SAMPLING_ALGORITHM = 'reservoir_sampling_algorithm_r';
export const MIN_TRAINING_EVENTS = 500;

// --- Types (§E) ---

export interface TrainingSetOpts {
  sampleRate: number;
  outputPath?: string;
  sourceDbPath: string;
  seed?: number;
  dryRun?: boolean;
}

export interface TrainingSetResult {
  path: string;
  total_events: number;
  sample_size: number;
  sample_rate: number;
  algorithm: string;
  created_at: string;
}

export interface TrainingLabel {
  human_topics: string[];
  labeler?: string;
  notes?: string;
}

export interface TrainingLabelResult {
  event_id: string;
  human_topics: string[];
  labeler: string;
  reviewed_at: string;
}

export interface TrainingProgressResult {
  total: number;
  reviewed: number;
  remaining: number;
  pct_complete: number;
  per_topic?: TopicCoverage[];
  topics_sufficient?: number;
  topics_insufficient?: number;
}

export interface TopicCoverage {
  topic: string;
  count: number;
  sufficient: boolean;
}

export interface TrainingSetSummary {
  path: string;
  created_at: string;
  sample_size: number;
  total_events: number;
  reviewed: number;
  remaining: number;
  pct_complete: number;
}

export interface UnreviewedEvent {
  event_id: string;
  title: string | null;
  content: string | null;
  url: string | null;
  source: string;
  feed: string | null;
  author: string | null;
  machine_topics?: string[];
  machine_confidences?: (number | null)[];
  machine_scores?: (number | null)[];
  published_at: string | null;
  fetched_at: string;
  score: number;
  comments: number;
}

export interface EvaluationOpts {
  minSamples: number;
  labeler?: string;
  /** When true, re-run classify() on title/content instead of reading stored machine_topics. */
  reclassify?: boolean;
  /** Override topics.yaml path (used by tests to pin a fixture). */
  topicsPath?: string;
}

export interface EvaluationResult {
  evaluated_events: number;
  overall: {
    precision: number;
    recall: number;
    f1: number;
    hamming_loss: number;
    over_classification_rate: number;
    false_over_classification_rate: number;
  };
  per_topic: TopicEvaluation[];
  insufficient_data: { topic: string; samples: number }[];
  confusion_pairs: { predicted: string; actual: string; count: number; direction: 'fp' | 'fn' }[];
}

export interface TopicEvaluation {
  topic: string;
  samples: number;
  precision: number;
  recall: number;
  f1: number;
  false_positives: number;
  false_negatives: number;
}

interface ExportEvent {
  event_id: string;
  title: string | null;
  source: string;
  feed: string | null;
  machine_topics: string[];
  machine_confidences: (number | null)[];
  machine_scores: (number | null)[];
  human_topics: string[] | null;
  labeler: string;
  notes: string | null;
  reviewed_at: string | null;
}

// --- Training DB Schema ---

const TRAINING_SCHEMA = `
CREATE TABLE training_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT    UNIQUE NOT NULL,
  title           TEXT,
  content         TEXT,
  url             TEXT,
  source          TEXT,
  feed            TEXT,
  published_at    TEXT,
  fetched_at      TEXT,
  author          TEXT,
  score           INTEGER DEFAULT 0,
  comments        INTEGER DEFAULT 0,
  machine_topics  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(machine_topics)),
  machine_confidences TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(machine_confidences)),
  machine_scores  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(machine_scores)),
  human_topics    TEXT    CHECK (human_topics IS NULL OR json_valid(human_topics)),
  labeler         TEXT    DEFAULT 'unspecified',
  notes           TEXT,
  reviewed_at     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_training_unreviewed ON training_events(id) WHERE reviewed_at IS NULL;

CREATE TABLE training_labels (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT    NOT NULL REFERENCES training_events(event_id),
  human_topics TEXT    NOT NULL CHECK (json_valid(human_topics)),
  labeler      TEXT    NOT NULL,
  notes        TEXT,
  labeled_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_training_labels_event ON training_labels(event_id);

CREATE TABLE training_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// --- Validation helpers ---

function openTrainingDb(dbPath: string, readonly = true): Database.Database {
  if (!existsSync(dbPath)) {
    throw new Error(`Training database not found: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly, timeout: 5000 });
  const appId = db.pragma('application_id', { simple: true }) as number;
  if (appId !== TRAINING_APP_ID) {
    db.close();
    throw new Error(
      `Not a training database (expected application_id 0x${TRAINING_APP_ID.toString(16).toUpperCase()}). Did you pass the main intelligence database by mistake?`,
    );
  }

  const schemaVersion = db.prepare("SELECT value FROM training_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (schemaVersion && schemaVersion.value !== '1') {
    db.close();
    throw new Error(
      `Training DB schema version ${schemaVersion.value} is not supported by this tool version (supports: 1).`,
    );
  }

  return db;
}

function parseJsonArray<T>(raw: string | null, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// --- Core Functions ---

/**
 * Generate a training set via reservoir sampling (Algorithm R).
 */
export function generateTrainingSet(
  sourceDb: Database.Database,
  opts: TrainingSetOpts,
): IntelResponse<TrainingSetResult | { total_events: number; sample_size: number; sample_rate: number; path: string }> {
  // Validate sample rate
  if (opts.sampleRate <= 0 || opts.sampleRate > MAX_SAMPLE_RATE) {
    return error({
      code: 'INVALID_QUERY',
      message: `Sample rate must be in (0.0, ${MAX_SAMPLE_RATE}]. Got ${opts.sampleRate}.`,
      retryable: false,
      suggested_action: 'Provide a valid --sample-rate value.',
    }) as unknown as IntelResponse<TrainingSetResult>;
  }

  // Validate seed if provided
  if (opts.seed != null) {
    if (!Number.isInteger(opts.seed) || opts.seed < 0 || opts.seed > 4294967295) {
      return error({
        code: 'INVALID_QUERY',
        message: 'Seed must be an integer in [0, 4294967295].',
        retryable: false,
        suggested_action: 'Provide a valid integer --seed value.',
      }) as unknown as IntelResponse<TrainingSetResult>;
    }
  }

  // Count events
  const totalRow = sourceDb.prepare('SELECT COUNT(*) AS cnt FROM events').get() as { cnt: number };
  const totalEvents = totalRow.cnt;

  if (totalEvents === 0) {
    return error({
      code: 'INVALID_QUERY',
      message: 'Source database has 0 events.',
      retryable: false,
      suggested_action: 'Run `intel collect --once` first.',
    }) as unknown as IntelResponse<TrainingSetResult>;
  }

  const sampleSize = Math.max(1, Math.round(totalEvents * opts.sampleRate));

  if (sampleSize < MIN_SAMPLE_SIZE) {
    return error({
      code: 'INVALID_QUERY',
      message: `Sample too small: ${totalEvents} events at rate ${opts.sampleRate} produces ${sampleSize} samples, minimum ${MIN_SAMPLE_SIZE}. Increase --sample-rate.`,
      retryable: false,
      suggested_action: `Increase --sample-rate to at least ${Math.ceil(MIN_SAMPLE_SIZE / totalEvents * 100) / 100}.`,
    }) as unknown as IntelResponse<TrainingSetResult>;
  }

  // Determine output path
  const now = new Date();
  const timestamp = now.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, '');
  const defaultDir = join(
    process.env.HOME ?? process.env.USERPROFILE ?? '.',
    '.local', 'share', 'intel',
  );
  const outputPath = opts.outputPath ?? join(defaultDir, `training-set-${timestamp}.db`);

  // Dry run — return metadata without creating DB
  if (opts.dryRun) {
    return ok({
      path: outputPath,
      total_events: totalEvents,
      sample_size: sampleSize,
      sample_rate: opts.sampleRate,
    });
  }

  // Check output path collision
  if (existsSync(outputPath)) {
    return error({
      code: 'INVALID_QUERY',
      message: `Output file already exists: ${outputPath}`,
      retryable: false,
      suggested_action: 'Delete the existing file or choose a different --output path.',
    }) as unknown as IntelResponse<TrainingSetResult>;
  }

  // Ensure output directory exists
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Set up PRNG
  const random = opts.seed != null ? mulberry32(opts.seed) : Math.random;

  // Reservoir sampling (Algorithm R)
  const iter = sourceDb
    .prepare(
      `SELECT event_id, title, content, url, source, feed,
              author, topics, published_at, fetched_at, score, comments
       FROM events ORDER BY id`,
    )
    .iterate() as IterableIterator<{
      event_id: string;
      title: string | null;
      content: string | null;
      url: string | null;
      source: string;
      feed: string | null;
      author: string | null;
      topics: string;
      published_at: string | null;
      fetched_at: string;
      score: number;
      comments: number;
    }>;

  const reservoir: Array<{
    event_id: string;
    title: string | null;
    content: string | null;
    url: string | null;
    source: string;
    feed: string | null;
    author: string | null;
    topics: string;
    published_at: string | null;
    fetched_at: string;
    score: number;
    comments: number;
    machine_confidences?: string;
    machine_scores?: string;
  }> = [];

  let i = 0;
  for (const row of iter) {
    if (i < sampleSize) {
      reservoir.push(row);
    } else {
      const j = Math.floor(random() * (i + 1));
      if (j < sampleSize) {
        reservoir[j] = row;
      }
    }
    i++;
  }

  // Batch-query event_topics for confidence/score data
  const CHUNK_SIZE = 500;
  const confByEvent = new Map<string, Map<string, { confidence: number | null; score: number | null }>>();

  for (let start = 0; start < reservoir.length; start += CHUNK_SIZE) {
    const chunk = reservoir.slice(start, start + CHUNK_SIZE);
    const ids = chunk.map((r) => r.event_id);
    const placeholders = ids.map(() => '?').join(',');
    try {
      const rows = sourceDb
        .prepare(
          `SELECT event_id, topic, confidence, score
           FROM event_topics WHERE event_id IN (${placeholders})`,
        )
        .all(...ids) as Array<{
          event_id: string;
          topic: string;
          confidence: number | null;
          score: number | null;
        }>;
      for (const c of rows) {
        if (!confByEvent.has(c.event_id)) confByEvent.set(c.event_id, new Map());
        confByEvent.get(c.event_id)!.set(c.topic, {
          confidence: c.confidence ?? null,
          score: c.score ?? null,
        });
      }
    } catch {
      // event_topics may not have score column in older schemas — ignore
    }
  }

  // Align confidences and scores to topic order
  for (const row of reservoir) {
    const topics: string[] = parseJsonArray(row.topics);
    const confMap = confByEvent.get(row.event_id) ?? new Map();
    const confidences = topics.map((t) => confMap.get(t)?.confidence ?? null);
    const scores = topics.map((t) => confMap.get(t)?.score ?? null);
    row.machine_confidences = JSON.stringify(confidences);
    row.machine_scores = JSON.stringify(scores);
  }

  // Compute metadata hashes
  const topicsYamlPath = join(__dirname, '..', '..', 'config', 'topics.yaml');
  const classifierPath = join(__dirname, '..', 'collector', 'topic-classifier.ts');
  const topicsYamlSha256 = existsSync(topicsYamlPath)
    ? createHash('sha256').update(readFileSync(topicsYamlPath)).digest('hex')
    : 'unknown';
  const classifierSha256 = existsSync(classifierPath)
    ? createHash('sha256').update(readFileSync(classifierPath)).digest('hex')
    : 'unknown';

  // Create training DB and populate
  let trainingDb: Database.Database | null = null;
  try {
    trainingDb = new Database(outputPath);
    trainingDb.pragma('journal_mode = WAL');
    trainingDb.pragma('synchronous = NORMAL');
    trainingDb.pragma(`application_id = ${TRAINING_APP_ID}`);

    trainingDb.exec(TRAINING_SCHEMA);

    const createdAt = now.toISOString();

    // Single transaction for all inserts
    trainingDb.transaction(() => {
      // Insert metadata
      const insertMeta = trainingDb!.prepare(
        'INSERT INTO training_meta (key, value) VALUES (?, ?)',
      );
      insertMeta.run('schema_version', '1');
      insertMeta.run('created_at', createdAt);
      insertMeta.run('source_db', resolve(opts.sourceDbPath));
      insertMeta.run('sample_size', String(sampleSize));
      insertMeta.run('total_events', String(totalEvents));
      insertMeta.run('sample_rate', String(opts.sampleRate));
      insertMeta.run('seed', opts.seed != null ? String(opts.seed) : 'null');
      insertMeta.run('prng_algorithm', opts.seed != null ? 'mulberry32' : 'null');
      insertMeta.run('topics_yaml_sha256', topicsYamlSha256);
      insertMeta.run('classifier_config_sha256', classifierSha256);
      insertMeta.run('algorithm', SAMPLING_ALGORITHM);

      // Insert sampled events
      const insertEvent = trainingDb!.prepare(`
        INSERT INTO training_events (
          event_id, title, content, url, source, feed, published_at,
          fetched_at, author, score, comments, machine_topics,
          machine_confidences, machine_scores
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of reservoir) {
        insertEvent.run(
          row.event_id,
          row.title,
          row.content,
          row.url,
          row.source,
          row.feed,
          row.published_at,
          row.fetched_at,
          row.author,
          row.score,
          row.comments,
          row.topics,
          row.machine_confidences ?? '[]',
          row.machine_scores ?? '[]',
        );
      }
    })();

    trainingDb.close();
    trainingDb = null;

    return ok({
      path: outputPath,
      total_events: totalEvents,
      sample_size: reservoir.length,
      sample_rate: opts.sampleRate,
      algorithm: SAMPLING_ALGORITHM,
      created_at: now.toISOString(),
    });
  } catch (err) {
    // Rollback: close and delete partial file
    if (trainingDb) {
      try { trainingDb.close(); } catch { /* ignore */ }
    }
    if (existsSync(outputPath)) {
      try { unlinkSync(outputPath); } catch { /* ignore */ }
    }
    throw err;
  }
}

/**
 * Get the next unreviewed events for classification.
 */
export function getNextUnreviewed(
  db: Database.Database,
  limit = 1,
  showMachineLabels = false,
): IntelResponse<UnreviewedEvent[]> {
  const effectiveLimit = Math.min(Math.max(1, limit), MAX_NEXT_LIMIT);

  const rows = db
    .prepare(
      `SELECT event_id, title, content, url, source, feed, author,
              machine_topics, machine_confidences, machine_scores,
              published_at, fetched_at, score, comments
       FROM training_events
       WHERE reviewed_at IS NULL
       ORDER BY id
       LIMIT ?`,
    )
    .all(effectiveLimit) as Array<{
      event_id: string;
      title: string | null;
      content: string | null;
      url: string | null;
      source: string;
      feed: string | null;
      author: string | null;
      machine_topics: string;
      machine_confidences: string;
      machine_scores: string;
      published_at: string | null;
      fetched_at: string;
      score: number;
      comments: number;
    }>;

  const events: UnreviewedEvent[] = rows.map((row) => {
    const event: UnreviewedEvent = {
      event_id: row.event_id,
      title: row.title,
      content: row.content,
      url: row.url,
      source: row.source,
      feed: row.feed,
      author: row.author,
      published_at: row.published_at,
      fetched_at: row.fetched_at,
      score: row.score,
      comments: row.comments,
    };

    if (showMachineLabels) {
      event.machine_topics = parseJsonArray(row.machine_topics);
      event.machine_confidences = parseJsonArray(row.machine_confidences);
      event.machine_scores = parseJsonArray(row.machine_scores);
    }

    return event;
  });

  return ok(events);
}

/**
 * Assign human-classified topics to a training event.
 */
export function updateTrainingLabel(
  db: Database.Database,
  eventId: string,
  label: TrainingLabel,
): IntelResponse<TrainingLabelResult> {
  // Check event exists
  const existing = db
    .prepare('SELECT event_id, human_topics, labeler, reviewed_at FROM training_events WHERE event_id = ?')
    .get(eventId) as {
      event_id: string;
      human_topics: string | null;
      labeler: string | null;
      reviewed_at: string | null;
    } | undefined;

  if (!existing) {
    return error({
      code: 'INVALID_QUERY',
      message: `Event not found in training set: ${eventId}`,
      retryable: false,
      suggested_action: 'Check the event_id and training database path.',
    }) as unknown as IntelResponse<TrainingLabelResult>;
  }

  const humanTopics = label.human_topics;
  const labeler = label.labeler ?? 'unspecified';
  const notes = label.notes ?? null;
  const warnings: string[] = [];

  // Validate topic count
  if (humanTopics.length > 5) {
    return error({
      code: 'INVALID_QUERY',
      message: `Too many topics: ${humanTopics.length}. Maximum is 5.`,
      retryable: false,
      suggested_action: 'Assign at most 5 topics.',
    }) as unknown as IntelResponse<TrainingLabelResult>;
  }

  if (humanTopics.length > 3) {
    warnings.push(
      `Typical labeling target is ≤3 topics; got ${humanTopics.length}. Proceeding — cross-domain events may legitimately need 4-5.`,
    );
  }

  // Validate topic IDs against taxonomy
  try {
    const validTopics = loadTopics();
    const validIds = new Set(validTopics.map((t) => t.id));
    for (const t of humanTopics) {
      if (!validIds.has(t)) {
        warnings.push(`Unknown topic ID: "${t}" — not in current taxonomy.`);
      }
    }
  } catch {
    // Can't load taxonomy — skip validation
  }

  // Check for overwrite
  if (existing.reviewed_at != null) {
    warnings.push(
      `Overwriting existing label from ${existing.labeler} at ${existing.reviewed_at}. Previous label preserved in training_labels history.`,
    );
  }

  const topicsJson = JSON.stringify(humanTopics);
  const reviewedAt = new Date().toISOString();

  // Transaction: update training_events + insert into training_labels
  db.transaction(() => {
    db.prepare(
      `UPDATE training_events
       SET human_topics = ?, labeler = ?, notes = ?, reviewed_at = ?
       WHERE event_id = ?`,
    ).run(topicsJson, labeler, notes, reviewedAt, eventId);

    db.prepare(
      `INSERT INTO training_labels (event_id, human_topics, labeler, notes)
       VALUES (?, ?, ?, ?)`,
    ).run(eventId, topicsJson, labeler, notes);
  })();

  return ok(
    {
      event_id: eventId,
      human_topics: humanTopics,
      labeler,
      reviewed_at: reviewedAt,
    },
    { warnings },
  );
}

/**
 * Report labeling progress for a training set.
 */
export function trainingProgress(
  db: Database.Database,
  verbose = false,
): IntelResponse<TrainingProgressResult> {
  const total = (
    db.prepare('SELECT COUNT(*) AS cnt FROM training_events').get() as { cnt: number }
  ).cnt;
  const reviewed = (
    db
      .prepare('SELECT COUNT(*) AS cnt FROM training_events WHERE reviewed_at IS NOT NULL')
      .get() as { cnt: number }
  ).cnt;
  const remaining = total - reviewed;
  const pctComplete = total > 0 ? Math.round((reviewed / total) * 1000) / 1000 : 0;

  const result: TrainingProgressResult = {
    total,
    reviewed,
    remaining,
    pct_complete: pctComplete,
  };

  if (verbose) {
    const topicRows = db
      .prepare(
        `SELECT j.value AS topic, COUNT(*) AS cnt
         FROM training_events te, json_each(te.human_topics) j
         WHERE te.reviewed_at IS NOT NULL
         GROUP BY j.value
         ORDER BY cnt DESC`,
      )
      .all() as Array<{ topic: string; cnt: number }>;

    result.per_topic = topicRows.map((r) => ({
      topic: r.topic,
      count: r.cnt,
      sufficient: r.cnt >= MIN_TOPIC_SAMPLES,
    }));
    result.topics_sufficient = result.per_topic.filter((t) => t.sufficient).length;
    result.topics_insufficient = result.per_topic.filter((t) => !t.sufficient).length;
  }

  return ok(result);
}

/**
 * List training databases in a directory.
 */
export function listTrainingSets(dir?: string): IntelResponse<TrainingSetSummary[]> {
  const scanDir =
    dir ??
    join(
      process.env.HOME ?? process.env.USERPROFILE ?? '.',
      '.local', 'share', 'intel',
    );

  if (!existsSync(scanDir)) {
    return ok([]);
  }

  const files = readdirSync(scanDir).filter(
    (f) => f.startsWith('training-set-') && f.endsWith('.db'),
  );

  const summaries: TrainingSetSummary[] = [];

  for (const file of files) {
    const filePath = join(scanDir, file);
    try {
      const db = new Database(filePath, { readonly: true, timeout: 2000 });
      try {
        const appId = db.pragma('application_id', { simple: true }) as number;
        if (appId !== TRAINING_APP_ID) continue;

        const meta = new Map<string, string>();
        const metaRows = db.prepare('SELECT key, value FROM training_meta').all() as Array<{
          key: string;
          value: string;
        }>;
        for (const row of metaRows) {
          meta.set(row.key, row.value);
        }

        const total = (
          db.prepare('SELECT COUNT(*) AS cnt FROM training_events').get() as { cnt: number }
        ).cnt;
        const reviewed = (
          db
            .prepare('SELECT COUNT(*) AS cnt FROM training_events WHERE reviewed_at IS NOT NULL')
            .get() as { cnt: number }
        ).cnt;

        summaries.push({
          path: filePath,
          created_at: meta.get('created_at') ?? '',
          sample_size: parseInt(meta.get('sample_size') ?? '0', 10),
          total_events: parseInt(meta.get('total_events') ?? '0', 10),
          reviewed,
          remaining: total - reviewed,
          pct_complete: total > 0 ? Math.round((reviewed / total) * 1000) / 1000 : 0,
        });
      } finally {
        db.close();
      }
    } catch {
      // Skip files that can't be opened or aren't valid DBs
    }
  }

  // Sort by created_at descending
  summaries.sort((a, b) => b.created_at.localeCompare(a.created_at));

  return ok(summaries);
}

/**
 * Export training events as JSON envelope or raw JSONL.
 */
export function exportTrainingSet(
  db: Database.Database,
  opts: {
    reviewedOnly?: boolean;
    raw?: boolean;
    outputPath?: string;
  } = {},
): IntelResponse<{ exported: number; events?: ExportEvent[]; path?: string }> | string {
  // Check output path collision
  if (opts.outputPath && existsSync(opts.outputPath)) {
    return error({
      code: 'INVALID_QUERY',
      message: `Output file already exists: ${opts.outputPath}`,
      retryable: false,
      suggested_action: 'Delete the existing file or choose a different --output path.',
    }) as unknown as IntelResponse<{ exported: number; events?: ExportEvent[]; path?: string }>;
  }

  const whereClause = opts.reviewedOnly ? 'WHERE reviewed_at IS NOT NULL' : '';
  const rows = db
    .prepare(
      `SELECT event_id, title, source, feed, machine_topics, machine_confidences,
              machine_scores, human_topics, labeler, notes, reviewed_at
       FROM training_events ${whereClause}
       ORDER BY id`,
    )
    .all() as Array<{
      event_id: string;
      title: string | null;
      source: string;
      feed: string | null;
      machine_topics: string;
      machine_confidences: string;
      machine_scores: string;
      human_topics: string | null;
      labeler: string;
      notes: string | null;
      reviewed_at: string | null;
    }>;

  const events: ExportEvent[] = rows.map((row) => ({
    event_id: row.event_id,
    title: row.title,
    source: row.source,
    feed: row.feed,
    machine_topics: parseJsonArray(row.machine_topics),
    machine_confidences: parseJsonArray(row.machine_confidences),
    machine_scores: parseJsonArray(row.machine_scores),
    human_topics: row.human_topics ? parseJsonArray<string>(row.human_topics) : null,
    labeler: row.labeler,
    notes: row.notes,
    reviewed_at: row.reviewed_at,
  }));

  // Write to file
  if (opts.outputPath) {
    const outputDir = dirname(opts.outputPath);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    const lines = events.map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(opts.outputPath, lines + (lines.length > 0 ? '\n' : ''));
    return ok({ exported: events.length, path: opts.outputPath });
  }

  // Raw JSONL to stdout
  if (opts.raw) {
    return events.map((e) => JSON.stringify(e)).join('\n');
  }

  // JSON envelope (default)
  return ok({ exported: events.length, events });
}

/**
 * Evaluate classifier accuracy by comparing machine vs human labels.
 */
export function evaluateTrainingSet(
  db: Database.Database,
  opts: EvaluationOpts = { minSamples: MIN_TOPIC_SAMPLES },
): IntelResponse<EvaluationResult> {
  // Get all reviewed events
  const needsContent = opts.reclassify ?? false;
  let query = needsContent
    ? `SELECT title, content, machine_topics, human_topics, labeler
       FROM training_events WHERE reviewed_at IS NOT NULL`
    : `SELECT machine_topics, human_topics, labeler
       FROM training_events WHERE reviewed_at IS NOT NULL`;
  const params: string[] = [];
  if (opts.labeler) {
    query += ' AND labeler = ?';
    params.push(opts.labeler);
  }

  const rows = db.prepare(query).all(...params) as Array<{
    title?: string | null;
    content?: string | null;
    machine_topics: string;
    human_topics: string;
    labeler: string;
  }>;

  if (rows.length < 10) {
    return error({
      code: 'INVALID_QUERY',
      message: `Insufficient reviewed events: ${rows.length}. Minimum 10 required.`,
      retryable: false,
      suggested_action: 'Label more events before evaluating.',
    }) as unknown as IntelResponse<EvaluationResult>;
  }

  // Get all topic IDs for Hamming loss
  const allTopics = loadTopics(opts.topicsPath);
  const totalTopics = allTopics.length || 66;

  // Per-topic counters
  const tp = new Map<string, number>();
  const fp = new Map<string, number>();
  const fn = new Map<string, number>();
  const topicSamples = new Map<string, number>();

  // Confusion pair counters
  const fpCounts = new Map<string, number>(); // "predicted|actual" → count
  const fnCounts = new Map<string, number>(); // "predicted|actual" → count

  // Over-classification counters
  let overClassified = 0;
  let falseOverClassified = 0;
  let totalSymmetricDiff = 0;

  for (const row of rows) {
    let machineSet: Set<string>;
    if (needsContent) {
      const classified = classify(row.title ?? null, row.content ?? null);
      machineSet = new Set(classified.map((t) => t.id));
    } else {
      machineSet = new Set<string>(parseJsonArray(row.machine_topics));
    }
    const humanSet = new Set<string>(parseJsonArray(row.human_topics));

    // Over-classification
    if (machineSet.size >= 4) overClassified++;
    if (machineSet.size >= 4 && humanSet.size <= 3) falseOverClassified++;

    // Symmetric difference for Hamming loss
    for (const t of machineSet) {
      if (!humanSet.has(t)) totalSymmetricDiff++;
    }
    for (const t of humanSet) {
      if (!machineSet.has(t)) totalSymmetricDiff++;
    }

    // Per-topic TP/FP/FN
    const allMentioned = new Set([...machineSet, ...humanSet]);
    for (const t of allMentioned) {
      const inMachine = machineSet.has(t);
      const inHuman = humanSet.has(t);

      if (inMachine && inHuman) {
        tp.set(t, (tp.get(t) ?? 0) + 1);
        topicSamples.set(t, (topicSamples.get(t) ?? 0) + 1);
      } else if (inMachine && !inHuman) {
        fp.set(t, (fp.get(t) ?? 0) + 1);
        topicSamples.set(t, (topicSamples.get(t) ?? 0) + 1);
        // FP confusion pair: predicted=t, actual=highest-scoring human topic
        const humanTopics = [...humanSet];
        const actual = humanTopics[0] ?? 'none';
        const key = `${t}|${actual}`;
        fpCounts.set(key, (fpCounts.get(key) ?? 0) + 1);
      } else if (!inMachine && inHuman) {
        fn.set(t, (fn.get(t) ?? 0) + 1);
        topicSamples.set(t, (topicSamples.get(t) ?? 0) + 1);
        // FN confusion pair: predicted=highest-scoring machine topic, actual=t
        const machineTopics = [...machineSet];
        const predicted = machineTopics[0] ?? 'none';
        const key = `${predicted}|${t}`;
        fnCounts.set(key, (fnCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // Compute per-topic metrics
  const perTopic: TopicEvaluation[] = [];
  const insufficientData: { topic: string; samples: number }[] = [];
  const precisions: number[] = [];
  const recalls: number[] = [];

  for (const [topic, samples] of topicSamples) {
    const tpCount = tp.get(topic) ?? 0;
    const fpCount = fp.get(topic) ?? 0;
    const fnCount = fn.get(topic) ?? 0;

    if (samples < opts.minSamples) {
      insufficientData.push({ topic, samples });
      continue;
    }

    const precision = tpCount + fpCount > 0 ? tpCount / (tpCount + fpCount) : 0;
    const recall = tpCount + fnCount > 0 ? tpCount / (tpCount + fnCount) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    perTopic.push({
      topic,
      samples,
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
      f1: Math.round(f1 * 1000) / 1000,
      false_positives: fpCount,
      false_negatives: fnCount,
    });

    precisions.push(precision);
    recalls.push(recall);
  }

  // Sort per_topic by F1 ascending (worst first)
  perTopic.sort((a, b) => a.f1 - b.f1);
  insufficientData.sort((a, b) => a.samples - b.samples);

  // Macro-averaged overall scores
  const overallPrecision =
    precisions.length > 0 ? precisions.reduce((a, b) => a + b, 0) / precisions.length : 0;
  const overallRecall =
    recalls.length > 0 ? recalls.reduce((a, b) => a + b, 0) / recalls.length : 0;
  const overallF1 =
    overallPrecision + overallRecall > 0
      ? (2 * overallPrecision * overallRecall) / (overallPrecision + overallRecall)
      : 0;

  const hammingLoss = rows.length > 0 ? totalSymmetricDiff / (rows.length * totalTopics) : 0;

  // Build confusion pairs
  const confusionPairs: { predicted: string; actual: string; count: number; direction: 'fp' | 'fn' }[] = [];
  for (const [key, count] of fpCounts) {
    const [predicted, actual] = key.split('|');
    confusionPairs.push({ predicted, actual, count, direction: 'fp' });
  }
  for (const [key, count] of fnCounts) {
    const [predicted, actual] = key.split('|');
    confusionPairs.push({ predicted, actual, count, direction: 'fn' });
  }
  confusionPairs.sort((a, b) => b.count - a.count);

  return ok({
    evaluated_events: rows.length,
    overall: {
      precision: Math.round(overallPrecision * 1000) / 1000,
      recall: Math.round(overallRecall * 1000) / 1000,
      f1: Math.round(overallF1 * 1000) / 1000,
      hamming_loss: Math.round(hammingLoss * 10000) / 10000,
      over_classification_rate: Math.round((overClassified / rows.length) * 1000) / 1000,
      false_over_classification_rate:
        Math.round((falseOverClassified / rows.length) * 1000) / 1000,
    },
    per_topic: perTopic,
    insufficient_data: insufficientData,
    confusion_pairs: confusionPairs.slice(0, 20),
  });
}

// --- Reclassify training set ---

export interface ReclassifyTrainingResult {
  events_processed: number;
  classifier_config_sha256: string;
  topics_yaml_sha256: string;
  labels_cleared?: number;
}

/**
 * Re-run the topic classifier on all training events.
 * Scraps existing machine_topics/confidences/scores, re-classifies from
 * title+content using the current classifier.
 *
 * When clearLabels is true, also NULLs out human_topics/labeler/notes/reviewed_at
 * and DELETEs all rows from training_labels so labeling can start fresh.
 */
export function reclassifyTrainingSet(
  db: Database.Database,
  batchSize = 500,
  clearLabels = false,
): IntelResponse<ReclassifyTrainingResult> {
  // Load current classifier
  const topics = loadTopics();
  if (topics.length === 0) {
    return error({
      code: 'INTERNAL_ERROR' as any,
      message: 'No topics loaded from topics.yaml. Cannot reclassify.',
      retryable: false,
      suggested_action: 'Check that config/topics.yaml exists and is valid.',
    }) as unknown as IntelResponse<ReclassifyTrainingResult>;
  }

  // Load statistical model for ensemble scoring if not already loaded (e.g. by CLI --model)
  if (!hasStatModel()) {
    const defaultDir = join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.local', 'share', 'intel');
    const modelPath = join(defaultDir, 'classifier-model.json');
    if (!loadStatModel(modelPath)) {
      console.warn(`[intel] No classifier model found at ${modelPath}; reclassification will use BM25-only scoring.`);
    }
  }

  // Compute new metadata hashes
  const topicsYamlPath = join(__dirname, '..', '..', 'config', 'topics.yaml');
  const classifierPath = join(__dirname, '..', 'collector', 'topic-classifier.ts');
  const topicsYamlSha256 = existsSync(topicsYamlPath)
    ? createHash('sha256').update(readFileSync(topicsYamlPath)).digest('hex')
    : 'unknown';
  const classifierSha256 = existsSync(classifierPath)
    ? createHash('sha256').update(readFileSync(classifierPath)).digest('hex')
    : 'unknown';

  const selectStmt = db.prepare(
    'SELECT event_id, title, content FROM training_events LIMIT ? OFFSET ?',
  );
  const updateStmt = db.prepare(`
    UPDATE training_events
    SET machine_topics = ?, machine_confidences = ?, machine_scores = ?
    WHERE event_id = ?
  `);

  let eventsProcessed = 0;
  let offset = 0;

  while (true) {
    const rows = selectStmt.all(batchSize, offset) as Array<{
      event_id: string;
      title: string | null;
      content: string | null;
    }>;
    if (rows.length === 0) break;

    db.transaction(() => {
      for (const row of rows) {
        const classified = classify(row.title, row.content);
        const topicIds = JSON.stringify(classified.map((t) => t.id));
        const confidences = JSON.stringify(classified.map((t) => t.confidence));
        const scores = JSON.stringify(classified.map((t) => t.score));
        updateStmt.run(topicIds, confidences, scores, row.event_id);
        eventsProcessed++;
      }
    })();

    offset += batchSize;
    if (rows.length < batchSize) break;
  }

  // Clear human labels if requested
  let labelsCleared: number | undefined;
  if (clearLabels) {
    db.prepare(
      `UPDATE training_events
       SET human_topics = NULL, labeler = NULL, notes = NULL, reviewed_at = NULL`,
    ).run();
    const deleted = db.prepare('DELETE FROM training_labels').run();
    labelsCleared = deleted.changes;
  }

  // Update metadata
  const upsertMeta = db.prepare(
    'INSERT OR REPLACE INTO training_meta (key, value) VALUES (?, ?)',
  );
  upsertMeta.run('topics_yaml_sha256', topicsYamlSha256);
  upsertMeta.run('classifier_config_sha256', classifierSha256);
  upsertMeta.run('reclassified_at', new Date().toISOString());

  return ok({
    events_processed: eventsProcessed,
    classifier_config_sha256: classifierSha256,
    topics_yaml_sha256: topicsYamlSha256,
    ...(labelsCleared !== undefined && { labels_cleared: labelsCleared }),
  });
}

// Re-export openTrainingDb for CLI commands
export { openTrainingDb };
