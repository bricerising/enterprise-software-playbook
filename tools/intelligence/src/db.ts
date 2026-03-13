import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PragmaVerification } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/** Application ID: 'INTE' in ASCII (0x494E5445) */
export const APPLICATION_ID = 0x494E5445;

/** Max retry attempts for SQLITE_BUSY */
const BUSY_MAX_RETRIES = 3;

/** Track pragma verification results across connections */
let lastPragmaVerifications: PragmaVerification[] = [];

export function getLastPragmaVerifications(): PragmaVerification[] {
  return lastPragmaVerifications;
}

/**
 * Verify a pragma by setting it and reading back.
 */
function verifyPragma(
  db: Database.Database,
  name: string,
  value: string | number,
): PragmaVerification {
  db.pragma(`${name} = ${value}`);
  const result = db.pragma(name, { simple: true });
  const actual = typeof value === 'number' ? Number(result) : String(result);
  return {
    name,
    expected: value,
    actual,
    ok: String(actual).toLowerCase() === String(value).toLowerCase(),
  };
}

/**
 * Read-only verification (no SET, just read back).
 */
function readPragma(
  db: Database.Database,
  name: string,
  expected: string | number,
): PragmaVerification {
  const result = db.pragma(name, { simple: true });
  const actual = typeof expected === 'number' ? Number(result) : String(result);
  return {
    name,
    expected,
    actual,
    ok: String(actual).toLowerCase() === String(expected).toLowerCase(),
  };
}

interface Migration {
  version: number;
  sql: string;
}

export function getMigrations(): Migration[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((f) => {
    const version = parseInt(f.split('-')[0], 10);
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf-8');
    return { version, sql };
  });
}

/**
 * Ensure the database has the correct application_id and schema.
 * Called on first open (writer side).
 */
export function ensureSchema(db: Database.Database): void {
  const currentAppId = db.pragma('application_id', { simple: true }) as number;
  if (currentAppId !== 0 && currentAppId !== APPLICATION_ID) {
    throw new Error(
      `Database has application_id 0x${currentAppId.toString(16).toUpperCase()}, ` +
        `expected 0x${APPLICATION_ID.toString(16).toUpperCase()} or 0 (fresh database). ` +
        `This does not appear to be an intel database.`,
    );
  }

  // Set initialization pragmas (must be before any tables for auto_vacuum)
  const journalMode = db.pragma('journal_mode', { simple: true });
  if (journalMode !== 'wal') {
    db.pragma('journal_mode = WAL');
  }

  const autoVacuum = db.pragma('auto_vacuum', { simple: true }) as number;
  if (autoVacuum !== 2) {
    db.pragma('auto_vacuum = INCREMENTAL');
    // auto_vacuum change requires VACUUM to take effect on existing DBs.
    // On empty DBs it takes effect immediately, but VACUUM is harmless.
    db.exec('VACUUM');
  }

  if (currentAppId === 0) {
    db.pragma(`application_id = ${APPLICATION_ID}`);
  }

  // Apply pending migrations
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  const migrations = getMigrations();

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      db.transaction(() => {
        db.exec(migration.sql);
        db.pragma(`user_version = ${migration.version}`);
      })();
    }
  }
}

/**
 * Open a writer connection (for the collector daemon).
 */
export function openWriter(
  dbPath: string,
  opts?: {
    synchronous?: string;
    walAutocheckpoint?: number;
    journalSizeLimit?: number;
  },
): Database.Database {
  const db = new Database(dbPath, { timeout: 5000 });
  const verifications: PragmaVerification[] = [];

  ensureSchema(db);

  verifications.push(
    verifyPragma(db, 'synchronous', opts?.synchronous === 'full' ? 2 : 1),
  );
  verifications.push(verifyPragma(db, 'foreign_keys', 1));
  verifications.push(verifyPragma(db, 'trusted_schema', 0));
  verifications.push(
    verifyPragma(db, 'wal_autocheckpoint', opts?.walAutocheckpoint ?? 1000),
  );
  verifications.push(
    verifyPragma(db, 'journal_size_limit', opts?.journalSizeLimit ?? 67108864),
  );

  lastPragmaVerifications = verifications;

  const failures = verifications.filter((v) => !v.ok);
  for (const f of failures) {
    console.error(
      `[intel] PRAGMA verification failed: ${f.name} expected ${f.expected}, got ${f.actual}`,
    );
  }

  return db;
}

/**
 * Open a reader connection (for CLI commands and MCP tools).
 */
export function openReader(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true, timeout: 5000 });

  // Verify application_id
  const appId = db.pragma('application_id', { simple: true }) as number;
  if (appId !== 0 && appId !== APPLICATION_ID) {
    db.close();
    throw new Error(
      `Database has application_id 0x${appId.toString(16).toUpperCase()}, ` +
        `expected 0x${APPLICATION_ID.toString(16).toUpperCase()}. ` +
        `This does not appear to be an intel database.`,
    );
  }

  const verifications: PragmaVerification[] = [];
  verifications.push(verifyPragma(db, 'query_only', 1));
  verifications.push(verifyPragma(db, 'trusted_schema', 0));

  lastPragmaVerifications = verifications;

  const failures = verifications.filter((v) => !v.ok);
  for (const f of failures) {
    console.error(
      `[intel] PRAGMA verification failed: ${f.name} expected ${f.expected}, got ${f.actual}`,
    );
  }

  return db;
}

/**
 * Open a reader, run a function, then close. Short-lived transaction pattern.
 */
export function withReader<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = openReader(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Retry a function on SQLITE_BUSY with exponential backoff + jitter.
 */
export function sqliteBusyRetry<T>(fn: () => T, maxRetries = BUSY_MAX_RETRIES): T {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      const isBusy =
        err instanceof Error &&
        (err.message.includes('SQLITE_BUSY') || err.message.includes('database is locked'));

      if (!isBusy || attempt === maxRetries) {
        throw err;
      }

      const base = 50 * Math.pow(2, attempt);
      const jitter = Math.random() * base;
      const delay = base + jitter;

      // Synchronous sleep (acceptable for better-sqlite3 sync API)
      const end = Date.now() + delay;
      while (Date.now() < end) {
        // busy wait
      }
    }
  }
  throw new Error('Unreachable');
}

/**
 * Check if the embedded SQLite version has the WAL-reset bug fix.
 */
export function checkSqliteVersion(version: string): {
  version: string;
  walResetFixed: boolean;
} {
  const parts = version.split('.').map(Number);
  const [major, minor, patch] = parts;

  const walResetFixed =
    major > 3 ||
    (major === 3 && minor > 52) ||
    (major === 3 && minor === 52 && patch >= 0) ||
    (major === 3 && minor === 51 && patch >= 3) ||
    (major === 3 && minor === 50 && patch >= 7) ||
    (major === 3 && minor === 44 && patch >= 6);

  return { version, walResetFixed };
}
