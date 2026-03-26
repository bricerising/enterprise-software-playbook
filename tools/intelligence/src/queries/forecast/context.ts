import type Database from 'better-sqlite3';
import type { ChangePointSummary, RankedChainItem, TopicContext } from './types.js';
import { PUB_TS, CONTEXT_TITLES_PER_TOPIC, sanitizeSnippet, formatISO } from './types.js';

/* ── Constants ──────────────────────────────────────────────────────── */

/** Days-ago threshold: breaks older than this get a separate break_titles query
 *  because the regular titles (sorted by score/recency) may miss the mechanism. */
const BREAK_AGE_THRESHOLD = 3;

/** Half-width of the window around the break date for break_titles query. */
const BREAK_WINDOW_DAYS = 2;

/* ── Context inlining (--with-context) ─────────────────────────────── */

export function buildTopicContext(
  db: Database.Database,
  changePoints: ChangePointSummary[],
  rankedChains: RankedChainItem[],
  windowStart: string,
  topRankedN: number,
  now: number,
): TopicContext[] {
  // Collect unique topics from change points and top ranked chains (both from + to)
  const topics = new Set<string>();
  for (const cp of changePoints) topics.add(cp.topic);
  for (const rc of rankedChains.slice(0, topRankedN)) {
    topics.add(rc.from_topic);
    topics.add(rc.to_topic);
  }

  if (topics.size === 0) return [];

  // Build a map of topic -> most recent break days_ago (for break_titles logic)
  const breakDaysAgo = new Map<string, number>();
  for (const cp of changePoints) {
    const existing = breakDaysAgo.get(cp.topic);
    if (existing === undefined || cp.days_ago < existing) {
      breakDaysAgo.set(cp.topic, cp.days_ago);
    }
  }

  const titleSql = `
    SELECT e.title
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE et.topic = ? AND ${PUB_TS} >= ?
    ORDER BY e.score DESC, ${PUB_TS} DESC
    LIMIT ?
  `;
  const stmt = db.prepare(titleSql);

  // Break-window query: events within ±BREAK_WINDOW_DAYS of the break date
  const breakTitleSql = `
    SELECT e.title
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE et.topic = ? AND ${PUB_TS} >= ? AND ${PUB_TS} <= ?
    ORDER BY e.score DESC, ${PUB_TS} DESC
    LIMIT ?
  `;
  const breakStmt = db.prepare(breakTitleSql);

  const results: TopicContext[] = [];
  for (const topic of topics) {
    const rows = stmt.all(topic, windowStart, CONTEXT_TITLES_PER_TOPIC) as Array<{ title: string | null }>;
    const titles = rows
      .map(r => sanitizeSnippet(r.title, { maxLength: 200 }).text)
      .filter(t => t.length > 0);

    const ctx: TopicContext = { topic, titles };

    // Add break_titles for change-point topics where the break is old enough
    const daysAgo = breakDaysAgo.get(topic);
    if (daysAgo !== undefined && daysAgo > BREAK_AGE_THRESHOLD) {
      const breakDateMs = now - daysAgo * 86_400_000;
      const windowStartMs = breakDateMs - BREAK_WINDOW_DAYS * 86_400_000;
      const windowEndMs = breakDateMs + BREAK_WINDOW_DAYS * 86_400_000;
      const breakWindowStart = formatISO(new Date(windowStartMs));
      const breakWindowEnd = formatISO(new Date(windowEndMs));

      const breakRows = breakStmt.all(
        topic, breakWindowStart, breakWindowEnd, CONTEXT_TITLES_PER_TOPIC,
      ) as Array<{ title: string | null }>;

      const titleSet = new Set(titles);
      const breakTitles = breakRows
        .map(r => sanitizeSnippet(r.title, { maxLength: 200 }).text)
        .filter(t => t.length > 0 && !titleSet.has(t));

      if (breakTitles.length > 0) {
        ctx.break_titles = breakTitles;
      }
      ctx.break_days_ago = daysAgo;
    }

    if (titles.length > 0 || (ctx.break_titles && ctx.break_titles.length > 0)) {
      results.push(ctx);
    }
  }

  // Sort by topic for stable output
  results.sort((a, b) => a.topic.localeCompare(b.topic));
  return results;
}
