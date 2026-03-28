/**
 * Output contract tests for the intelligence tool response envelope.
 *
 * Validates that every query function returns the canonical IntelResponse
 * shape.  These tests break if envelope fields are renamed, removed, or
 * change type — catching silent contract drift before downstream consumers
 * (skills, agents) fail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWriter, openReader } from '../src/db.js';
import { searchEvents } from '../src/queries/search.js';
import { computeTrends } from '../src/queries/trends.js';
import { queryTopics } from '../src/queries/topics.js';
import { queryStats } from '../src/queries/stats.js';
import type Database from 'better-sqlite3';

let tmpDir: string;
let dbPath: string;
let writer: Database.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'intel-contract-'));
  dbPath = join(tmpDir, 'test.db');
  writer = openWriter(dbPath);

  const insert = writer.prepare(`
    INSERT INTO events (event_id, source, feed, url, title, content,
      fetched_at, topics, tags, score, comments)
    VALUES (?, 'rss', 'test', ?, ?, ?, ?, '["ai.foundation-models"]', '[]', 0, 0)
  `);

  const now = new Date();
  insert.run(
    'rss:test:1',
    'https://example.com/1',
    'Contract Test Event',
    'Content for contract testing.',
    now.toISOString(),
  );
  writer.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Envelope shape — every response must have these top-level fields
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = ['tool', 'schema_version', 'status', 'data', 'warnings', 'next_cursor'];

function assertEnvelope(response: Record<string, unknown>): void {
  for (const key of ENVELOPE_KEYS) {
    expect(response).toHaveProperty(key);
  }
  expect(response.tool).toBe('intel');
  expect(response.schema_version).toBe('v2');
  expect(['ok', 'error']).toContain(response.status);
  expect(Array.isArray(response.warnings)).toBe(true);
}

describe('IntelResponse envelope contract', () => {
  it('search returns valid envelope', () => {
    const reader = openReader(dbPath);
    try {
      const result = searchEvents(reader, 'contract', { limit: 10 });
      assertEnvelope(result as unknown as Record<string, unknown>);
      expect(result.status).toBe('ok');
    } finally {
      reader.close();
    }
  });

  it('trends returns valid envelope', () => {
    const reader = openReader(dbPath);
    try {
      const result = computeTrends(reader, {});
      assertEnvelope(result as unknown as Record<string, unknown>);
      expect(result.status).toBe('ok');
    } finally {
      reader.close();
    }
  });

  it('topics returns valid envelope', () => {
    const reader = openReader(dbPath);
    try {
      const result = queryTopics(reader, {});
      assertEnvelope(result as unknown as Record<string, unknown>);
      expect(result.status).toBe('ok');
    } finally {
      reader.close();
    }
  });

  it('stats returns valid envelope', () => {
    const reader = openReader(dbPath);
    try {
      const result = queryStats(reader);
      assertEnvelope(result as unknown as Record<string, unknown>);
      expect(result.status).toBe('ok');
    } finally {
      reader.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Pagination contract — when present, must have required fields
// ---------------------------------------------------------------------------

describe('Pagination contract', () => {
  it('search pagination has required fields when present', () => {
    const reader = openReader(dbPath);
    try {
      const result = searchEvents(reader, 'contract', { limit: 10 });
      if (result.pagination) {
        expect(result.pagination).toHaveProperty('returned_count');
        expect(result.pagination).toHaveProperty('limit_applied');
        expect(result.pagination).toHaveProperty('truncated');
        expect(typeof result.pagination.returned_count).toBe('number');
        expect(typeof result.pagination.limit_applied).toBe('number');
        expect(typeof result.pagination.truncated).toBe('boolean');
      }
    } finally {
      reader.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Search result item contract
// ---------------------------------------------------------------------------

describe('Search result item contract', () => {
  it('search result items have required fields', () => {
    const reader = openReader(dbPath);
    try {
      const result = searchEvents(reader, 'contract', { limit: 10 });
      if (result.status === 'ok' && Array.isArray(result.data) && result.data.length > 0) {
        const item = result.data[0];
        expect(item).toHaveProperty('event_id');
        expect(item).toHaveProperty('title');
        expect(item).toHaveProperty('source');
        expect(item).toHaveProperty('snippet');
        expect(typeof item.event_id).toBe('string');
      }
    } finally {
      reader.close();
    }
  });
});
