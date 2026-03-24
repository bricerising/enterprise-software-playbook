import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import {
  tokenize,
  computeIDF,
  buildCorpusIDF,
  matchesTopicBM25,
  BM25_THRESHOLDS,
  BM25_SIGMOID_MIDPOINT,
  BM25_SIGMOID_TEMPERATURE,
  type TopicDefExtended,
  type BM25Result,
} from './bm25.js';
import { computeCorpusIDF, vectorize } from './tfidf.js';
import type { ClassifierModel } from './classifier.js';

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
let topicThresholds: Map<string, number> = new Map();

// --- Statistical model ensemble state ---
let statModel: ClassifierModel | null = null;
let statVocabulary: Map<string, number> | null = null;
let statIdf: number[] | null = null;

/** Ensemble boost/penalize factor when stat model agrees/disagrees with BM25 (v3 fallback). */
const STAT_ENSEMBLE_FACTOR = 0.15;

/** Minimum LR sigmoid probability for LR-only topics (BM25 missed). */
const LR_ONLY_MIN_PROB = 0.7;

/**
 * Inverse BM25 sigmoid: convert a probability in (0,1) back to BM25 raw-score scale.
 * Inverse of: p = 1 / (1 + exp(-(score - midpoint) / temperature))
 */
function inverseSigmoid(prob: number): number {
  // Clamp to avoid log(0) or log(negative)
  const p = Math.min(Math.max(prob, 1e-6), 1 - 1e-6);
  return -Math.log(1 / p - 1) * BM25_SIGMOID_TEMPERATURE + BM25_SIGMOID_MIDPOINT;
}

/**
 * Load a serialized statistical classifier model for ensemble scoring.
 * Returns true if loaded successfully, false if file not found.
 */
export function loadStatModel(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as ClassifierModel;
    if (raw.version < 3) {
      console.error(`[intel] Skipping model ${filePath}: version ${raw.version} (need ≥3, re-train with logistic regression)`);
      return false;
    }
    statModel = raw;
    statVocabulary = new Map(Object.entries(raw.vocabulary));
    statIdf = raw.idf;
    return true;
  } catch {
    statModel = null;
    statVocabulary = null;
    statIdf = null;
    return false;
  }
}

/** Clear loaded stat model (for testing). */
export function clearStatModel(): void {
  statModel = null;
  statVocabulary = null;
  statIdf = null;
}

/** Check if a stat model is loaded (for testing). */
export function hasStatModel(): boolean {
  return statModel !== null;
}

// Backward-compatible aliases
export const loadCNBModel = loadStatModel;
export const clearCNBModel = clearStatModel;
export const hasCNBModel = hasStatModel;

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

/** Replace the cached IDF with an externally-computed IDF (e.g., corpus-derived). */
export function setCachedIdf(idf: Map<string, number>): void {
  cachedIdf = idf;
}

/**
 * Load corpus IDF from a JSON file. Falls back to bootstrap IDF for
 * any keyword tokens not present in the corpus.
 * Returns true if file was loaded, false if not found.
 */
export function loadCorpusIDF(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, number>;
    const corpusIdf = new Map(Object.entries(raw));
    // Merge: corpus IDF takes precedence, bootstrap fills gaps
    for (const [token, val] of cachedIdf) {
      if (!corpusIdf.has(token)) {
        corpusIdf.set(token, val);
      }
    }
    cachedIdf = corpusIdf;
    return true;
  } catch {
    return false;
  }
}

/**
 * Load per-topic score thresholds from a JSON file.
 * Each topic gets an individually optimized threshold instead of the global default.
 * Returns true if file was loaded, false if not found.
 */
export function loadTopicThresholds(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, number>;
    topicThresholds = new Map(Object.entries(raw));
    return true;
  } catch {
    return false;
  }
}

/** Set per-topic thresholds directly (for testing). */
export function setTopicThresholds(thresholds: Map<string, number>): void {
  topicThresholds = thresholds;
}

/** Get per-topic thresholds map. */
export function getTopicThresholds(): Map<string, number> {
  return topicThresholds;
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

  // Phase 2+3: Statistical model ensemble — blend LR scores with BM25
  if (statModel && statVocabulary && statIdf) {
    const statVector = vectorize(tokens, statVocabulary, statIdf, true);
    const bm25TopicIds = new Set(scored.map((r) => r.topicId));

    // Compute LR sigmoid probability for each topic
    const lrProbs = new Map<string, number>();
    for (const [topicId, topicClassifier] of Object.entries(statModel.classifiers)) {
      let lrScore = topicClassifier.bias;
      for (const [idx, val] of statVector) {
        const weight = topicClassifier.weights[idx] ?? 0;
        lrScore += val * weight;
      }
      // Convert raw logit to sigmoid probability
      lrProbs.set(topicId, 1 / (1 + Math.exp(-lrScore)));
    }

    // Phase 3a: Blend scores for topics already in BM25 results
    // Uses multiplicative approach: LR confidence scaled by alpha nudges BM25 score.
    // This avoids sigmoid saturation issues that occur with probability-space blending
    // at extreme BM25 scores (where sigmoid → 1.0 makes round-tripping lossy).
    for (const result of scored) {
      const topicClassifier = statModel.classifiers[result.topicId];
      if (!topicClassifier) continue;

      const lrProb = lrProbs.get(result.topicId) ?? 0;
      const alpha = topicClassifier.blend_alpha ?? STAT_ENSEMBLE_FACTOR;

      // Map LR prob [0,1] to boost factor [-alpha, +alpha]
      const lrBoost = alpha * (2 * lrProb - 1);
      result.score *= 1 + lrBoost;
      const bm25Prob = 1 / (1 + Math.exp(-(result.score - BM25_SIGMOID_MIDPOINT) / BM25_SIGMOID_TEMPERATURE));
      result.confidence = Math.round(Math.min(1.0, bm25Prob) * 1000) / 1000;
    }

    // Phase 3b: LR-only topics (BM25 missed) — surface if LR is confident enough
    for (const [topicId, topicClassifier] of Object.entries(statModel.classifiers)) {
      if (bm25TopicIds.has(topicId)) continue;

      const lrProb = lrProbs.get(topicId) ?? 0;
      if (lrProb < LR_ONLY_MIN_PROB) continue;

      const alpha = topicClassifier.blend_alpha ?? STAT_ENSEMBLE_FACTOR;
      const blended = alpha * lrProb;
      const blendedScore = inverseSigmoid(blended);

      scored.push({
        topicId,
        score: blendedScore,
        confidence: Math.round(Math.min(1.0, blended) * 1000) / 1000,
        matched: true,
        suppressed: false,
      });
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
