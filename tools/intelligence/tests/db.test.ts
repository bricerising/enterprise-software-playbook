import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openWriter,
  openReader,
  withReader,
  ensureSchema,
  APPLICATION_ID,
  checkSqliteVersion,
  getLastPragmaVerifications,
  getMigrations,
} from '../src/db.js';
import Database from 'better-sqlite3';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'intel-test-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('openWriter', () => {
  it('creates database with correct application_id', () => {
    const db = openWriter(dbPath);
    const appId = db.pragma('application_id', { simple: true });
    expect(appId).toBe(APPLICATION_ID);
    db.close();
  });

  it('sets WAL journal mode', () => {
    const db = openWriter(dbPath);
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
    db.close();
  });

  it('sets incremental auto_vacuum', () => {
    const db = openWriter(dbPath);
    const autoVacuum = db.pragma('auto_vacuum', { simple: true });
    expect(autoVacuum).toBe(2); // INCREMENTAL
    db.close();
  });

  it('applies migrations and sets user_version', () => {
    const db = openWriter(dbPath);
    const version = db.pragma('user_version', { simple: true });
    const latestVersion = Math.max(...getMigrations().map((m) => m.version));
    expect(version).toBe(latestVersion);

    // Verify tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('events');
    expect(names).toContain('events_fts');
    expect(names).toContain('event_topics');
    expect(names).toContain('checkpoints');
    expect(names).toContain('collector_health');
    db.close();
  });

  it('verifies pragmas and stores results', () => {
    const db = openWriter(dbPath);
    const verifications = getLastPragmaVerifications();
    expect(verifications.length).toBeGreaterThan(0);
    expect(verifications.every((v) => v.ok)).toBe(true);
    db.close();
  });

  it('sets trusted_schema = OFF', () => {
    const db = openWriter(dbPath);
    const trusted = db.pragma('trusted_schema', { simple: true });
    expect(trusted).toBe(0);
    db.close();
  });

  it('sets foreign_keys = ON', () => {
    const db = openWriter(dbPath);
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
    db.close();
  });
});

describe('openReader', () => {
  it('throws if database does not exist', () => {
    expect(() => openReader('/nonexistent/path.db')).toThrow('Database not found');
  });

  it('opens existing database in read-only mode', () => {
    const writer = openWriter(dbPath);
    writer.close();

    const reader = openReader(dbPath);
    const queryOnly = reader.pragma('query_only', { simple: true });
    expect(queryOnly).toBe(1);
    reader.close();
  });

  it('rejects database with wrong application_id', () => {
    const db = new Database(dbPath);
    db.pragma('application_id = 12345');
    db.close();

    expect(() => openReader(dbPath)).toThrow('does not appear to be an intel database');
  });

  it('sets trusted_schema = OFF', () => {
    const writer = openWriter(dbPath);
    writer.close();

    const reader = openReader(dbPath);
    const trusted = reader.pragma('trusted_schema', { simple: true });
    expect(trusted).toBe(0);
    reader.close();
  });
});

describe('withReader', () => {
  it('opens and closes reader around function', () => {
    const writer = openWriter(dbPath);
    writer.close();

    const result = withReader(dbPath, (db) => {
      return db.pragma('application_id', { simple: true });
    });
    expect(result).toBe(APPLICATION_ID);
  });

  it('closes reader even on error', () => {
    const writer = openWriter(dbPath);
    writer.close();

    expect(() =>
      withReader(dbPath, () => {
        throw new Error('test error');
      }),
    ).toThrow('test error');
  });
});

describe('ensureSchema', () => {
  it('rejects database with non-zero non-matching application_id', () => {
    const db = new Database(dbPath);
    db.pragma('application_id = 99999');
    expect(() => ensureSchema(db)).toThrow('does not appear to be an intel database');
    db.close();
  });

  it('accepts fresh database (application_id = 0)', () => {
    const db = new Database(dbPath);
    expect(() => ensureSchema(db)).not.toThrow();
    db.close();
  });

  it('is idempotent', () => {
    const db = new Database(dbPath, { timeout: 5000 });
    ensureSchema(db);
    ensureSchema(db); // Should not throw
    const version = db.pragma('user_version', { simple: true });
    const latestVersion = Math.max(...getMigrations().map((m) => m.version));
    expect(version).toBe(latestVersion);
    db.close();
  });
});

describe('checkSqliteVersion', () => {
  it('detects WAL-reset fix in >= 3.52.0', () => {
    expect(checkSqliteVersion('3.52.0').walResetFixed).toBe(true);
    expect(checkSqliteVersion('3.53.1').walResetFixed).toBe(true);
  });

  it('detects WAL-reset fix in backport versions', () => {
    expect(checkSqliteVersion('3.51.3').walResetFixed).toBe(true);
    expect(checkSqliteVersion('3.50.7').walResetFixed).toBe(true);
    expect(checkSqliteVersion('3.44.6').walResetFixed).toBe(true);
  });

  it('detects unfixed versions', () => {
    expect(checkSqliteVersion('3.51.2').walResetFixed).toBe(false);
    expect(checkSqliteVersion('3.50.6').walResetFixed).toBe(false);
    expect(checkSqliteVersion('3.44.5').walResetFixed).toBe(false);
    expect(checkSqliteVersion('3.45.0').walResetFixed).toBe(false);
  });
});
