import type Database from 'better-sqlite3';
import type { IntelResponse } from '../types.js';
import { ok } from '../util/envelope.js';
import type { LifecycleItem, ChainItem } from './forecast/types.js';
import { detectChains } from './forecast/chains.js';
import { computeLifecycles } from './forecast/lifecycle.js';

/* ── Types ─────────────────────────────────────────────────────────── */

export interface AuditTopicItem {
  topic: string;
  domain: string;
  volume_3m: number;
  trend: 'increasing' | 'decreasing' | 'stable' | 'flat';
  overlap: Array<{ topic: string; pct: number }>;
  learning_weight: number | null;
  cross_domain_chains: number;
  lifecycle_phase: string | null;
  flags: string[];
}

export interface AuditDomainSummary {
  domain: string;
  topic_count: number;
  pct: number;
  volume_3m: number;
  flagged_count: number;
}

export interface AuditData {
  topics: AuditTopicItem[];
  domains: AuditDomainSummary[];
  total_topics: number;
  total_flagged: number;
}

export interface TopicAuditOpts {
  domain?: string;
  flagged?: boolean;
  belowMinimum?: boolean;
  overlap?: string;
}

/* ── Constants ─────────────────────────────────────────────────────── */

const MINIMUM_VOLUME_3M = 10;
const OVERLAP_THRESHOLD = 0.1;
const MAX_OVERLAP_PER_TOPIC = 5;
const LOW_WEIGHT_THRESHOLD = 0.7;
const DOMAIN_IMBALANCE_THRESHOLD = 0.3;

/* ── Audit query ───────────────────────────────────────────────────── */

