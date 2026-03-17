import type Database from 'better-sqlite3';
import type { IntelResponse } from '../types.js';
import { ok } from '../util/envelope.js';
import { sanitizeSnippet } from '../util/text.js';
import { sinceISO as _sinceISO, formatISO } from '../util/time.js';

/* ── Constants ──────────────────────────────────────────────────────── */

/** SQL expression for real-world event timestamp (publication time, fetch-time fallback).
 *  Temporal analysis must use this instead of raw fetched_at so that bulk ingests
 *  don't compress weeks of signal into a single calendar day. */
const PUB_TS = 'COALESCE(e.published_at, e.fetched_at)';
const PUB_DAY = `DATE(${PUB_TS})`;

const WINDOWS = [
  { label: '1d', ms: 86_400_000 },
  { label: '7d', ms: 604_800_000 },
  { label: '14d', ms: 1_209_600_000 },
  { label: '30d', ms: 2_592_000_000 },
] as const;

const MAX_TITLES_PER_SCENARIO = 3;

/** Exponential decay half-life in days. Chains with recent co-occurrences
 *  are weighted higher than old ones. */
const DECAY_HALF_LIFE_DAYS = 14;
const DECAY_LAMBDA = Math.LN2 / DECAY_HALF_LIFE_DAYS;

/** CUSUM change-point detection sensitivity.
 *  k = allowance (slack) in standard deviations; h = decision threshold. */
const CUSUM_K_SIGMA = 0.5;
const CUSUM_H_SIGMA = 4.0;

/** Days within which a CUSUM change point discounts chain reliability.
 *  A change point 0 days ago → full discount; at the horizon → no discount. */
const CUSUM_DISCOUNT_HORIZON_DAYS = 7;

/** Softmax temperature for scenario projection. Values < 1.0 sharpen the
 *  probability distribution so top scenarios differentiate from the rest.
 *  1.0 = standard softmax; 0.5 = doubled log-posterior differences. */
const SOFTMAX_TEMPERATURE = 0.5;

/** HMM-style Gaussian emission model parameters.
 *  Each phase has expected accelerations at each window and a spread. */
const PHASE_EMISSIONS: Record<
  string,
  { means: Record<string, number>; stddev: number }
> = {
  emerging:     { means: { '1d': 1.0, '7d': 0.5, '14d': 0.2, '30d': 0.0 }, stddev: 0.5 },
  accelerating: { means: { '1d': 0.5, '7d': 0.5, '14d': 0.3, '30d': 0.3 }, stddev: 0.4 },
  peaking:      { means: { '1d': -0.3, '7d': 0.3, '14d': 0.2, '30d': 0.1 }, stddev: 0.4 },
  decaying:     { means: { '1d': -0.5, '7d': -0.3, '14d': -0.2, '30d': -0.1 }, stddev: 0.4 },
  stable:       { means: { '1d': 0.0, '7d': 0.0, '14d': 0.0, '30d': 0.0 }, stddev: 0.15 },
};

/* ── Interfaces ─────────────────────────────────────────────────────── */

export interface ChangePointSummary {
  topic: string;
  days_ago: number;
}

/** Inline context titles for a topic, used by --with-context to save deepening round-trips. */
export interface TopicContext {
  topic: string;
  titles: string[];
}

export interface ForecastData {
  window: { start: string; end: string; events_analyzed: number };
  /** Omitted in summary mode (limit 0). */
  lifecycles?: LifecycleItem[];
  /** Omitted in summary mode (limit 0). */
  chains?: ChainItem[];
  ranked_chains: RankedChainItem[];
  scenarios: ScenarioItem[];
  /** Omitted in summary mode (limit 0). */
  multiscale?: MultiscaleItem[];
  /** Omitted in summary mode (limit 0). */
  transitive_chains?: TransitiveChainItem[];
  /** Omitted in summary mode (limit 0). */
  entropy?: EntropyItem[];
  dynamics: DynamicItem[];
  change_points_summary: ChangePointSummary[];
  /** Present when --with-context is used. Top event titles per change point topic
   *  and per top ranked chain topic, inlined to save deepening round-trips. */
  context?: TopicContext[];
}

export interface LifecycleItem {
  topic: string;
  phase: 'emerging' | 'accelerating' | 'peaking' | 'decaying' | 'stable';
  phase_confidence: number;
  phase_probabilities?: Record<string, number>;
  volumes: Record<string, number>;
  accelerations: Record<string, number>;
  change_points: number[];
}

export interface ChainItem {
  from_topic: string;
  to_topic: string;
  support: number;
  avg_lag_days: number;
  source_diversity: number;
  active: boolean;
  lift: number;
  confidence: number;
  directionality: number;
  lag_stddev: number;
  decay_weighted_support: number;
  /** Fraction of window days on which the trigger topic spikes (0-1).
   *  High values (> 0.5) indicate omnipresent topics whose chains are less informative. */
  trigger_base_rate: number;
  /** Calendar artifact hint. Present when co-occurrences cluster on weekdays.
   *  'weekday_correlated' = both trigger and target spike predominantly Mon-Fri
   *  and co-occurrences are >85% weekday. Likely a calendar cadence, not causal. */
  temporal_pattern?: 'weekday_correlated';
}

export interface TransitiveChainItem {
  path: string[];
  total_lag_days: number;
  min_support: number;
  combined_lift: number;
  cross_domain: boolean;
}

export interface RankedChainItem extends ChainItem {
  score: number;
  cross_domain: boolean;
}

export interface ScenarioItem {
  target_topic: string;
  probability: number;
  timeframe_days: [number, number];
  trigger_topics: string[];
  supporting_chains: number;
  evidence_titles: string[];
  /** Parallel array with evidence_titles: per-title relevance hint based on
   *  how many topics the source event was assigned to. Fewer topics = more
   *  specific classification = higher confidence the title is actually relevant.
   *  'high' = 1-2 topics, 'medium' = 3-4, 'low' = 5 (classifier may be noisy). */
  evidence_relevance: Array<'high' | 'medium' | 'low'>;
  target_entropy: number;
}

export interface EntropyItem {
  topic: string;
  entropy: number;
  normalized_entropy: number;
  active_days: number;
}

export interface MultiscaleItem {
  topic: string;
  alignment: 'aligned_up' | 'aligned_down' | 'diverging' | 'transitioning';
  d1_accel: number;
  d7_accel: number;
  d30_accel: number;
}

export type DynamicType = 'reinforcing_loop' | 'delay' | 'accumulation' | 'dampening';

export interface DynamicItem {
  type: DynamicType;
  topics: string[];
  metric: { name: string; value: number; secondary_value?: number };
  interpretation: string;
}

/** Maximum trigger chains that contribute to any single target's posterior.
 *  Prevents posterior saturation when many triggers are simultaneously active. */
const MAX_CHAINS_PER_TARGET = 5;

/** Maximum ranked chains per trigger topic in the top-50.
 *  Ensures diverse trigger representation; high-base-rate triggers
 *  don't monopolize all ranked chain slots. */
