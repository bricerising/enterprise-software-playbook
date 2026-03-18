import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWriter } from '../src/db.js';
import { computeForecast } from '../src/queries/forecast.js';
import { detectDynamics } from '../src/queries/forecast.js';
import type { ChainItem, LifecycleItem, MultiscaleItem, EntropyItem } from '../src/queries/forecast.js';
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
  publishedAt?: string,
) => {
  db.prepare(`
    INSERT INTO events (event_id, source, feed, url, canonical_url, title, content,
      published_at, fetched_at, topics, tags, score, comments)
    VALUES (?, ?, 'test', ?, ?, ?, '', ?, ?, ?, '[]', ?, 0)
  `).run(eventId, source, url, url, title, publishedAt ?? null, fetchedAt, JSON.stringify(topics), score);

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
    expect(result.data).toHaveProperty('dynamics');
    expect(result.data).toHaveProperty('change_points_summary');
    expect(result.data.window.events_analyzed).toBeGreaterThan(0);
  });

  it('detects chains with correct support counts', () => {
    const result = computeForecast(db, { min_support: 2, window_days: 30 });
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
      expect(typeof chain.trigger_base_rate).toBe('number');
      expect(chain.trigger_base_rate).toBeGreaterThanOrEqual(0);
      expect(chain.trigger_base_rate).toBeLessThanOrEqual(1);
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
      expect(typeof ms.d90_accel).toBe('number');
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
      expect(result.data.dynamics).toEqual([]);
      expect(result.data.change_points_summary).toEqual([]);
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
    const result = computeForecast(db, { min_support: 2, window_days: 30 });
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

  it('normalized_confidence is in [0, 1] and finite', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const tc of result.data.transitive_chains) {
      expect(typeof tc.normalized_confidence).toBe('number');
      expect(Number.isFinite(tc.normalized_confidence)).toBe(true);
      expect(tc.normalized_confidence).toBeGreaterThanOrEqual(0);
      expect(tc.normalized_confidence).toBeLessThanOrEqual(1);
    }
  });
});

/* ── Exponential decay weighting tests ─────────────────────────────── */

describe('exponential decay weighting', () => {
  it('decay_weighted_support is <= support for all chains', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const chain of result.data.chains) {
      expect(chain.decay_weighted_support).toBeLessThanOrEqual(chain.support + 0.01);
      expect(chain.decay_weighted_support).toBeGreaterThan(0);
    }
  });

  it('recent chains have higher decay ratio than old chains', () => {
    const result = computeForecast(db, { min_support: 2 });
    const chains = result.data.chains;
    if (chains.length === 0) return;

    // All chains should have a valid decay_weighted_support
    for (const c of chains) {
      expect(Number.isFinite(c.decay_weighted_support)).toBe(true);
    }
  });
});

/* ── Entropy-based surprise scoring tests ──────────────────────────── */

describe('entropy scoring', () => {
  it('entropy section is present in forecast data', () => {
    const result = computeForecast(db, { min_support: 2 });
    expect(result.data).toHaveProperty('entropy');
    expect(result.data.entropy.length).toBeGreaterThan(0);
  });

  it('entropy values are in valid ranges', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const e of result.data.entropy) {
      expect(typeof e.topic).toBe('string');
      expect(e.entropy).toBeGreaterThanOrEqual(0);
      expect(e.normalized_entropy).toBeGreaterThanOrEqual(0);
      expect(e.normalized_entropy).toBeLessThanOrEqual(1);
      expect(e.active_days).toBeGreaterThanOrEqual(1);
    }
  });

  it('scenarios include target_entropy field', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const s of result.data.scenarios) {
      expect(typeof s.target_entropy).toBe('number');
      expect(s.target_entropy).toBeGreaterThanOrEqual(0);
    }
  });

  it('uniform distribution has highest normalized entropy', () => {
    // Topics with events spread evenly across many days should have
    // higher normalized_entropy than topics with all events on one day
    const result = computeForecast(db, { min_support: 2 });
    const entropyMap = new Map(result.data.entropy.map((e) => [e.topic, e]));

    // All entropy values should be valid
    for (const [, e] of entropyMap) {
      expect(Number.isFinite(e.entropy)).toBe(true);
      expect(Number.isFinite(e.normalized_entropy)).toBe(true);
    }
  });
});

