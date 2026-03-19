import type Database from 'better-sqlite3';
import type { LifecycleItem } from './types.js';
import { PUB_TS, WINDOWS, PHASE_EMISSIONS, sinceISO } from './types.js';

/* ── A. Lifecycle positioning ───────────────────────────────────────── */

export function computeLifecycles(
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
    const d90 = accels['90d'] ?? 0;
    const v30 = volumes['30d'] ?? 0;

    const ruleResult = classifyPhase(d1, d7, d14, d30, d90, v30, median30d);
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
  d90: number,
  v30: number,
  median30d: number,
): { phase: LifecycleItem['phase']; confidence: number } {
  // Count directional agreement across windows for confidence
  const directions = [d1, d7, d30, d90].map((a) =>
    a > 0.2 ? 1 : a < -0.2 ? -1 : 0,
  );
  const agreeing = Math.max(
    directions.filter((d) => d === 1).length,
    directions.filter((d) => d === -1).length,
    directions.filter((d) => d === 0).length,
  );
  const confidence = Math.round((agreeing / 4) * 100) / 100;

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
    for (const w of ['1d', '7d', '14d', '30d', '90d']) {
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
