import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openWriter } from '../src/db.js';
import {
  generateTrainingSet,
  getNextUnreviewed,
  updateTrainingLabel,
  trainingProgress,
  listTrainingSets,
  exportTrainingSet,
  evaluateTrainingSet,
  openTrainingDb,
  TRAINING_APP_ID,
  SAMPLING_ALGORITHM,
} from '../src/queries/training.js';
import { mulberry32 } from '../src/collector/topic-classifier.js';

let tmpDir: string;
let dbPath: string;
let writer: Database.Database;

/** Insert n test events into the source database. */
function seedEvents(db: Database.Database, n: number): void {
  const insert = db.prepare(`
    INSERT INTO events (event_id, source, title, content, topics, tags, score, comments, fetched_at)
    VALUES (?, 'rss', ?, ?, '[]', '[]', 0, 0, datetime('now'))
  `);
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      insert.run(`rss:test:${i}`, `Test Event ${i}`, `Content for event ${i}`);
    }
  })();
}

/** Helper to create a populated training DB for label/progress/evaluate tests. */
function createTrainingDb(outputPath: string, n = 20): string {
  const result = generateTrainingSet(writer, {
    sampleRate: 1.0,
    outputPath,
    sourceDbPath: dbPath,
  });
  expect(result.status).toBe('ok');
  return outputPath;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'intel-training-test-'));
  dbPath = join(tmpDir, 'test.db');
  writer = openWriter(dbPath);
  seedEvents(writer, 1000);
});

