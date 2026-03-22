import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { IntelResponse } from '../types.js';
import { ok, error } from '../util/envelope.js';
import { encodeCursor, decodeCursor } from './cursor.js';

const COMMAND_LIST = 'journal-list';
const COMMAND_SEARCH = 'journal-search';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface SignalRef {
  type: 'event' | 'topic';
  id: string;
}

export interface JournalEntry {
  entry_id: string;
  context: string;
  decision: string;
  rationale: string | null;
  signal_refs: SignalRef[];
  tags: string[];
  created_at: string;
}

export interface AddEntryOpts {
  context: string;
  decision: string;
  rationale?: string;
  signal_refs?: SignalRef[];
  tags?: string[];
}

export interface ListEntriesOpts {
  since?: string;
  tag?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchJournalOpts {
  since?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchResultItem {
  entry_id: string;
  context: string;
  decision: string;
  rationale: string | null;
  signal_refs: SignalRef[];
  tags: string[];
  created_at: string;
  snippet: string;
  fts_rank: number;
}

function parseJsonArray<T>(raw: string | null, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Add a journal entry. Requires a writer connection.
 */
export function addEntry(
  db: Database.Database,
  opts: AddEntryOpts,
): IntelResponse<JournalEntry> {
  if (!opts.context || opts.context.trim().length === 0) {
    return error({
      code: 'INVALID_QUERY',
      message: 'Journal entry context must not be empty.',
      retryable: false,
      suggested_action: 'Provide a non-empty --context value.',
    }) as unknown as IntelResponse<JournalEntry>;
  }

  if (!opts.decision || opts.decision.trim().length === 0) {
    return error({
      code: 'INVALID_QUERY',
      message: 'Journal entry decision must not be empty.',
      retryable: false,
      suggested_action: 'Provide a non-empty --decision value.',
    }) as unknown as IntelResponse<JournalEntry>;
  }

  const entryId = randomUUID();
  const signalRefs = JSON.stringify(opts.signal_refs ?? []);
  const tags = JSON.stringify(opts.tags ?? []);
  const rationale = opts.rationale?.trim() || null;

  const sql = `
    INSERT INTO journal_entries (entry_id, context, decision, rationale, signal_refs, tags)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  db.prepare(sql).run(entryId, opts.context.trim(), opts.decision.trim(), rationale, signalRefs, tags);

  // Read back the created entry to get server-generated created_at
  const row = db.prepare('SELECT * FROM journal_entries WHERE entry_id = ?').get(entryId) as {
    entry_id: string;
    context: string;
    decision: string;
    rationale: string | null;
    signal_refs: string;
    tags: string;
    created_at: string;
  };

  const entry: JournalEntry = {
    entry_id: row.entry_id,
    context: row.context,
    decision: row.decision,
    rationale: row.rationale,
    signal_refs: parseJsonArray<SignalRef>(row.signal_refs),
    tags: parseJsonArray<string>(row.tags),
    created_at: row.created_at,
  };

  return ok(entry);
}

/**
 * List journal entries with filters and keyset pagination.
 * Ordered by created_at DESC, entry_id DESC.
 */
export function listEntries(
  db: Database.Database,
  opts: ListEntriesOpts = {},
): IntelResponse<JournalEntry[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  let cursorKeys: Record<string, string | number> | null = null;
  if (opts.cursor) {
    try {
      const token = decodeCursor(opts.cursor, COMMAND_LIST);
      cursorKeys = token.keys;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid cursor';
      return error({
        code: 'INVALID_CURSOR',
        message: msg,
        retryable: false,
        suggested_action: 'Omit the cursor parameter to start from the beginning.',
      }) as unknown as IntelResponse<JournalEntry[]>;
    }
  }

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.since) {
    conditions.push('j.created_at >= ?');
    params.push(opts.since);
  }

  if (opts.tag) {
    conditions.push('EXISTS (SELECT 1 FROM json_each(j.tags) WHERE json_each.value = ?)');
    params.push(opts.tag);
  }

  if (cursorKeys) {
    conditions.push('(j.created_at < ? OR (j.created_at = ? AND j.entry_id < ?))');
    params.push(
      cursorKeys.created_at as string,
      cursorKeys.created_at as string,
      cursorKeys.entry_id as string,
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT j.entry_id, j.context, j.decision, j.rationale,
           j.signal_refs, j.tags, j.created_at
    FROM journal_entries j
    ${whereClause}
    ORDER BY j.created_at DESC, j.entry_id DESC
    LIMIT ?
  `;
  params.push(limit + 1);

  const rows = db.prepare(sql).all(...params) as Array<{
    entry_id: string;
    context: string;
    decision: string;
    rationale: string | null;
    signal_refs: string;
    tags: string;
    created_at: string;
  }>;

  const truncated = rows.length > limit;
  const resultRows = truncated ? rows.slice(0, limit) : rows;

  const items: JournalEntry[] = resultRows.map((row) => ({
    entry_id: row.entry_id,
    context: row.context,
    decision: row.decision,
    rationale: row.rationale,
    signal_refs: parseJsonArray<SignalRef>(row.signal_refs),
    tags: parseJsonArray<string>(row.tags),
    created_at: row.created_at,
  }));

  let nextCursor: string | null = null;
  if (truncated && resultRows.length > 0) {
    const last = resultRows[resultRows.length - 1];
    nextCursor = encodeCursor({
      schema_version: 'v1',
      command: COMMAND_LIST,
      keys: {
        created_at: last.created_at,
        entry_id: last.entry_id,
      },
    });
  }

  return ok(items, {
    pagination: {
      returned_count: items.length,
      limit_applied: limit,
      truncated,
    },
    next_cursor: nextCursor,
  });
}

/**
 * Full-text search across journal entries using FTS5 MATCH.
 * Results ordered by fts_rank ASC (lower is better), then entry_id DESC.
 */
export function searchJournal(
  db: Database.Database,
  query: string,
  opts: SearchJournalOpts = {},
): IntelResponse<SearchResultItem[]> {
  if (!query || query.trim().length === 0) {
    return error({
      code: 'INVALID_QUERY',
      message: 'Search query must not be empty.',
      retryable: false,
      suggested_action: 'Provide a non-empty search query.',
    }) as unknown as IntelResponse<SearchResultItem[]>;
  }

  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  let cursorKeys: Record<string, string | number> | null = null;
  if (opts.cursor) {
    try {
      const token = decodeCursor(opts.cursor, COMMAND_SEARCH);
      cursorKeys = token.keys;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid cursor';
      return error({
        code: 'INVALID_CURSOR',
        message: msg,
        retryable: false,
        suggested_action: 'Omit the cursor parameter to start from the beginning.',
      }) as unknown as IntelResponse<SearchResultItem[]>;
    }
  }

  const conditions: string[] = ['journal_fts MATCH ?'];
  const params: (string | number)[] = [query];

  if (opts.since) {
    conditions.push('j.created_at >= ?');
    params.push(opts.since);
  }

  if (cursorKeys) {
    conditions.push(
      '(journal_fts.rank > ? OR (journal_fts.rank = ? AND j.entry_id < ?))',
    );
    params.push(
      cursorKeys.fts_rank as number,
      cursorKeys.fts_rank as number,
      cursorKeys.entry_id as string,
    );
  }

  const whereClause = conditions.join(' AND ');

  const sql = `
    SELECT j.entry_id, j.context, j.decision, j.rationale,
           j.signal_refs, j.tags, j.created_at,
           snippet(journal_fts, 0, '[', ']', '...', 32) AS snippet,
           journal_fts.rank AS fts_rank
    FROM journal_fts
    JOIN journal_entries j ON j.rowid = journal_fts.rowid
    WHERE ${whereClause}
    ORDER BY fts_rank ASC, j.entry_id DESC
    LIMIT ?
  `;
  params.push(limit + 1);

  const rows = db.prepare(sql).all(...params) as Array<{
    entry_id: string;
    context: string;
    decision: string;
    rationale: string | null;
    signal_refs: string;
    tags: string;
    created_at: string;
    snippet: string | null;
    fts_rank: number;
  }>;

  const truncated = rows.length > limit;
  const resultRows = truncated ? rows.slice(0, limit) : rows;

  const items: SearchResultItem[] = resultRows.map((row) => ({
    entry_id: row.entry_id,
    context: row.context,
    decision: row.decision,
    rationale: row.rationale,
    signal_refs: parseJsonArray<SignalRef>(row.signal_refs),
    tags: parseJsonArray<string>(row.tags),
    created_at: row.created_at,
    snippet: row.snippet ?? '',
    fts_rank: row.fts_rank,
  }));

  let nextCursor: string | null = null;
  if (truncated && resultRows.length > 0) {
    const last = resultRows[resultRows.length - 1];
    nextCursor = encodeCursor({
      schema_version: 'v1',
      command: COMMAND_SEARCH,
      keys: {
        fts_rank: last.fts_rank,
        entry_id: last.entry_id,
      },
    });
  }

  return ok(items, {
    pagination: {
      returned_count: items.length,
      limit_applied: limit,
      truncated,
    },
    next_cursor: nextCursor,
  });
}
