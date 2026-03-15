import type Database from 'better-sqlite3';
import type { IntelResponse } from '../types.js';
import { ok } from '../util/envelope.js';
import { sanitizeSnippet } from '../util/text.js';
import { sinceISO as _sinceISO, formatISO } from '../util/time.js';

/* ── Constants ──────────────────────────────────────────────────────── */

const WINDOWS = [
  { label: '1d', ms: 86_400_000 },
  { label: '7d', ms: 604_800_000 },
  { label: '14d', ms: 1_209_600_000 },
  { label: '30d', ms: 2_592_000_000 },
] as const;

const MAX_TITLES_PER_SCENARIO = 3;

/* ── Interfaces ─────────────────────────────────────────────────────── */

export interface ForecastData {
  window: { start: string; end: string; events_analyzed: number };
  lifecycles: LifecycleItem[];
  chains: ChainItem[];
  ranked_chains: RankedChainItem[];
  scenarios: ScenarioItem[];
  multiscale: MultiscaleItem[];
}

export interface LifecycleItem {
  topic: string;
  phase: 'emerging' | 'accelerating' | 'peaking' | 'decaying' | 'stable';
  phase_confidence: number;
  volumes: Record<string, number>;
  accelerations: Record<string, number>;
}

export interface ChainItem {
  from_topic: string;
  to_topic: string;
  support: number;
  avg_lag_days: number;
  source_diversity: number;
  active: boolean;
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
}

export interface MultiscaleItem {
  topic: string;
  alignment: 'aligned_up' | 'aligned_down' | 'diverging' | 'transitioning';
  d1_accel: number;
  d7_accel: number;
  d30_accel: number;
}

export interface ComputeForecastOpts {
  lag_window_days?: number;
  min_support?: number;
  top_scenarios?: number;
  dedup?: string;
}

/* ── Main entry ─────────────────────────────────────────────────────── */

