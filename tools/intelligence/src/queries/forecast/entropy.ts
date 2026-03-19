import type Database from 'better-sqlite3';
import type { EntropyItem } from './types.js';
import { PUB_TS, PUB_DAY } from './types.js';

/* ── F. Entropy-based surprise scoring ─────────────────────────────── */

export function computeEntropy(
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
