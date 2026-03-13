import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../src/queries/cursor.js';

describe('cursor encoding/decoding', () => {
  it('round-trips a valid cursor', () => {
    const token = {
      schema_version: 'v1' as const,
      command: 'events',
      keys: { fetched_at: '2026-03-13T10:00:00.000Z', event_id: 'rss:aws:123' },
    };

    const encoded = encodeCursor(token);
    expect(typeof encoded).toBe('string');

    const decoded = decodeCursor(encoded, 'events');
    expect(decoded.schema_version).toBe('v1');
    expect(decoded.command).toBe('events');
    expect(decoded.keys.fetched_at).toBe('2026-03-13T10:00:00.000Z');
    expect(decoded.keys.event_id).toBe('rss:aws:123');
  });

  it('rejects cursor with wrong command', () => {
    const token = {
      schema_version: 'v1' as const,
      command: 'events',
      keys: { fetched_at: '2026-03-13T10:00:00.000Z', event_id: 'test' },
    };
    const encoded = encodeCursor(token);
    expect(() => decodeCursor(encoded, 'search')).toThrow();
  });

  it('rejects malformed cursor', () => {
    expect(() => decodeCursor('not-valid-base64!', 'events')).toThrow();
  });

  it('rejects cursor with wrong schema_version', () => {
    const raw = Buffer.from(
      JSON.stringify({
        schema_version: 'v2',
        command: 'events',
        keys: {},
      }),
    ).toString('base64url');
    expect(() => decodeCursor(raw, 'events')).toThrow();
  });

  it('uses base64url encoding (no +/= characters)', () => {
    const token = {
      schema_version: 'v1' as const,
      command: 'events',
      keys: { fetched_at: '2026-03-13T10:00:00.000Z', event_id: 'rss:special+chars/test' },
    };
    const encoded = encodeCursor(token);
    expect(encoded).not.toMatch(/[+/=]/);
  });
});
