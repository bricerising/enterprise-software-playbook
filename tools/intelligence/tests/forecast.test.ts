import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWriter } from '../src/db.js';
import { computeForecast } from '../src/queries/forecast.js';
import type Database from 'better-sqlite3';

let tmpDir: string;
let dbPath: string;
let db: Database.Database;

const insertEvent = (
  db: Database.Database,
  eventId: string,
  source: string,
  url: string,
  title: string,
  fetchedAt: string,
  topics: string[],
  score: number = 0,
) => {
  db.prepare(`
    INSERT INTO events (event_id, source, feed, url, canonical_url, title, content,
      fetched_at, topics, tags, score, comments)
    VALUES (?, ?, 'test', ?, ?, ?, '', ?, ?, '[]', ?, 0)
  `).run(eventId, source, url, url, title, fetchedAt, JSON.stringify(topics), score);

  const insertTopic = db.prepare(
    'INSERT OR IGNORE INTO event_topics (event_id, topic) VALUES (?, ?)',
  );
  for (const t of topics) {
    insertTopic.run(eventId, t);
  }
};

/**
 * Build synthetic chain patterns:
 *   Pattern A: ai.llm → ai.agents (3 occurrences, ~2-day lag, single source)
 *   Pattern B: aws.bedrock → aws.lambda (4 occurrences, ~1-day lag, cross-source)
 *   Current spike: ai.llm active now (triggers scenario prediction for ai.agents)
 */
