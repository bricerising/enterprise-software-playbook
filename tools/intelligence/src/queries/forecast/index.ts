import type Database from 'better-sqlite3';
import type { IntelResponse } from '../../types.js';
import { ok } from '../../util/envelope.js';
import type {
  ForecastData, ComputeForecastOpts,
  ChangePointSummary, DynamicItem,
} from './types.js';
import { COMPACT_LIMITS, SUMMARY_LIMITS, sinceISO, formatISO } from './types.js';

import { computeLifecycles } from './lifecycle.js';
import { detectChains, detectTransitiveChains, buildMultiscaleView, computeRankedChains } from './chains.js';
import { computeEntropy } from './entropy.js';
import { detectChangePoints } from './cusum.js';
import { projectScenariosBayesian } from './scenarios.js';
import { detectDynamics } from './dynamics.js';
import { buildTopicContext } from './context.js';

/* ── Re-exports ────────────────────────────────────────────────────── */

export type {
  ChangePointSummary, TopicContext, ForecastData,
  LifecycleItem, ChainItem, TransitiveChainItem, RankedChainItem,
  ScenarioItem, EntropyItem, MultiscaleItem,
  DynamicType, DynamicItem,
  ComputeForecastOpts,
  SnapshotResult, EvaluateResult,
} from './types.js';

export { detectDynamics } from './dynamics.js';
export { saveSnapshot, evaluateForecasts } from './snapshot.js';

/* ── Main entry ─────────────────────────────────────────────────────── */