const MAX_RANKED_PER_TRIGGER = 3;

/** Maximum transitive chains per A→B prefix in the top-100.
 *  Ensures diverse cross-domain paths rather than five variations
 *  of the same cascade (e.g., all sharing aws.bedrock→hw.chip prefix). */
const MAX_TRANSITIVE_PER_PREFIX = 3;

export interface ComputeForecastOpts {
  lag_window_days?: number;
  min_support?: number;
  top_scenarios?: number;
  dedup?: string;
  /** Overall analysis window in days (default: 30). Accepted values: 7, 14, 30. */
  window_days?: number;
  /** When true, return a compact summary (top-N per section) instead of full output. */
  compact?: boolean;
  /** When true, return a minimal summary (top-3 scenarios, top-5 chains, top-3 dynamics,
   *  change points) for fast agent consumption. Implies compact. */
  summary?: boolean;
  /** When true, inline top event titles per change point topic and per top ranked chain
   *  topic. Saves a round-trip of `intel search` deepening calls. */
  with_context?: boolean;
  /** Filter output to specific topic IDs (e.g., ['ai.openai', 'hw.gpu']).
   *  The full pipeline runs but output is post-filtered to only include data
   *  relating to these topics. Eliminates the need to run the full forecast
   *  twice to extract lifecycle/multiscale/entropy for specific topics. */
  topics?: string[];
  /** Filter output to specific section names (e.g., ['lifecycles', 'entropy']).
   *  Only these sections are included in the response. Valid values:
   *  lifecycles, chains, ranked_chains, scenarios, multiscale,
   *  transitive_chains, entropy, dynamics, change_points_summary, context. */
  sections?: string[];
}

/* ── Main entry ─────────────────────────────────────────────────────── */

/** Compact mode limits per section. */
const COMPACT_LIMITS = {
  lifecycles: 15,
  chains: 15,
  ranked_chains: 10,
  scenarios: 10,
  multiscale: 15,
  transitive_chains: 10,
  entropy: 15,
  dynamics_per_type: 5,
} as const;

/** Summary mode limits — aggressive reduction for fast agent synthesis. */
const SUMMARY_LIMITS = {
  lifecycles: 0,
  chains: 0,
  ranked_chains: 5,
  scenarios: 3,
  multiscale: 0,
  transitive_chains: 0,
  entropy: 0,
  dynamics_per_type: 1,
} as const;

export function computeForecast(
  db: Database.Database,
  opts: ComputeForecastOpts = {},
): IntelResponse<ForecastData> {
  const lagWindowDays = opts.lag_window_days ?? 7;
  // TODO: raise to 3 once the collector has 6+ weeks of steady data and top
  // topics consistently show 5+ spike-days per 30d window.
  const minSupport = opts.min_support ?? 2;
  const topScenarios = opts.top_scenarios ?? 10;
  const useDedup = opts.dedup !== 'none';
  const summary = opts.summary ?? false;
  const compact = summary || (opts.compact ?? false);

  // Overall analysis window (default 30 days)
  const windowDays = opts.window_days ?? 30;
  const windowMs = windowDays * 86_400_000;

  const now = Date.now();
  const windowStart = sinceISO(windowMs);
  const end = formatISO(new Date(now));

  // Count events in analysis window
  const countSql = `
    SELECT COUNT(*) AS cnt FROM events WHERE fetched_at >= ?
  `;
  const { cnt: eventsAnalyzed } = db.prepare(countSql).get(windowStart) as { cnt: number };

  const lifecycles = computeLifecycles(db, now, useDedup);

  // G. CUSUM change-point detection — merge into lifecycle items
  const changePointMap = detectChangePoints(db, windowStart, useDedup);
  for (const lc of lifecycles) {
    lc.change_points = changePointMap.get(lc.topic) ?? [];
  }

  const chains = detectChains(db, windowStart, lagWindowDays, minSupport, useDedup, lifecycles);
  const transitive_chains = detectTransitiveChains(chains);

  // F. Entropy scoring
  const entropy = computeEntropy(db, windowStart, useDedup);

  // J. Bayesian scenario projection (replaces heuristic scoring)
  const scenarios = projectScenariosBayesian(
    db, chains, lifecycles, entropy, windowStart, topScenarios, useDedup,
  );

  const multiscale = buildMultiscaleView(lifecycles);
  const ranked_chains = computeRankedChains(chains, lifecycles);
  // Freshness gate: identify topics with at least one event where published_at
  // is non-null and falls within the analysis window. Topics where all events
  // use the fetched_at fallback may be backfill artifacts (e.g., old blog posts
  // bulk-ingested recently) and should not trigger accumulation signals.
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
  const dynamicsPerType = limits?.dynamics_per_type ?? MAX_DYNAMICS_PER_TYPE;
  const dynamics = detectDynamics(chains, lifecycles, multiscale, entropy, dynamicsPerType, freshTopics);

  // Build change_points_summary: topics with CUSUM change points, sorted by recency
  const changePointsSummary: ChangePointSummary[] = [];
  for (const lc of lifecycles) {
    for (const daysAgo of lc.change_points) {
      changePointsSummary.push({ topic: lc.topic, days_ago: daysAgo });
    }
  }
  changePointsSummary.sort((a, b) => a.days_ago - b.days_ago);

  // --with-context: inline top event titles for change point topics and
  // top ranked chain topics so the agent doesn't need separate deepening calls.
  const withContext = opts.with_context ?? false;
  let context: TopicContext[] | undefined;
  if (withContext) {
    context = buildTopicContext(db, changePointsSummary, ranked_chains, windowStart, limits?.ranked_chains ?? 5);
  }

  // --topics: post-filter all sections to only include data relating to specified topics.
  // The full pipeline runs (chains/scenarios need cross-topic data) but output is filtered.
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
  const sectionFilter = opts.sections && opts.sections.length > 0
    ? new Set(opts.sections)
    : null;

  if (limits) {
    const result: ForecastData = {
      window: { start: windowStart, end, events_analyzed: eventsAnalyzed },
      ranked_chains: filteredRankedChains.slice(0, limits.ranked_chains),
      scenarios: filteredScenarios.slice(0, limits.scenarios),
      dynamics: filteredDynamics,
      change_points_summary: filteredChangePoints,
    };
    // Only include sections whose limit is > 0 — avoids wasted tokens
    // from empty arrays in summary mode.
    if (limits.lifecycles > 0) result.lifecycles = filteredLifecycles.slice(0, limits.lifecycles);
    if (limits.chains > 0) result.chains = filteredChains.slice(0, limits.chains);
    if (limits.multiscale > 0) result.multiscale = filteredMultiscale.slice(0, limits.multiscale);
    if (limits.transitive_chains > 0) result.transitive_chains = filteredTransitive.slice(0, limits.transitive_chains);
    if (limits.entropy > 0) result.entropy = filteredEntropy.slice(0, limits.entropy);
    if (filteredContext) result.context = filteredContext;

    if (sectionFilter) {
      return ok(filterSections(result, sectionFilter));
    }

    return ok(result);
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
    return ok(filterSections(fullResult, sectionFilter));
  }

  return ok(fullResult);
}

