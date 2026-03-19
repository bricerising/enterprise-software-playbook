import type Database from 'better-sqlite3';
import { PUB_TS, PUB_DAY, CUSUM_K_SIGMA, CUSUM_H_SIGMA } from './types.js';

/* ── G. CUSUM change-point detection ──────────────────────────────── */

export function detectChangePoints(
  db: Database.Database,
  windowStart: string,
  useDedup: boolean,
  now?: number,
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

  const today = now ? new Date(now) : new Date();
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