export function computeForecast(
  db: Database.Database,
  opts: ComputeForecastOpts = {},
): IntelResponse<ForecastData> {
  const lagWindowDays = opts.lag_window_days ?? 7;
  const minSupport = opts.min_support ?? 3;
  const topScenarios = opts.top_scenarios ?? 10;
  const useDedup = opts.dedup !== 'none';

  const now = Date.now();
  const window30dStart = sinceISO(WINDOWS[3].ms);
  const end = formatISO(new Date(now));

  // Count events in analysis window
  const countSql = `
    SELECT COUNT(*) AS cnt FROM events WHERE fetched_at >= ?
  `;
  const { cnt: eventsAnalyzed } = db.prepare(countSql).get(window30dStart) as { cnt: number };

  const lifecycles = computeLifecycles(db, now, useDedup);
  const chains = detectChains(db, window30dStart, lagWindowDays, minSupport, useDedup, lifecycles);
  const scenarios = projectScenarios(db, chains, lifecycles, window30dStart, topScenarios, useDedup);
  const multiscale = buildMultiscaleView(lifecycles);
  const ranked_chains = computeRankedChains(chains, lifecycles);

  return ok({
    window: { start: window30dStart, end, events_analyzed: eventsAnalyzed },
    lifecycles,
    chains,
    ranked_chains,
    scenarios,
    multiscale,
  });
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
      WHERE e.fetched_at >= ?
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
      WHERE e.fetched_at >= ? AND e.fetched_at < ?
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

    const { phase, confidence } = classifyPhase(d1, d7, d14, d30, v30, median30d);

    results.push({
      topic,
      phase,
      phase_confidence: confidence,
      volumes,
      accelerations: accels,
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
  window30dStart: string,
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
      SELECT et.topic, DATE(e.fetched_at) AS day,
             ${volumeExpr} AS volume,
             COUNT(DISTINCT e.source) AS sources
      FROM event_topics et JOIN events e ON e.event_id = et.event_id
      WHERE e.fetched_at >= ?
      GROUP BY et.topic, DATE(e.fetched_at)
      HAVING volume >= 3
    )
    SELECT a.topic AS from_topic, b.topic AS to_topic,
           COUNT(*) AS support,
           AVG(JULIANDAY(b.day) - JULIANDAY(a.day)) AS avg_lag_days,
           COUNT(DISTINCT a.sources || ',' || b.sources) AS source_pairs
    FROM daily_volumes a JOIN daily_volumes b
      ON b.day > a.day
      AND JULIANDAY(b.day) - JULIANDAY(a.day) <= ?
      AND a.topic != b.topic
    GROUP BY a.topic, b.topic
    HAVING support >= ?
    ORDER BY support DESC
  `;

  const chainRows = db.prepare(chainSql).all(
    window30dStart,
    lagWindowDays,
    minSupport,
  ) as Array<{
    from_topic: string;
    to_topic: string;
    support: number;
    avg_lag_days: number;
    source_pairs: number;
  }>;

  if (chainRows.length === 0) return [];

  // Normalize source_diversity to 0-1
  const maxSourcePairs = Math.max(...chainRows.map((r) => r.source_pairs));

  // Determine which topics are currently spiking (volume >= 3 in last 24h)
  const spikeSql = `
    SELECT et.topic, ${volumeExpr} AS volume
    FROM event_topics et JOIN events e ON e.event_id = et.event_id
    WHERE e.fetched_at >= ?
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

  return chainRows.map((row) => ({
    from_topic: row.from_topic,
    to_topic: row.to_topic,
    support: row.support,
    avg_lag_days: Math.round(row.avg_lag_days * 10) / 10,
    source_diversity: maxSourcePairs > 0
      ? Math.round((row.source_pairs / maxSourcePairs) * 100) / 100
      : 0,
    active: spiking.has(row.from_topic),
  }));
}

/* ── C. Scenario projection ─────────────────────────────────────────── */

function projectScenarios(
  db: Database.Database,
  chains: ChainItem[],
  lifecycles: LifecycleItem[],
  window30dStart: string,
  topN: number,
  useDedup: boolean,
): ScenarioItem[] {
  const activeChains = chains.filter((c) => c.active);
  if (activeChains.length === 0) return [];

  // Build acceleration lookup from lifecycles (prefer d1, fallback to d7)
  const accelMap = new Map<string, number>();
  for (const lc of lifecycles) {
    const d1 = lc.accelerations['1d'] ?? 0;
    const d7 = lc.accelerations['7d'] ?? 0;
    accelMap.set(lc.topic, Math.abs(d1) >= 0.1 ? d1 : d7);
  }

  // Score each chain
  const scored = activeChains.map((chain) => {
    const fromAccel = Math.max(0, accelMap.get(chain.from_topic) ?? 0);
    return {
      ...chain,
      rawScore: chain.support * chain.source_diversity * (1 + fromAccel),
    };
  });

  // Find max score for normalization
  const maxScore = Math.max(...scored.map((s) => s.rawScore));

  // Aggregate chains pointing to same target
  const targetMap = new Map<
    string,
    {
      totalScore: number;
      triggerTopics: Set<string>;
      chainCount: number;
      avgLagMin: number;
      avgLagMax: number;
    }
  >();

  for (const s of scored) {
    const existing = targetMap.get(s.to_topic);
    if (existing) {
      existing.totalScore += s.rawScore;
      existing.triggerTopics.add(s.from_topic);
      existing.chainCount += 1;
      existing.avgLagMin = Math.min(existing.avgLagMin, s.avg_lag_days * 0.5);
      existing.avgLagMax = Math.max(existing.avgLagMax, s.avg_lag_days * 1.5);
    } else {
      targetMap.set(s.to_topic, {
        totalScore: s.rawScore,
        triggerTopics: new Set([s.from_topic]),
        chainCount: 1,
        avgLagMin: s.avg_lag_days * 0.5,
        avgLagMax: s.avg_lag_days * 1.5,
      });
    }
  }

  // Normalize probabilities across all targets
  const maxTotalScore = Math.max(...[...targetMap.values()].map((t) => t.totalScore));

  // Fetch evidence titles
  const volumeExpr = useDedup
    ? 'COALESCE(e.canonical_url, e.event_id)'
    : 'e.event_id';
  const titleSql = `
    SELECT e.title
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE et.topic = ? AND e.fetched_at >= ?
    ORDER BY e.score DESC, e.fetched_at DESC
    LIMIT ?
  `;
  const titleStmt = db.prepare(titleSql);

  const scenarios: ScenarioItem[] = [];
  for (const [target, data] of targetMap) {
    const probability = maxTotalScore > 0
      ? Math.round((data.totalScore / maxTotalScore) * 100) / 100
      : 0;

    const titleRows = titleStmt.all(
      target,
      window30dStart,
      MAX_TITLES_PER_SCENARIO,
    ) as Array<{ title: string | null }>;

    const evidenceTitles = titleRows
      .map((r) => sanitizeSnippet(r.title, { maxLength: 200 }).text)
      .filter((t) => t.length > 0);

    scenarios.push({
      target_topic: target,
      probability,
      timeframe_days: [
        Math.round(data.avgLagMin * 10) / 10,
        Math.round(data.avgLagMax * 10) / 10,
      ],
      trigger_topics: [...data.triggerTopics],
      supporting_chains: data.chainCount,
      evidence_titles: evidenceTitles,
    });
  }

  // Sort by probability descending, take top N
  scenarios.sort((a, b) => b.probability - a.probability);
  return scenarios.slice(0, topN);
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
    const score =
      Math.round(chain.support * chain.source_diversity * (1 + accel) * 100) / 100;
    const cross_domain =
      chain.from_topic.split('.')[0] !== chain.to_topic.split('.')[0];
    return { ...chain, score, cross_domain };
  });

  // Sort: cross-domain first, then by score descending
  ranked.sort((a, b) => {
    if (a.cross_domain !== b.cross_domain) return a.cross_domain ? -1 : 1;
    return b.score - a.score;
  });

  return ranked.slice(0, 50);
}

/** sinceISO with optional explicit `now` for deterministic window alignment. */
function sinceISO(durationMs: number, now?: number): string {
  if (now === undefined) return _sinceISO(durationMs);
  return formatISO(new Date(now - durationMs));
}
