import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWriter, openReader } from '../src/db.js';
import { searchEvents } from '../src/queries/search.js';
import type Database from 'better-sqlite3';

let tmpDir: string;
let dbPath: string;
let writer: Database.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'intel-test-'));
  dbPath = join(tmpDir, 'test.db');
  writer = openWriter(dbPath);

  const insert = writer.prepare(`
    INSERT INTO events (event_id, source, feed, url, title, content,
      fetched_at, topics, tags, score, comments)
    VALUES (?, 'rss', 'test', ?, ?, ?, ?, '[]', '[]', 0, 0)
  `);

  const now = new Date();

  insert.run(
    'rss:test:1',
    'https://example.com/bedrock',
    'Building RAG Applications with Amazon Bedrock',
    'Amazon Bedrock provides a fully managed service for building retrieval augmented generation applications. Use foundation models from leading providers.',
    new Date(now.getTime() - 60000).toISOString(),
  );

  insert.run(
    'rss:test:2',
    'https://example.com/lambda',
    'AWS Lambda Cold Start Optimization',
    'Techniques for reducing cold start times in AWS Lambda functions, including provisioned concurrency and SnapStart.',
    new Date(now.getTime() - 120000).toISOString(),
  );

  insert.run(
    'rss:test:3',
    'https://example.com/security',
    'CVE-2026-12345 Critical Vulnerability Found',
    'A critical security vulnerability was discovered in a popular npm package affecting node.js applications worldwide.',
    new Date(now.getTime() - 180000).toISOString(),
  );

  writer.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('searchEvents', () => {
  it('searches by keyword', () => {
    const reader = openReader(dbPath);
    try {
      const result = searchEvents(reader, 'Bedrock', {});
      expect(result.status).toBe('ok');
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data[0].title).toContain('Bedrock');
    } finally {
      reader.close();
    }
  });

  it('returns snippets with match markers', () => {
    const reader = openReader(dbPath);
    try {
      const result = searchEvents(reader, 'Bedrock', {});
      const first = result.data[0];
      expect(first.snippet).toBeDefined();
      // Snippet should contain FTS5 markers
      expect(first.snippet).toMatch(/\[.*\]/);
    } finally {
      reader.close();
    }
  });

  it('returns fts_rank (lower is better)', () => {
    const reader = openReader(dbPath);
    try {
      const result = searchEvents(reader, 'Bedrock', {});
      expect(result.data[0].fts_rank).toBeDefined();
      expect(typeof result.data[0].fts_rank).toBe('number');
    } finally {
      reader.close();
    }
  });

  it('returns empty for no matches', () => {
    const reader = openReader(dbPath);
    try {
      const result = searchEvents(reader, 'nonexistentterm12345', {});
      expect(result.status).toBe('ok');
      expect(result.data.length).toBe(0);
    } finally {
      reader.close();
    }
  });

  it('respects limit', () => {
    const reader = openReader(dbPath);
    try {
      const result = searchEvents(reader, 'AWS OR Lambda OR Bedrock OR vulnerability', { limit: 1 });
      expect(result.data.length).toBeLessThanOrEqual(1);
    } finally {
      reader.close();
    }
  });

  it('searches CVE patterns', () => {
    const reader = openReader(dbPath);
    try {
      // FTS5 with tokenchars '-_' treats CVE-2026-12345 as a single token.
      // Search for the full token or use prefix query.
      const result = searchEvents(reader, '"CVE-2026-12345"', {});
      expect(result.data.length).toBeGreaterThan(0);
    } finally {
      reader.close();
    }
  });
});