export function computeForecast(
  db: Database.Database,
  opts: ComputeForecastOpts = {},
): IntelResponse<ForecastData> {
  const lagWindowDays = opts.lag_window_days ?? 7;
  const minSupport = opts.min_support ?? 2;
  const topScenarios = opts.top_scenarios ?? 10;
  const useDedup = opts.dedup !== 'none';
  const summary = opts.summary ?? false;
  const compact = summary || (opts.compact ?? false);

  // Overall analysis window (default 120 days), clamped to actual data coverage
  const requestedWindowDays = opts.window_days ?? 120;
  if (requestedWindowDays <= 0) {
    return ok({
      window: { start: '', end: '', events_analyzed: 0 },
      ranked_chains: [],
      scenarios: [],
      dynamics: [],
      change_points_summary: [],
    } as ForecastData, {
      warnings: [`Invalid window_days: ${requestedWindowDays}. Must be > 0.`],
    });
  }
  const warnings: string[] = [];

  const now = Date.now();
  const { t: oldestEvent } = db.prepare('SELECT MIN(fetched_at) AS t FROM events').get() as { t: string | null };
  const dataDays = oldestEvent ? Math.floor((now - new Date(oldestEvent).getTime()) / 86_400_000) : 0;

  const windowDays = dataDays > 0 ? Math.min(requestedWindowDays, dataDays) : requestedWindowDays;
  if (windowDays < requestedWindowDays) {
    warnings.push(`Window clamped from ${requestedWindowDays}d to ${windowDays}d (only ${dataDays}d of data available)`);
  }

  const windowMs = windowDays * 86_400_000;
  const windowStart = sinceISO(windowMs);
  const end = formatISO(new Date(now));

  // Count events in analysis window
  const countSql = `
    SELECT COUNT(*) AS cnt FROM events WHERE fetched_at >= ?
  `;
  const { cnt: eventsAnalyzed } = db.prepare(countSql).get(windowStart) as { cnt: number };

  const lifecycles = computeLifecycles(db, now, useDedup);

  // G. CUSUM change-point detection — merge into lifecycle items
  const changePointMap = detectChangePoints(db, windowStart, useDedup, now);
  for (const lc of lifecycles) {
    lc.change_points = changePointMap.get(lc.topic) ?? [];
  }

  const chains = detectChains(db, windowStart, lagWindowDays, minSupport, useDedup, lifecycles);
  const transitive_chains = detectTransitiveChains(chains);

  // F. Entropy scoring
  const entropy = computeEntropy(db, windowStart, useDedup);

  // J. Bayesian scenario projection
  const scenarios = projectScenariosBayesian(
    db, chains, lifecycles, entropy, windowStart, topScenarios, useDedup,
  );

  const multiscale = buildMultiscaleView(lifecycles);
  const ranked_chains = computeRankedChains(chains, lifecycles);

  // Freshness gate: identify topics with at least one event where published_at
  // is non-null and falls within the analysis window.
  const freshnessSql = `
    SELECT DISTINCT et.topic
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE e.published_at IS NOT NULL
      AND e.published_at >= ?
  `;
  const freshTopics = new Set(
    (db.prepare(freshnessSql).all(windowStart) as Array<{ topic: string }>)
      .map(r => r.topic),
  );

  const limits = summary ? SUMMARY_LIMITS : (compact ? COMPACT_LIMITS : null);
  const dynamicsPerType = limits
    ? Math.max(limits.dynamics_per_type, COMPACT_LIMITS.dynamics_per_type)
    : undefined;
  const dynamics = detectDynamics(chains, lifecycles, multiscale, entropy, dynamicsPerType, freshTopics);

  // Build change_points_summary: topics with CUSUM change points, sorted by recency
  const changePointsSummary: ChangePointSummary[] = [];
  for (const lc of lifecycles) {
    for (const daysAgo of lc.change_points) {
      changePointsSummary.push({ topic: lc.topic, days_ago: daysAgo });
    }
  }
  changePointsSummary.sort((a, b) => a.days_ago - b.days_ago);

  // --with-context: inline top event titles
  const withContext = opts.with_context ?? false;
  let context: import('./types.js').TopicContext[] | undefined;
  if (withContext) {
    context = buildTopicContext(db, changePointsSummary, ranked_chains, windowStart, limits?.ranked_chains ?? 5);
  }

  // --topics: post-filter all sections to only include data relating to specified topics.
  const topicFilter = opts.topics && opts.topics.length > 0
    ? new Set(opts.topics)
    : null;

  const filteredLifecycles = topicFilter
    ? lifecycles.filter(lc => topicFilter.has(lc.topic))
    : lifecycles;
  const filteredChains = topicFilter
    ? chains.filter(c => topicFilter.has(c.from_topic) || topicFilter.has(c.to_topic))
    : chains;
  const filteredRankedChains = topicFilter
    ? ranked_chains.filter(c => topicFilter.has(c.from_topic) || topicFilter.has(c.to_topic))
    : ranked_chains;
  const filteredScenarios = topicFilter
    ? scenarios.filter(s => topicFilter.has(s.target_topic) || s.trigger_topics.some(t => topicFilter.has(t)))
    : scenarios;
  const filteredMultiscale = topicFilter
    ? multiscale.filter(ms => topicFilter.has(ms.topic))
    : multiscale;
  const filteredTransitive = topicFilter
    ? transitive_chains.filter(tc => tc.path.some(p => topicFilter.has(p)))
    : transitive_chains;
  const filteredEntropy = topicFilter
    ? entropy.filter(e => topicFilter.has(e.topic))
    : entropy;
  const filteredDynamics = topicFilter
    ? dynamics.filter(d => d.topics.some(t => topicFilter.has(t)))
    : dynamics;
  const filteredChangePoints = topicFilter
    ? changePointsSummary.filter(cp => topicFilter.has(cp.topic))
    : changePointsSummary;
  const filteredContext = topicFilter && context
    ? context.filter(c => topicFilter.has(c.topic))
    : context;

  // --section: only include specified sections in the response.
  const VALID_SECTIONS = new Set([
    'lifecycles', 'chains', 'ranked_chains', 'scenarios', 'multiscale',
    'transitive_chains', 'entropy', 'dynamics', 'change_points_summary', 'context',
  ]);
  if (opts.sections && opts.sections.length > 0) {
    const invalid = opts.sections.filter(s => !VALID_SECTIONS.has(s));
    if (invalid.length > 0) {
      warnings.push(`Unknown --section value(s): ${invalid.join(', ')}. Valid: ${[...VALID_SECTIONS].join(', ')}`);
    }
  }
  const sectionFilter = opts.sections && opts.sections.length > 0
    ? new Set(opts.sections.filter(s => VALID_SECTIONS.has(s)))
    : null;

  if (limits) {
    // Adaptive summary: when summary mode produces thin scenario yield (< 3),
    // auto-upgrade those sections to compact limits.
    const effectiveLimits: Record<string, number> = { ...limits };
    if (summary && filteredScenarios.length < 3) {
      effectiveLimits.ranked_chains = Math.max(limits.ranked_chains, COMPACT_LIMITS.ranked_chains);
      effectiveLimits.dynamics_per_type = Math.max(limits.dynamics_per_type, COMPACT_LIMITS.dynamics_per_type);
      effectiveLimits.lifecycles = Math.max(limits.lifecycles, COMPACT_LIMITS.lifecycles);
    }

    const result: ForecastData = {
      window: { start: windowStart, end, events_analyzed: eventsAnalyzed },
      ranked_chains: filteredRankedChains.slice(0, effectiveLimits.ranked_chains),
      scenarios: filteredScenarios.slice(0, effectiveLimits.scenarios),
      dynamics: capDynamicsPerType(filteredDynamics, effectiveLimits.dynamics_per_type),
      change_points_summary: filteredChangePoints,
    };
    if (effectiveLimits.lifecycles > 0) result.lifecycles = filteredLifecycles.slice(0, effectiveLimits.lifecycles);
    if (effectiveLimits.chains > 0) result.chains = filteredChains.slice(0, effectiveLimits.chains);
    if (effectiveLimits.multiscale > 0) result.multiscale = filteredMultiscale.slice(0, effectiveLimits.multiscale);
    if (effectiveLimits.transitive_chains > 0) result.transitive_chains = filteredTransitive.slice(0, effectiveLimits.transitive_chains);
    if (effectiveLimits.entropy > 0) result.entropy = filteredEntropy.slice(0, effectiveLimits.entropy);
    if (filteredContext) result.context = filteredContext;

    if (sectionFilter) {
      return ok(filterSections(result, sectionFilter), { warnings });
    }

    return ok(result, { warnings });
  }

  const fullResult: ForecastData = {
    window: { start: windowStart, end, events_analyzed: eventsAnalyzed },
    lifecycles: filteredLifecycles,
    chains: filteredChains,
    ranked_chains: filteredRankedChains,
    scenarios: filteredScenarios,
    multiscale: filteredMultiscale,
    transitive_chains: filteredTransitive,
    entropy: filteredEntropy,
    dynamics: filteredDynamics,
    change_points_summary: filteredChangePoints,
    ...(filteredContext ? { context: filteredContext } : {}),
  };

  if (sectionFilter) {
    return ok(filterSections(fullResult, sectionFilter), { warnings });
  }

  return ok(fullResult, { warnings });
}

/** Re-cap dynamics per type after initial detection. */
function capDynamicsPerType(items: DynamicItem[], maxPerType: number): DynamicItem[] {
  const counts = new Map<string, number>();
  return items.filter(d => {
    const count = counts.get(d.type) ?? 0;
    if (count >= maxPerType) return false;
    counts.set(d.type, count + 1);
    return true;
  });
}

/** Strip a ForecastData to only the sections named in the filter set. */
function filterSections(data: ForecastData, keep: Set<string>): ForecastData {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any = { window: data.window };
  const keys: Array<keyof Omit<ForecastData, 'window'>> = [
    'lifecycles', 'chains', 'ranked_chains', 'scenarios', 'multiscale',
    'transitive_chains', 'entropy', 'dynamics', 'change_points_summary', 'context',
  ];
  for (const k of keys) {
    if (keep.has(k) && data[k] !== undefined) out[k] = data[k];
  }
  return out as ForecastData;
}