/** Strip a ForecastData to only the sections named in the filter set.
 *  `window` is always included. The result is typed as ForecastData but
 *  omitted sections will be absent from the serialized JSON. */
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

/* ── A. Lifecycle positioning ───────────────────────────────────────── */

function computeLifecycles(
  db: Database.Database,
  now: number,
  useDedup: boolean,
): LifecycleItem[] {
  const volumeExpr = useDedup
    ? 'COUNT(DISTINCT COALESCE(e.canonical_url, e.event_id))'
    : 'COUNT(*)';

  // Compute volume + acceleration at each of 4 windows
  const volumesByTopic = new Map<string, Record<string, number>>();
  const accelsByTopic = new Map<string, Record<string, number>>();

  for (const w of WINDOWS) {
    const windowStart = sinceISO(w.ms, now);
    const prevStart = sinceISO(w.ms * 2, now);

    const currentSql = `
      SELECT et.topic, ${volumeExpr} AS volume
      FROM event_topics et
      JOIN events e ON e.event_id = et.event_id
      WHERE ${PUB_TS} >= ?
      GROUP BY et.topic
    `;
    const currentRows = db.prepare(currentSql).all(windowStart) as Array<{
      topic: string;
      volume: number;
    }>;

    const prevSql = `
      SELECT et.topic, ${volumeExpr} AS volume
      FROM event_topics et
      JOIN events e ON e.event_id = et.event_id
      WHERE ${PUB_TS} >= ? AND ${PUB_TS} < ?
      GROUP BY et.topic
    `;
    const prevRows = db.prepare(prevSql).all(prevStart, windowStart) as Array<{
      topic: string;
      volume: number;
    }>;

    const prevMap = new Map<string, number>();
    for (const r of prevRows) prevMap.set(r.topic, r.volume);

    for (const row of currentRows) {
      const prevVolume = prevMap.get(row.topic) ?? 0;
      const acceleration =
        prevVolume > 0
          ? (row.volume - prevVolume) / prevVolume
          : row.volume > 0
            ? 1.0
            : 0.0;

      if (!volumesByTopic.has(row.topic)) volumesByTopic.set(row.topic, {});
      if (!accelsByTopic.has(row.topic)) accelsByTopic.set(row.topic, {});
      volumesByTopic.get(row.topic)![w.label] = row.volume;
      accelsByTopic.get(row.topic)![w.label] = Math.round(acceleration * 100) / 100;
    }
  }

  // Compute median 30d volume for 'emerging' threshold
  const all30dVolumes = [...volumesByTopic.values()]
    .map((v) => v['30d'] ?? 0)
    .sort((a, b) => a - b);
  const median30d =
    all30dVolumes.length > 0
      ? all30dVolumes[Math.floor(all30dVolumes.length / 2)]
      : 0;

  const results: LifecycleItem[] = [];

  for (const [topic, volumes] of volumesByTopic) {
    const accels = accelsByTopic.get(topic)!;
    const d1 = accels['1d'] ?? 0;
    const d7 = accels['7d'] ?? 0;
    const d14 = accels['14d'] ?? 0;
    const d30 = accels['30d'] ?? 0;
    const v30 = volumes['30d'] ?? 0;

    const ruleResult = classifyPhase(d1, d7, d14, d30, v30, median30d);
    const hmmResult = classifyPhaseHMM(accels);

    // Use HMM phase when its confidence is substantially higher;
    // otherwise keep the deterministic rule-based phase for backward compat.
    const useHmm = hmmResult.confidence > ruleResult.confidence + 0.15;
    const phase = useHmm ? hmmResult.phase : ruleResult.phase;
    const confidence = useHmm ? hmmResult.confidence : ruleResult.confidence;

    results.push({
      topic,
      phase,
      phase_confidence: confidence,
      // Only include HMM posterior when it was actually used for classification;
      // avoids confusing consumers with probabilities that disagree with the assigned phase.
      ...(useHmm ? { phase_probabilities: hmmResult.probabilities } : {}),
      volumes,
      accelerations: accels,
      change_points: [], // populated after lifecycle computation
    });
  }

  return results;
}

function classifyPhase(
  d1: number,
  d7: number,
  _d14: number,
  d30: number,
  v30: number,
  median30d: number,
): { phase: LifecycleItem['phase']; confidence: number } {
  // Count directional agreement across windows for confidence
  const directions = [d1, d7, d30].map((a) =>
    a > 0.2 ? 1 : a < -0.2 ? -1 : 0,
  );
  const agreeing = Math.max(
    directions.filter((d) => d === 1).length,
    directions.filter((d) => d === -1).length,
    directions.filter((d) => d === 0).length,
  );
  const confidence = Math.round((agreeing / 3) * 100) / 100;

  // Classification rules (order matters — first match wins)
  if (d1 > 0.5 && d7 > 0 && v30 < median30d) {
    return { phase: 'emerging', confidence };
  }
  if (d1 > 0 && d7 > 0 && d30 > 0) {
    return { phase: 'accelerating', confidence };
  }
  if (d1 < 0 && d7 > 0) {
    return { phase: 'peaking', confidence };
  }
  if (d1 < 0 && d7 < 0) {
    return { phase: 'decaying', confidence };
  }
  if (Math.abs(d1) < 0.2 && Math.abs(d7) < 0.2 && Math.abs(d30) < 0.2) {
    return { phase: 'stable', confidence };
  }
  // Secondary rules: d7/d30 fallback when d1 is dead
  if (Math.abs(d1) < 0.1) {
    if (d7 > 1.0 && d30 > 0 && v30 < median30d) {
      return { phase: 'emerging', confidence };
    }
    if (d7 > 0.2 && d30 > 0) {
      return { phase: 'accelerating', confidence };
    }
    if (d7 < -0.1 && d30 > 0.2) {
      return { phase: 'peaking', confidence };
    }
    if (d7 < -0.1 && d30 < -0.1) {
      return { phase: 'decaying', confidence };
    }
  }
  // Default fallback
  return { phase: 'stable', confidence };
}

/* ── B. Chain detection ─────────────────────────────────────────────── */