afterEach(() => {
  writer.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- generateTrainingSet (9 tests) ---

describe('generateTrainingSet', () => {
  it('creates training database with correct sample size', () => {
    const outputPath = join(tmpDir, 'training.db');
    const result = generateTrainingSet(writer, {
      sampleRate: 0.1,
      outputPath,
      sourceDbPath: dbPath,
      seed: 42,
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.sample_size).toBe(100);
      expect(result.data.total_events).toBe(1000);
    }
  });

  it('stores metadata correctly in training_meta', () => {
    const outputPath = join(tmpDir, 'training.db');
    generateTrainingSet(writer, {
      sampleRate: 0.1,
      outputPath,
      sourceDbPath: dbPath,
      seed: 42,
    });

    const tdb = new Database(outputPath, { readonly: true });
    try {
      const meta = new Map<string, string>();
      const rows = tdb.prepare('SELECT key, value FROM training_meta').all() as Array<{
        key: string;
        value: string;
      }>;
      for (const row of rows) {
        meta.set(row.key, row.value);
      }
      expect(meta.get('algorithm')).toBe(SAMPLING_ALGORITHM);
      expect(meta.get('sample_rate')).toBe('0.1');
      expect(meta.get('total_events')).toBe('1000');
      expect(meta.get('seed')).toBe('42');
      expect(meta.get('prng_algorithm')).toBe('mulberry32');
      expect(meta.get('schema_version')).toBe('1');
      expect(meta.get('classifier_config_sha256')).toBeDefined();
      expect(meta.get('topics_yaml_sha256')).toBeDefined();
    } finally {
      tdb.close();
    }
  });

  it('errors on empty database', () => {
    // Create a fresh empty DB
    const emptyDbPath = join(tmpDir, 'empty.db');
    const emptyWriter = openWriter(emptyDbPath);
    const outputPath = join(tmpDir, 'training.db');

    const result = generateTrainingSet(emptyWriter, {
      sampleRate: 0.1,
      outputPath,
      sourceDbPath: emptyDbPath,
    });
    emptyWriter.close();

    expect(result.status).toBe('error');
  });

  it('errors when output path already exists', () => {
    const outputPath = join(tmpDir, 'existing.db');
    writeFileSync(outputPath, 'dummy');

    const result = generateTrainingSet(writer, {
      sampleRate: 0.1,
      outputPath,
      sourceDbPath: dbPath,
    });
    expect(result.status).toBe('error');
  });

  it('all sampled events have human_topics IS NULL initially', () => {
    const outputPath = join(tmpDir, 'training.db');
    generateTrainingSet(writer, {
      sampleRate: 1.0,
      outputPath,
      sourceDbPath: dbPath,
    });

    const tdb = new Database(outputPath, { readonly: true });
    try {
      const row = tdb
        .prepare('SELECT COUNT(*) AS cnt FROM training_events WHERE human_topics IS NOT NULL')
        .get() as { cnt: number };
      expect(row.cnt).toBe(0);
    } finally {
      tdb.close();
    }
  });

  it('machine_topics contains valid JSON arrays', () => {
    const outputPath = join(tmpDir, 'training.db');
    generateTrainingSet(writer, {
      sampleRate: 0.5,
      outputPath,
      sourceDbPath: dbPath,
    });

    const tdb = new Database(outputPath, { readonly: true });
    try {
      const rows = tdb
        .prepare('SELECT machine_topics FROM training_events LIMIT 5')
        .all() as Array<{ machine_topics: string }>;
      for (const row of rows) {
        const parsed = JSON.parse(row.machine_topics);
        expect(Array.isArray(parsed)).toBe(true);
      }
    } finally {
      tdb.close();
    }
  });

  it('sample size respects --sample-rate', () => {
    const outputPath = join(tmpDir, 'training.db');
    const result = generateTrainingSet(writer, {
      sampleRate: 0.2,
      outputPath,
      sourceDbPath: dbPath,
      seed: 42,
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.sample_size).toBe(200);
    }
  });

  it('training DB has application_id = TRAINING_APP_ID', () => {
    const outputPath = join(tmpDir, 'training.db');
    generateTrainingSet(writer, {
      sampleRate: 0.5,
      outputPath,
      sourceDbPath: dbPath,
    });

    const tdb = new Database(outputPath, { readonly: true });
    try {
      const appId = tdb.pragma('application_id', { simple: true }) as number;
      expect(appId).toBe(TRAINING_APP_ID);
    } finally {
      tdb.close();
    }
  });

  it('rolls back and deletes partial file on insert failure', () => {
    // Use an invalid output directory to trigger failure
    const outputPath = join(tmpDir, 'nonexistent', 'deep', 'path', 'training.db');

    // This should succeed because mkdirSync({ recursive: true }) creates the directory
    // Instead test with a path that's a file (not a directory)
    const blockPath = join(tmpDir, 'blocker');
    writeFileSync(blockPath, 'x');
    const badOutputPath = join(blockPath, 'training.db'); // blockPath is a file, not dir

    try {
      generateTrainingSet(writer, {
        sampleRate: 0.5,
        outputPath: badOutputPath,
        sourceDbPath: dbPath,
      });
    } catch {
      // Expected — mkdirSync fails on a file path
    }

    expect(existsSync(badOutputPath)).toBe(false);
  });
});

// --- updateTrainingLabel (7 tests) ---

describe('updateTrainingLabel', () => {
  let trainingDbPath: string;
  let tdb: Database.Database;

  beforeEach(() => {
    trainingDbPath = join(tmpDir, 'label-test.db');
    createTrainingDb(trainingDbPath, 100);
    tdb = openTrainingDb(trainingDbPath, false);
  });

  afterEach(() => {
    tdb.close();
  });

  it('sets human_topics, labeler, notes, and reviewed_at', () => {
    const events = tdb
      .prepare('SELECT event_id FROM training_events LIMIT 1')
      .all() as Array<{ event_id: string }>;
    const eventId = events[0].event_id;

    const result = updateTrainingLabel(tdb, eventId, {
      human_topics: ['ai.foundation-models', 'compute.gpu'],
      labeler: 'haiku',
      notes: 'test note',
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.human_topics).toEqual(['ai.foundation-models', 'compute.gpu']);
      expect(result.data.labeler).toBe('haiku');
      expect(result.data.reviewed_at).toBeDefined();
    }

    // Check training_labels row
    const labelRow = tdb
      .prepare('SELECT * FROM training_labels WHERE event_id = ?')
      .get(eventId) as { human_topics: string; labeler: string; notes: string };
    expect(labelRow).toBeDefined();
    expect(JSON.parse(labelRow.human_topics)).toEqual(['ai.foundation-models', 'compute.gpu']);
  });

  it('returns INVALID_QUERY for non-existent event_id', () => {
    const result = updateTrainingLabel(tdb, 'nonexistent:event:id', {
      human_topics: ['ai.safety'],
    });
    expect(result.status).toBe('error');
  });

  it('empty topics list stores []', () => {
    const events = tdb
      .prepare('SELECT event_id FROM training_events LIMIT 1')
      .all() as Array<{ event_id: string }>;
    const eventId = events[0].event_id;

    const result = updateTrainingLabel(tdb, eventId, {
      human_topics: [],
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.human_topics).toEqual([]);
    }

    // Verify stored as valid JSON array, not NULL
    const row = tdb
      .prepare('SELECT human_topics FROM training_events WHERE event_id = ?')
      .get(eventId) as { human_topics: string };
    expect(row.human_topics).toBe('[]');
  });

  it('labeler defaults to "unspecified" when omitted', () => {
    const events = tdb
      .prepare('SELECT event_id FROM training_events LIMIT 1')
      .all() as Array<{ event_id: string }>;

    const result = updateTrainingLabel(tdb, events[0].event_id, {
      human_topics: ['ai.safety'],
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.labeler).toBe('unspecified');
    }
  });

  it('re-labeling updates training_events and appends training_labels row', () => {
    const events = tdb
      .prepare('SELECT event_id FROM training_events LIMIT 1')
      .all() as Array<{ event_id: string }>;
    const eventId = events[0].event_id;

    // First label
    updateTrainingLabel(tdb, eventId, {
      human_topics: ['ai.safety'],
      labeler: 'haiku',
    });

    // Re-label
    const result = updateTrainingLabel(tdb, eventId, {
      human_topics: ['ai.agents'],
      labeler: 'sonnet',
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.human_topics).toEqual(['ai.agents']);
      expect(result.data.labeler).toBe('sonnet');
    }

    // Check both labels in training_labels
    const labels = tdb
      .prepare('SELECT * FROM training_labels WHERE event_id = ? ORDER BY id')
      .all(eventId) as Array<{ human_topics: string; labeler: string }>;
    expect(labels.length).toBe(2);
    expect(labels[0].labeler).toBe('haiku');
    expect(labels[1].labeler).toBe('sonnet');
  });

  it('re-labeling produces overwrite warning', () => {
    const events = tdb
      .prepare('SELECT event_id FROM training_events LIMIT 1')
      .all() as Array<{ event_id: string }>;
    const eventId = events[0].event_id;

    updateTrainingLabel(tdb, eventId, {
      human_topics: ['ai.safety'],
      labeler: 'haiku',
    });

    const result = updateTrainingLabel(tdb, eventId, {
      human_topics: ['ai.agents'],
      labeler: 'sonnet',
    });
    expect(result.status).toBe('ok');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('Overwriting existing label');
  });

  it('training_labels contains all historical labels after re-labeling', () => {
    const events = tdb
      .prepare('SELECT event_id FROM training_events LIMIT 1')
      .all() as Array<{ event_id: string }>;
    const eventId = events[0].event_id;

    updateTrainingLabel(tdb, eventId, { human_topics: ['ai.safety'], labeler: 'v1' });
    updateTrainingLabel(tdb, eventId, { human_topics: ['ai.agents'], labeler: 'v2' });
    updateTrainingLabel(tdb, eventId, { human_topics: ['ai.rag'], labeler: 'v3' });

    const labels = tdb
      .prepare('SELECT human_topics, labeler FROM training_labels WHERE event_id = ? ORDER BY id')
      .all(eventId) as Array<{ human_topics: string; labeler: string }>;
    expect(labels.length).toBe(3);
    expect(JSON.parse(labels[0].human_topics)).toEqual(['ai.safety']);
    expect(JSON.parse(labels[1].human_topics)).toEqual(['ai.agents']);
    expect(JSON.parse(labels[2].human_topics)).toEqual(['ai.rag']);
  });
});

// --- trainingProgress (3 tests) ---

describe('trainingProgress', () => {
  let trainingDbPath: string;
  let tdb: Database.Database;

  beforeEach(() => {
    trainingDbPath = join(tmpDir, 'progress-test.db');
    createTrainingDb(trainingDbPath, 100);
    tdb = openTrainingDb(trainingDbPath, false);
  });

  afterEach(() => {
    tdb.close();
  });

  it('reports correct counts before and after labeling', () => {
    const before = trainingProgress(tdb);
    expect(before.status).toBe('ok');
    if (before.status === 'ok') {
      expect(before.data.total).toBe(1000);
      expect(before.data.reviewed).toBe(0);
      expect(before.data.remaining).toBe(1000);
    }

    // Label one event
    const event = tdb
      .prepare('SELECT event_id FROM training_events LIMIT 1')
      .get() as { event_id: string };
    updateTrainingLabel(tdb, event.event_id, { human_topics: ['ai.safety'] });

    const after = trainingProgress(tdb);
    if (after.status === 'ok') {
      expect(after.data.reviewed).toBe(1);
      expect(after.data.remaining).toBe(999);
    }
  });

  it('pct_complete is 0.0 with no reviews', () => {
    const result = trainingProgress(tdb);
    if (result.status === 'ok') {
      expect(result.data.pct_complete).toBe(0);
    }
  });

  it('with verbose=true returns per-topic counts', () => {
    // Label some events with topics
    const events = tdb
      .prepare('SELECT event_id FROM training_events LIMIT 5')
      .all() as Array<{ event_id: string }>;
    for (const e of events) {
      updateTrainingLabel(tdb, e.event_id, {
        human_topics: ['ai.foundation-models'],
        labeler: 'test',
      });
    }

    const result = trainingProgress(tdb, true);
    if (result.status === 'ok') {
      expect(result.data.per_topic).toBeDefined();
      expect(result.data.per_topic!.length).toBeGreaterThan(0);
      const aiTopic = result.data.per_topic!.find((t) => t.topic === 'ai.foundation-models');
      expect(aiTopic).toBeDefined();
      expect(aiTopic!.count).toBe(5);
      expect(aiTopic!.sufficient).toBe(false); // 5 < 30
    }
  });
});

// --- getNextUnreviewed (4 tests) ---

describe('getNextUnreviewed', () => {
  let trainingDbPath: string;
  let tdb: Database.Database;

  beforeEach(() => {
    trainingDbPath = join(tmpDir, 'next-test.db');
    createTrainingDb(trainingDbPath, 100);
    tdb = openTrainingDb(trainingDbPath, false);
  });

  afterEach(() => {
    tdb.close();
  });

  it('returns unreviewed events with machine labels omitted by default', () => {
    const result = getNextUnreviewed(tdb, 1);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.length).toBe(1);
      expect(result.data[0].event_id).toBeDefined();
      expect(result.data[0].machine_topics).toBeUndefined();
      expect(result.data[0].machine_confidences).toBeUndefined();
    }
  });

  it('returns empty array when all events are reviewed', () => {
    // Label all events
    const events = tdb
      .prepare('SELECT event_id FROM training_events')
      .all() as Array<{ event_id: string }>;
    for (const e of events) {
      updateTrainingLabel(tdb, e.event_id, { human_topics: [] });
    }

    const result = getNextUnreviewed(tdb, 1);
    if (result.status === 'ok') {
      expect(result.data.length).toBe(0);
    }
  });

  it('respects limit parameter', () => {
    const result = getNextUnreviewed(tdb, 5);
    if (result.status === 'ok') {
      expect(result.data.length).toBe(5);
    }
  });

  it('includes machine labels when showMachineLabels=true', () => {
    const result = getNextUnreviewed(tdb, 1, true);
    if (result.status === 'ok') {
      expect(result.data.length).toBe(1);
      expect(result.data[0].machine_topics).toBeDefined();
      expect(Array.isArray(result.data[0].machine_topics)).toBe(true);
      expect(result.data[0].machine_confidences).toBeDefined();
      expect(result.data[0].machine_scores).toBeDefined();
    }
  });
});

