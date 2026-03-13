import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWriter } from '../src/db.js';
import {
  checkpoint,
  prune,
  quickCheck,
  rebuildFts,
  rebuildTopicIndex,
  optimizeFts,
} from '../src/db-maintenance.js';
import type Database from 'better-sqlite3';

let tmpDir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'intel-test-'));
  dbPath = join(tmpDir, 'test.db');
  db = openWriter(dbPath);

  // Insert test data
  const insert = db.prepare(`
    INSERT INTO events (event_id, source, feed, url, title, content,
      fetched_at, topics, tags, score, comments)
    VALUES (?, 'rss', 'test', ?, ?, ?, ?, ?, '[]', 0, 0)
  `);
  const insertTopic = db.prepare(
    'INSERT OR IGNORE INTO event_topics (event_id, topic) VALUES (?, ?)',
  );

  for (let i = 0; i < 10; i++) {
    const eventId = `rss:test:${i}`;
    const daysAgo = i * 5;
    const fetchedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    insert.run(eventId, `https://example.com/${i}`, `Title ${i}`, `Content ${i}`, fetchedAt, '["test.topic"]');
    insertTopic.run(eventId, 'test.topic');
  }
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('checkpoint', () => {
  it('runs PASSIVE checkpoint', () => {
    const result = checkpoint(db, 'passive');
    expect(result).toHaveProperty('busy');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('checkpointed');
  });
});

describe('prune', () => {
  it('deletes events older than retention period', () => {
    const before = db.prepare('SELECT count(*) as c FROM events').get() as { c: number };
    expect(before.c).toBe(10);

    const result = prune(db, 15); // 15 day retention
    expect(result.deleted).toBeGreaterThan(0);

    const after = db.prepare('SELECT count(*) as c FROM events').get() as { c: number };
    expect(after.c).toBeLessThan(before.c);
  });
});

describe('quickCheck', () => {
  it('reports ok for healthy database', () => {
    const result = quickCheck(db);
    expect(result.ok).toBe(true);
    expect(result.errors.length).toBe(0);
  });
});

describe('rebuildFts', () => {
  it('rebuilds FTS index without error', () => {
    expect(() => rebuildFts(db)).not.toThrow();

    // Verify FTS still works
    const results = db.prepare(
      "SELECT count(*) as c FROM events_fts WHERE events_fts MATCH 'Title'",
    ).get() as { c: number };
    expect(results.c).toBeGreaterThan(0);
  });
});

describe('rebuildTopicIndex', () => {
  it('rebuilds event_topics from JSON', () => {
    const before = db.prepare('SELECT count(*) as c FROM event_topics').get() as { c: number };
    expect(before.c).toBe(10);

    const count = rebuildTopicIndex(db);
    expect(count).toBe(10);

    const after = db.prepare('SELECT count(*) as c FROM event_topics').get() as { c: number };
    expect(after.c).toBe(10);
  });
});

describe('optimizeFts', () => {
  it('runs without error', () => {
    expect(() => optimizeFts(db)).not.toThrow();
  });
});