function detectChains(
  db: Database.Database,
  windowStart: string,
  lagWindowDays: number,
  minSupport: number,
  useDedup: boolean,
  lifecycles: LifecycleItem[],
): ChainItem[] {
  const volumeExpr = useDedup
    ? 'COUNT(DISTINCT COALESCE(e.canonical_url, e.event_id))'
    : 'COUNT(*)';

  const chainSql = `
    WITH daily_volumes AS (
      SELECT et.topic, ${PUB_DAY} AS day,
             ${volumeExpr} AS volume,
             COUNT(DISTINCT e.source) AS sources
      FROM event_topics et JOIN events e ON e.event_id = et.event_id
      WHERE ${PUB_TS} >= ?
      GROUP BY et.topic, ${PUB_DAY}
      HAVING volume >= 3
    ),
    topic_spike_days AS (
      SELECT topic, COUNT(DISTINCT day) AS spike_days
      FROM daily_volumes
      GROUP BY topic
    ),
    total_window AS (
      SELECT COUNT(DISTINCT day) AS total_days FROM daily_volumes
    )
    SELECT a.topic AS from_topic, b.topic AS to_topic,
           COUNT(*) AS support,
           AVG(JULIANDAY(b.day) - JULIANDAY(a.day)) AS avg_lag_days,
           AVG(CASE WHEN a.sources < b.sources THEN a.sources ELSE b.sources END) AS avg_min_sources,
           (COUNT(*) * 1.0 * tw.total_days) / (sa.spike_days * sb.spike_days) AS lift,
           (COUNT(*) * 1.0) / sa.spike_days AS confidence,
           SQRT(MAX(0,
             AVG((JULIANDAY(b.day) - JULIANDAY(a.day)) * (JULIANDAY(b.day) - JULIANDAY(a.day)))
             - AVG(JULIANDAY(b.day) - JULIANDAY(a.day)) * AVG(JULIANDAY(b.day) - JULIANDAY(a.day))
           )) AS lag_stddev,
           MAX(b.day) AS most_recent_day,
           sa.spike_days * 1.0 / tw.total_days AS trigger_base_rate,
           AVG(CASE WHEN CAST(STRFTIME('%w', a.day) AS INTEGER) BETWEEN 1 AND 5 THEN 1.0 ELSE 0.0 END) AS trigger_weekday_ratio,
           AVG(CASE WHEN CAST(STRFTIME('%w', b.day) AS INTEGER) BETWEEN 1 AND 5 THEN 1.0 ELSE 0.0 END) AS target_weekday_ratio
    FROM daily_volumes a
    JOIN daily_volumes b
      ON b.day > a.day
      AND JULIANDAY(b.day) - JULIANDAY(a.day) <= ?
      AND a.topic != b.topic
    JOIN topic_spike_days sa ON sa.topic = a.topic
    JOIN topic_spike_days sb ON sb.topic = b.topic
    CROSS JOIN total_window tw
    GROUP BY a.topic, b.topic
    HAVING support >= ?
    ORDER BY lift DESC, support DESC
  `;

  const chainRows = db.prepare(chainSql).all(
    windowStart,
    lagWindowDays,
    minSupport,
  ) as Array<{
    from_topic: string;
    to_topic: string;
    support: number;
    avg_lag_days: number;
    avg_min_sources: number;
    lift: number;
    confidence: number;
    lag_stddev: number | null;
    most_recent_day: string;
    trigger_base_rate: number;
    trigger_weekday_ratio: number;
    target_weekday_ratio: number;
  }>;

  if (chainRows.length === 0) return [];

  const nowDate = new Date();
  const nowJulian = julianDay(nowDate);

  // Normalize source_diversity to 0-1
  const maxMinSources = Math.max(...chainRows.map((r) => r.avg_min_sources));

  // Determine which topics are currently spiking (volume >= 3 in last 24h)
  const spikeSql = `
    SELECT et.topic, ${volumeExpr} AS volume
    FROM event_topics et JOIN events e ON e.event_id = et.event_id
    WHERE ${PUB_TS} >= ?
    GROUP BY et.topic
    HAVING volume >= 3
  `;
  const spikeRows = db.prepare(spikeSql).all(sinceISO(86_400_000)) as Array<{
    topic: string;
    volume: number;
  }>;
  const spiking = new Set(spikeRows.map((r) => r.topic));

  // Tiered activation: also include topics with strong 7d acceleration
  for (const lc of lifecycles) {
    if ((lc.accelerations['7d'] ?? 0) > 1.0) spiking.add(lc.topic);
  }

  const chainList = chainRows.map((row) => {
    // Exponential decay: weight support by recency of most recent co-occurrence
    const recentJulian = julianDay(new Date(row.most_recent_day + 'T00:00:00Z'));
    const daysSinceRecent = Math.max(0, nowJulian - recentJulian);
    const decayFactor = Math.exp(-DECAY_LAMBDA * daysSinceRecent);

    // Temporal artifact detection: if both trigger and target spike predominantly
    // on weekdays (Mon-Fri) with >85% ratio, the chain is likely a calendar cadence.
    const trigWd = row.trigger_weekday_ratio ?? 0;
    const tgtWd = row.target_weekday_ratio ?? 0;
    const temporalPattern: 'weekday_correlated' | undefined =
      trigWd > 0.85 && tgtWd > 0.85 ? 'weekday_correlated' : undefined;

    return {
      from_topic: row.from_topic,
      to_topic: row.to_topic,
      support: row.support,
      avg_lag_days: Math.round(row.avg_lag_days * 10) / 10,
      source_diversity: maxMinSources > 0
        ? Math.round((row.avg_min_sources / maxMinSources) * 100) / 100
        : 0,
      active: spiking.has(row.from_topic),
      lift: Math.round((row.lift ?? 0) * 100) / 100,
      confidence: Math.round(Math.min(row.confidence ?? 0, 1) * 100) / 100,
      directionality: 1.0, // placeholder, computed below
      lag_stddev: Math.round((row.lag_stddev ?? 0) * 100) / 100,
      decay_weighted_support: Math.round(row.support * decayFactor * 100) / 100,
      trigger_base_rate: Math.round((row.trigger_base_rate ?? 0) * 100) / 100,
      ...(temporalPattern ? { temporal_pattern: temporalPattern } : {}),
    };
  });

  // Compute directionality: support(A→B) / (support(A→B) + support(B→A))
  const supportLookup = new Map<string, number>();
  for (const c of chainList) {
    supportLookup.set(`${c.from_topic}→${c.to_topic}`, c.support);
  }
  for (const c of chainList) {
    const forward = supportLookup.get(`${c.from_topic}→${c.to_topic}`) ?? 0;
    const reverse = supportLookup.get(`${c.to_topic}→${c.from_topic}`) ?? 0;
    c.directionality = reverse === 0
      ? 1.0
      : Math.round((forward / (forward + reverse)) * 100) / 100;
  }

  return chainList;
}

/* ── B2. Transitive chain detection ────────────────────────────────── */