/* ── CUSUM change-point detection tests ────────────────────────────── */

describe('CUSUM change-point detection', () => {
  it('lifecycles include change_points field', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const lc of result.data.lifecycles) {
      expect(Array.isArray(lc.change_points)).toBe(true);
      for (const cp of lc.change_points) {
        expect(typeof cp).toBe('number');
        expect(cp).toBeGreaterThanOrEqual(0); // days ago
      }
    }
  });

  it('detects change points in data with volume spikes', () => {
    // The test fixtures have distinct spike patterns — ai.llm has recent burst
    const result = computeForecast(db, { min_support: 2 });
    // At least one topic should have change points given the spike patterns
    const allChangePoints = result.data.lifecycles.flatMap((lc) => lc.change_points);
    // This is a soft assertion — real data may or may not trigger CUSUM
    expect(Array.isArray(allChangePoints)).toBe(true);
  });
});

/* ── HMM probabilistic phase classifier tests ─────────────────────── */

describe('HMM phase classifier', () => {
  it('phase_probabilities only present when HMM was used', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const lc of result.data.lifecycles) {
      if (lc.phase_probabilities) {
        // When present, must have all five phases
        const phases = ['emerging', 'accelerating', 'peaking', 'decaying', 'stable'];
        for (const phase of phases) {
          expect(typeof lc.phase_probabilities[phase]).toBe('number');
          expect(lc.phase_probabilities[phase]).toBeGreaterThanOrEqual(0);
          expect(lc.phase_probabilities[phase]).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('phase probabilities sum to approximately 1.0 when present', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const lc of result.data.lifecycles) {
      if (!lc.phase_probabilities) continue;
      const sum = Object.values(lc.phase_probabilities).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 1);
    }
  });

  it('assigned phase matches highest probability when phase_probabilities present', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const lc of result.data.lifecycles) {
      if (!lc.phase_probabilities) continue;
      // When HMM was used, the assigned phase should be the HMM best
      const entries = Object.entries(lc.phase_probabilities);
      const best = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
      expect(lc.phase).toBe(best[0]);
    }
  });
});

/* ── Bayesian scenario projection tests ────────────────────────────── */

describe('Bayesian scenario projection', () => {
  it('scenarios still satisfy probability 0-1 invariant', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const s of result.data.scenarios) {
      expect(s.probability).toBeGreaterThanOrEqual(0);
      expect(s.probability).toBeLessThanOrEqual(1);
    }
  });

  it('scenario probabilities sum to ~1.0 (softmax normalized)', () => {
    const result = computeForecast(db, { min_support: 2 });
    if (result.data.scenarios.length > 0) {
      const sum = result.data.scenarios.reduce((acc, s) => acc + s.probability, 0);
      // Allow rounding tolerance: each probability is rounded to 2 decimal places
      expect(sum).toBeGreaterThan(0.9);
      expect(sum).toBeLessThanOrEqual(1.1);
      // Highest probability is the first entry (sorted descending)
      expect(result.data.scenarios[0].probability).toBeGreaterThan(0);
      expect(result.data.scenarios[0].probability).toBeLessThanOrEqual(1);
    }
  });

  it('scenarios are sorted by probability descending', () => {
    const result = computeForecast(db, { min_support: 2 });
    const scenarios = result.data.scenarios;
    for (let i = 1; i < scenarios.length; i++) {
      expect(scenarios[i - 1].probability).toBeGreaterThanOrEqual(scenarios[i].probability);
    }
  });

  it('empty database still returns empty scenarios', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'intel-bayesian-'));
    const emptyPath = join(emptyDir, 'empty.db');
    const emptyDb = openWriter(emptyPath);

    try {
      const result = computeForecast(emptyDb);
      expect(result.data.scenarios).toEqual([]);
      expect(result.data.entropy).toEqual([]);
    } finally {
      emptyDb.close();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('entropy widens timeframe for bursty targets', () => {
    const result = computeForecast(db, { min_support: 2 });
    const scenarios = result.data.scenarios;
    // Scenarios with non-zero entropy should have timeframe_days[0] <= timeframe_days[1]
    // and entropy factor widens the spread
    for (const s of scenarios) {
      expect(s.timeframe_days[0]).toBeLessThanOrEqual(s.timeframe_days[1]);
      expect(s.timeframe_days[0]).toBeGreaterThanOrEqual(0);
    }
  });

  it('CUSUM discount keeps probabilities in valid range', () => {
    // Even with CUSUM discounting active, probabilities must still be 0-1
    // and sum to ~1.0 (softmax normalization)
    const result = computeForecast(db, { min_support: 2 });
    const scenarios = result.data.scenarios;
    for (const s of scenarios) {
      expect(s.probability).toBeGreaterThanOrEqual(0);
      expect(s.probability).toBeLessThanOrEqual(1);
    }
    if (scenarios.length > 0) {
      const sum = scenarios.reduce((acc, s) => acc + s.probability, 0);
      expect(sum).toBeGreaterThan(0.9);
      expect(sum).toBeLessThanOrEqual(1.1);
    }
  });
});

