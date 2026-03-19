import type Database from 'better-sqlite3';
import type { ChangePointSummary, RankedChainItem, TopicContext } from './types.js';
import { PUB_TS, CONTEXT_TITLES_PER_TOPIC, sanitizeSnippet } from './types.js';

/* ── Context inlining (--with-context) ─────────────────────────────── */

export function buildTopicContext(
  db: Database.Database,
  changePoints: ChangePointSummary[],
  rankedChains: RankedChainItem[],
  windowStart: string,
  topRankedN: number,
): TopicContext[] {
  // Collect unique topics from change points and top ranked chains (both from + to)
  const topics = new Set<string>();
  for (const cp of changePoints) topics.add(cp.topic);
  for (const rc of rankedChains.slice(0, topRankedN)) {
    topics.add(rc.from_topic);
    topics.add(rc.to_topic);
  }

  if (topics.size === 0) return [];

  const titleSql = `
    SELECT e.title
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE et.topic = ? AND ${PUB_TS} >= ?
    ORDER BY e.score DESC, ${PUB_TS} DESC
    LIMIT ?
  `;
  const stmt = db.prepare(titleSql);

  const results: TopicContext[] = [];
  for (const topic of topics) {
    const rows = stmt.all(topic, windowStart, CONTEXT_TITLES_PER_TOPIC) as Array<{ title: string | null }>;
    const titles = rows
      .map(r => sanitizeSnippet(r.title, { maxLength: 200 }).text)
      .filter(t => t.length > 0);
    if (titles.length > 0) {
      results.push({ topic, titles });
    }
  }

  // Sort by topic for stable output
  results.sort((a, b) => a.topic.localeCompare(b.topic));
  return results;
}