function detectTransitiveChains(chains: ChainItem[]): TransitiveChainItem[] {
  // Build adjacency: from_topic → list of chains
  const adj = new Map<string, ChainItem[]>();
  for (const c of chains) {
    const list = adj.get(c.from_topic);
    if (list) list.push(c);
    else adj.set(c.from_topic, [c]);
  }

  const results: TransitiveChainItem[] = [];

  for (const ab of chains) {
    const bcList = adj.get(ab.to_topic);
    if (!bcList) continue;
    for (const bc of bcList) {
      // Skip loops: A→B→A
      if (bc.to_topic === ab.from_topic) continue;

      const path = [ab.from_topic, ab.to_topic, bc.to_topic];
      const total_lag_days = Math.round((ab.avg_lag_days + bc.avg_lag_days) * 10) / 10;
      const min_support = Math.min(ab.support, bc.support);
      const combined_lift = Math.round(ab.lift * bc.lift * 100) / 100;
      const cross_domain = path[0].split('.')[0] !== path[path.length - 1].split('.')[0];

      results.push({ path, total_lag_days, min_support, combined_lift, cross_domain });
    }
  }

  // Sort by combined_lift descending, then apply per-prefix diversity cap.
  // Without this, a single high-lift A→B prefix can dominate all top results
  // (e.g., 5 variations of aws.bedrock→hw.chip→*).
  results.sort((a, b) => b.combined_lift - a.combined_lift);

  const prefixCounts = new Map<string, number>();
  const diversified: TransitiveChainItem[] = [];
  for (const tc of results) {
    const prefix = `${tc.path[0]}→${tc.path[1]}`;
    const count = prefixCounts.get(prefix) ?? 0;
    if (count >= MAX_TRANSITIVE_PER_PREFIX) continue;
    prefixCounts.set(prefix, count + 1);
    diversified.push(tc);
    if (diversified.length >= 100) break;
  }

  return diversified;
}

/* ── D. Multiscale convergence ──────────────────────────────────────── */

function buildMultiscaleView(lifecycles: LifecycleItem[]): MultiscaleItem[] {
  return lifecycles.map((lc) => {
    const d1 = lc.accelerations['1d'] ?? 0;
    const d7 = lc.accelerations['7d'] ?? 0;
    const d30 = lc.accelerations['30d'] ?? 0;

    // Use d7 as proxy for short-term when d1 is dead
    const short = Math.abs(d1) >= 0.1 ? d1 : d7;

    let alignment: MultiscaleItem['alignment'];
    if (short > 0 && d7 > 0 && d30 > 0) {
      alignment = 'aligned_up';
    } else if (short < 0 && d7 < 0 && d30 < 0) {
      alignment = 'aligned_down';
    } else if ((short > 0 && d30 < 0) || (short < 0 && d30 > 0)) {
      alignment = 'diverging';
    } else if ((short > 0 && d7 < 0) || (short < 0 && d7 > 0)) {
      alignment = 'transitioning';
    } else {
      // All near zero or mixed without clear divergence
      alignment = 'aligned_up'; // treat zero/zero as neutral-up
    }

    return {
      topic: lc.topic,
      alignment,
      d1_accel: d1,
      d7_accel: d7,
      d30_accel: d30,
    };
  });
}

/* ── E. Ranked chains ──────────────────────────────────────────────── */

function computeRankedChains(
  chains: ChainItem[],
  lifecycles: LifecycleItem[],
): RankedChainItem[] {
  const activeChains = chains.filter((c) => c.active);
  if (activeChains.length === 0) return [];

  // Build acceleration lookup (prefer d1, fallback to d7)
  const accelMap = new Map<string, number>();
  for (const lc of lifecycles) {
    const d1 = lc.accelerations['1d'] ?? 0;
    const d7 = lc.accelerations['7d'] ?? 0;
    accelMap.set(lc.topic, Math.abs(d1) >= 0.1 ? d1 : d7);
  }

  const ranked: RankedChainItem[] = activeChains.map((chain) => {
    const accel = Math.max(0, accelMap.get(chain.from_topic) ?? 0);
    // Base-rate discount: omnipresent triggers (base_rate > 0.5) get penalized
    // so high-base-rate topics like lang.typescript don't dominate rankings.
    const baseRateDiscount = 1 / (1 + Math.max(0, chain.trigger_base_rate - 0.5) * 3);
    const score =
      Math.round(chain.support * chain.source_diversity * chain.lift * chain.confidence * (1 + accel) * baseRateDiscount * 100) / 100;
    const cross_domain =
      chain.from_topic.split('.')[0] !== chain.to_topic.split('.')[0];
    return { ...chain, score, cross_domain };
  });

  // Sort: cross-domain first, then by score descending
  ranked.sort((a, b) => {
    if (a.cross_domain !== b.cross_domain) return a.cross_domain ? -1 : 1;
    return b.score - a.score;
  });

  // Per-trigger cap: ensure diverse trigger representation in results.
  // After sorting by score, keep at most MAX_RANKED_PER_TRIGGER per trigger.
  const triggerCounts = new Map<string, number>();
  const diversified: RankedChainItem[] = [];
  for (const rc of ranked) {
    const count = triggerCounts.get(rc.from_topic) ?? 0;
    if (count >= MAX_RANKED_PER_TRIGGER) continue;
    triggerCounts.set(rc.from_topic, count + 1);
    diversified.push(rc);
    if (diversified.length >= 50) break;
  }

  return diversified;
}

/* ── F. Entropy-based surprise scoring ─────────────────────────────── */

function computeEntropy(
  db: Database.Database,
  windowStart: string,
  useDedup: boolean,
): EntropyItem[] {
  const volumeExpr = useDedup
    ? 'COUNT(DISTINCT COALESCE(e.canonical_url, e.event_id))'
    : 'COUNT(*)';

  const sql = `
    SELECT et.topic, ${PUB_DAY} AS day, ${volumeExpr} AS volume
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE ${PUB_TS} >= ?
    GROUP BY et.topic, ${PUB_DAY}
  `;
  const rows = db.prepare(sql).all(windowStart) as Array<{
    topic: string;
    day: string;
    volume: number;
  }>;

  // Group by topic
  const byTopic = new Map<string, number[]>();
  for (const r of rows) {
    const arr = byTopic.get(r.topic);
    if (arr) arr.push(r.volume);
    else byTopic.set(r.topic, [r.volume]);
  }

  const results: EntropyItem[] = [];
  for (const [topic, volumes] of byTopic) {
    const totalVolume = volumes.reduce((a, b) => a + b, 0);
    if (totalVolume === 0) continue;

    // Shannon entropy: H = -Σ p_i × log2(p_i)
    let entropy = 0;
    for (const v of volumes) {
      if (v > 0) {
        const p = v / totalVolume;
        entropy -= p * Math.log2(p);
      }
    }

    const activeDays = volumes.length;
    // Normalize: max entropy = log2(active_days) for uniform distribution
    const maxEntropy = activeDays > 1 ? Math.log2(activeDays) : 1;
    const normalizedEntropy = Math.round((entropy / maxEntropy) * 100) / 100;

    results.push({
      topic,
      entropy: Math.round(entropy * 1000) / 1000,
      normalized_entropy: normalizedEntropy,
      active_days: activeDays,
    });
  }

  return results;
}

/* ── F2. Systems dynamics detection ────────────────────────────────── */

/** Maximum dynamics entries per type. Keeps output manageable for synthesis. */
const MAX_DYNAMICS_PER_TYPE = 10;

