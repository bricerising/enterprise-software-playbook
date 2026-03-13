import type Database from 'better-sqlite3';
import type { IntelResponse, SourceType } from '../types.js';
import { ok } from '../util/envelope.js';
import { sanitizeSnippet } from '../util/text.js';
import { parseDuration, sinceISO, formatISO } from '../util/time.js';

const DEFAULT_SINCE = '6h';
const DEFAULT_TOP = 10;
const MAX_TOP = 10;
const DEFAULT_MAX_EVENTS = 5;
const MAX_EVENTS_PER_TREND = 5;
const SNIPPET_MAX_LENGTH = 500;

export interface PackEventItem {
  event_id: string;
  title: string;
  url: string | null;
  source: SourceType;
  published_at: string | null;
  snippet: string;
  snippet_flags: string[];
}

export interface PackTrendItem {
  topic: string;
  score: number;
  volume: number;
  acceleration: number;
  events: PackEventItem[];
}

export interface PackSourceHealth {
  source: string;
  feed: string;
  status: 'healthy' | 'stale' | 'error';
  events_in_window: number;
}

export interface PackData {
  window: {
    start: string;
    end: string;
  };
  trends: PackTrendItem[];
  source_health: PackSourceHealth[];
}

export interface BuildPackOpts {
  since?: string;        // duration string, e.g. '6h', '24h'
  top?: number;          // max trends (capped at 10)
  maxEvents?: number;    // max events per trend (capped at 5)
}

/**
 * Build a bounded evidence bundle for agent synthesis.
 *
 * Combines trends + top events per trend + source health into a single
 * pre-assembled dataset. This is not a brief -- it provides evidence;
 * the agent provides interpretation.
 *
 * Bounded: max 10 trends, max 5 events per trend, snippets truncated to 500 chars.
 * All text sanitized per the safe snippets contract.
 */
export function buildPack(
  db: Database.Database,
  opts: BuildPackOpts = {},
): IntelResponse<PackData> {
  const sinceStr = opts.since ?? DEFAULT_SINCE;
  const top = Math.min(Math.max(1, opts.top ?? DEFAULT_TOP), MAX_TOP);
  const maxEvents = Math.min(Math.max(1, opts.maxEvents ?? DEFAULT_MAX_EVENTS), MAX_EVENTS_PER_TREND);

  const windowMs = parseDuration(sinceStr);
  const now = Date.now();
  const windowStart = sinceISO(windowMs);
  const windowEnd = formatISO(new Date(now));
  const prevWindowStart = sinceISO(windowMs * 2);

  // --- Trends computation (inline, bounded) ---

  // Current window volumes with cross-source dedup
  const currentSql = `
    SELECT et.topic,
           COUNT(DISTINCT COALESCE(e.canonical_url, e.event_id)) AS volume
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE e.fetched_at >= ?
    GROUP BY et.topic
    ORDER BY volume DESC
  `;
  const currentRows = db.prepare(currentSql).all(windowStart) as Array<{
    topic: string;
    volume: number;
  }>;

  // Previous window volumes for acceleration
  const prevSql = `
    SELECT et.topic,
           COUNT(DISTINCT COALESCE(e.canonical_url, e.event_id)) AS volume
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE e.fetched_at >= ? AND e.fetched_at < ?
    GROUP BY et.topic
  `;
  const prevRows = db.prepare(prevSql).all(prevWindowStart, windowStart) as Array<{
    topic: string;
    volume: number;
  }>;

  const prevVolumeMap = new Map<string, number>();
  for (const row of prevRows) {
    prevVolumeMap.set(row.topic, row.volume);
  }

  // Score and rank
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
    return { topic: row.topic, volume, prevVolume, acceleration, rawScore };
  });

  scored.sort((a, b) => b.rawScore - a.rawScore);
  const topScored = scored.slice(0, top);

  // Normalize scores to 0-10
  const maxRaw = topScored.length > 0 ? topScored[0].rawScore : 0;
  const minRaw = topScored.length > 0 ? topScored[topScored.length - 1].rawScore : 0;
  const range = maxRaw - minRaw;

  // --- Fetch top events per trend ---

  const eventSql = `
    SELECT e.event_id, e.title, e.url, e.source, e.published_at, e.content
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE et.topic = ? AND e.fetched_at >= ?
    ORDER BY e.score DESC, e.fetched_at DESC
    LIMIT ?
  `;
  const eventStmt = db.prepare(eventSql);

  const trends: PackTrendItem[] = topScored.map((item) => {
    const normalizedScore =
      range > 0
        ? ((item.rawScore - minRaw) / range) * 10
        : 10.0;
    const score = Math.round(normalizedScore * 10) / 10;

    const eventRows = eventStmt.all(item.topic, windowStart, maxEvents) as Array<{
      event_id: string;
      title: string | null;
      url: string | null;
      source: SourceType;
      published_at: string | null;
      content: string | null;
    }>;

    const events: PackEventItem[] = eventRows.map((ev) => {
      const { text: snippet, flags: snippetFlags } = sanitizeSnippet(
        ev.content ?? ev.title,
        { maxLength: SNIPPET_MAX_LENGTH },
      );

      return {
        event_id: ev.event_id,
        title: sanitizeSnippet(ev.title, { maxLength: 200 }).text,
        url: ev.url,
        source: ev.source,
        published_at: ev.published_at,
        snippet,
        snippet_flags: snippetFlags,
      };
    });

    return {
      topic: item.topic,
      score,
      volume: item.volume,
      acceleration: Math.round(item.acceleration * 100) / 100,
      events,
    };
  });

  // --- Source health ---

  const DEFAULT_POLL_INTERVAL_S = 300;
  const staleThresholdMs = DEFAULT_POLL_INTERVAL_S * 2 * 1000;

  const healthSql = `
    SELECT
      ch.source,
      ch.feed,
      ch.last_success_at,
      ch.last_error,
      COALESCE(ew.cnt, 0) AS events_in_window
    FROM collector_health ch
    LEFT JOIN (
      SELECT source, feed, COUNT(*) AS cnt
      FROM events
      WHERE fetched_at >= ?
      GROUP BY source, feed
    ) ew ON ew.source = ch.source AND ew.feed = ch.feed
    ORDER BY ch.source, ch.feed
  `;
  const healthRows = db.prepare(healthSql).all(windowStart) as Array<{
    source: string;
    feed: string;
    last_success_at: string | null;
    last_error: string | null;
    events_in_window: number;
  }>;

  const sourceHealth: PackSourceHealth[] = healthRows.map((row) => {
    let status: 'healthy' | 'stale' | 'error';
    if (row.last_error) {
      status = 'error';
    } else if (!row.last_success_at) {
      status = 'stale';
    } else {
      const age = now - new Date(row.last_success_at).getTime();
      status = age > staleThresholdMs ? 'stale' : 'healthy';
    }

    return {
      source: row.source,
      feed: row.feed,
      status,
      events_in_window: row.events_in_window,
    };
  });

  const packData: PackData = {
    window: {
      start: windowStart,
      end: windowEnd,
    },
    trends,
    source_health: sourceHealth,
  };

  return ok(packData);
}