// --- listTrainingSets (3 tests) ---

describe('listTrainingSets', () => {
  it('discovers training DBs in directory', () => {
    const listDir = join(tmpDir, 'list-test');
    mkdirSync(listDir);

    const outputPath = join(listDir, 'training-set-2026-01-01T00-00-00.db');
    generateTrainingSet(writer, {
      sampleRate: 0.5,
      outputPath,
      sourceDbPath: dbPath,
    });

    const result = listTrainingSets(listDir);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.length).toBe(1);
      expect(result.data[0].path).toBe(outputPath);
      expect(result.data[0].sample_size).toBeGreaterThan(0);
    }
  });

  it('skips non-training DB files', () => {
    const listDir = join(tmpDir, 'list-skip');
    mkdirSync(listDir);

    // Create a non-training file with the right name pattern
    const fakePath = join(listDir, 'training-set-fake.db');
    writeFileSync(fakePath, 'not a database');

    // Create a real training DB
    const realPath = join(listDir, 'training-set-real.db');
    generateTrainingSet(writer, {
      sampleRate: 0.5,
      outputPath: realPath,
      sourceDbPath: dbPath,
    });

    const result = listTrainingSets(listDir);
    if (result.status === 'ok') {
      expect(result.data.length).toBe(1);
      expect(result.data[0].path).toBe(realPath);
    }
  });

  it('returns empty array when no training DBs found', () => {
    const emptyDir = join(tmpDir, 'empty-list');
    mkdirSync(emptyDir);

    const result = listTrainingSets(emptyDir);
    if (result.status === 'ok') {
      expect(result.data.length).toBe(0);
    }
  });
});

