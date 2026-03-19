import type Database from 'better-sqlite3';
import type { ScenarioItem, SnapshotResult, EvaluateResult } from './types.js';
import { PUB_TS, PUB_DAY, SNAPSHOT_RETENTION_DAYS, MIN_OUTCOMES_FOR_WEIGHT, WEIGHT_FLOOR, formatISO } from './types.js';

/* ── Forecast snapshot & learning ───────────────────────────────────── */

/**
 * Save a forecast snapshot for later evaluation. Persists top scenarios
 * into forecast_snapshots + forecast_outcomes (outcome = NULL = pending).
 * Also prunes snapshots older than 90 days.
 */
export function saveSnapshot(
  db: Database.Database,
  scenarios: ScenarioItem[],
  windowDays: number,
): SnapshotResult {
  // Insert snapshot
  const insertSnapshot = db.prepare(`
    INSERT INTO forecast_snapshots (window_days, scenarios)
    VALUES (?, ?)
  `);
  const insertOutcome = db.prepare(`
    INSERT OR IGNORE INTO forecast_outcomes (snapshot_id, target_topic, predicted_probability)
    VALUES (?, ?, ?)
  `);

  const result = db.transaction(() => {
    const info = insertSnapshot.run(windowDays, JSON.stringify(scenarios));
    const snapshotId = info.lastInsertRowid as number;

    let saved = 0;
    for (const s of scenarios) {
      insertOutcome.run(snapshotId, s.target_topic, s.score);
      saved++;
    }

    // Retention: delete snapshots older than 90 days
    const cutoff = formatISO(new Date(Date.now() - SNAPSHOT_RETENTION_DAYS * 86_400_000));
    const deleteOutcomes = db.prepare(`
      DELETE FROM forecast_outcomes WHERE snapshot_id IN (
        SELECT snapshot_id FROM forecast_snapshots WHERE created_at < ?
      )
    `);
    const deleteSnapshots = db.prepare(`
      DELETE FROM forecast_snapshots WHERE created_at < ?
    `);
    deleteOutcomes.run(cutoff);
    const pruneInfo = deleteSnapshots.run(cutoff);

    return {
      snapshot_id: snapshotId,
      scenarios_saved: saved,
      snapshots_pruned: pruneInfo.changes,
    };
  })();

  return result;
}

/**
 * Evaluate pending forecast outcomes and update topic weights.
 *
 * For each pending outcome (outcome IS NULL):
 * - Check if target_topic had a spike day (volume >= 3) within the predicted
 *   timeframe since snapshot creation
 * - Set outcome = 1 (observed) or 0 (not observed, timeframe elapsed)
 * - Compute Brier score: (predicted_score - outcome)^2
 * - Skip if timeframe hasn't elapsed yet
 *
 * Note: predicted_score is a temperature-sharpened softmax score, not a
 * calibrated probability. The Brier score therefore measures ranking quality
 * relative to outcomes, not true calibration.
 *
 * Then update topic_weights using Brier Skill Score (base-rate adjusted):
 *   skill = 1 - brier / brier_ref (per outcome, where brier_ref = naive base-rate predictor)
 *   weight = WEIGHT_FLOOR + (1 - WEIGHT_FLOOR) * max(0, avg_skill)
 * Falls back to raw Brier formula when brier_ref is unavailable (legacy rows).
 */
