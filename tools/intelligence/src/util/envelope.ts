import type { IntelResponse, IntelError, PaginationMeta } from '../types.js';

export function ok<T>(
  data: T,
  opts?: {
    warnings?: string[];
    pagination?: PaginationMeta;
    next_cursor?: string | null;
  },
): IntelResponse<T> {
  return {
    tool: 'intel',
    schema_version: 'v2',
    status: 'ok',
    data,
    warnings: opts?.warnings ?? [],
    pagination: opts?.pagination,
    next_cursor: opts?.next_cursor ?? null,
  };
}

export function error(err: IntelError): IntelResponse<null> {
  return {
    tool: 'intel',
    schema_version: 'v2',
    status: 'error',
    data: null,
    warnings: [],
    next_cursor: null,
    ...({ error: err } as Record<string, unknown>),
  };
}

export function busyError(context: 'read' | 'maintenance'): IntelResponse<null> {
  const suggested =
    context === 'read'
      ? 'Retry in a moment.'
      : 'Stop the collector daemon before running this maintenance command, or let the daemon handle it via the control channel.';
  return error({
    code: 'SQLITE_BUSY',
    message: 'Database is busy (WAL checkpoint/write contention).',
    retryable: true,
    suggested_action: suggested,
  });
}
