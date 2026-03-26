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
let topicById: Map<string, TopicDefExtended> = new Map();
// --- Statistical model ensemble state ---
let statModel: ClassifierModel | null = null;
let statVocabulary: Map<string, number> | null = null;
let statIdf: number[] | null = null;


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
    if (!raw.training_meta?.bm25_val_includes_title) {
      console.warn(`[intel] Model ${filePath} was trained without title-boosted BM25 validation; blend_alpha values may be miscalibrated. Re-train to fix.`);
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

/** Return metadata about the loaded stat model, or null if none loaded. */
export function getStatModelMeta(): {
  version: number;
  created_at: string;
  training_date: string | null;
  vocabulary_size: number;
  num_classifiers: number;
  topic_ids: string[];
} | null {
  if (!statModel) return null;
  return {
    version: statModel.version,
    created_at: statModel.created_at,
    training_date: statModel.training_meta?.training_date ?? null,
    vocabulary_size: Object.keys(statModel.vocabulary).length,
    num_classifiers: Object.keys(statModel.classifiers).length,
    topic_ids: Object.keys(statModel.classifiers),
  };
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

  loadedTopics = (parsed.topics ?? []).map((t) => {
    const negKeywords = t.negative_keywords
      ? t.negative_keywords.map((k) => k.toLowerCase())
      : undefined;
    const ctxTerms = (t.context_terms ?? []).map((c) => c.toLowerCase());

    // Pre-tokenize negative keywords and context terms for classify perf (CR-04)
    let negTokens: Set<string> | undefined;
    if (negKeywords && negKeywords.length > 0) {
      negTokens = new Set<string>();
      for (const nk of negKeywords) {
        for (const tok of tokenize(nk)) negTokens.add(tok);
      }
    }
    let ctxTokens: Set<string> | undefined;
    if (ctxTerms.length > 0) {
      ctxTokens = new Set<string>();
      for (const ct of ctxTerms) {
        for (const tok of tokenize(ct)) ctxTokens.add(tok);
      }
    }

    return {
      id: t.id,
      label: t.label,
      keywords: (t.keywords ?? []).map((k) => k.toLowerCase()),
      negative_keywords: negKeywords,
      context_required: t.context_required,
      context_terms: ctxTerms,
      priority: t.priority ?? 50,
      _negTokens: negTokens,
      _ctxTokens: ctxTokens,
    };
  });

  // Build lookup map
  topicById = new Map(loadedTopics.map((t) => [t.id, t]));

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

  // --- Path A: LR-primary (topics with trained LR classifiers) ---
  const lrResults: ClassifiedTopic[] = [];

  if (statModel && statVocabulary && statIdf) {
    const statVector = vectorize(tokens, statVocabulary, statIdf, true);
    const lrTopicIds = new Set(Object.keys(statModel.classifiers));

    for (const [topicId, topicClassifier] of Object.entries(statModel.classifiers)) {
      // Compute raw logit: dot(w, x) + bias
      let logit = topicClassifier.bias;
      for (const [idx, val] of statVector) {
        const weight = topicClassifier.weights[idx] ?? 0;
        logit += val * weight;
      }

      // Gate by per-topic score_threshold (raw logit, optimized for F1 during training)
      const threshold = topicClassifier.score_threshold ?? 0;
      if (logit < threshold) continue;
      const confidence = 1 / (1 + Math.exp(-logit));

      // Apply negative keyword + context_required guards
      const topicDef = topicById.get(topicId);
      if (topicDef) {
        if (topicDef._negTokens && topicDef._negTokens.size > 0) {
          if (tokens.some((t) => topicDef._negTokens!.has(t))) continue;
        }
        if (topicDef.context_required && topicDef._ctxTokens && topicDef._ctxTokens.size > 0) {
          if (!tokens.some((t) => topicDef._ctxTokens!.has(t))) continue;
        }
      }

      lrResults.push({
        id: topicId,
        confidence: Math.round(confidence * 1000) / 1000,
        score: logit, // raw logit for training DB debugging
      });
    }

    // --- Path B: BM25-fallback (topics WITHOUT LR classifiers) ---
    const bm25Results: ClassifiedTopic[] = [];
    for (const td of loadedTopics) {
      if (lrTopicIds.has(td.id)) continue; // LR handles this topic

      const result = matchesTopicBM25(title, content, td, cachedIdf, {
        tokens,
        titleTokens,
        avgDocLen: 150,
      });
      if (result.matched && !result.suppressed) {
        const weight = topicWeights.get(td.id) ?? 1.0;
        const weightedScore = result.score * weight;
        if (weightedScore < BM25_THRESHOLDS[0]) continue; // flat minimum for BM25 fallback

        bm25Results.push({
          id: td.id,
          confidence: Math.round(
            Math.min(1.0, result.confidence * weight) * 1000,
          ) / 1000,
          score: weightedScore,
        });
      }
    }

    // --- Merge: combine both paths, sort by confidence descending, take top-N ---
    const merged = [...lrResults, ...bm25Results];
    merged.sort((a, b) => b.confidence - a.confidence);
    return merged.slice(0, maxTopics);
  }

  // --- No-model fallback: all topics use BM25 with escalating threshold gate ---
  const scored: BM25Result[] = [];
  for (const td of loadedTopics) {
    const result = matchesTopicBM25(title, content, td, cachedIdf, {
      tokens,
      titleTokens,
      avgDocLen: 150,
    });
    if (result.matched && !result.suppressed) {
      const weight = topicWeights.get(td.id) ?? 1.0;
      result.score *= weight;
      result.confidence = Math.round(
        Math.min(1.0, result.confidence * weight) * 1000,
      ) / 1000;
      scored.push(result);
    }
  }

  scored.sort((a, b) => b.score - a.score);

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
      break;
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