export function evaluateForecasts(db: Database.Database): EvaluateResult {
  const now = Date.now();

  // Fetch pending outcomes without the scenarios JSON blob
  const pendingSql = `
    SELECT fo.outcome_id, fo.snapshot_id, fo.target_topic, fo.predicted_probability,
           fs.created_at
    FROM forecast_outcomes fo
    JOIN forecast_snapshots fs ON fs.snapshot_id = fo.snapshot_id
    WHERE fo.outcome IS NULL
  `;
  const pendingRows = db.prepare(pendingSql).all() as Array<{
    outcome_id: number;
    snapshot_id: number;
    target_topic: string;
    predicted_probability: number;
    created_at: string;
  }>;

  // Fetch scenario timeframes separately — one JSON parse per snapshot
  const snapshotSql = `
    SELECT snapshot_id, scenarios FROM forecast_snapshots WHERE snapshot_id = ?
  `;
  const snapshotStmt = db.prepare(snapshotSql);

  const updateOutcome = db.prepare(`
    UPDATE forecast_outcomes
    SET outcome = ?, brier_score = ?, base_rate = ?, brier_ref = ?, evaluated_at = ?
    WHERE outcome_id = ?
  `);

  const spikeSql = `
    SELECT 1
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE et.topic = ?
      AND ${PUB_TS} >= ?
      AND ${PUB_TS} < ?
    GROUP BY ${PUB_DAY}
    HAVING COUNT(*) >= 3
    LIMIT 1
  `;
  const spikeStmt = db.prepare(spikeSql);

  let evaluated = 0;
  let skipped = 0;
  const nowISO = formatISO(new Date(now));

  // Group pending outcomes by snapshot_id
  const bySnapshot = new Map<number, {
    createdAt: string;
    outcomes: typeof pendingRows;
  }>();
  for (const row of pendingRows) {
    let group = bySnapshot.get(row.snapshot_id);
    if (!group) {
      group = {
        createdAt: row.created_at,
        outcomes: [],
      };
      bySnapshot.set(row.snapshot_id, group);
    }
    group.outcomes.push(row);
  }

  // Parse scenario timeframes lazily per snapshot
  const scenarioCache = new Map<number, ScenarioItem[]>();
  function getScenariosForSnapshot(snapshotId: number): ScenarioItem[] {
    let cached = scenarioCache.get(snapshotId);
    if (cached) return cached;
    const row = snapshotStmt.get(snapshotId) as { snapshot_id: number; scenarios: string } | undefined;
    if (!row) {
      scenarioCache.set(snapshotId, []);
      return [];
    }
    try {
      const parsed = JSON.parse(row.scenarios);
      cached = Array.isArray(parsed) ? parsed as ScenarioItem[] : [];
      if (!Array.isArray(parsed)) {
        console.error(`[intel] forecast: scenarios in snapshot ${snapshotId} is not an array, skipping`);
      }
    } catch {
      console.error(`[intel] forecast: corrupted scenarios JSON in snapshot ${snapshotId}, skipping`);
      cached = [];
    }
    scenarioCache.set(snapshotId, cached);
    return cached;
  }

  const results = db.transaction(() => {
    for (const [snapshotId, group] of bySnapshot) {
      const scenarios = getScenariosForSnapshot(snapshotId);
      for (const row of group.outcomes) {
        const scenario = scenarios.find(s => s.target_topic === row.target_topic);
        if (!scenario) {
          const brier = row.predicted_probability * row.predicted_probability;
          updateOutcome.run(0, brier, null, null, nowISO, row.outcome_id);
          evaluated++;
          continue;
        }

        const createdAt = new Date(group.createdAt).getTime();
        const maxDays = scenario.timeframe_days[1];
        const deadlineMs = createdAt + maxDays * 86_400_000;

        if (now < deadlineMs) {
          skipped++;
          continue;
        }

        const windowStart = formatISO(new Date(createdAt));
        const windowEnd = formatISO(new Date(deadlineMs));
        const spikeRows = spikeStmt.all(row.target_topic, windowStart, windowEnd);
        const observed = spikeRows.length > 0 ? 1 : 0;
        const brier = (row.predicted_probability - observed) ** 2;
        const baseRate = scenario.target_base_rate;
        const brierRef = baseRate * (1 - baseRate) ** 2 + (1 - baseRate) * baseRate ** 2;

        updateOutcome.run(observed, brier, baseRate, brierRef > 0 ? brierRef : null, nowISO, row.outcome_id);
        evaluated++;
      }
    }

    // Update topic weights from evaluated outcomes
    const weightSql = `
      SELECT target_topic,
             SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS tp,
             SUM(CASE WHEN outcome = 0 THEN 1 ELSE 0 END) AS fp,
             AVG(brier_score) AS avg_brier,
             AVG(CASE WHEN brier_ref IS NOT NULL AND brier_ref > 0
                   THEN 1.0 - brier_score / brier_ref
                   ELSE NULL END) AS avg_skill,
             COUNT(*) AS total
      FROM forecast_outcomes
      WHERE outcome IS NOT NULL AND brier_score IS NOT NULL
      GROUP BY target_topic
    `;
    const weightRows = db.prepare(weightSql).all() as Array<{
      target_topic: string;
      tp: number;
      fp: number;
      avg_brier: number;
      avg_skill: number | null;
      total: number;
    }>;

    const upsertWeight = db.prepare(`
      INSERT INTO topic_weights (topic_id, weight, true_positives, false_positives, avg_brier_score, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(topic_id) DO UPDATE SET
        weight = excluded.weight,
        true_positives = excluded.true_positives,
        false_positives = excluded.false_positives,
        avg_brier_score = excluded.avg_brier_score,
        updated_at = excluded.updated_at
    `);

    let weightsUpdated = 0;
    for (const row of weightRows) {
      if (row.total < MIN_OUTCOMES_FOR_WEIGHT) continue;

      const avgBrier = row.avg_brier ?? 0.25;
      const weight = row.avg_skill !== null
        ? Math.round((WEIGHT_FLOOR + (1 - WEIGHT_FLOOR) * Math.max(0, row.avg_skill)) * 1000) / 1000
        : Math.round((WEIGHT_FLOOR + (1 - WEIGHT_FLOOR) * (1 - avgBrier)) * 1000) / 1000;

      upsertWeight.run(row.target_topic, weight, row.tp, row.fp, avgBrier, nowISO);
      weightsUpdated++;
    }

    return { evaluated, skipped, weights_updated: weightsUpdated };
  })();

  return results;
}