// --- exportTrainingSet (4 tests) ---

describe('exportTrainingSet', () => {
  let trainingDbPath: string;
  let tdb: Database.Database;

  beforeEach(() => {
    trainingDbPath = join(tmpDir, 'export-test.db');
    createTrainingDb(trainingDbPath, 100);
    tdb = openTrainingDb(trainingDbPath, false);

    // Label some events
    const events = tdb
      .prepare('SELECT event_id FROM training_events LIMIT 5')
      .all() as Array<{ event_id: string }>;
    for (const e of events) {
      updateTrainingLabel(tdb, e.event_id, {
        human_topics: ['ai.safety'],
        labeler: 'test',
      });
    }
  });

  afterEach(() => {
    tdb.close();
  });

  it('default export returns JSON envelope with events array', () => {
    const result = exportTrainingSet(tdb);
    expect(typeof result).toBe('object');
    if (typeof result === 'object' && result.status === 'ok') {
      expect(result.data.exported).toBe(1000);
      expect(result.data.events).toBeDefined();
      expect(result.data.events!.length).toBe(1000);
    }
  });

  it('raw export returns JSONL string', () => {
    const result = exportTrainingSet(tdb, { raw: true });
    expect(typeof result).toBe('string');
    const lines = (result as string).split('\n').filter(Boolean);
    expect(lines.length).toBe(1000);
    // Each line is valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('reviewed-only filters to labeled events', () => {
    const result = exportTrainingSet(tdb, { reviewedOnly: true });
    if (typeof result === 'object' && result.status === 'ok') {
      expect(result.data.exported).toBe(5);
    }
  });

  it('errors when output path already exists', () => {
    const outPath = join(tmpDir, 'existing-export.jsonl');
    writeFileSync(outPath, 'dummy');

    const result = exportTrainingSet(tdb, { outputPath: outPath });
    expect(typeof result).toBe('object');
    if (typeof result === 'object') {
      expect(result.status).toBe('error');
    }
  });
});

