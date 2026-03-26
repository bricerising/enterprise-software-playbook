import type Database from 'better-sqlite3';
import type { IntelResponse } from '../types.js';
import { ok } from '../util/envelope.js';
import { sanitizeSnippet } from '../util/text.js';
import { parseDuration, sinceISO } from '../util/time.js';
import { checkTopicReviewWarning } from './review-warning.js';

const DEFAULT_WINDOW = '60m';
const DEFAULT_TOP = 10;
const MAX_TOP = 50;
const MAX_TITLES_PER_TOPIC = 3;

export interface TrendItem {
  topic: string;
  score: number;
  volume: number;
  prev_volume: number;
  acceleration: number;
  evidence_count: number;
  top_titles: string[];
}

export interface ComputeTrendsOpts {
  window?: string;   // duration string, e.g. '60m', '24h'
  top?: number;
  since?: string;    // explicit start time override (ISO 8601)
  dedup?: string;    // dedup mode: 'canonical' | 'none'
}

/**
 * Compute trending topics using windowed aggregation.
 *
 * Scoring algorithm (from spec):
 *   volume = COUNT(DISTINCT COALESCE(e.canonical_url, e.event_id))
 *   acceleration = prev_volume > 0
 *     ? (volume - prev_volume) / prev_volume
 *     : volume > 0 ? 1.0 : 0.0
 *   raw_score = volume + max(0, acceleration * volume)
 *   score = normalized to 0-10 across result set
 *
 * Uses two windows: current (window) and previous (prevWindow of same size
 * ending where current begins) for acceleration calculation.
 *
 * Cross-source dedup via canonical_url: COUNT(DISTINCT COALESCE(e.canonical_url, e.event_id))
 */
export function computeTrends(
  db: Database.Database,
  opts: ComputeTrendsOpts = {},
): IntelResponse<TrendItem[]> {
  const windowStr = opts.window ?? DEFAULT_WINDOW;
  const top = Math.min(Math.max(1, opts.top ?? DEFAULT_TOP), MAX_TOP);

  const windowMs = parseDuration(windowStr);
  const now = Date.now();

  // Current window: [windowStart, now]
  const windowStart = sinceISO(windowMs);
  // Previous window: [prevWindowStart, windowStart]
  const prevWindowStart = sinceISO(windowMs * 2);

  // If explicit since is provided (duration string like "24h"), use that as window override
  let effectiveWindowStart = windowStart;
  let effectivePrevStart = prevWindowStart;
  if (opts.since) {
    const sinceMs = parseDuration(opts.since);
    effectiveWindowStart = sinceISO(sinceMs);
    effectivePrevStart = sinceISO(sinceMs * 2);
  }

  // Query current window volumes — cross-source dedup unless dedup=none
  const useDedup = opts.dedup !== 'none';
  const volumeExpr = useDedup
    ? 'COUNT(DISTINCT COALESCE(e.canonical_url, e.event_id))'
    : 'COUNT(*)';

  const currentSql = `
    SELECT et.topic,
           ${volumeExpr} AS volume
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE e.fetched_at >= ?
    GROUP BY et.topic
    ORDER BY volume DESC
  `;
  const currentRows = db.prepare(currentSql).all(effectiveWindowStart) as Array<{
    topic: string;
    volume: number;
  }>;

  if (currentRows.length === 0) {
    return ok([]);
  }

  // Query previous window volumes for acceleration
  const prevSql = `
    SELECT et.topic,
           ${volumeExpr} AS volume
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE e.fetched_at >= ? AND e.fetched_at < ?
    GROUP BY et.topic
  `;
  const prevRows = db.prepare(prevSql).all(effectivePrevStart, effectiveWindowStart) as Array<{
    topic: string;
    volume: number;
  }>;

  const prevVolumeMap = new Map<string, number>();
  for (const row of prevRows) {
    prevVolumeMap.set(row.topic, row.volume);
  }

  // Compute raw scores
  const scored = currentRows.map((row) => {
    const volume = row.volume;
    const prevVolume = prevVolumeMap.get(row.topic) ?? 0;

    const acceleration =
      prevVolume > 0
        ? (volume - prevVolume) / prevVolume
        : volume > 0
          ? 1.0
          : 0.0;

    const rawScore = volume + Math.max(0, acceleration * volume);

    return {
      topic: row.topic,
      volume,
      prevVolume,
      acceleration,
      rawScore,
    };
  });

  // Sort by raw score descending, take top N
  scored.sort((a, b) => b.rawScore - a.rawScore);
  const topScored = scored.slice(0, top);

  if (topScored.length === 0) {
    return ok([]);
  }

  // Normalize scores to 0-10 scale
  const maxRaw = topScored[0].rawScore;
  const minRaw = topScored[topScored.length - 1].rawScore;
  const range = maxRaw - minRaw;

  // Fetch top titles for each trending topic
  const titleSql = `
    SELECT e.title
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE et.topic = ? AND e.fetched_at >= ?
    ORDER BY e.score DESC, e.fetched_at DESC
    LIMIT ?
  `;
  const titleStmt = db.prepare(titleSql);

  const trends: TrendItem[] = topScored.map((item) => {
    // Normalize score: if all same raw score, give max 10
    const normalizedScore =
      range > 0
        ? ((item.rawScore - minRaw) / range) * 10
        : 10.0;

    // Round to 1 decimal
    const score = Math.round(normalizedScore * 10) / 10;

    // Fetch top titles
    const titleRows = titleStmt.all(
      item.topic,
      effectiveWindowStart,
      MAX_TITLES_PER_TOPIC,
    ) as Array<{ title: string | null }>;

    const topTitles = titleRows
      .map((r) => sanitizeSnippet(r.title, { maxLength: 200 }).text)
      .filter((t) => t.length > 0);

    return {
      topic: item.topic,
      score,
      volume: item.volume,
      prev_volume: item.prevVolume,
      acceleration: Math.round(item.acceleration * 100) / 100,
      evidence_count: item.volume,
      top_titles: topTitles,
    };
  });

  const warnings: string[] = [];
  const reviewWarning = checkTopicReviewWarning(db);
  if (reviewWarning) warnings.push(reviewWarning);

  return ok(trends, { warnings });
}
