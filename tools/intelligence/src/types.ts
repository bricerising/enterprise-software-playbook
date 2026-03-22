/** Response envelope for all intel commands */
export interface IntelResponse<T> {
  tool: 'intel';
  schema_version: 'v1';
  status: 'ok' | 'error';
  data: T;
  warnings: string[];
  pagination?: PaginationMeta;
  next_cursor: string | null;
}

export interface PaginationMeta {
  returned_count: number;
  limit_applied: number;
  truncated: boolean;
}

export interface IntelError {
  code: IntelErrorCode;
  message: string;
  retryable: boolean;
  suggested_action: string;
}

export type IntelErrorCode =
  | 'SQLITE_BUSY'
  | 'INVALID_QUERY'
  | 'DB_NOT_FOUND'
  | 'COLLECTOR_NOT_RUNNING'
  | 'INVALID_CURSOR'
  | 'INTERNAL_ERROR';

export type SourceType = 'rss' | 'hackernews' | 'edgar' | 'earnings';

export interface StoredEvent {
  id: number;
  event_id: string;
  source: SourceType;
  feed: string | null;
  url: string | null;
  canonical_url: string | null;
  title: string | null;
  content: string | null;
  author: string | null;
  published_at: string | null;
  fetched_at: string;
  topics: string; // JSON array
  tags: string; // JSON array
  score: number;
  comments: number;
  source_meta: string | null; // JSON
  content_flags: string | null; // JSON array
  created_at: string;
}

export interface CursorToken {
  schema_version: 'v1';
  command: string;
  keys: Record<string, string | number>;
}

export interface Checkpoint {
  source: string;
  feed: string;
  cursor: string;
  updated_at: string;
}

export interface CollectorHealthRow {
  source: string;
  feed: string;
  last_polled_at: string;
  last_success_at: string | null;
  last_error: string | null;
  events_in_poll: number;
  http_etag: string | null;
  http_last_modified: string | null;
}

export interface PragmaVerification {
  name: string;
  expected: string | number;
  actual: string | number;
  ok: boolean;
}

export type ContentFlag =
  | 'extracted'
  | 'blocked_domain'
  | 'truncated'
  | 'fetch_failed'
  | 'injection_markers';
