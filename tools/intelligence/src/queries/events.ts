import type Database from 'better-sqlite3';
import type { IntelResponse, SourceType } from '../types.js';
import { ok, error } from '../util/envelope.js';
import { sanitizeSnippet } from '../util/text.js';
import { encodeCursor, decodeCursor } from './cursor.js';

const COMMAND = 'events';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SNIPPET_MAX_LENGTH = 500;

export interface EventListItem {
  event_id: string;
  title: string;
  url: string | null;
  source: SourceType;
  feed: string | null;
  published_at: string | null;
  fetched_at: string;
  topics: string[];
  snippet: string;
  snippet_flags: string[];
  score: number;
  comments: number;
}

export interface EventDetail {
  event_id: string;
  title: string | null;
  url: string | null;
  canonical_url: string | null;
  source: SourceType;
  feed: string | null;
  author: string | null;
  published_at: string | null;
  fetched_at: string;
  topics: string[];
  tags: string[];
  content: string | null;
  score: number;
  comments: number;
  source_meta: unknown | null;
  content_flags: string[];
  created_at: string;
}

export interface ListEventsOpts {
  topic?: string;
  source?: SourceType;
  since?: string; // ISO 8601 UTC timestamp
  limit?: number;
  cursor?: string;
}

/**
 * List events with snippets (sanitized), keyset pagination by (fetched_at, event_id).
 * Supports topic filter via event_topics JOIN, source filter, and since filter.
 */
export function listEvents(
  db: Database.Database,
  opts: ListEventsOpts = {},
): IntelResponse<EventListItem[]> {
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
      }) as unknown as IntelResponse<EventListItem[]>;
    }
  }

  // Build query dynamically based on filters
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // Topic filter via JOIN
  const useTopicJoin = !!opts.topic;

  if (opts.source) {
    conditions.push('e.source = ?');
    params.push(opts.source);
  }

  if (opts.since) {
    conditions.push('e.fetched_at >= ?');
    params.push(opts.since);
  }

  if (opts.topic) {
    conditions.push('et.topic = ?');
    params.push(opts.topic);
  }

  // Keyset pagination: ORDER BY fetched_at DESC, event_id DESC
  // Cursor encodes { fetched_at, event_id } — resume with "less than"
  if (cursorKeys) {
    conditions.push('(e.fetched_at < ? OR (e.fetched_at = ? AND e.event_id < ?))');
    params.push(
      cursorKeys.fetched_at as string,
      cursorKeys.fetched_at as string,
      cursorKeys.event_id as string,
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const joinClause = useTopicJoin
    ? 'JOIN event_topics et ON et.event_id = e.event_id'
    : '';

  // Fetch limit + 1 to detect truncation
  const sql = `
    SELECT e.event_id, e.title, e.url, e.source, e.feed,
           e.published_at, e.fetched_at, e.topics, e.content,
           e.score, e.comments
    FROM events e
    ${joinClause}
    ${whereClause}
    ORDER BY e.fetched_at DESC, e.event_id DESC
    LIMIT ?
  `;
  params.push(limit + 1);

  const rows = db.prepare(sql).all(...params) as Array<{
    event_id: string;
    title: string | null;
    url: string | null;
    source: SourceType;
    feed: string | null;
    published_at: string | null;
    fetched_at: string;
    topics: string;
    content: string | null;
    score: number;
    comments: number;
  }>;

  const truncated = rows.length > limit;
  const resultRows = truncated ? rows.slice(0, limit) : rows;

  const items: EventListItem[] = resultRows.map((row) => {
    const { text: snippet, flags: snippetFlags } = sanitizeSnippet(
      row.content ?? row.title,
      { maxLength: SNIPPET_MAX_LENGTH },
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
      feed: row.feed,
      published_at: row.published_at,
      fetched_at: row.fetched_at,
      topics,
      snippet,
      snippet_flags: snippetFlags,
      score: row.score,
      comments: row.comments,
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
        fetched_at: last.fetched_at,
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

/**
 * Get a single event with full content by event_id.
 * When raw=true, content is returned unsanitized.
 */
export function getEvent(
  db: Database.Database,
  eventId: string,
  opts?: { raw?: boolean },
): IntelResponse<EventDetail | null> {
  const sql = `
    SELECT e.event_id, e.title, e.url, e.canonical_url, e.source, e.feed,
           e.author, e.published_at, e.fetched_at, e.topics, e.tags,
           e.content, e.score, e.comments, e.source_meta,
           e.content_flags, e.created_at
    FROM events e
    WHERE e.event_id = ?
  `;

  const row = db.prepare(sql).get(eventId) as {
    event_id: string;
    title: string | null;
    url: string | null;
    canonical_url: string | null;
    source: SourceType;
    feed: string | null;
    author: string | null;
    published_at: string | null;
    fetched_at: string;
    topics: string;
    tags: string;
    content: string | null;
    score: number;
    comments: number;
    source_meta: string | null;
    content_flags: string | null;
    created_at: string;
  } | undefined;

  if (!row) {
    return ok(null, {
      warnings: [`Event not found: ${eventId}`],
    });
  }

  let topics: string[];
  try {
    topics = JSON.parse(row.topics);
  } catch {
    topics = [];
  }

  let tags: string[];
  try {
    tags = JSON.parse(row.tags);
  } catch {
    tags = [];
  }

  let sourceMeta: unknown | null = null;
  if (row.source_meta) {
    try {
      sourceMeta = JSON.parse(row.source_meta);
    } catch {
      sourceMeta = null;
    }
  }

  let contentFlags: string[];
  try {
    contentFlags = row.content_flags ? JSON.parse(row.content_flags) : [];
  } catch {
    contentFlags = [];
  }

  const detail: EventDetail = {
    event_id: row.event_id,
    title: row.title,
    url: row.url,
    canonical_url: row.canonical_url,
    source: row.source,
    feed: row.feed,
    author: row.author,
    published_at: row.published_at,
    fetched_at: row.fetched_at,
    topics,
    tags,
    content: row.content,
    score: row.score,
    comments: row.comments,
    source_meta: sourceMeta,
    content_flags: contentFlags,
    created_at: row.created_at,
  };

  return ok(detail);
}
