import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import {
  tokenize,
  computeIDF,
  matchesTopicBM25,
  BM25_THRESHOLDS,
  type TopicDefExtended,
  type BM25Result,
} from './bm25.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOPICS_PATH = join(__dirname, '..', '..', 'config', 'topics.yaml');

export type { TopicDefExtended };

export interface ClassifiedTopic {
  id: string;
  confidence: number;
  score: number;
}

let loadedTopics: TopicDefExtended[] = [];
let topicWeights: Map<string, number> = new Map();
let cachedIdf: Map<string, number> = new Map();

export function loadTopics(topicsPath?: string, db?: Database.Database): TopicDefExtended[] {
  const path = topicsPath ?? DEFAULT_TOPICS_PATH;
  if (!existsSync(path)) {
    console.error(`[intel] Topics file not found: ${path}`);
    return [];
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as {
    topics: Array<{
      id: string;
      label: string;
      keywords?: string[];
      negative_keywords?: string[];
      regex?: string[]; // ignored — kept for parse compatibility
      priority?: number;
      context_required?: boolean;
      context_terms?: string[];
    }>;
  };

  loadedTopics = (parsed.topics ?? []).map((t) => ({
    id: t.id,
    label: t.label,
    keywords: (t.keywords ?? []).map((k) => k.toLowerCase()),
    negative_keywords: t.negative_keywords
      ? t.negative_keywords.map((k) => k.toLowerCase())
      : undefined,
    context_required: t.context_required,
    context_terms: (t.context_terms ?? []).map((c) => c.toLowerCase()),
    priority: t.priority ?? 50,
  }));

  // Compute bootstrap IDF from topic keyword frequencies
  cachedIdf = computeIDF(loadedTopics);

  // Load learned topic weights from DB if available
  if (db) {
    loadTopicWeights(db);
  }

  return loadedTopics;
}

/** Load learned topic weights from the topic_weights table. */
function loadTopicWeights(db: Database.Database): void {
  topicWeights = new Map();
  try {
    const rows = db.prepare('SELECT topic_id, weight FROM topic_weights').all() as Array<{
      topic_id: string;
      weight: number;
    }>;
    for (const row of rows) {
      topicWeights.set(row.topic_id, row.weight);
    }
  } catch {
    // Table may not exist yet (pre-migration) — use defaults
  }
}

/** Get the current topic weights map (for testing). */
export function getTopicWeights(): Map<string, number> {
  return topicWeights;
}

export function getLoadedTopics(): TopicDefExtended[] {
  return loadedTopics;
}

/** Get the cached IDF map (for testing/external use). */
export function getCachedIdf(): Map<string, number> {
  return cachedIdf;
}

/**
 * Cap on combined title+content length for classification.
 * Longer content (page boilerplate, sidebars, related-article links) triggers
 * false-positive keyword matches across unrelated topics. 3,000 chars ≈ title
 * + first ~500 words, which is sufficient to identify the article's core topics.
 */
const CLASSIFY_TEXT_CAP = 3_000;

/**
 * Classify text into topics with confidence scores using BM25 scoring.
 * Returns up to maxTopics ClassifiedTopic entries, sorted by score (highest first).
 *
 * BM25 flow:
 * 1. Tokenize once (shared across all topics)
 * 2. Score all topics
 * 3. Sort by score descending
 * 4. Apply escalating threshold gate per rank position
 */
export function classify(
  title: string | null,
  content: string | null,
  maxTopics = 5,
): ClassifiedTopic[] {
  if (loadedTopics.length === 0) return [];

  const text = ((title ?? '') + ' ' + (content ?? '')).slice(0, CLASSIFY_TEXT_CAP);
  const tokens = tokenize(text);
  const titleTokens = tokenize((title ?? '').slice(0, 200));

  if (tokens.length === 0) return [];

  // Score all topics
  const scored: BM25Result[] = [];
  for (const td of loadedTopics) {
    const result = matchesTopicBM25(title, content, td, cachedIdf, {
      tokens,
      titleTokens,
      avgDocLen: 150,
    });
    if (result.matched && !result.suppressed) {
      // Apply topic weight from Brier loop
      const weight = topicWeights.get(td.id) ?? 1.0;
      result.score *= weight;
      result.confidence = Math.round(
        Math.min(1.0, result.confidence * weight) * 1000,
      ) / 1000;
      scored.push(result);
    }
  }

  // Sort by score descending (BM25 score already incorporates priority)
  scored.sort((a, b) => b.score - a.score);

  // Apply escalating threshold gate per rank position
  const result: ClassifiedTopic[] = [];
  const thresholdCount = Math.min(scored.length, maxTopics, BM25_THRESHOLDS.length);
  for (let i = 0; i < thresholdCount; i++) {
    if (scored[i].score >= BM25_THRESHOLDS[i]) {
      result.push({
        id: scored[i].topicId,
        confidence: scored[i].confidence,
        score: scored[i].score,
      });
    } else {
      break; // escalating: if rank i fails, rank i+1 cannot pass
    }
  }

  return result;
}

/**
 * Backward-compatible classify that returns topic IDs only.
 */
export function classifyIds(
  title: string | null,
  content: string | null,
  maxTopics = 5,
): string[] {
  return classify(title, content, maxTopics).map((t) => t.id);
}

/**
 * Mulberry32 seeded PRNG. Returns a function that generates pseudo-random
 * numbers in [0, 1). Deterministic: same seed produces same sequence.
 *
 * Used by training set generation for reproducible reservoir sampling.
 */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