export function detectDynamics(
  chains: ChainItem[],
  lifecycles: LifecycleItem[],
  multiscale: MultiscaleItem[],
  entropy: EntropyItem[],
  maxPerType: number = MAX_DYNAMICS_PER_TYPE,
  freshTopics?: Set<string>,
): DynamicItem[] {
  // Rank each type by signal strength, then cap
  const loops = detectReinforcingLoops(chains);
  loops.sort((a, b) => (b.metric.secondary_value ?? 0) - (a.metric.secondary_value ?? 0)); // by mutual lift

  const delays = detectDelays(chains);
  delays.sort((a, b) => (a.metric.secondary_value ?? Infinity) - (b.metric.secondary_value ?? Infinity)); // by tightest lag_stddev

  const accum = detectAccumulations(lifecycles, multiscale, entropy, freshTopics);
  accum.sort((a, b) => b.metric.value - a.metric.value); // by normalized_entropy

  const damp = detectDampening(lifecycles);
  damp.sort((a, b) => a.metric.value - b.metric.value); // by most recent change point

  return [
    ...loops.slice(0, maxPerType),
    ...delays.slice(0, maxPerType),
    ...accum.slice(0, maxPerType),
    ...damp.slice(0, maxPerType),
  ];
}

function detectReinforcingLoops(chains: ChainItem[]): DynamicItem[] {
  const lookup = new Map<string, ChainItem>();
  for (const c of chains) {
    lookup.set(`${c.from_topic}→${c.to_topic}`, c);
  }

  const seen = new Set<string>();
  const results: DynamicItem[] = [];

  for (const c of chains) {
    if (c.directionality < 0.3 || c.directionality > 0.7) continue;
    if (c.lift <= 1) continue;

    const reverseKey = `${c.to_topic}→${c.from_topic}`;
    const reverse = lookup.get(reverseKey);
    if (!reverse || reverse.lift <= 1) continue;

    const pairKey = [c.from_topic, c.to_topic].sort().join('↔');
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    const mutualLift = Math.round(Math.min(c.lift, reverse.lift) * 100) / 100;
    results.push({
      type: 'reinforcing_loop',
      topics: [c.from_topic, c.to_topic],
      metric: { name: 'directionality', value: c.directionality, secondary_value: mutualLift },
      interpretation: `${c.from_topic} and ${c.to_topic} amplify each other (directionality ${c.directionality}, mutual lift ${mutualLift}x)`,
    });
  }

  return results;
}

function detectDelays(chains: ChainItem[]): DynamicItem[] {
  return chains
    .filter((c) => c.active && c.avg_lag_days >= 0.5)
    .map((c) => ({
      type: 'delay' as const,
      topics: [c.from_topic, c.to_topic],
      metric: { name: 'avg_lag_days', value: c.avg_lag_days, secondary_value: c.lag_stddev },
      interpretation: `When ${c.from_topic} spikes, ${c.to_topic} follows in ${c.avg_lag_days}±${c.lag_stddev} days`,
    }));
}

function detectAccumulations(
  lifecycles: LifecycleItem[],
  multiscale: MultiscaleItem[],
  entropy: EntropyItem[],
  freshTopics?: Set<string>,
): DynamicItem[] {
  const msMap = new Map<string, MultiscaleItem>();
  for (const ms of multiscale) msMap.set(ms.topic, ms);

  const entMap = new Map<string, EntropyItem>();
  for (const e of entropy) entMap.set(e.topic, e);

  const results: DynamicItem[] = [];

  for (const lc of lifecycles) {
    if (lc.phase !== 'emerging' && lc.phase !== 'accelerating') continue;

    // Freshness gate: skip topics whose events are all fetched_at fallback
    // (no published_at in the analysis window). These may be backfill artifacts
    // where old content was bulk-ingested recently, creating a false volume spike.
    if (freshTopics && !freshTopics.has(lc.topic)) continue;

    const ms = msMap.get(lc.topic);
    if (!ms || ms.alignment !== 'aligned_up') continue;

    const ent = entMap.get(lc.topic);
    if (!ent || ent.normalized_entropy <= 0.5) continue;

    results.push({
      type: 'accumulation',
      topics: [lc.topic],
      metric: { name: 'normalized_entropy', value: ent.normalized_entropy },
      interpretation: `${lc.topic} is ${lc.phase} with all timescales aligned upward and rising entropy — pressure is accumulating`,
    });
  }

  return results;
}

function detectDampening(lifecycles: LifecycleItem[]): DynamicItem[] {
  const results: DynamicItem[] = [];

  for (const lc of lifecycles) {
    if (lc.phase !== 'decaying') continue;

    const recentCps = lc.change_points.filter((cp) => cp <= 14);
    if (recentCps.length === 0) continue;

    const mostRecent = Math.min(...recentCps);
    results.push({
      type: 'dampening',
      topics: [lc.topic],
      metric: { name: 'change_point_days_ago', value: mostRecent },
      interpretation: `${lc.topic} had a structural break ${mostRecent} days ago and is now decaying — a balancing force may be dampening this signal`,
    });
  }

  return results;
}

/* ── G. CUSUM change-point detection ──────────────────────────────── */

function detectChangePoints(
  db: Database.Database,
  windowStart: string,
  useDedup: boolean,
): Map<string, number[]> {
  const volumeExpr = useDedup
    ? 'COUNT(DISTINCT COALESCE(e.canonical_url, e.event_id))'
    : 'COUNT(*)';

  const sql = `
    SELECT et.topic, ${PUB_DAY} AS day, ${volumeExpr} AS volume
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE ${PUB_TS} >= ?
    GROUP BY et.topic, ${PUB_DAY}
    ORDER BY et.topic, day
  `;
  const rows = db.prepare(sql).all(windowStart) as Array<{
    topic: string;
    day: string;
    volume: number;
  }>;

  // Group daily volumes by topic (ordered by day)
  const byTopic = new Map<string, Array<{ day: string; volume: number }>>();
  for (const r of rows) {
    const arr = byTopic.get(r.topic);
    if (arr) arr.push({ day: r.day, volume: r.volume });
    else byTopic.set(r.topic, [{ day: r.day, volume: r.volume }]);
  }

  const today = new Date();
  const result = new Map<string, number[]>();

  for (const [topic, dayVolumes] of byTopic) {
    if (dayVolumes.length < 3) {
      result.set(topic, []);
      continue;
    }

    const volumes = dayVolumes.map((d) => d.volume);
    const mean = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const variance =
      volumes.reduce((a, v) => a + (v - mean) ** 2, 0) / volumes.length;
    const stddev = Math.sqrt(variance);

    if (stddev < 0.01) {
      result.set(topic, []);
      continue;
    }

    const k = CUSUM_K_SIGMA * stddev;
    const h = CUSUM_H_SIGMA * stddev;
    const changePoints: number[] = [];

    // Upper CUSUM (detects upward shifts)
    let sUp = 0;
    // Lower CUSUM (detects downward shifts)
    let sDown = 0;

    for (let i = 0; i < volumes.length; i++) {
      sUp = Math.max(0, sUp + (volumes[i] - mean) - k);
      sDown = Math.max(0, sDown - (volumes[i] - mean) - k);

      if (sUp > h || sDown > h) {
        // Change point detected — compute day offset from today
        const dayDate = new Date(dayVolumes[i].day + 'T00:00:00Z');
        const offset = Math.round(
          (today.getTime() - dayDate.getTime()) / 86_400_000,
        );
        changePoints.push(offset);
        // Reset after detection
        sUp = 0;
        sDown = 0;
      }
    }

    result.set(topic, changePoints);
  }

  return result;
}

