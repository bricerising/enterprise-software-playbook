const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i;

const MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a human-readable duration string into milliseconds.
 * Supports: 100ms, 30s, 15m, 6h, 7d, 1w
 */
export function parseDuration(input: string): number {
  const match = input.trim().match(DURATION_RE);
  if (!match) {
    throw new Error(`Invalid duration: "${input}". Expected format: <number><unit> (e.g., 15m, 6h, 7d)`);
  }
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  return Math.round(value * MULTIPLIERS[unit]);
}

/** Format a Date to ISO 8601 UTC string with milliseconds */
export function formatISO(date: Date = new Date()): string {
  return date.toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
}

/** Return an ISO 8601 UTC timestamp for (now - durationMs) */
export function sinceISO(durationMs: number): string {
  return formatISO(new Date(Date.now() - durationMs));
}

/** SQLite-compatible timestamp format for comparisons */
export function sqliteNow(): string {
  return formatISO(new Date());
}