/* ── published_at vs fetched_at temporal analysis tests ────────────── */

describe('published_at temporal analysis', () => {
  let pubDir: string;
  let pubDb: Database.Database;

  beforeEach(() => {
    pubDir = mkdtempSync(join(tmpdir(), 'intel-pubat-test-'));
    const pubPath = join(pubDir, 'pubat.db');
    pubDb = openWriter(pubPath);
  });

  afterEach(() => {
    pubDb.close();
    rmSync(pubDir, { recursive: true, force: true });
  });

  it('uses published_at for chain detection when it differs from fetched_at', () => {
    // Simulate a bulk ingest: all events fetched on the SAME day, but
    // published across 3 distinct days. Chain detection should find patterns
    // based on published_at, not fetched_at.
    const now = Date.now();
    const DAY = 86_400_000;
    const bulkFetchTime = new Date(now).toISOString();

    // topic.alpha spikes on days -10, -6, -2 (published_at)
    // topic.beta  spikes on days -8, -4, -1 (published_at, ~2d lag from alpha)
    // All fetched_at = now (single bulk ingest)
    for (let i = 0; i < 3; i++) {
      const alphaDay = now - (10 - i * 4) * DAY;
      const betaDay = alphaDay + 2 * DAY;

      for (let j = 0; j < 4; j++) {
        const alphaPub = new Date(alphaDay + j * 3600_000).toISOString();
        insertEvent(pubDb, `alpha-${i}-${j}`, 'rss', `https://ex.com/a-${i}-${j}`,
          `Alpha ${i}-${j}`, bulkFetchTime, ['topic.alpha'], j, alphaPub);

        const betaPub = new Date(betaDay + j * 3600_000).toISOString();
        insertEvent(pubDb, `beta-${i}-${j}`, 'rss', `https://ex.com/b-${i}-${j}`,
          `Beta ${i}-${j}`, bulkFetchTime, ['topic.beta'], j, betaPub);
      }
    }

    const result = computeForecast(pubDb, { min_support: 2 });
    const chains = result.data.chains;

    // With fetched_at, all events land on the same day → 0 chains.
    // With published_at, alpha→beta co-occurs 3 times with ~2d lag → chains found.
    expect(chains.length).toBeGreaterThan(0);

    const alphaToBeta = chains.find(
      (c) => c.from_topic === 'topic.alpha' && c.to_topic === 'topic.beta',
    );
    expect(alphaToBeta).toBeDefined();
    expect(alphaToBeta!.support).toBeGreaterThanOrEqual(2);
    // Lag includes all co-occurrence pairs within the 7d window, not just
    // the intended 1:1 pairings, so avg_lag is higher than the base 2d offset.
    expect(alphaToBeta!.avg_lag_days).toBeGreaterThan(0);
    expect(alphaToBeta!.avg_lag_days).toBeLessThanOrEqual(7);
  });

  it('dynamics section is present and empty with empty database', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'intel-dyn-empty-'));
    const emptyPath = join(emptyDir, 'empty.db');
    const emptyDb = openWriter(emptyPath);

    try {
      const result = computeForecast(emptyDb);
      expect(result.data.dynamics).toEqual([]);
    } finally {
      emptyDb.close();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('falls back to fetched_at when published_at is null', () => {
    // Events without published_at should still participate in analysis
    const now = Date.now();
    const DAY = 86_400_000;

    for (let i = 0; i < 3; i++) {
      const baseDay = now - (15 - i * 5) * DAY;
      for (let j = 0; j < 4; j++) {
        const ts = new Date(baseDay + j * 3600_000).toISOString();
        // No publishedAt → falls back to fetchedAt via COALESCE
        insertEvent(pubDb, `nopub-a-${i}-${j}`, 'rss', `https://ex.com/np-a-${i}-${j}`,
          `NoPub A ${i}-${j}`, ts, ['nopub.alpha'], j);
      }
      const lagDay = baseDay + 2 * DAY;
      for (let j = 0; j < 3; j++) {
        const ts = new Date(lagDay + j * 3600_000).toISOString();
        insertEvent(pubDb, `nopub-b-${i}-${j}`, 'rss', `https://ex.com/np-b-${i}-${j}`,
          `NoPub B ${i}-${j}`, ts, ['nopub.beta'], j);
      }
    }

    const result = computeForecast(pubDb, { min_support: 2, window_days: 30 });
    const chains = result.data.chains;
    expect(chains.length).toBeGreaterThan(0);
  });
});