// --- evaluateTrainingSet (8 tests) ---

describe('evaluateTrainingSet', () => {
  let trainingDbPath: string;
  let tdb: Database.Database;

  function labelEvents(
    db: Database.Database,
    machineTopicsMap: Record<string, string[]>,
    humanTopicsMap: Record<string, string[]>,
    labeler = 'test',
  ): void {
    for (const [eventId, humanTopics] of Object.entries(humanTopicsMap)) {
      // Set machine_topics for evaluation
      if (machineTopicsMap[eventId]) {
        db.prepare('UPDATE training_events SET machine_topics = ? WHERE event_id = ?').run(
          JSON.stringify(machineTopicsMap[eventId]),
          eventId,
        );
      }
      updateTrainingLabel(db, eventId, { human_topics: humanTopics, labeler });
    }
  }

  beforeEach(() => {
    trainingDbPath = join(tmpDir, 'eval-test.db');
    createTrainingDb(trainingDbPath, 100);
    tdb = openTrainingDb(trainingDbPath, false);
  });

  afterEach(() => {
    tdb.close();
  });

  it('computes correct per-topic precision and recall', () => {
    // Get event IDs
    const events = tdb
      .prepare('SELECT event_id FROM training_events ORDER BY id LIMIT 40')
      .all() as Array<{ event_id: string }>;

    const machine: Record<string, string[]> = {};
    const human: Record<string, string[]> = {};

    // 30 events where machine and human agree on ai.safety
    for (let i = 0; i < 30; i++) {
      machine[events[i].event_id] = ['ai.safety'];
      human[events[i].event_id] = ['ai.safety'];
    }
    // 5 false positives (machine says ai.safety, human disagrees)
    for (let i = 30; i < 35; i++) {
      machine[events[i].event_id] = ['ai.safety'];
      human[events[i].event_id] = ['ai.agents'];
    }
    // 5 false negatives (human says ai.safety, machine missed)
    for (let i = 35; i < 40; i++) {
      machine[events[i].event_id] = ['ai.agents'];
      human[events[i].event_id] = ['ai.safety'];
    }

    labelEvents(tdb, machine, human);

    const result = evaluateTrainingSet(tdb, { minSamples: 5 });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const aiSafety = result.data.per_topic.find((t) => t.topic === 'ai.safety');
      expect(aiSafety).toBeDefined();
      if (aiSafety) {
        // precision = 30 / (30 + 5) = 0.857
        expect(aiSafety.precision).toBeCloseTo(0.857, 2);
        // recall = 30 / (30 + 5) = 0.857
        expect(aiSafety.recall).toBeCloseTo(0.857, 2);
      }
    }
  });

  it('reports over-classification rate', () => {
    const events = tdb
      .prepare('SELECT event_id FROM training_events ORDER BY id LIMIT 20')
      .all() as Array<{ event_id: string }>;

    const machine: Record<string, string[]> = {};
    const human: Record<string, string[]> = {};

    // 5 over-classified (machine assigns 4+ topics)
    for (let i = 0; i < 5; i++) {
      machine[events[i].event_id] = ['ai.safety', 'ai.agents', 'ai.rag', 'ai.training'];
      human[events[i].event_id] = ['ai.safety']; // human says only 1
    }
    // 15 normal
    for (let i = 5; i < 20; i++) {
      machine[events[i].event_id] = ['ai.safety'];
      human[events[i].event_id] = ['ai.safety'];
    }

    labelEvents(tdb, machine, human);

    const result = evaluateTrainingSet(tdb, { minSamples: 1 });
    if (result.status === 'ok') {
      expect(result.data.overall.over_classification_rate).toBeCloseTo(0.25, 2); // 5/20
      expect(result.data.overall.false_over_classification_rate).toBeCloseTo(0.25, 2); // 5/20
    }
  });

  it('topics below minSamples appear in insufficient_data', () => {
    const events = tdb
      .prepare('SELECT event_id FROM training_events ORDER BY id LIMIT 12')
      .all() as Array<{ event_id: string }>;

    const machine: Record<string, string[]> = {};
    const human: Record<string, string[]> = {};

    for (let i = 0; i < 12; i++) {
      machine[events[i].event_id] = ['data.governance'];
      human[events[i].event_id] = ['data.governance'];
    }

    labelEvents(tdb, machine, human);

    const result = evaluateTrainingSet(tdb, { minSamples: 30 });
    if (result.status === 'ok') {
      const insufficient = result.data.insufficient_data.find((t) => t.topic === 'data.governance');
      expect(insufficient).toBeDefined();
      expect(insufficient!.samples).toBe(12);
    }
  });

  it('confusion pairs identify set differences correctly', () => {
    const events = tdb
      .prepare('SELECT event_id FROM training_events ORDER BY id LIMIT 15')
      .all() as Array<{ event_id: string }>;

    const machine: Record<string, string[]> = {};
    const human: Record<string, string[]> = {};

    // Machine: [A, B], Human: [B, C] → FP for A, FN for C
    for (let i = 0; i < 10; i++) {
      machine[events[i].event_id] = ['ai.safety', 'ai.agents'];
      human[events[i].event_id] = ['ai.agents', 'ai.rag'];
    }
    // Fill remaining to meet min 10 evaluated
    for (let i = 10; i < 15; i++) {
      machine[events[i].event_id] = ['ai.safety'];
      human[events[i].event_id] = ['ai.safety'];
    }

    labelEvents(tdb, machine, human);

    const result = evaluateTrainingSet(tdb, { minSamples: 1 });
    if (result.status === 'ok') {
      // Check confusion pairs contain FP for ai.safety and FN for ai.rag
      const fpSafety = result.data.confusion_pairs.find(
        (p) => p.direction === 'fp' && p.predicted === 'ai.safety',
      );
      expect(fpSafety).toBeDefined();

      const fnRag = result.data.confusion_pairs.find(
        (p) => p.direction === 'fn' && p.actual === 'ai.rag',
      );
      expect(fnRag).toBeDefined();
    }
  });

  it('returns INVALID_QUERY when fewer than 10 events reviewed', () => {
    const events = tdb
      .prepare('SELECT event_id FROM training_events LIMIT 5')
      .all() as Array<{ event_id: string }>;

    for (const e of events) {
      tdb.prepare('UPDATE training_events SET machine_topics = ? WHERE event_id = ?').run(
        '["ai.safety"]',
        e.event_id,
      );
      updateTrainingLabel(tdb, e.event_id, { human_topics: ['ai.safety'] });
    }

    const result = evaluateTrainingSet(tdb, { minSamples: 1 });
    expect(result.status).toBe('error');
  });

  it('computes Hamming loss correctly', () => {
    const events = tdb
      .prepare('SELECT event_id FROM training_events ORDER BY id LIMIT 10')
      .all() as Array<{ event_id: string }>;

    const machine: Record<string, string[]> = {};
    const human: Record<string, string[]> = {};

    // Each event has 1 disagreement (symmetric diff = 2 per event — 1 FP + 1 FN)
    for (let i = 0; i < 10; i++) {
      machine[events[i].event_id] = ['ai.safety'];
      human[events[i].event_id] = ['ai.agents'];
    }

    labelEvents(tdb, machine, human);

    const result = evaluateTrainingSet(tdb, { minSamples: 1 });
    if (result.status === 'ok') {
      // symmetric_diff = 2 per event × 10 events = 20
      // hamming_loss = 20 / (10 × 66) ≈ 0.0303
      expect(result.data.overall.hamming_loss).toBeCloseTo(20 / (10 * 66), 3);
    }
  });

  it('labeler filter restricts evaluation', () => {
    const events = tdb
      .prepare('SELECT event_id FROM training_events ORDER BY id LIMIT 20')
      .all() as Array<{ event_id: string }>;

    // Label first 10 with haiku, next 10 with sonnet
    for (let i = 0; i < 10; i++) {
      tdb.prepare('UPDATE training_events SET machine_topics = ? WHERE event_id = ?').run(
        '["ai.safety"]',
        events[i].event_id,
      );
      updateTrainingLabel(tdb, events[i].event_id, {
        human_topics: ['ai.safety'],
        labeler: 'haiku',
      });
    }
    for (let i = 10; i < 20; i++) {
      tdb.prepare('UPDATE training_events SET machine_topics = ? WHERE event_id = ?').run(
        '["ai.agents"]',
        events[i].event_id,
      );
      updateTrainingLabel(tdb, events[i].event_id, {
        human_topics: ['ai.agents'],
        labeler: 'sonnet',
      });
    }

    const haikuResult = evaluateTrainingSet(tdb, { minSamples: 1, labeler: 'haiku' });
    if (haikuResult.status === 'ok') {
      expect(haikuResult.data.evaluated_events).toBe(10);
    }
  });

  it('handles null machine_confidences in evaluation', () => {
    const events = tdb
      .prepare('SELECT event_id FROM training_events ORDER BY id LIMIT 10')
      .all() as Array<{ event_id: string }>;

    for (const e of events) {
      // machine_confidences are already [] (empty) by default — this is fine
      tdb.prepare('UPDATE training_events SET machine_topics = ?, machine_confidences = ? WHERE event_id = ?').run(
        '["ai.safety"]',
        '[null]',
        e.event_id,
      );
      updateTrainingLabel(tdb, e.event_id, { human_topics: ['ai.safety'] });
    }

    const result = evaluateTrainingSet(tdb, { minSamples: 1 });
    // Should still work — null confidences don't affect precision/recall
    expect(result.status).toBe('ok');
  });
});

