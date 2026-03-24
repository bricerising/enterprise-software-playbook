import type Database from 'better-sqlite3';
import type { ChainItem, TransitiveChainItem, RankedChainItem, LifecycleItem, MultiscaleItem, ConfidenceTier } from './types.js';
import {
  PUB_TS, PUB_DAY,
  DECAY_LAMBDA,
  MAX_TRANSITIVE_PER_PREFIX, MAX_RANKED_PER_TRIGGER,
  MIN_CHAIN_TOPIC_EVENTS,
  CHAIN_TIER_HIGH_VOLUME, CHAIN_TIER_HIGH_DIVERSITY, CHAIN_TIER_HIGH_SUPPORT,
  CHAIN_TIER_MODERATE_VOLUME, CHAIN_TIER_MODERATE_DIVERSITY, CHAIN_TIER_MODERATE_SUPPORT,
  sinceISO, julianDay,
} from './types.js';

/* ── B. Chain detection ─────────────────────────────────────────────── */

export function detectChains(
  db: Database.Database,
  windowStart: string,
  lagWindowDays: number,
  minSupport: number,
  useDedup: boolean,
  lifecycles: LifecycleItem[],
  topicCounts?: Map<string, number>,
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
    LIMIT 500
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
    // on weekdays (Mon-Fri) with >75% ratio, the chain is likely a calendar cadence.
    const trigWd = row.trigger_weekday_ratio ?? 0;
    const tgtWd = row.target_weekday_ratio ?? 0;
    const weekdayRatio = Math.round(((trigWd + tgtWd) / 2) * 100) / 100;
    const temporalPattern: 'weekday_correlated' | undefined =
      trigWd > 0.75 && tgtWd > 0.75 ? 'weekday_correlated' : undefined;

    const chainItem: ChainItem = {
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
      weekday_ratio: weekdayRatio,
      confidence_tier: 'low', // provisional; assigned below
    };
    return chainItem;
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

  // Assign confidence tiers based on topic volume, source diversity, and support
  if (topicCounts) {
    for (const c of chainList) {
      c.confidence_tier = assignConfidenceTier(c, topicCounts);
    }
  }

  return chainList;
}

/* ── Spec 014 §B: Chain confidence tier assignment ─────────────────── */

export function assignConfidenceTier(
  chain: ChainItem,
  topicCounts: Map<string, number>,
): ConfidenceTier {
  const fromCount = topicCounts.get(chain.from_topic) ?? 0;
  const toCount = topicCounts.get(chain.to_topic) ?? 0;
  const minCount = Math.min(fromCount, toCount);

  if (minCount < MIN_CHAIN_TOPIC_EVENTS) return 'spurious';

  if (
    minCount >= CHAIN_TIER_HIGH_VOLUME &&
    chain.source_diversity >= CHAIN_TIER_HIGH_DIVERSITY &&
    chain.support >= CHAIN_TIER_HIGH_SUPPORT
  ) return 'high';

  if (
    minCount >= CHAIN_TIER_MODERATE_VOLUME &&
    chain.source_diversity >= CHAIN_TIER_MODERATE_DIVERSITY &&
    chain.support >= CHAIN_TIER_MODERATE_SUPPORT
  ) return 'moderate';

  return 'low';
}

/* ── B2. Transitive chain detection ────────────────────────────────── */

export function detectTransitiveChains(chains: ChainItem[]): TransitiveChainItem[] {
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
      // Geometric mean of leg confidences — calibrated [0,1] metric
      // that penalizes chains where one leg has weak confidence.
      const normalized_confidence = Math.round(
        Math.sqrt(ab.confidence * bc.confidence) * 100,
      ) / 100;

      results.push({ path, total_lag_days, min_support, combined_lift, cross_domain, normalized_confidence });
    }
  }

  // Sort by combined_lift descending, then apply per-prefix diversity cap.
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

export function buildMultiscaleView(lifecycles: LifecycleItem[]): MultiscaleItem[] {
  return lifecycles.map((lc) => {
    const d1 = lc.accelerations['1d'] ?? 0;
    const d7 = lc.accelerations['7d'] ?? 0;
    const d30 = lc.accelerations['30d'] ?? 0;
    const d90 = lc.accelerations['90d'] ?? 0;

    // Use d7 as proxy for short-term when d1 is dead
    const short = Math.abs(d1) >= 0.1 ? d1 : d7;
    // Use d90 as long-term signal when available, fall back to d30
    const long = Math.abs(d90) >= 0.05 ? d90 : d30;

    let alignment: MultiscaleItem['alignment'];
    if (short > 0 && d7 > 0 && long > 0) {
      alignment = 'aligned_up';
    } else if (short < 0 && d7 < 0 && long < 0) {
      alignment = 'aligned_down';
    } else if ((short > 0 && long < 0) || (short < 0 && long > 0)) {
      alignment = 'diverging';
    } else if ((short > 0 && d7 < 0) || (short < 0 && d7 > 0)) {
      alignment = 'transitioning';
    } else {
      // All near zero or mixed without clear divergence — treat as stable/down
      // to avoid false accumulation signals from inactive topics
      alignment = 'aligned_down';
    }

    return {
      topic: lc.topic,
      alignment,
      d1_accel: d1,
      d7_accel: d7,
      d30_accel: d30,
      d90_accel: d90,
    };
  });
}

/* ── E. Ranked chains ──────────────────────────────────────────────── */

export function computeRankedChains(
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