/* ── H. HMM-style probabilistic phase classifier ─────────────────── */

/** Gaussian log-probability density. */
function gaussianLogPdf(x: number, mean: number, stddev: number): number {
  const z = (x - mean) / stddev;
  return -0.5 * Math.log(2 * Math.PI) - Math.log(stddev) - 0.5 * z * z;
}

/**
 * Compute posterior probability of each phase given observed accelerations.
 * Uses Gaussian emission model with uniform prior across phases.
 */
function classifyPhaseHMM(
  accels: Record<string, number>,
): { phase: LifecycleItem['phase']; confidence: number; probabilities: Record<string, number> } {
  const phases = Object.keys(PHASE_EMISSIONS) as LifecycleItem['phase'][];
  const logLikelihoods: Record<string, number> = {};

  for (const phase of phases) {
    const { means, stddev } = PHASE_EMISSIONS[phase];
    let logLik = 0;
    for (const w of ['1d', '7d', '14d', '30d']) {
      const observed = accels[w] ?? 0;
      logLik += gaussianLogPdf(observed, means[w], stddev);
    }
    logLikelihoods[phase] = logLik;
  }

  // Convert log-likelihoods to probabilities via log-sum-exp
  const maxLogLik = Math.max(...Object.values(logLikelihoods));
  const expValues: Record<string, number> = {};
  let sumExp = 0;
  for (const phase of phases) {
    const e = Math.exp(logLikelihoods[phase] - maxLogLik);
    expValues[phase] = e;
    sumExp += e;
  }

  const probabilities: Record<string, number> = {};
  let bestPhase: LifecycleItem['phase'] = 'stable';
  let bestProb = 0;
  for (const phase of phases) {
    const prob = Math.round((expValues[phase] / sumExp) * 1000) / 1000;
    probabilities[phase] = prob;
    if (prob > bestProb) {
      bestProb = prob;
      bestPhase = phase;
    }
  }

  return { phase: bestPhase, confidence: bestProb, probabilities };
}

/* ── J. Bayesian scenario projection ──────────────────────────────── */