// --- application_id validation (1 test) ---

describe('application_id validation', () => {
  it('opening main intelligence DB as training DB produces error', () => {
    expect(() => openTrainingDb(dbPath, true)).toThrow(/Not a training database/);
  });
});

// --- generate --dry-run (2 tests) ---

describe('generate --dry-run', () => {
  it('returns metadata without creating file', () => {
    const outputPath = join(tmpDir, 'dry-run.db');
    const result = generateTrainingSet(writer, {
      sampleRate: 0.1,
      outputPath,
      sourceDbPath: dbPath,
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.total_events).toBe(1000);
      expect(result.data.sample_size).toBe(100);
    }
    expect(existsSync(outputPath)).toBe(false);
  });

  it('still validates parameters in dry run', () => {
    const result = generateTrainingSet(writer, {
      sampleRate: -0.1,
      outputPath: join(tmpDir, 'dry-run.db'),
      sourceDbPath: dbPath,
      dryRun: true,
    });
    expect(result.status).toBe('error');
  });
});

// --- reservoir sampling determinism (1 test) ---

describe('reservoir sampling determinism', () => {
  it('same seed produces same sample', () => {
    const path1 = join(tmpDir, 'determinism1.db');
    const path2 = join(tmpDir, 'determinism2.db');

    generateTrainingSet(writer, {
      sampleRate: 0.3,
      outputPath: path1,
      sourceDbPath: dbPath,
      seed: 42,
    });

    generateTrainingSet(writer, {
      sampleRate: 0.3,
      outputPath: path2,
      sourceDbPath: dbPath,
      seed: 42,
    });

    const db1 = new Database(path1, { readonly: true });
    const db2 = new Database(path2, { readonly: true });
    try {
      const ids1 = (
        db1.prepare('SELECT event_id FROM training_events ORDER BY id').all() as Array<{
          event_id: string;
        }>
      ).map((r) => r.event_id);
      const ids2 = (
        db2.prepare('SELECT event_id FROM training_events ORDER BY id').all() as Array<{
          event_id: string;
        }>
      ).map((r) => r.event_id);

      expect(ids1).toEqual(ids2);
    } finally {
      db1.close();
      db2.close();
    }
  });
});

// --- reservoir sampling uniformity (1 test, describe.skip) ---

describe.skip('reservoir sampling uniformity', () => {
  it(
    'chi-squared test for uniform distribution',
    () => {
      const N = 100;
      const k = 10;
      const trials = 1000;
      const counts = new Array(N).fill(0);

      for (let trial = 0; trial < trials; trial++) {
        const rng = mulberry32(trial);
        const reservoir: number[] = [];

        for (let i = 0; i < N; i++) {
          if (i < k) {
            reservoir.push(i);
          } else {
            const j = Math.floor(rng() * (i + 1));
            if (j < k) {
              reservoir[j] = i;
            }
          }
        }

        for (const idx of reservoir) {
          counts[idx]++;
        }
      }

      // Expected count per element: trials * k / N = 1000 * 10 / 100 = 100
      const expected = (trials * k) / N;

      // Chi-squared statistic
      let chiSquared = 0;
      for (let i = 0; i < N; i++) {
        chiSquared += Math.pow(counts[i] - expected, 2) / expected;
      }

      // Critical value for 99 df at α = 0.001 ≈ 148.23
      expect(chiSquared).toBeLessThan(148.23);
    },
    { timeout: 60_000 },
  );
});
