import type Database from 'better-sqlite3';
import type { ChainItem, LifecycleItem, EntropyItem, ScenarioItem, ConfidenceTier } from './types.js';
import {
  PUB_TS, PUB_DAY,
  MAX_TITLES_PER_SCENARIO, MAX_CHAINS_PER_TARGET,
  CUSUM_DISCOUNT_HORIZON_DAYS, SOFTMAX_TEMPERATURE,
  SCENARIO_DECIMAL_PLACES,
  sanitizeSnippet,
} from './types.js';

/* ── Spec 014 §C: Worst-tier utility ──────────────────────────────── */

const tierOrder: Record<ConfidenceTier, number> = {
  spurious: 0, low: 1, moderate: 2, high: 3,
};

export function worstTier(tiers: ConfidenceTier[]): ConfidenceTier {
  if (tiers.length === 0) {
    return 'spurious';
  }
  return tiers.reduce((worst, t) =>
    tierOrder[t] < tierOrder[worst] ? t : worst,
  );
}

/* ── J. Bayesian scenario projection ──────────────────────────────── */

export function projectScenariosBayesian(
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
  const triggerFanout = new Map<string, number>();
  for (const chain of activeChains) {
    triggerFanout.set(chain.from_topic, (triggerFanout.get(chain.from_topic) ?? 0) + 1);
  }

  // Bayesian aggregation: for each target, posterior ∝ prior × ∏(signal_i)
  // Pre-sort chains per target by effective signal so we can cap at MAX_CHAINS_PER_TARGET
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
    // historical co-movement patterns may not hold.
    const fromCp = recentCpMap.get(chain.from_topic);
    const toCp = recentCpMap.get(chain.to_topic);
    const mostRecentCp = Math.min(fromCp ?? Infinity, toCp ?? Infinity);
    if (mostRecentCp < CUSUM_DISCOUNT_HORIZON_DAYS) {
      const cpDiscount = 0.5 + 0.5 * (mostRecentCp / CUSUM_DISCOUNT_HORIZON_DAYS);
      effectiveLift *= cpDiscount;
    }

    // Enrich signal with confidence and source diversity
    const confidenceFactor = Math.sqrt(Math.max(chain.confidence, 0.01));
    const diversityFactor = Math.sqrt(Math.max(chain.source_diversity, 0.01));

    // Fanout penalty: triggers that chain to many targets are less informative
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
      contributingChainTiers: ConfidenceTier[];
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
    const contributingChainTiers: ConfidenceTier[] = [];

    for (const { chain, effectiveSignal, lagMin, lagMax } of capped) {
      logPosterior += Math.log(Math.max(effectiveSignal, 1.01));
      const existing = triggerContributions.get(chain.from_topic) ?? 0;
      triggerContributions.set(chain.from_topic, Math.max(existing, effectiveSignal));
      avgLagMin = Math.min(avgLagMin, lagMin);
      avgLagMax = Math.max(avgLagMax, lagMax);
      contributingChainTiers.push(chain.confidence_tier);
    }

    targetMap.set(target, {
      logPosterior,
      triggerContributions,
      chainCount: capped.length,
      avgLagMin,
      avgLagMax,
      contributingChainTiers,
    });
  }

  // Convert log-posteriors to normalized scores via temperature-scaled softmax.
  const entries = [...targetMap.entries()];
  const maxLogPost = Math.max(...entries.map(([, d]) => d.logPosterior));

  let softmaxSum = 0;
  for (const [, data] of entries) {
    softmaxSum += Math.exp((data.logPosterior - maxLogPost) / SOFTMAX_TEMPERATURE);
  }

  // Fetch evidence titles with topic_count and classifier confidence
  const titleSql = `
    SELECT e.title,
           (SELECT COUNT(*) FROM event_topics et2 WHERE et2.event_id = e.event_id) AS topic_count,
           et.confidence AS topic_confidence
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE et.topic = ? AND ${PUB_TS} >= ?
    ORDER BY e.score DESC, ${PUB_TS} DESC
    LIMIT ?
  `;
  const titleStmt = db.prepare(titleSql);

  const scenarios: ScenarioItem[] = [];
  for (const [target, data] of entries) {
    const roundFactor = Math.pow(10, SCENARIO_DECIMAL_PLACES);
    const score = Math.round(
      (Math.exp((data.logPosterior - maxLogPost) / SOFTMAX_TEMPERATURE) / softmaxSum) * roundFactor,
    ) / roundFactor;

    const titleRows = titleStmt.all(
      target,
      windowStart,
      MAX_TITLES_PER_SCENARIO,
    ) as Array<{ title: string | null; topic_count: number; topic_confidence: number }>;

    const evidenceEntries = titleRows
      .map((r) => {
        const topicConfidence = r.topic_confidence ?? 1.0;
        const topicCountFactor = r.topic_count <= 2 ? 1.0 : r.topic_count <= 4 ? 0.7 : 0.4;
        const combinedScore = topicConfidence * topicCountFactor;
        const relevance: 'high' | 'medium' | 'low' =
          combinedScore >= 0.7 ? 'high' : combinedScore >= 0.4 ? 'medium' : 'low';
        return {
          text: sanitizeSnippet(r.title, { maxLength: 200 }).text,
          relevance,
        };
      })
      .filter((e) => e.text.length > 0);
    const evidenceTitles = evidenceEntries.map((e) => e.text);
    const evidenceRelevance = evidenceEntries.map((e) => e.relevance);

    // Entropy-widened timeframe
    const targetEnt = entropyMap.get(target) ?? 0;
    const entropyFactor = 1 + targetEnt;
    const center = (data.avgLagMin + data.avgLagMax) / 2;
    const halfWidth = (data.avgLagMax - data.avgLagMin) / 2;
    const widenedMin = Math.max(0, center - halfWidth * entropyFactor);
    const widenedMax = center + halfWidth * entropyFactor;

    // Sort trigger topics by contribution strength
    const sortedTriggers = [...data.triggerContributions.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([topic]) => topic);

    const targetBaseRate = Math.round((baseRates.get(target) ?? 0) * 100) / 100;

    scenarios.push({
      target_topic: target,
      score,
      timeframe_days: [
        Math.round(widenedMin * 10) / 10,
        Math.round(widenedMax * 10) / 10,
      ],
      trigger_topics: sortedTriggers,
      supporting_chains: data.chainCount,
      evidence_titles: evidenceTitles,
      evidence_relevance: evidenceRelevance,
      target_entropy: targetEnt,
      target_base_rate: targetBaseRate,
      min_chain_tier: worstTier(data.contributingChainTiers),
    });
  }

  // Pre-filter: drop scenarios where ALL evidence is topically unrelated
  // or omnipresent target + weak evidence
  const filtered = scenarios.filter(s => {
    if (s.evidence_relevance.length > 0 && s.evidence_relevance.every(r => r === 'low')) {
      return false;
    }
    if (s.target_base_rate > 0.8 && !s.evidence_relevance.some(r => r === 'high')) {
      return false;
    }
    return true;
  });

  filtered.sort((a, b) => b.score - a.score);
  return filtered.slice(0, topN);
}