function projectScenariosBayesian(
  db: Database.Database,
  chains: ChainItem[],
  lifecycles: LifecycleItem[],
  entropyItems: EntropyItem[],
  windowStart: string,
  topN: number,
  useDedup: boolean,
): ScenarioItem[] {
  // Filter: active chains with above-chance lift
  const activeChains = chains.filter((c) => c.active && c.lift >= 1.5);
  if (activeChains.length === 0) return [];

  // Compute base rates: P(topic spikes on any given day)
  // Use spike_days / total_days from chain data (approximate from lifecycles)
  const volumeExpr = useDedup
    ? 'COUNT(DISTINCT COALESCE(e.canonical_url, e.event_id))'
    : 'COUNT(*)';
  const baseRateSql = `
    WITH daily_volumes AS (
      SELECT et.topic, ${PUB_DAY} AS day, ${volumeExpr} AS volume
      FROM event_topics et JOIN events e ON e.event_id = et.event_id
      WHERE ${PUB_TS} >= ?
      GROUP BY et.topic, ${PUB_DAY}
      HAVING volume >= 3
    ),
    total_window AS (
      SELECT COUNT(DISTINCT ${PUB_DAY}) AS total_days
      FROM events e WHERE ${PUB_TS} >= ?
    )
    SELECT dv.topic,
           COUNT(DISTINCT dv.day) AS spike_days,
           tw.total_days
    FROM daily_volumes dv CROSS JOIN total_window tw
    GROUP BY dv.topic
  `;
  const baseRateRows = db.prepare(baseRateSql).all(
    windowStart,
    windowStart,
  ) as Array<{ topic: string; spike_days: number; total_days: number }>;

  const baseRates = new Map<string, number>();
  for (const r of baseRateRows) {
    baseRates.set(r.topic, r.total_days > 0 ? r.spike_days / r.total_days : 0.1);
  }

  // Entropy lookup for target topics
  const entropyMap = new Map<string, number>();
  for (const e of entropyItems) {
    entropyMap.set(e.topic, e.normalized_entropy);
  }

  // CUSUM: build lookup of most recent change point per topic (days ago)
  const recentCpMap = new Map<string, number>();
  for (const lc of lifecycles) {
    if (lc.change_points.length > 0) {
      recentCpMap.set(lc.topic, Math.min(...lc.change_points));
    }
  }

  // Compute trigger fan-out: how many distinct targets each trigger reaches.
  // High-fanout triggers (chain to everything) are less informative than
  // targeted ones, so we penalize them in the posterior.
  const triggerFanout = new Map<string, number>();
  for (const chain of activeChains) {
    triggerFanout.set(chain.from_topic, (triggerFanout.get(chain.from_topic) ?? 0) + 1);
  }

  // Bayesian aggregation: for each target, posterior ∝ prior × ∏(signal_i)
  // where signal_i incorporates lift, decay, confidence, source diversity,
  // and trigger fanout penalty.
  // Pre-sort chains per target by effective signal so we can cap at MAX_CHAINS_PER_TARGET
  // to prevent posterior saturation when many triggers are simultaneously active.
  const chainsByTarget = new Map<string, Array<{
    chain: typeof activeChains[0];
    effectiveSignal: number;
    lagMin: number;
    lagMax: number;
  }>>();

  for (const chain of activeChains) {
    const stddev = chain.lag_stddev || 0;
    const lagMin = Math.max(0, chain.avg_lag_days - 2 * stddev);
    const lagMax = chain.avg_lag_days + 2 * stddev;

    // Use decay-weighted lift as the base likelihood ratio
    const decayRatio = chain.support > 0
      ? chain.decay_weighted_support / chain.support
      : 1;
    let effectiveLift = chain.lift * decayRatio;

    // CUSUM discount: if trigger or target had a recent structural break,
    // historical co-movement patterns may not hold. Linearly discount
    // from full strength at the horizon to half strength at day 0.
    const fromCp = recentCpMap.get(chain.from_topic);
    const toCp = recentCpMap.get(chain.to_topic);
    const mostRecentCp = Math.min(fromCp ?? Infinity, toCp ?? Infinity);
    if (mostRecentCp < CUSUM_DISCOUNT_HORIZON_DAYS) {
      const cpDiscount = 0.5 + 0.5 * (mostRecentCp / CUSUM_DISCOUNT_HORIZON_DAYS);
      effectiveLift *= cpDiscount;
    }

    // Enrich signal with confidence and source diversity so chains with
    // stronger evidence produce higher posteriors and differentiate scenarios.
    const confidenceFactor = Math.sqrt(Math.max(chain.confidence, 0.01));
    const diversityFactor = Math.sqrt(Math.max(chain.source_diversity, 0.01));

    // Fanout penalty: triggers that chain to many targets are less informative
    // than targeted ones. Uses inverse-log to smoothly penalize high fanout.
    const fanout = triggerFanout.get(chain.from_topic) ?? 1;
    const fanoutPenalty = 1 / Math.log2(1 + fanout);

    const effectiveSignal = effectiveLift * confidenceFactor * diversityFactor * fanoutPenalty;

    const existing = chainsByTarget.get(chain.to_topic);
    const entry = { chain, effectiveSignal, lagMin, lagMax };
    if (existing) {
      existing.push(entry);
    } else {
      chainsByTarget.set(chain.to_topic, [entry]);
    }
  }

  const targetMap = new Map<
    string,
    {
      logPosterior: number;
      triggerContributions: Map<string, number>;
      chainCount: number;
      avgLagMin: number;
      avgLagMax: number;
    }
  >();

  for (const [target, entries] of chainsByTarget) {
    // Sort by effective signal descending, keep only top N chains per target
    entries.sort((a, b) => b.effectiveSignal - a.effectiveSignal);
    const capped = entries.slice(0, MAX_CHAINS_PER_TARGET);

    const prior = baseRates.get(target) ?? 0.05;
    let logPosterior = Math.log(prior);
    const triggerContributions = new Map<string, number>();
    let avgLagMin = Infinity;
    let avgLagMax = -Infinity;

    for (const { chain, effectiveSignal, lagMin, lagMax } of capped) {
      logPosterior += Math.log(Math.max(effectiveSignal, 1.01));
      // Track max contribution per trigger for sorting
      const existing = triggerContributions.get(chain.from_topic) ?? 0;
      triggerContributions.set(chain.from_topic, Math.max(existing, effectiveSignal));
      avgLagMin = Math.min(avgLagMin, lagMin);
      avgLagMax = Math.max(avgLagMax, lagMax);
    }

    targetMap.set(target, {
      logPosterior,
      triggerContributions,
      chainCount: capped.length,
      avgLagMin,
      avgLagMax,
    });
  }

  // Convert log-posteriors to normalized probabilities via temperature-scaled softmax.
  // Temperature < 1.0 sharpens the distribution so top scenarios stand out.
  // This produces a proper probability distribution that sums to 1.0.
  const entries = [...targetMap.entries()];
  const maxLogPost = Math.max(...entries.map(([, d]) => d.logPosterior));

  // Compute softmax denominator: Σ exp((logPost_i - maxLogPost) / T)
  let softmaxSum = 0;
  for (const [, data] of entries) {
    softmaxSum += Math.exp((data.logPosterior - maxLogPost) / SOFTMAX_TEMPERATURE);
  }

  // Fetch evidence titles with topic_count for relevance scoring.
  // Events assigned to fewer topics have more specific classification,
  // so their titles are more likely genuinely relevant to the target topic.
  const titleSql = `
    SELECT e.title,
           (SELECT COUNT(*) FROM event_topics et2 WHERE et2.event_id = e.event_id) AS topic_count
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE et.topic = ? AND ${PUB_TS} >= ?
    ORDER BY e.score DESC, ${PUB_TS} DESC
    LIMIT ?
  `;
  const titleStmt = db.prepare(titleSql);

  const scenarios: ScenarioItem[] = [];
  for (const [target, data] of entries) {
    // Temperature-scaled softmax: exp((logPost - max) / T) / Σexp((logPost_i - max) / T)
    const probability = Math.round(
      (Math.exp((data.logPosterior - maxLogPost) / SOFTMAX_TEMPERATURE) / softmaxSum) * 100,
    ) / 100;

    const titleRows = titleStmt.all(
      target,
      windowStart,
      MAX_TITLES_PER_SCENARIO,
    ) as Array<{ title: string | null; topic_count: number }>;

    const evidenceEntries = titleRows
      .map((r) => ({
        text: sanitizeSnippet(r.title, { maxLength: 200 }).text,
        relevance: (r.topic_count <= 2 ? 'high' : r.topic_count <= 4 ? 'medium' : 'low') as 'high' | 'medium' | 'low',
      }))
      .filter((e) => e.text.length > 0);
    const evidenceTitles = evidenceEntries.map((e) => e.text);
    const evidenceRelevance = evidenceEntries.map((e) => e.relevance);

    // Entropy-widened timeframe: bursty targets get wider prediction windows.
    // entropyFactor ranges from 1.0 (perfectly predictable) to 2.0 (max entropy).
    const targetEnt = entropyMap.get(target) ?? 0;
    const entropyFactor = 1 + targetEnt;
    const center = (data.avgLagMin + data.avgLagMax) / 2;
    const halfWidth = (data.avgLagMax - data.avgLagMin) / 2;
    const widenedMin = Math.max(0, center - halfWidth * entropyFactor);
    const widenedMax = center + halfWidth * entropyFactor;

    // Sort trigger topics by their contribution to this specific target's
    // posterior (strongest first), so triggers differ per scenario.
    const sortedTriggers = [...data.triggerContributions.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([topic]) => topic);

    scenarios.push({
      target_topic: target,
      probability,
      timeframe_days: [
        Math.round(widenedMin * 10) / 10,
        Math.round(widenedMax * 10) / 10,
      ],
      trigger_topics: sortedTriggers,
      supporting_chains: data.chainCount,
      evidence_titles: evidenceTitles,
      evidence_relevance: evidenceRelevance,
      target_entropy: targetEnt,
    });
  }

  // Pre-filter: drop scenarios where ALL evidence is topically unrelated
  // (all 'low' relevance). This catches cases where the classifier misfired
  // on every supporting event — the scenario has no genuine evidence.
  const filtered = scenarios.filter(s =>
    s.evidence_relevance.length === 0 ||
    s.evidence_relevance.some(r => r !== 'low'),
  );

  // Sort by probability descending, take top N
  filtered.sort((a, b) => b.probability - a.probability);
  return filtered.slice(0, topN);
}

/* ── Context inlining (--with-context) ─────────────────────────────── */

/** Max titles per topic in the context section. */
const CONTEXT_TITLES_PER_TOPIC = 3;

function buildTopicContext(
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

/** sinceISO with optional explicit `now` for deterministic window alignment. */
function sinceISO(durationMs: number, now?: number): string {
  if (now === undefined) return _sinceISO(durationMs);
  return formatISO(new Date(now - durationMs));
}

/** Convert a Date to a Julian day number (for age calculations matching SQL JULIANDAY). */
function julianDay(d: Date): number {
  return d.getTime() / 86_400_000 + 2_440_587.5;
}