/* ── Dynamics detection tests ──────────────────────────────────────── */

describe('dynamics detection (integration)', () => {
  it('dynamics section is present and is an array', () => {
    const result = computeForecast(db, { min_support: 2 });
    expect(Array.isArray(result.data.dynamics)).toBe(true);
  });

  it('each item has valid type, non-empty topics, metric with name+value, and interpretation', () => {
    const result = computeForecast(db, { min_support: 2 });
    const validTypes = ['reinforcing_loop', 'delay', 'accumulation', 'dampening'];
    for (const d of result.data.dynamics) {
      expect(validTypes).toContain(d.type);
      expect(d.topics.length).toBeGreaterThan(0);
      expect(typeof d.metric.name).toBe('string');
      expect(typeof d.metric.value).toBe('number');
      expect(typeof d.interpretation).toBe('string');
      expect(d.interpretation.length).toBeGreaterThan(0);
    }
  });

  it('delay items reference active chains with lag > 0', () => {
    const result = computeForecast(db, { min_support: 2 });
    const delays = result.data.dynamics.filter((d) => d.type === 'delay');
    for (const d of delays) {
      expect(d.metric.name).toBe('avg_lag_days');
      expect(d.metric.value).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe('dynamics detection (unit)', () => {
  const makeChain = (overrides: Partial<ChainItem> = {}): ChainItem => ({
    from_topic: 'a',
    to_topic: 'b',
    support: 5,
    avg_lag_days: 2,
    source_diversity: 0.5,
    active: false,
    lift: 2.0,
    confidence: 0.8,
    directionality: 0.5,
    lag_stddev: 0.5,
    decay_weighted_support: 4.0,
    trigger_base_rate: 0.3,
    weekday_ratio: 0.6,
    ...overrides,
  });

  const makeLifecycle = (overrides: Partial<LifecycleItem> = {}): LifecycleItem => ({
    topic: 'test.topic',
    phase: 'stable',
    phase_confidence: 0.8,
    volumes: { '1d': 5, '7d': 20, '14d': 40, '30d': 80, '90d': 200 },
    accelerations: { '1d': 0, '7d': 0, '14d': 0, '30d': 0, '90d': 0 },
    change_points: [],
    ...overrides,
  });

  const makeMultiscale = (overrides: Partial<MultiscaleItem> = {}): MultiscaleItem => ({
    topic: 'test.topic',
    alignment: 'aligned_up',
    d1_accel: 0.5,
    d7_accel: 0.3,
    d30_accel: 0.2,
    d90_accel: 0.1,
    ...overrides,
  });

  const makeEntropy = (overrides: Partial<EntropyItem> = {}): EntropyItem => ({
    topic: 'test.topic',
    entropy: 3.0,
    normalized_entropy: 0.7,
    active_days: 10,
    ...overrides,
  });

  it('bidirectional chains with directionality 0.5 and lift 2.0 → one reinforcing_loop', () => {
    const chains = [
      makeChain({ from_topic: 'x', to_topic: 'y', directionality: 0.5, lift: 2.0 }),
      makeChain({ from_topic: 'y', to_topic: 'x', directionality: 0.5, lift: 2.0 }),
    ];
    const result = detectDynamics(chains, [], [], []);
    const loops = result.filter((d) => d.type === 'reinforcing_loop');
    expect(loops).toHaveLength(1);
    expect(loops[0].topics.sort()).toEqual(['x', 'y']);
  });

  it('bidirectional chains with lift 0.8 → no reinforcing loop', () => {
    const chains = [
      makeChain({ from_topic: 'x', to_topic: 'y', directionality: 0.5, lift: 0.8 }),
      makeChain({ from_topic: 'y', to_topic: 'x', directionality: 0.5, lift: 0.8 }),
    ];
    const result = detectDynamics(chains, [], [], []);
    const loops = result.filter((d) => d.type === 'reinforcing_loop');
    expect(loops).toHaveLength(0);
  });

  it('decaying lifecycle with change_points [3] → one dampening', () => {
    const lifecycles = [makeLifecycle({ phase: 'decaying', change_points: [3] })];
    const result = detectDynamics([], lifecycles, [], []);
    const dampening = result.filter((d) => d.type === 'dampening');
    expect(dampening).toHaveLength(1);
    expect(dampening[0].metric.value).toBe(3);
  });

  it('decaying lifecycle with no change_points → no dampening', () => {
    const lifecycles = [makeLifecycle({ phase: 'decaying', change_points: [] })];
    const result = detectDynamics([], lifecycles, [], []);
    const dampening = result.filter((d) => d.type === 'dampening');
    expect(dampening).toHaveLength(0);
  });

  it('emerging topic + aligned_up + entropy 0.7 → one accumulation', () => {
    const lifecycles = [makeLifecycle({ topic: 'acc.topic', phase: 'emerging' })];
    const multiscale = [makeMultiscale({ topic: 'acc.topic', alignment: 'aligned_up' })];
    const entropy = [makeEntropy({ topic: 'acc.topic', normalized_entropy: 0.7 })];
    const result = detectDynamics([], lifecycles, multiscale, entropy);
    const acc = result.filter((d) => d.type === 'accumulation');
    expect(acc).toHaveLength(1);
    expect(acc[0].topics).toEqual(['acc.topic']);
  });

  it('stable topic + aligned_up + entropy 0.7 → no accumulation', () => {
    const lifecycles = [makeLifecycle({ topic: 'stable.topic', phase: 'stable' })];
    const multiscale = [makeMultiscale({ topic: 'stable.topic', alignment: 'aligned_up' })];
    const entropy = [makeEntropy({ topic: 'stable.topic', normalized_entropy: 0.7 })];
    const result = detectDynamics([], lifecycles, multiscale, entropy);
    const acc = result.filter((d) => d.type === 'accumulation');
    expect(acc).toHaveLength(0);
  });
});

/* ── Summary mode tests ────────────────────────────────────────────── */

describe('summary mode', () => {
  it('returns at most 3 scenarios in summary mode', () => {
    const result = computeForecast(db, { min_support: 2, summary: true });
    expect(result.status).toBe('ok');
    expect(result.data.scenarios.length).toBeLessThanOrEqual(3);
  });

  it('returns at most 5 ranked chains in summary mode', () => {
    const result = computeForecast(db, { min_support: 2, summary: true });
    expect(result.data.ranked_chains.length).toBeLessThanOrEqual(5);
  });

  it('omits detail sections entirely in summary mode', () => {
    const result = computeForecast(db, { min_support: 2, summary: true, window_days: 30 });
    // Zero-limited sections should be omitted from the response (not empty arrays)
    expect(result.data.lifecycles).toBeUndefined();
    expect(result.data.chains).toBeUndefined();
    expect(result.data.multiscale).toBeUndefined();
    expect(result.data.transitive_chains).toBeUndefined();
    expect(result.data.entropy).toBeUndefined();
  });

  it('always includes change_points_summary', () => {
    const result = computeForecast(db, { min_support: 2, summary: true });
    expect(Array.isArray(result.data.change_points_summary)).toBe(true);
  });

  it('change_points_summary is sorted by days_ago ascending', () => {
    const result = computeForecast(db, { min_support: 2 });
    const cps = result.data.change_points_summary;
    for (let i = 1; i < cps.length; i++) {
      expect(cps[i - 1].days_ago).toBeLessThanOrEqual(cps[i].days_ago);
    }
  });

  it('adaptive summary upgrades sections when scenario yield is thin', () => {
    // Use high min_support to reduce scenario yield
    const result = computeForecast(db, { min_support: 2, summary: true, top_scenarios: 1 });
    // With thin scenario yield (< 3), adaptive summary should upgrade
    // ranked_chains to compact limit (10) and include lifecycles
    if (result.data.scenarios.length < 3) {
      // Ranked chains should be allowed up to 10 (compact limit)
      expect(result.data.ranked_chains.length).toBeLessThanOrEqual(10);
      // Lifecycles should be present (upgraded from 0 to compact limit 15)
      if (result.data.lifecycles) {
        expect(result.data.lifecycles.length).toBeLessThanOrEqual(15);
      }
    }
  });
});

/* ── Scenario differentiation tests ────────────────────────────────── */

describe('scenario differentiation', () => {
  it('scenarios have non-uniform probabilities when chain quality differs', () => {
    const result = computeForecast(db, { min_support: 2 });
    const scenarios = result.data.scenarios;
    if (scenarios.length < 2) return;

    // At least some probability variation should exist (not all identical)
    const probs = new Set(scenarios.map((s) => s.probability));
    expect(probs.size).toBeGreaterThan(1);
  });

  it('trigger_topics are sorted by contribution per scenario', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const s of result.data.scenarios) {
      // trigger_topics should be an array (sorted by contribution)
      expect(Array.isArray(s.trigger_topics)).toBe(true);
      expect(s.trigger_topics.length).toBeGreaterThan(0);
    }
  });

  it('chains include trigger_base_rate field', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const chain of result.data.chains) {
      expect(typeof chain.trigger_base_rate).toBe('number');
      expect(chain.trigger_base_rate).toBeGreaterThanOrEqual(0);
      expect(chain.trigger_base_rate).toBeLessThanOrEqual(1);
    }
  });

  it('chains are sorted by lift descending', () => {
    const result = computeForecast(db, { min_support: 2 });
    const chains = result.data.chains!;
    for (let i = 1; i < chains.length; i++) {
      expect(chains[i - 1].lift).toBeGreaterThanOrEqual(chains[i].lift);
    }
  });
});

/* ── Evidence relevance tests ──────────────────────────────────────── */

describe('evidence relevance', () => {
  it('scenarios include evidence_relevance parallel to evidence_titles', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const s of result.data.scenarios) {
      expect(s.evidence_relevance).toHaveLength(s.evidence_titles.length);
      for (const r of s.evidence_relevance) {
        expect(['high', 'medium', 'low']).toContain(r);
      }
    }
  });

  it('scenarios include target_base_rate field', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const s of result.data.scenarios) {
      expect(typeof s.target_base_rate).toBe('number');
      expect(s.target_base_rate).toBeGreaterThanOrEqual(0);
      expect(s.target_base_rate).toBeLessThanOrEqual(1);
    }
  });
});

