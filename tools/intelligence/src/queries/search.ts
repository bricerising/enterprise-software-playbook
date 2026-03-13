import type Database from 'better-sqlite3';
import type { IntelResponse, SourceType } from '../types.js';
import { ok, error } from '../util/envelope.js';
import { sanitizeSnippet } from '../util/text.js';
import { encodeCursor, decodeCursor } from './cursor.js';

const COMMAND = 'search';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface SearchResultItem {
  event_id: string;
  title: string;
  url: string | null;
  source: SourceType;
  published_at: string | null;
  fetched_at: string;
  topics: string[];
  snippet: string;
  snippet_flags: string[];
  fts_rank: number;
}

export interface SearchEventsOpts {
  source?: SourceType;
  topic?: string;
  since?: string; // ISO 8601 UTC timestamp
  limit?: number;
  cursor?: string;
}

/**
 * Full-text search across events using FTS5 MATCH.
 *
 * Uses FTS5's snippet() function with '['/']' markers for match highlighting.
 * Results ordered by fts_rank ASC (lower is better), then event_id DESC.
 * Keyset pagination by (fts_rank, event_id).
 *
 * Snippet pattern from spec:
 *   snippet(events_fts, 0, '[', ']', '...', 32)
 */
export function searchEvents(
  db: Database.Database,
  query: string,
  opts: SearchEventsOpts = {},
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

  // Decode cursor if provided
  let cursorKeys: Record<string, string | number> | null = null;
  if (opts.cursor) {
    try {
      const token = decodeCursor(opts.cursor, COMMAND);
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

  // Build filter conditions
  const conditions: string[] = ['events_fts MATCH ?'];
  const params: (string | number)[] = [query];

  if (opts.source) {
    conditions.push('e.source = ?');
    params.push(opts.source);
  }

  if (opts.since) {
    conditions.push('e.fetched_at >= ?');
    params.push(opts.since);
  }

  // Topic filter via JOIN
  const useTopicJoin = !!opts.topic;
  if (opts.topic) {
    conditions.push('et.topic = ?');
    params.push(opts.topic);
  }

  // Keyset pagination: ORDER BY fts_rank ASC, event_id DESC
  // Cursor encodes { fts_rank, event_id } — resume with "greater than" for rank (ascending)
  if (cursorKeys) {
    conditions.push(
      '(events_fts.rank > ? OR (events_fts.rank = ? AND e.event_id < ?))',
    );
    params.push(
      cursorKeys.fts_rank as number,
      cursorKeys.fts_rank as number,
      cursorKeys.event_id as string,
    );
  }

  const whereClause = conditions.join(' AND ');
  const topicJoin = useTopicJoin
    ? 'JOIN event_topics et ON et.event_id = e.event_id'
    : '';

  // Fetch limit + 1 to detect truncation
  const sql = `
    SELECT e.event_id, e.title, e.url, e.source, e.published_at, e.fetched_at,
           e.topics,
           snippet(events_fts, 0, '[', ']', '...', 32) AS snippet,
           events_fts.rank AS fts_rank
    FROM events_fts
    JOIN events e ON e.id = events_fts.rowid
    ${topicJoin}
    WHERE ${whereClause}
    ORDER BY fts_rank ASC, e.event_id DESC
    LIMIT ?
  `;
  params.push(limit + 1);

  const rows = db.prepare(sql).all(...params) as Array<{
    event_id: string;
    title: string | null;
    url: string | null;
    source: SourceType;
    published_at: string | null;
    fetched_at: string;
    topics: string;
    snippet: string | null;
    fts_rank: number;
  }>;

  const truncated = rows.length > limit;
  const resultRows = truncated ? rows.slice(0, limit) : rows;

  const items: SearchResultItem[] = resultRows.map((row) => {
    // Sanitize the FTS snippet — preserving [ ] match markers
    const { text: sanitizedSnippet, flags: snippetFlags } = sanitizeSnippet(
      row.snippet,
      { maxLength: 500 },
    );

    let topics: string[];
    try {
      topics = JSON.parse(row.topics);
    } catch {
      topics = [];
    }

    return {
      event_id: row.event_id,
      title: sanitizeSnippet(row.title, { maxLength: 200 }).text,
      url: row.url,
      source: row.source,
      published_at: row.published_at,
      fetched_at: row.fetched_at,
      topics,
      snippet: sanitizedSnippet,
      snippet_flags: snippetFlags,
      fts_rank: row.fts_rank,
    };
  });

  // Build next_cursor from last item
  let nextCursor: string | null = null;
  if (truncated && resultRows.length > 0) {
    const last = resultRows[resultRows.length - 1];
    nextCursor = encodeCursor({
      schema_version: 'v1',
      command: COMMAND,
      keys: {
        fts_rank: last.fts_rank,
        event_id: last.event_id,
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
