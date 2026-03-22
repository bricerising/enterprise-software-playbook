import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWriter, openReader } from '../src/db.js';
import { addEntry, listEntries, searchJournal } from '../src/queries/journal.js';
import type Database from 'better-sqlite3';

let tmpDir: string;
let dbPath: string;
let writer: Database.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'intel-journal-test-'));
  dbPath = join(tmpDir, 'test.db');
  writer = openWriter(dbPath);
});

afterEach(() => {
  writer.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('addEntry', () => {
  it('creates and returns entry', () => {
    const result = addEntry(writer, {
      context: 'Evaluating message queue options',
      decision: 'Use SQS over RabbitMQ',
    });
    expect(result.status).toBe('ok');
    expect(result.data.entry_id).toBeDefined();
    expect(result.data.context).toBe('Evaluating message queue options');
    expect(result.data.decision).toBe('Use SQS over RabbitMQ');
    expect(result.data.rationale).toBeNull();
    expect(result.data.signal_refs).toEqual([]);
    expect(result.data.tags).toEqual([]);
    expect(result.data.created_at).toBeDefined();
  });

  it('validates required context field', () => {
    const result = addEntry(writer, {
      context: '',
      decision: 'Some decision',
    });
    expect(result.status).toBe('error');
  });

  it('validates required decision field', () => {
    const result = addEntry(writer, {
      context: 'Some context',
      decision: '',
    });
    expect(result.status).toBe('error');
  });

  it('stores tags and signal_refs', () => {
    const result = addEntry(writer, {
      context: 'Choosing database',
      decision: 'PostgreSQL for OLTP',
      rationale: 'Better JSON support and ecosystem',
      tags: ['infrastructure', 'database'],
      signal_refs: [
        { type: 'event', id: 'rss:test:42' },
        { type: 'topic', id: 'cloud.databases' },
      ],
    });
    expect(result.status).toBe('ok');
    expect(result.data.tags).toEqual(['infrastructure', 'database']);
    expect(result.data.signal_refs).toEqual([
      { type: 'event', id: 'rss:test:42' },
      { type: 'topic', id: 'cloud.databases' },
    ]);
    expect(result.data.rationale).toBe('Better JSON support and ecosystem');
  });
});

describe('listEntries', () => {
  beforeEach(() => {
    // Insert entries with explicit timestamps for ordering tests
    const insert = writer.prepare(`
      INSERT INTO journal_entries (entry_id, context, decision, rationale, signal_refs, tags, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run('id-1', 'Context A', 'Decision A', null, '[]', '["infra"]', '2026-01-01T00:00:00.000Z');
    insert.run('id-2', 'Context B', 'Decision B', null, '[]', '["security"]', '2026-01-02T00:00:00.000Z');
    insert.run('id-3', 'Context C', 'Decision C', null, '[]', '["infra","security"]', '2026-01-03T00:00:00.000Z');
  });

  it('returns entries in reverse chronological order', () => {
    const reader = openReader(dbPath);
    try {
      const result = listEntries(reader);
      expect(result.status).toBe('ok');
      expect(result.data.length).toBe(3);
      expect(result.data[0].entry_id).toBe('id-3');
      expect(result.data[1].entry_id).toBe('id-2');
      expect(result.data[2].entry_id).toBe('id-1');
    } finally {
      reader.close();
    }
  });

  it('filters by --since', () => {
    const reader = openReader(dbPath);
    try {
      const result = listEntries(reader, { since: '2026-01-02T00:00:00.000Z' });
      expect(result.status).toBe('ok');
      expect(result.data.length).toBe(2);
      expect(result.data[0].entry_id).toBe('id-3');
      expect(result.data[1].entry_id).toBe('id-2');
    } finally {
      reader.close();
    }
  });

  it('filters by --tag', () => {
    const reader = openReader(dbPath);
    try {
      const result = listEntries(reader, { tag: 'security' });
      expect(result.status).toBe('ok');
      expect(result.data.length).toBe(2);
      expect(result.data[0].entry_id).toBe('id-3');
      expect(result.data[1].entry_id).toBe('id-2');
    } finally {
      reader.close();
    }
  });

  it('supports pagination', () => {
    const reader = openReader(dbPath);
    try {
      const page1 = listEntries(reader, { limit: 2 });
      expect(page1.status).toBe('ok');
      expect(page1.data.length).toBe(2);
      expect(page1.pagination?.truncated).toBe(true);
      expect(page1.next_cursor).toBeDefined();

      const page2 = listEntries(reader, { limit: 2, cursor: page1.next_cursor! });
      expect(page2.status).toBe('ok');
      expect(page2.data.length).toBe(1);
      expect(page2.data[0].entry_id).toBe('id-1');
      expect(page2.pagination?.truncated).toBe(false);
    } finally {
      reader.close();
    }
  });
});

describe('searchJournal', () => {
  beforeEach(() => {
    // Use addEntry so FTS triggers fire
    addEntry(writer, {
      context: 'Evaluating Kubernetes vs ECS for container orchestration',
      decision: 'Adopt ECS Fargate',
      rationale: 'Lower operational overhead for our team size',
    });
    addEntry(writer, {
      context: 'Choosing API gateway',
      decision: 'Use Kong over AWS API Gateway',
      rationale: 'Better plugin ecosystem and self-hosted option',
    });
  });

  it('finds entries by keyword', () => {
    const reader = openReader(dbPath);
    try {
      const result = searchJournal(reader, 'Kubernetes', {});
      expect(result.status).toBe('ok');
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data[0].context).toContain('Kubernetes');
    } finally {
      reader.close();
    }
  });

  it('returns empty for no matches', () => {
    const reader = openReader(dbPath);
    try {
      const result = searchJournal(reader, 'nonexistentterm99999', {});
      expect(result.status).toBe('ok');
      expect(result.data.length).toBe(0);
    } finally {
      reader.close();
    }
  });

  it('returns fts_rank and snippet', () => {
    const reader = openReader(dbPath);
    try {
      const result = searchJournal(reader, 'Kubernetes', {});
      expect(result.data[0].fts_rank).toBeDefined();
      expect(typeof result.data[0].fts_rank).toBe('number');
      expect(result.data[0].snippet).toBeDefined();
    } finally {
      reader.close();
    }
  });

  it('rejects empty query', () => {
    const reader = openReader(dbPath);
    try {
      const result = searchJournal(reader, '', {});
      expect(result.status).toBe('error');
    } finally {
      reader.close();
    }
  });
});

describe('migration 008', () => {
  it('journal_entries table exists', () => {
    const reader = openReader(dbPath);
    try {
      const tables = reader
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='journal_entries'")
        .all();
      expect(tables.length).toBe(1);
    } finally {
      reader.close();
    }
  });

  it('journal_fts virtual table exists', () => {
    const reader = openReader(dbPath);
    try {
      const tables = reader
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='journal_fts'")
        .all();
      expect(tables.length).toBe(1);
    } finally {
      reader.close();
    }
  });
});
