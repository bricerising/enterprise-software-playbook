/**
 * One-vs-rest L2-regularized logistic regression classifier for multi-label topic classification.
 *
 * Replaces CNB (Complement Naive Bayes) which failed due to extreme class imbalance —
 * complement distributions converged, producing near-identical scores for all topics.
 * LR learns a decision boundary directly from positive examples with class weighting.
 *
 * Architecture:
 *   tokens → TF-IDF vector → 66 binary LR classifiers → threshold optimization → top-5 topics
 */

import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tokenize, matchesTopicBM25, computeIDF, BM25_THRESHOLDS, type TopicDefExtended } from './bm25.js';
import { buildVocabularyChiSquared, computeCorpusIDF, vectorize } from './tfidf.js';
import { loadTopics, mulberry32 } from './topic-classifier.js';
import type Database from 'better-sqlite3';

// --- Constants ---

export const MIN_EXAMPLES = 20;
export const MIN_TRAINING_EVENTS = 500;
export const MAX_VOCABULARY = 5_000;
export const SPLIT_SEED = 42;
export const VALIDATION_SPLIT = 0.2;
export const MODEL_STALENESS_DAYS = 90;

// Logistic regression hyperparameters
const LR_LEARNING_RATE = 0.5;
const LR_DECAY = 0.95;
const LR_LAMBDA = 0.001;
const LR_EPOCHS = 30;
const LR_TRAIN_SEED = 123;

// --- Types ---

export interface LogisticClassifier {
  weights: Map<number, number>;
  bias: number;
}

export interface ClassifierModel {
  version: number;
  created_at: string;
  vocabulary: Record<string, number>;
  idf: number[];
  classifiers: Record<
    string,
    {
      weights: Record<number, number>;
      bias: number;
      score_threshold?: number;
      blend_alpha?: number;
      lr_val_f1?: number;
      bm25_val_f1?: number;
    }
  >;
  training_meta: {
    training_db: string;
    num_examples: number;
    num_positive_per_topic: Record<string, number>;
    training_date: string;
  };
}

export interface ClassifierTrainResult {
  model_path: string;
  vocabulary_size: number;
  per_topic: Array<{
    topic: string;
    method: 'logistic' | 'bm25_fallback';
    examples: number;
    val_precision?: number;
    val_recall?: number;
    val_f1?: number;
    reason?: string;
  }>;
  overall_validation: {
    precision: number;
    recall: number;
    f1: number;
  };
}

// --- Training ---

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Train a single binary logistic regression classifier for one topic.
 * Uses SGD with L2 regularization and class-balanced sample weights.
 */
export function trainLogistic(
  vectors: Map<number, number>[],
  labels: boolean[],
  _vocabSize: number,
  opts: { lr?: number; decay?: number; lambda?: number; epochs?: number; seed?: number } = {},
): LogisticClassifier {
  const lr0 = opts.lr ?? LR_LEARNING_RATE;
  const decay = opts.decay ?? LR_DECAY;
  const lambda = opts.lambda ?? LR_LAMBDA;
  const epochs = opts.epochs ?? LR_EPOCHS;
  const seed = opts.seed ?? LR_TRAIN_SEED;

  const N = vectors.length;
  const nPos = labels.filter((l) => l).length;
  const nNeg = N - nPos;

  // Class-balanced sample weights (sklearn "balanced" formula: N / (2 * n_class))
  const posWeight = N / (2 * nPos);
  const negWeight = N / (2 * nNeg);

  // Sparse weight vector
  const weights = new Map<number, number>();
  let bias = 0;
  let currentLr = lr0;

  const rng = mulberry32(seed);
  const indices = Array.from({ length: N }, (_, i) => i);

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Deterministic shuffle
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    for (const idx of indices) {
      const x = vectors[idx];
      const y = labels[idx] ? 1 : 0;

      // Compute dot(w, x) + b
      let z = bias;
      for (const [featIdx, val] of x) {
        z += (weights.get(featIdx) ?? 0) * val;
      }

      const pred = sigmoid(z);
      const error = pred - y;
      const sampleWeight = y === 1 ? posWeight : negWeight;
      const grad = error * sampleWeight;

      // Sparse weight update with L2 regularization
      for (const [featIdx, val] of x) {
        const w = weights.get(featIdx) ?? 0;
        const newW = w - currentLr * (grad * val + lambda * w);
        if (Math.abs(newW) > 1e-10) {
          weights.set(featIdx, newW);
        } else {
          weights.delete(featIdx);
        }
      }

      bias -= currentLr * grad;
    }

    currentLr *= decay;
  }

  return { weights, bias };
}