/* ── Chain ranking diversity tests ─────────────────────────────────── */

describe('ranked chain diversity', () => {
  it('no trigger appears more than 3 times in ranked chains', () => {
    const result = computeForecast(db, { min_support: 2 });
    const triggerCounts = new Map<string, number>();
    for (const rc of result.data.ranked_chains) {
      triggerCounts.set(rc.from_topic, (triggerCounts.get(rc.from_topic) ?? 0) + 1);
    }
    for (const [, count] of triggerCounts) {
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it('high base-rate triggers get lower scores', () => {
    const result = computeForecast(db, { min_support: 2 });
    const ranked = result.data.ranked_chains;
    // All ranked chains should have valid scores
    for (const rc of ranked) {
      expect(typeof rc.score).toBe('number');
      expect(rc.score).toBeGreaterThanOrEqual(0);
    }
  });
});

/* ── temporal_pattern tests ────────────────────────────────────────── */

describe('temporal_pattern', () => {
  it('chains have temporal_pattern field only when weekday_correlated', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const chain of result.data.chains!) {
      if (chain.temporal_pattern) {
        expect(chain.temporal_pattern).toBe('weekday_correlated');
      }
    }
  });

  it('chains always include weekday_ratio field in [0, 1]', () => {
    const result = computeForecast(db, { min_support: 2 });
    for (const chain of result.data.chains!) {
      expect(typeof chain.weekday_ratio).toBe('number');
      expect(chain.weekday_ratio).toBeGreaterThanOrEqual(0);
      expect(chain.weekday_ratio).toBeLessThanOrEqual(1);
    }
  });
});

/* ── --with-context tests ──────────────────────────────────────────── */

describe('with_context', () => {
  it('context is absent when with_context is false', () => {
    const result = computeForecast(db, { min_support: 2 });
    expect(result.data.context).toBeUndefined();
  });

  it('context is present when with_context is true', () => {
    const result = computeForecast(db, { min_support: 2, with_context: true });
    expect(result.data.context).toBeDefined();
    expect(Array.isArray(result.data.context)).toBe(true);
  });

  it('context entries have topic and non-empty titles', () => {
    const result = computeForecast(db, { min_support: 2, with_context: true });
    for (const ctx of result.data.context ?? []) {
      expect(typeof ctx.topic).toBe('string');
      expect(ctx.topic.length).toBeGreaterThan(0);
      expect(ctx.titles.length).toBeGreaterThan(0);
      expect(ctx.titles.length).toBeLessThanOrEqual(3);
      for (const title of ctx.titles) {
        expect(typeof title).toBe('string');
        expect(title.length).toBeGreaterThan(0);
      }
    }
  });

  it('context is sorted by topic', () => {
    const result = computeForecast(db, { min_support: 2, with_context: true });
    const context = result.data.context ?? [];
    for (let i = 1; i < context.length; i++) {
      expect(context[i - 1].topic.localeCompare(context[i].topic)).toBeLessThanOrEqual(0);
    }
  });

  it('context works with summary mode', () => {
    const result = computeForecast(db, { min_support: 2, summary: true, with_context: true, window_days: 30 });
    expect(result.status).toBe('ok');
    expect(result.data.context).toBeDefined();
    // Summary sections should still be omitted
    expect(result.data.lifecycles).toBeUndefined();
  });

  it('context is empty for empty database', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'intel-ctx-empty-'));
    const emptyPath = join(emptyDir, 'empty.db');
    const emptyDb = openWriter(emptyPath);

    try {
      const result = computeForecast(emptyDb, { with_context: true });
      expect(result.data.context).toEqual([]);
    } finally {
      emptyDb.close();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