export function auditTopics(
  db: Database.Database,
  opts: TopicAuditOpts = {},
): IntelResponse<AuditData> {
  const warnings: string[] = [];

  // 1. Per-topic 3-month volume with trend
  const volumeRows = db
    .prepare(
      `
    SELECT et.topic,
      COUNT(*) AS volume_3m,
      SUM(CASE WHEN e.fetched_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') THEN 1 ELSE 0 END) AS vol_recent,
      SUM(CASE WHEN e.fetched_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 days')
                AND e.fetched_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') THEN 1 ELSE 0 END) AS vol_mid,
      SUM(CASE WHEN e.fetched_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 days') THEN 1 ELSE 0 END) AS vol_old
    FROM event_topics et
    JOIN events e ON e.event_id = et.event_id
    WHERE e.fetched_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')
    GROUP BY et.topic
    `,
    )
    .all() as Array<{
    topic: string;
    volume_3m: number;
    vol_recent: number;
    vol_mid: number;
    vol_old: number;
  }>;

  const volumeMap = new Map<
    string,
    { volume_3m: number; trend: AuditTopicItem['trend'] }
  >();
  for (const row of volumeRows) {
    let trend: AuditTopicItem['trend'];
    if (row.volume_3m === 0) {
      trend = 'flat';
    } else if (row.vol_recent > row.vol_mid && row.vol_mid >= row.vol_old) {
      trend = 'increasing';
    } else if (row.vol_recent < row.vol_mid && row.vol_mid <= row.vol_old) {
      trend = 'decreasing';
    } else if (
      row.vol_recent === 0 &&
      row.vol_mid === 0 &&
      row.vol_old === 0
    ) {
      trend = 'flat';
    } else {
      trend = 'stable';
    }
    volumeMap.set(row.topic, { volume_3m: row.volume_3m, trend });
  }

  // 2. Co-classification overlap via self-join on event_topics (>10%, top 5)
  const overlapRows = db
    .prepare(
      `
    WITH topic_totals AS (
      SELECT et.topic, COUNT(*) AS total
      FROM event_topics et
      JOIN events e ON e.event_id = et.event_id
      WHERE e.fetched_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')
      GROUP BY et.topic
    )
    SELECT a.topic AS topic_a, b.topic AS topic_b,
      COUNT(*) AS shared,
      CAST(COUNT(*) AS REAL) / MIN(ta.total, tb.total) AS overlap_pct
    FROM event_topics a
    JOIN event_topics b ON a.event_id = b.event_id AND a.topic < b.topic
    JOIN events e ON e.event_id = a.event_id
    JOIN topic_totals ta ON ta.topic = a.topic
    JOIN topic_totals tb ON tb.topic = b.topic
    WHERE e.fetched_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')
    GROUP BY a.topic, b.topic
    HAVING overlap_pct > ?
    ORDER BY overlap_pct DESC
    `,
    )
    .all(OVERLAP_THRESHOLD) as Array<{
    topic_a: string;
    topic_b: string;
    shared: number;
    overlap_pct: number;
  }>;

  // Build per-topic overlap map (both directions, top 5)
  const overlapMap = new Map<string, Array<{ topic: string; pct: number }>>();
  for (const row of overlapRows) {
    for (const [self, other] of [
      [row.topic_a, row.topic_b],
      [row.topic_b, row.topic_a],
    ] as const) {
      const existing = overlapMap.get(self) ?? [];
      if (existing.length < MAX_OVERLAP_PER_TOPIC) {
        existing.push({
          topic: other,
          pct: Math.round(row.overlap_pct * 1000) / 1000,
        });
        overlapMap.set(self, existing);
      }
    }
  }

  // 3. Learning weights from topic_weights
  const weightMap = new Map<string, number>();
  try {
    const weightRows = db
      .prepare('SELECT topic_id, weight FROM topic_weights')
      .all() as Array<{ topic_id: string; weight: number }>;
    for (const row of weightRows) {
      weightMap.set(row.topic_id, row.weight);
    }
  } catch {
    // Table may not exist
  }

  // 4. Lifecycle phases via computeLifecycles
  const now = Date.now();
  let lifecycles: LifecycleItem[];
  try {
    lifecycles = computeLifecycles(db, now, true);
  } catch {
    lifecycles = [];
    warnings.push('Could not compute lifecycles — lifecycle phase will be null');
  }
  const lifecycleMap = new Map<string, string>();
  for (const lc of lifecycles) {
    lifecycleMap.set(lc.topic, lc.phase);
  }

  // 5. Cross-domain chain count via detectChains
  const windowStart = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  let chains: ChainItem[];
  try {
    chains = detectChains(db, windowStart, 7, 2, true, lifecycles);
  } catch {
    chains = [];
    warnings.push('Could not detect chains — cross_domain_chains will be 0');
  }

  const crossDomainCount = new Map<string, number>();
  for (const chain of chains) {
    const fromDomain = chain.from_topic.split('.')[0];
    const toDomain = chain.to_topic.split('.')[0];
    if (fromDomain !== toDomain) {
      crossDomainCount.set(
        chain.from_topic,
        (crossDomainCount.get(chain.from_topic) ?? 0) + 1,
      );
      crossDomainCount.set(
        chain.to_topic,
        (crossDomainCount.get(chain.to_topic) ?? 0) + 1,
      );
    }
  }

  // 6. Build audit items with flags
  const allTopics = [...volumeMap.keys()].sort();
  const totalTopics = allTopics.length;

  // Domain counts for imbalance check
  const domainCounts = new Map<string, number>();
  for (const topic of allTopics) {
    const domain = topic.split('.')[0];
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
  }

  let items: AuditTopicItem[] = allTopics.map((topic) => {
    const domain = topic.split('.')[0];
    const vol = volumeMap.get(topic) ?? { volume_3m: 0, trend: 'flat' as const };
    const overlap = overlapMap.get(topic) ?? [];
    const weight = weightMap.get(topic) ?? null;
    const crossChains = crossDomainCount.get(topic) ?? 0;
    const phase = lifecycleMap.get(topic) ?? null;

    const flags: string[] = [];

    if (vol.volume_3m < MINIMUM_VOLUME_3M) {
      flags.push('below_minimum_volume');
    }
    for (const o of overlap) {
      flags.push(`high_overlap:${o.topic}`);
    }
    if (weight !== null && weight < LOW_WEIGHT_THRESHOLD) {
      flags.push('low_learning_weight');
    }
    if (crossChains === 0) {
      flags.push('no_cross_domain_chains');
    }
    const domainPct =
      totalTopics > 0
        ? (domainCounts.get(domain) ?? 0) / totalTopics
        : 0;
    if (domainPct > DOMAIN_IMBALANCE_THRESHOLD) {
      flags.push('domain_imbalance');
    }

    return {
      topic,
      domain,
      volume_3m: vol.volume_3m,
      trend: vol.trend,
      overlap,
      learning_weight: weight,
      cross_domain_chains: crossChains,
      lifecycle_phase: phase,
      flags,
    };
  });

  // 7. Apply filters
  if (opts.domain) {
    items = items.filter((i) => i.domain === opts.domain);
  }
  if (opts.flagged) {
    items = items.filter((i) => i.flags.length > 0);
  }
  if (opts.belowMinimum) {
    items = items.filter((i) => i.flags.includes('below_minimum_volume'));
  }
  if (opts.overlap) {
    const needle = opts.overlap;
    items = items.filter((i) =>
      i.flags.some((f) => f === `high_overlap:${needle}`),
    );
  }

  // 8. Build domain summaries
  const domainSummaryMap = new Map<
    string,
    { count: number; volume: number; flagged: number }
  >();
  for (const item of allTopics.map(
    (t) =>
      items.find((i) => i.topic === t) ?? {
        domain: t.split('.')[0],
        volume_3m: 0,
        flags: [] as string[],
      },
  )) {
    const d = item.domain;
    const existing = domainSummaryMap.get(d) ?? {
      count: 0,
      volume: 0,
      flagged: 0,
    };
    existing.count += 1;
    existing.volume += item.volume_3m;
    if (item.flags.length > 0) existing.flagged += 1;
    domainSummaryMap.set(d, existing);
  }

  const domains: AuditDomainSummary[] = [...domainSummaryMap.entries()]
    .map(([domain, s]) => ({
      domain,
      topic_count: s.count,
      pct: totalTopics > 0 ? Math.round((s.count / totalTopics) * 1000) / 1000 : 0,
      volume_3m: s.volume,
      flagged_count: s.flagged,
    }))
    .sort((a, b) => b.topic_count - a.topic_count);

  const data: AuditData = {
    topics: items,
    domains,
    total_topics: totalTopics,
    total_flagged: items.filter((i) => i.flags.length > 0).length,
  };

  return ok(data, { warnings });
}

/* ── Mark review completed ─────────────────────────────────────────── */

export function markTopicReviewCompleted(
  db: Database.Database,
): { key: string; value: string } {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tool_metadata (key, value, updated_at)
     VALUES ('topic_review_last_completed', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(now, now);
  return { key: 'topic_review_last_completed', value: now };
}
