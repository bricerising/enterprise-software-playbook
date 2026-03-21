import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWriter } from '../src/db.js';
import { computeTrends } from '../src/queries/trends.js';
import type Database from 'better-sqlite3';

let tmpDir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'intel-test-'));
  dbPath = join(tmpDir, 'test.db');
  db = openWriter(dbPath);

  // Insert test events
  const insert = db.prepare(`
    INSERT INTO events (event_id, source, feed, url, canonical_url, title, content,
      fetched_at, topics, tags, score, comments)
    VALUES (?, 'rss', 'test', ?, ?, ?, '', ?, ?, '[]', ?, 0)
  `);

  const insertTopic = db.prepare(
    'INSERT OR IGNORE INTO event_topics (event_id, topic) VALUES (?, ?)',
  );

  const now = new Date();

  // Recent events (within 60m window)
  for (let i = 0; i < 10; i++) {
    const eventId = `rss:test:recent-${i}`;
    const fetchedAt = new Date(now.getTime() - i * 60000).toISOString();
    const url = `https://example.com/article-${i}`;
    insert.run(eventId, url, url, `AWS Bedrock Article ${i}`, fetchedAt, '["ai.foundation-models"]', i);
    insertTopic.run(eventId, 'ai.foundation-models');
  }

  // Older events (in previous window for acceleration calc)
  for (let i = 0; i < 3; i++) {
    const eventId = `rss:test:old-${i}`;
    const fetchedAt = new Date(now.getTime() - 90 * 60000 - i * 60000).toISOString();
    const url = `https://example.com/old-${i}`;
    insert.run(eventId, url, url, `Old Bedrock Article ${i}`, fetchedAt, '["ai.foundation-models"]', 0);
    insertTopic.run(eventId, 'ai.foundation-models');
  }

  // Cross-source dedup test: same canonical_url, different source
  const sharedUrl = 'https://example.com/shared-article';
  const recentTime = new Date(now.getTime() - 5 * 60000).toISOString();
  insert.run('hn:123', sharedUrl, sharedUrl, 'Shared Article HN', recentTime, '["ai.agents"]', 50);
  insertTopic.run('hn:123', 'ai.agents');
  insert.run('rss:test:shared', sharedUrl, sharedUrl, 'Shared Article RSS', recentTime, '["ai.agents"]', 0);
  insertTopic.run('rss:test:shared', 'ai.agents');
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('computeTrends', () => {
  it('returns trending topics with scores', () => {
    const result = computeTrends(db, { window: '60m', top: 10 });
    expect(result.status).toBe('ok');
    expect(result.data.length).toBeGreaterThan(0);

    const bedrock = result.data.find((t: any) => t.topic === 'ai.foundation-models');
    expect(bedrock).toBeDefined();
    expect(bedrock.volume).toBeGreaterThan(0);
    expect(bedrock.score).toBeGreaterThanOrEqual(0);
    expect(bedrock.score).toBeLessThanOrEqual(10);
  });

  it('performs cross-source dedup on canonical_url', () => {
    const result = computeTrends(db, { window: '60m', top: 10 });
    const llm = result.data.find((t: any) => t.topic === 'ai.agents');
    // Both events share canonical_url, so volume should be 1 (not 2)
    expect(llm).toBeDefined();
    expect(llm.volume).toBe(1);
  });

  it('computes acceleration from prev_volume', () => {
    const result = computeTrends(db, { window: '60m', top: 10 });
    const bedrock = result.data.find((t: any) => t.topic === 'ai.foundation-models');
    expect(bedrock).toBeDefined();
    expect(bedrock.prev_volume).toBeDefined();
    expect(bedrock.acceleration).toBeDefined();
  });

  it('normalizes scores to 0-10', () => {
    const result = computeTrends(db, { window: '60m', top: 10 });
    for (const trend of result.data) {
      expect(trend.score).toBeGreaterThanOrEqual(0);
      expect(trend.score).toBeLessThanOrEqual(10);
    }
  });

  it('includes top_titles', () => {
    const result = computeTrends(db, { window: '60m', top: 10 });
    const bedrock = result.data.find((t: any) => t.topic === 'ai.foundation-models');
    expect(bedrock.top_titles).toBeDefined();
    expect(bedrock.top_titles.length).toBeGreaterThan(0);
    expect(bedrock.top_titles.length).toBeLessThanOrEqual(3);
  });

  it('respects --top limit', () => {
    const result = computeTrends(db, { window: '60m', top: 1 });
    expect(result.data.length).toBe(1);
  });
});