/**
 * Predict raw logistic regression score for a document vector.
 * Returns raw logit (dot(w, x) + b). Higher = more likely positive class.
 */
export function predictLogistic(
  vector: Map<number, number>,
  classifier: LogisticClassifier,
): number {
  let score = classifier.bias;
  for (const [idx, val] of vector) {
    const w = classifier.weights.get(idx) ?? 0;
    score += w * val;
  }
  return score;
}

/**
 * Find optimal raw score threshold that maximizes F1 on scored data.
 * Requires minimum precision to avoid over-permissive thresholds on imbalanced data.
 */
function findOptimalThreshold(
  scores: number[],
  labels: boolean[],
  minPrecision = 0.10,
): { threshold: number; precision: number; recall: number; f1: number } {
  const totalPos = labels.filter((l) => l).length;
  if (totalPos === 0) return { threshold: Infinity, precision: 0, recall: 0, f1: 0 };

  // Sort by score descending — walk from highest threshold down
  const indexed = scores.map((s, i) => ({ score: s, label: labels[i] }));
  indexed.sort((a, b) => b.score - a.score);

  let tp = 0;
  let fp = 0;
  let bestF1 = 0;
  let bestThreshold = indexed[0].score + 1;
  let bestPrecision = 0;
  let bestRecall = 0;

  for (let i = 0; i < indexed.length; i++) {
    if (indexed[i].label) tp++;
    else fp++;

    const precision = tp / (tp + fp);
    if (precision < minPrecision) continue;

    const fn = totalPos - tp;
    const recall = tp / (tp + fn);
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    if (f1 > bestF1) {
      bestF1 = f1;
      bestThreshold = indexed[i].score;
      bestPrecision = precision;
      bestRecall = recall;
    }
  }

  return { threshold: bestThreshold, precision: bestPrecision, recall: bestRecall, f1: bestF1 };
}

/**
 * Compute BM25 validation F1 for a single topic by running matchesTopicBM25
 * on each validation document and comparing predictions to human labels.
 */