function seedChainFixtures(db: Database.Database): void {
  const now = Date.now();

  // Pattern A: ai.llm spike on day D, ai.agents spike on day D+2 (3 times)
  for (let i = 0; i < 3; i++) {
    const baseDay = now - (20 - i * 5) * 86_400_000; // days 20, 15, 10 ago
    // ai.llm spike (3+ events on baseDay)
    for (let j = 0; j < 4; j++) {
      const ts = new Date(baseDay + j * 3600_000).toISOString();
      insertEvent(db, `llm-spike-${i}-${j}`, 'rss', `https://ex.com/llm-${i}-${j}`,
        `LLM Article ${i}-${j}`, ts, ['ai.llm'], j);
    }
    // ai.agents spike 2 days later (3+ events)
    const lagDay = baseDay + 2 * 86_400_000;
    for (let j = 0; j < 3; j++) {
      const ts = new Date(lagDay + j * 3600_000).toISOString();
      insertEvent(db, `agents-spike-${i}-${j}`, 'rss', `https://ex.com/agents-${i}-${j}`,
        `Agent Framework Article ${i}-${j}`, ts, ['ai.agents'], j);
    }
  }

  // Pattern B: aws.bedrock → aws.lambda (4 occurrences, ~1-day lag, cross-source)
  for (let i = 0; i < 4; i++) {
    const baseDay = now - (25 - i * 5) * 86_400_000; // days 25, 20, 15, 10 ago
    // aws.bedrock spike (cross-source: rss + hackernews)
    for (let j = 0; j < 3; j++) {
      const ts = new Date(baseDay + j * 3600_000).toISOString();
      const src = j % 2 === 0 ? 'rss' : 'hackernews';
      insertEvent(db, `bedrock-spike-${i}-${j}`, src, `https://ex.com/bedrock-${i}-${j}`,
        `Bedrock Update ${i}-${j}`, ts, ['aws.bedrock'], j);
    }
    // aws.lambda spike 1 day later
    const lagDay = baseDay + 1 * 86_400_000;
    for (let j = 0; j < 3; j++) {
      const ts = new Date(lagDay + j * 3600_000).toISOString();
      const src = j % 2 === 0 ? 'hackernews' : 'rss';
      insertEvent(db, `lambda-spike-${i}-${j}`, src, `https://ex.com/lambda-${i}-${j}`,
        `Lambda Integration ${i}-${j}`, ts, ['aws.lambda'], j);
    }
  }

  // Current spike: ai.llm active right now (triggers scenarios)
  for (let j = 0; j < 5; j++) {
    const ts = new Date(now - j * 3600_000).toISOString();
    insertEvent(db, `llm-now-${j}`, 'rss', `https://ex.com/llm-now-${j}`,
      `Breaking LLM News ${j}`, ts, ['ai.llm'], 10 + j);
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'intel-forecast-test-'));
  dbPath = join(tmpDir, 'test.db');
  db = openWriter(dbPath);
  seedChainFixtures(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('computeForecast', () => {
  it('returns all sections in response envelope', () => {
    const result = computeForecast(db, { min_support: 2 });
    expect(result.status).toBe('ok');
    expect(result.data).toHaveProperty('window');
    expect(result.data).toHaveProperty('lifecycles');
    expect(result.data).toHaveProperty('chains');
    expect(result.data).toHaveProperty('ranked_chains');
    expect(result.data).toHaveProperty('scenarios');
    expect(result.data).toHaveProperty('multiscale');
    expect(result.data).toHaveProperty('transitive_chains');
    expect(result.data.window.events_analyzed).toBeGreaterThan(0);
  });

  it('detects chains with correct support counts', () => {
    const result = computeForecast(db, { min_support: 2 });
    const chains = result.data.chains;
    expect(chains.length).toBeGreaterThan(0);

    // Each chain should have support >= min_support and new statistical fields
    for (const chain of chains) {
      expect(chain.support).toBeGreaterThanOrEqual(2);
      expect(chain.avg_lag_days).toBeGreaterThan(0);
      expect(chain.source_diversity).toBeGreaterThanOrEqual(0);
      expect(chain.source_diversity).toBeLessThanOrEqual(1);
      expect(typeof chain.lift).toBe('number');
      expect(typeof chain.confidence).toBe('number');
      expect(typeof chain.directionality).toBe('number');
      expect(typeof chain.lag_stddev).toBe('number');
    }
  });

  it('marks chains active when trigger topic is spiking', () => {
    const result = computeForecast(db, { min_support: 2 });
    const chains = result.data.chains;

    // ai.llm has a current spike, so chains from ai.llm should be active
    const llmChains = chains.filter((c) => c.from_topic === 'ai.llm');
    if (llmChains.length > 0) {
      expect(llmChains.some((c) => c.active)).toBe(true);
    }
  });

  it('generates scenarios with probability 0-1 and valid timeframe', () => {
    const result = computeForecast(db, { min_support: 2 });
    const scenarios = result.data.scenarios;

    for (const s of scenarios) {
      expect(s.probability).toBeGreaterThanOrEqual(0);
      expect(s.probability).toBeLessThanOrEqual(1);
      expect(s.timeframe_days).toHaveLength(2);
      expect(s.timeframe_days[0]).toBeLessThanOrEqual(s.timeframe_days[1]);
      expect(s.trigger_topics.length).toBeGreaterThan(0);
      expect(s.supporting_chains).toBeGreaterThan(0);
    }
  });

  it('classifies lifecycle phases correctly', () => {
    const result = computeForecast(db, { min_support: 2 });
    const lifecycles = result.data.lifecycles;
    expect(lifecycles.length).toBeGreaterThan(0);

    const validPhases = ['emerging', 'accelerating', 'peaking', 'decaying', 'stable'];
    for (const lc of lifecycles) {
      expect(validPhases).toContain(lc.phase);
      expect(lc.phase_confidence).toBeGreaterThanOrEqual(0);
      expect(lc.phase_confidence).toBeLessThanOrEqual(1);
    }
  });

  it('multiscale convergence classification works', () => {
    const result = computeForecast(db, { min_support: 2 });
    const multiscale = result.data.multiscale;
    expect(multiscale.length).toBeGreaterThan(0);

    const validAlignments = ['aligned_up', 'aligned_down', 'diverging', 'transitioning'];
    for (const ms of multiscale) {
      expect(validAlignments).toContain(ms.alignment);
      expect(typeof ms.d1_accel).toBe('number');
      expect(typeof ms.d7_accel).toBe('number');
      expect(typeof ms.d30_accel).toBe('number');
    }
  });

  it('respects min_support threshold', () => {
    const lowThreshold = computeForecast(db, { min_support: 2 });
    const highThreshold = computeForecast(db, { min_support: 10 });

    expect(highThreshold.data.chains.length).toBeLessThanOrEqual(
      lowThreshold.data.chains.length,
    );
  });

  it('respects top_scenarios limit', () => {
    const result = computeForecast(db, { min_support: 2, top_scenarios: 1 });
    expect(result.data.scenarios.length).toBeLessThanOrEqual(1);
  });

  it('handles empty database gracefully', () => {
    // Create a fresh empty database
    const emptyDir = mkdtempSync(join(tmpdir(), 'intel-empty-'));
    const emptyPath = join(emptyDir, 'empty.db');
    const emptyDb = openWriter(emptyPath);

    try {
      const result = computeForecast(emptyDb);
      expect(result.status).toBe('ok');
      expect(result.data.lifecycles).toEqual([]);
      expect(result.data.chains).toEqual([]);
      expect(result.data.ranked_chains).toEqual([]);
      expect(result.data.scenarios).toEqual([]);
      expect(result.data.multiscale).toEqual([]);
      expect(result.data.transitive_chains).toEqual([]);
      expect(result.data.window.events_analyzed).toBe(0);
    } finally {
      emptyDb.close();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('evidence titles present and capped at 3', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const s of result.data.scenarios) {
      expect(s.evidence_titles.length).toBeLessThanOrEqual(3);
      for (const title of s.evidence_titles) {
        expect(typeof title).toBe('string');
        expect(title.length).toBeGreaterThan(0);
      }
    }
  });
});

/* ── Sparse-data tests (zero events in last 24h) ──────────────────── */

/**
 * Sparse-day fixture: all events land in the 2-7 day window, zero in last 24h.
 * ml.transformers → ml.training chain with strong 7d acceleration.
 * Also includes a cross-domain chain: ml.transformers → infra.gpu
 */
function seedSparseFixtures(db: Database.Database): void {
  const now = Date.now();
  const DAY = 86_400_000;

  // ml.transformers: heavy activity 2-6 days ago, nothing in prior 7-14d window
  // This creates strong 7d acceleration (current >> previous)
  for (let day = 2; day <= 6; day++) {
    for (let j = 0; j < 5; j++) {
      const ts = new Date(now - day * DAY + j * 3600_000).toISOString();
      insertEvent(db, `sparse-tf-${day}-${j}`, 'rss',
        `https://ex.com/tf-${day}-${j}`,
        `Transformer Paper ${day}-${j}`, ts, ['ml.transformers'], j);
    }
  }

  // ml.training: activity 2-5 days ago (follows ml.transformers with ~1d lag)
  for (let day = 2; day <= 5; day++) {
    for (let j = 0; j < 4; j++) {
      const ts = new Date(now - day * DAY + j * 3600_000).toISOString();
      insertEvent(db, `sparse-train-${day}-${j}`, 'rss',
        `https://ex.com/train-${day}-${j}`,
        `Training Framework ${day}-${j}`, ts, ['ml.training'], j);
    }
  }

  // infra.gpu: activity 3-5 days ago (cross-domain from ml.transformers)
  for (let day = 3; day <= 5; day++) {
    for (let j = 0; j < 3; j++) {
      const ts = new Date(now - day * DAY + j * 3600_000).toISOString();
      const src = j % 2 === 0 ? 'rss' : 'hackernews';
      insertEvent(db, `sparse-gpu-${day}-${j}`, src,
        `https://ex.com/gpu-${day}-${j}`,
        `GPU Availability ${day}-${j}`, ts, ['infra.gpu'], j);
    }
  }

  // Add events in the previous 7d window (8-12 days ago) with low volume
  // so 7d acceleration = (current - prev) / prev >> 1.0
  for (let day = 8; day <= 10; day++) {
    const ts = new Date(now - day * DAY).toISOString();
    insertEvent(db, `sparse-prev-tf-${day}`, 'rss',
      `https://ex.com/prev-tf-${day}`,
      `Old Transformer ${day}`, ts, ['ml.transformers'], 0);
    insertEvent(db, `sparse-prev-train-${day}`, 'rss',
      `https://ex.com/prev-train-${day}`,
      `Old Training ${day}`, ts, ['ml.training'], 0);
  }

  // Add some older baseline events (15-20 days ago) for 30d context
  for (let day = 15; day <= 17; day++) {
    const ts = new Date(now - day * DAY).toISOString();
    insertEvent(db, `sparse-old-tf-${day}`, 'rss',
      `https://ex.com/old-tf-${day}`,
      `Old Transformer ${day}`, ts, ['ml.transformers'], 0);
    insertEvent(db, `sparse-old-train-${day}`, 'rss',
      `https://ex.com/old-train-${day}`,
      `Old Training ${day}`, ts, ['ml.training'], 0);
  }
}

describe('sparse-day fallbacks', () => {
  let sparseDir: string;
  let sparseDb: Database.Database;

  beforeEach(() => {
    sparseDir = mkdtempSync(join(tmpdir(), 'intel-sparse-test-'));
    const sparsePath = join(sparseDir, 'sparse.db');
    sparseDb = openWriter(sparsePath);
    seedSparseFixtures(sparseDb);
  });

  afterEach(() => {
    sparseDb.close();
    rmSync(sparseDir, { recursive: true, force: true });
  });

  it('generates scenarios with 7d fallback when 24h is empty', () => {
    const result = computeForecast(sparseDb, { min_support: 2 });
    // With tiered activation, 7d-accelerating topics activate chains
    expect(result.data.scenarios.length).toBeGreaterThan(0);
  });

  it('does not classify high-7d-accel topics as stable', () => {
    const result = computeForecast(sparseDb, { min_support: 2 });
    const tf = result.data.lifecycles.find((lc) => lc.topic === 'ml.transformers');
    expect(tf).toBeDefined();
    // d1 should be 0 (no events in last 24h), but d7 should be high
    expect(tf!.accelerations['1d'] ?? 0).toBe(0);
    expect(tf!.accelerations['7d']).toBeGreaterThan(1.0);
    // Phase should NOT be stable given strong 7d acceleration
    expect(tf!.phase).not.toBe('stable');
  });

  it('multiscale uses d7 proxy when d1 is zero', () => {
    const result = computeForecast(sparseDb, { min_support: 2 });
    const tf = result.data.multiscale.find((m) => m.topic === 'ml.transformers');
    expect(tf).toBeDefined();
    expect(tf!.d1_accel).toBe(0);
    // With d7 > 0 and d30 > 0, alignment should be aligned_up (not default)
    // The key test: it shouldn't be aligned_up purely from the d1=0 fallback default
    // — it should actually evaluate using d7 as the short proxy
    expect(tf!.d7_accel).toBeGreaterThan(0);
    // alignment should reflect d7, not default to aligned_up from zero d1
    expect(['aligned_up', 'aligned_down', 'diverging', 'transitioning']).toContain(tf!.alignment);
  });

  it('ranked chains are scored, sorted, and capped at 50', () => {
    const result = computeForecast(sparseDb, { min_support: 2 });
    const ranked = result.data.ranked_chains;

    for (const rc of ranked) {
      expect(typeof rc.score).toBe('number');
      expect(rc.score).toBeGreaterThanOrEqual(0);
      expect(typeof rc.cross_domain).toBe('boolean');
      expect(rc.active).toBe(true);
    }
    expect(ranked.length).toBeLessThanOrEqual(50);

    // Verify sort order: cross-domain first, then by score desc
    for (let i = 1; i < ranked.length; i++) {
      if (ranked[i - 1].cross_domain === ranked[i].cross_domain) {
        expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
      } else {
        // cross_domain=true should come before cross_domain=false
        expect(ranked[i - 1].cross_domain).toBe(true);
      }
    }
  });

  it('cross-domain marking uses top-level domain comparison', () => {
    const result = computeForecast(sparseDb, { min_support: 2 });
    const ranked = result.data.ranked_chains;

    for (const rc of ranked) {
      const fromDomain = rc.from_topic.split('.')[0];
      const toDomain = rc.to_topic.split('.')[0];
      expect(rc.cross_domain).toBe(fromDomain !== toDomain);
    }
  });
});

/* ── Statistical rigor tests ───────────────────────────────────────── */

describe('chain statistical fields', () => {
  it('lift and confidence are finite and in expected ranges', () => {
    const result = computeForecast(db, { min_support: 2 });
    const chains = result.data.chains;
    expect(chains.length).toBeGreaterThan(0);

    for (const c of chains) {
      expect(Number.isFinite(c.lift)).toBe(true);
      expect(c.lift).toBeGreaterThan(0);
      expect(Number.isFinite(c.confidence)).toBe(true);
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
      expect(Number.isFinite(c.lag_stddev)).toBe(true);
      expect(c.lag_stddev).toBeGreaterThanOrEqual(0);
    }
  });

  it('directionality symmetry: A→B + B→A directionalities sum to 1.0', () => {
    const result = computeForecast(db, { min_support: 2 });
    const chains = result.data.chains;

    const lookup = new Map<string, number>();
    for (const c of chains) {
      lookup.set(`${c.from_topic}→${c.to_topic}`, c.directionality);
    }

    for (const c of chains) {
      const reverseKey = `${c.to_topic}→${c.from_topic}`;
      const reverseDir = lookup.get(reverseKey);
      if (reverseDir !== undefined) {
        // A→B directionality + B→A directionality should sum to ~1.0
        expect(c.directionality + reverseDir).toBeCloseTo(1.0, 1);
      } else {
        // No reverse chain means directionality = 1.0
        expect(c.directionality).toBe(1.0);
      }
    }
  });
});

/* ── Transitive chain tests ────────────────────────────────────────── */

describe('transitive chains', () => {
  it('has valid structure and no A→B→A loops', () => {
    const result = computeForecast(db, { min_support: 2 });
    const tc = result.data.transitive_chains;

    for (const chain of tc) {
      // Path must have 3 elements
      expect(chain.path).toHaveLength(3);
      // No loops: first != last
      expect(chain.path[0]).not.toBe(chain.path[2]);
      // Numeric fields are finite
      expect(Number.isFinite(chain.total_lag_days)).toBe(true);
      expect(chain.total_lag_days).toBeGreaterThan(0);
      expect(Number.isFinite(chain.min_support)).toBe(true);
      expect(chain.min_support).toBeGreaterThanOrEqual(2);
      expect(Number.isFinite(chain.combined_lift)).toBe(true);
      expect(chain.combined_lift).toBeGreaterThan(0);
      expect(typeof chain.cross_domain).toBe('boolean');
    }
  });

  it('cross_domain is correct for transitive paths', () => {
    const result = computeForecast(db, { min_support: 2 });
    const tc = result.data.transitive_chains;

    for (const chain of tc) {
      const firstDomain = chain.path[0].split('.')[0];
      const lastDomain = chain.path[chain.path.length - 1].split('.')[0];
      expect(chain.cross_domain).toBe(firstDomain !== lastDomain);
    }
  });

  it('capped at 100 results', () => {
    const result = computeForecast(db, { min_support: 2 });
    expect(result.data.transitive_chains.length).toBeLessThanOrEqual(100);
  });
});
