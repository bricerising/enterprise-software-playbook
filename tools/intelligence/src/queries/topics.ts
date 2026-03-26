import type Database from 'better-sqlite3';
import type { IntelResponse } from '../types.js';
import { ok } from '../util/envelope.js';
import { checkTopicReviewWarning } from './review-warning.js';

export interface TopicItem {
  topic: string;
  active: boolean;
  event_count_7d: number;
}

export interface QueryTopicsOpts {
  /** List of configured topics from topics.yaml */
  configuredTopics?: string[];
  /** Only show topics with events in the last 7 days */
  active?: boolean;
  /** Filter topics by keyword match (case-insensitive substring) */
  match?: string;
}

/**
 * List topics from the configured topics allowlist.
 *
 * - --active filter: only topics with events in the last 7 days
 *   (via event_topics JOIN with events WHERE fetched_at >= 7 days ago)
 * - --match filter: case-insensitive keyword match on topic name
 *
 * If no configuredTopics list is provided, falls back to topics
 * found in the event_topics table.
 */
export function queryTopics(
  db: Database.Database,
  opts: QueryTopicsOpts = {},
): IntelResponse<TopicItem[]> {
  // Get event counts per topic in last 7 days from the database
  const activeTopicsSql = `
    SELECT et.topic, COUNT(*) AS event_count
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE e.fetched_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
    GROUP BY et.topic
  `;

  const activeRows = db.prepare(activeTopicsSql).all() as Array<{
    topic: string;
    event_count: number;
  }>;

  const activeMap = new Map<string, number>();
  for (const row of activeRows) {
    activeMap.set(row.topic, row.event_count);
  }

  // Build the topic list from configured topics or from what's in the DB
  let topicNames: string[];
  if (opts.configuredTopics && opts.configuredTopics.length > 0) {
    topicNames = opts.configuredTopics;
  } else {
    // Fall back to all topics found in event_topics
    const allTopicsSql = `SELECT DISTINCT topic FROM event_topics ORDER BY topic`;
    const allRows = db.prepare(allTopicsSql).all() as Array<{ topic: string }>;
    topicNames = allRows.map((r) => r.topic);
  }

  let items: TopicItem[] = topicNames.map((topic) => {
    const eventCount = activeMap.get(topic) ?? 0;
    return {
      topic,
      active: eventCount > 0,
      event_count_7d: eventCount,
    };
  });

  // Apply --match filter (case-insensitive substring)
  if (opts.match) {
    const needle = opts.match.toLowerCase();
    items = items.filter((item) => item.topic.toLowerCase().includes(needle));
  }

  // Apply --active filter
  if (opts.active) {
    items = items.filter((item) => item.active);
  }

  // Sort: active topics first (by event count desc), then alphabetical
  items.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.event_count_7d !== b.event_count_7d) return b.event_count_7d - a.event_count_7d;
    return a.topic.localeCompare(b.topic);
  });

  const warnings: string[] = [];
  const reviewWarning = checkTopicReviewWarning(db);
  if (reviewWarning) warnings.push(reviewWarning);

  return ok(items, { warnings });
}