function computeBM25ValF1(
  valDocs: string[][],
  valTopics: string[][],
  topicId: string,
  topicDefs: TopicDefExtended[],
  idf: Map<string, number>,
): { precision: number; recall: number; f1: number } {
  const topicDef = topicDefs.find((t) => t.id === topicId);
  if (!topicDef) return { precision: 0, recall: 0, f1: 0 };

  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < valDocs.length; i++) {
    const tokens = valDocs[i];
    const result = matchesTopicBM25(null, tokens.join(' '), topicDef, idf, {
      tokens,
      titleTokens: [],
      avgDocLen: 150,
    });
    const predicted = result.matched && !result.suppressed && result.score >= BM25_THRESHOLDS[0];
    const actual = valTopics[i].includes(topicId);
    if (predicted && actual) tp++;
    else if (predicted && !actual) fp++;
    else if (!predicted && actual) fn++;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

/**
 * Full training pipeline: load data → build vocab → train LR classifiers → optimize thresholds → serialize.
 */
export function trainClassifier(
  trainingDb: Database.Database,
  opts: {
    outputPath?: string;
    minExamples?: number;
    validationSplit?: number;
  } = {},
): ClassifierTrainResult {
  const minExamples = opts.minExamples ?? MIN_EXAMPLES;
  const validationSplit = opts.validationSplit ?? VALIDATION_SPLIT;

  // Load labeled events
  const rows = trainingDb
    .prepare(
      `SELECT event_id, title, content, human_topics
       FROM training_events
       WHERE reviewed_at IS NOT NULL AND human_topics IS NOT NULL`,
    )
    .all() as Array<{
      event_id: string;
      title: string | null;
      content: string | null;
      human_topics: string;
    }>;

  if (rows.length < MIN_TRAINING_EVENTS) {
    throw new Error(
      `Insufficient training data: ${rows.length} labeled events, minimum ${MIN_TRAINING_EVENTS} required.`,
    );
  }

  // Tokenize all documents
  const documents: string[][] = [];
  const eventTopics: string[][] = [];
  for (const row of rows) {
    const text = ((row.title ?? '') + ' ' + (row.content ?? '')).slice(0, 3000);
    documents.push(tokenize(text));
    eventTopics.push(JSON.parse(row.human_topics));
  }

  // Stratified train/validation split
  const rng = mulberry32(SPLIT_SEED);
  const valIndices = new Set<number>();
  const targetValSize = Math.floor(documents.length * validationSplit);

  // Build per-topic positive index lists
  const topicPositiveIndices = new Map<string, number[]>();
  for (let i = 0; i < eventTopics.length; i++) {
    for (const t of eventTopics[i]) {
      if (!topicPositiveIndices.has(t)) topicPositiveIndices.set(t, []);
      topicPositiveIndices.get(t)!.push(i);
    }
  }

  // Sort topics by rarity (fewest examples first) so rare topics get priority
  const sortedTopicEntries = [...topicPositiveIndices.entries()]
    .sort((a, b) => a[1].length - b[1].length);

  for (const [, indices] of sortedTopicEntries) {
    const numForVal = Math.max(1, Math.round(indices.length * validationSplit));
    const shuffled = [...indices];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let assigned = 0;
    for (const idx of shuffled) {
      if (assigned >= numForVal) break;
      if (!valIndices.has(idx)) {
        valIndices.add(idx);
        assigned++;
      }
    }
  }

  // Fill remaining val slots from unassigned indices if needed
  if (valIndices.size < targetValSize) {
    const unassigned = [];
    for (let i = 0; i < documents.length; i++) {
      if (!valIndices.has(i)) unassigned.push(i);
    }
    for (let i = unassigned.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [unassigned[i], unassigned[j]] = [unassigned[j], unassigned[i]];
    }
    for (const idx of unassigned) {
      if (valIndices.size >= targetValSize) break;
      valIndices.add(idx);
    }
  }

  const trainIndices: number[] = [];
  const valIndicesArr: number[] = [];
  for (let i = 0; i < documents.length; i++) {
    if (valIndices.has(i)) valIndicesArr.push(i);
    else trainIndices.push(i);
  }

  const trainDocs = trainIndices.map((i) => documents[i]);
  const trainTopics = trainIndices.map((i) => eventTopics[i]);
  const valDocs = valIndicesArr.map((i) => documents[i]);
  const valTopics = valIndicesArr.map((i) => eventTopics[i]);

  // Build chi-squared vocabulary from train docs only
  const vocabulary = buildVocabularyChiSquared(trainDocs, trainTopics, MAX_VOCABULARY);
  const idf = computeCorpusIDF(trainDocs, vocabulary);

  // Vectorize with normalize=true — L2-normalized TF-IDF is standard for LR
  const trainVectors = trainDocs.map((doc) => vectorize(doc, vocabulary, idf, true));
  const valVectors = valDocs.map((doc) => vectorize(doc, vocabulary, idf, true));

  // Get all topic IDs
  const allTopics = loadTopics();
  const topicIds = allTopics.map((t) => t.id);

  // Count positive examples per topic
  const positiveCounts = new Map<string, number>();
  for (const topics of trainTopics) {
    for (const t of topics) {
      positiveCounts.set(t, (positiveCounts.get(t) ?? 0) + 1);
    }
  }

  // Compute bootstrap IDF for BM25 validation
  const bm25Idf = computeIDF(allTopics);

  // Train per-topic classifiers
  const classifiers: Record<
    string,
    {
      weights: Record<number, number>;
      bias: number;
      score_threshold: number;
      blend_alpha: number;
      lr_val_f1: number;
      bm25_val_f1: number;
    }
  > = {};
  const perTopicResults: ClassifierTrainResult['per_topic'] = [];
  const valPrecisions: number[] = [];
  const valRecalls: number[] = [];

  for (const topicId of topicIds) {
    const numPositive = positiveCounts.get(topicId) ?? 0;

    if (numPositive < minExamples) {
      perTopicResults.push({
        topic: topicId,
        method: 'bm25_fallback',
        examples: numPositive,
        reason: 'below min_examples threshold',
      });
      continue;
    }

    // Binary labels for this topic
    const trainLabels = trainTopics.map((topics) => topics.includes(topicId));
    const valLabels = valTopics.map((topics) => topics.includes(topicId));

    // Train logistic regression
    const lr = trainLogistic(trainVectors, trainLabels, vocabulary.size);

    // Get raw scores
    const trainScores = trainVectors.map((v) => predictLogistic(v, lr));
    const valScores = valVectors.map((v) => predictLogistic(v, lr));

    // Find optimal threshold on validation scores (unbiased threshold selection)
    const optimal = findOptimalThreshold(valScores, valLabels);

    // Evaluate threshold on validation set only (unbiased estimate)
    let valTp = 0, valFp = 0, valFn = 0;
    for (let i = 0; i < valScores.length; i++) {
      const predicted = valScores[i] >= optimal.threshold;
      if (predicted && valLabels[i]) valTp++;
      else if (predicted && !valLabels[i]) valFp++;
      else if (!predicted && valLabels[i]) valFn++;
    }
    const valPrec = valTp + valFp > 0 ? valTp / (valTp + valFp) : 0;
    const valRec = valTp + valFn > 0 ? valTp / (valTp + valFn) : 0;
    const valF1 = valPrec + valRec > 0 ? (2 * valPrec * valRec) / (valPrec + valRec) : 0;

    valPrecisions.push(valPrec);
    valRecalls.push(valRec);

    // Compute BM25 validation F1 for this topic
    const bm25Val = computeBM25ValF1(valDocs, valTopics, topicId, allTopics, bm25Idf);

    // Compute per-topic blend_alpha: LR influence proportional to its relative strength
    const blendAlpha = Math.min(0.5, Math.max(0.05, valF1 / (bm25Val.f1 + valF1 + 0.01)));

    // Serialize classifier
    const weightsObj: Record<number, number> = {};
    for (const [idx, val] of lr.weights) {
      weightsObj[idx] = val;
    }

    classifiers[topicId] = {
      weights: weightsObj,
      bias: lr.bias,
      score_threshold: optimal.threshold,
      blend_alpha: Math.round(blendAlpha * 1000) / 1000,
      lr_val_f1: Math.round(valF1 * 1000) / 1000,
      bm25_val_f1: Math.round(bm25Val.f1 * 1000) / 1000,
    };

    perTopicResults.push({
      topic: topicId,
      method: 'logistic',
      examples: numPositive,
      val_precision: Math.round(valPrec * 1000) / 1000,
      val_recall: Math.round(valRec * 1000) / 1000,
      val_f1: Math.round(valF1 * 1000) / 1000,
    });
  }

  // Overall validation metrics (macro-averaged)
  const overallPrecision =
    valPrecisions.length > 0
      ? valPrecisions.reduce((a, b) => a + b, 0) / valPrecisions.length
      : 0;
  const overallRecall =
    valRecalls.length > 0
      ? valRecalls.reduce((a, b) => a + b, 0) / valRecalls.length
      : 0;
  const overallF1 =
    overallPrecision + overallRecall > 0
      ? (2 * overallPrecision * overallRecall) / (overallPrecision + overallRecall)
      : 0;

  // Build model
  const vocabObj: Record<string, number> = {};
  for (const [term, idx] of vocabulary) {
    vocabObj[term] = idx;
  }

  const numPositivePerTopic: Record<string, number> = {};
  for (const [topic, count] of positiveCounts) {
    numPositivePerTopic[topic] = count;
  }

  const model: ClassifierModel = {
    version: 4,
    created_at: new Date().toISOString(),
    vocabulary: vocabObj,
    idf,
    classifiers,
    training_meta: {
      training_db: 'unknown',
      num_examples: rows.length,
      num_positive_per_topic: numPositivePerTopic,
      training_date: new Date().toISOString(),
    },
  };

  // Determine output path
  const now = new Date();
  const timestamp = now.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, '');
  const defaultDir = join(
    process.env.HOME ?? process.env.USERPROFILE ?? '.',
    '.local', 'share', 'intel',
  );
  const outputPath = opts.outputPath ?? join(defaultDir, `classifier-model-${timestamp}.json`);

  if (existsSync(outputPath)) {
    throw new Error(`Output file already exists: ${outputPath}`);
  }

  // Write atomically (temp file + rename)
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  const tempPath = outputPath + '.tmp';
  writeFileSync(tempPath, JSON.stringify(model, null, 2));
  renameSync(tempPath, outputPath);

  return {
    model_path: outputPath,
    vocabulary_size: vocabulary.size,
    per_topic: perTopicResults,
    overall_validation: {
      precision: Math.round(overallPrecision * 1000) / 1000,
      recall: Math.round(overallRecall * 1000) / 1000,
      f1: Math.round(overallF1 * 1000) / 1000,
    },
  };
}
