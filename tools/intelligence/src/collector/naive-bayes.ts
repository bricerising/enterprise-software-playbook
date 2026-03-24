/**
 * Complement Naive Bayes classifier for multi-label topic classification.
 *
 * CNB is designed for class imbalance — it learns from complement classes
 * (all documents NOT in the target class), producing robust classifiers
 * even with very few positive examples.
 *
 * Architecture:
 *   tokens → TF-IDF vector → 66 binary CNB classifiers → Platt calibration → top-5 topics
 */

import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tokenize } from './bm25.js';
import { buildVocabulary, computeCorpusIDF, vectorize } from './tfidf.js';
import { fitPlatt, calibrate, type SigmoidParams } from './platt.js';
import { loadTopics } from './topic-classifier.js';
import type Database from 'better-sqlite3';

// --- Constants (§G) ---

export const CNB_MIN_EXAMPLES = 20;
export const CNB_MIN_TRAINING_EVENTS = 500;
export const CNB_MAX_VOCABULARY = 20_000;
export const CNB_VALIDATION_SPLIT = 0.2;
export const CNB_PROBABILITY_THRESHOLD = 0.3;
export const MODEL_STALENESS_DAYS = 90;

// --- Types ---

export interface ClassifierModel {
  version: number;
  created_at: string;
  vocabulary: Record<string, number>;
  idf: number[];
  classifiers: Record<
    string,
    {
      log_theta: Record<number, number>;
      platt_a: number;
      platt_b: number;
      prior: number;
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
    method: 'cnb' | 'bm25_fallback';
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

interface CNBClassifier {
  logTheta: Map<number, number>;
  prior: number;
}

// --- Training ---

/**
 * Train a single Complement Naive Bayes binary classifier for one topic.
 * Returns sparse log-theta vector and log prior.
 */
export function trainCNB(
  vectors: Map<number, number>[],
  labels: boolean[],
  vocabSize: number,
  alpha = 1.0,
): CNBClassifier {
  const nPos = labels.filter((l) => l).length;
  const nNeg = labels.length - nPos;
  const prior = Math.log((nPos + alpha) / (labels.length + 2 * alpha));

  // Complement class: accumulate TF-IDF from documents NOT in this class
  const complementCounts = new Map<number, number>();
  let complementTotal = 0;

  for (let i = 0; i < vectors.length; i++) {
    if (!labels[i]) {
      // Negative example — add to complement
      for (const [idx, val] of vectors[i]) {
        complementCounts.set(idx, (complementCounts.get(idx) ?? 0) + val);
        complementTotal += val;
      }
    }
  }

  // Compute complement log-theta with Laplace smoothing
  const logTheta = new Map<number, number>();
  const denominator = complementTotal + alpha * vocabSize;

  for (const [idx, count] of complementCounts) {
    logTheta.set(idx, Math.log((count + alpha) / denominator));
  }

  return { logTheta, prior };
}

/**
 * Predict raw CNB score for a document vector against a trained classifier.
 * Returns uncalibrated log-odds (higher = more likely positive class).
 */
export function predictCNB(
  vector: Map<number, number>,
  classifier: CNBClassifier,
): number {
  let score = classifier.prior;

  // CNB prediction: score = prior - sum(x_i * complement_log_theta_i)
  // Negating complement weights gives the positive class score
  for (const [idx, val] of vector) {
    const theta = classifier.logTheta.get(idx) ?? 0;
    score -= val * theta;
  }

  return score;
}

/**
 * Full training pipeline: load data → build vocab → train CNB classifiers → fit Platt → serialize.
 */
export function trainClassifier(
  trainingDb: Database.Database,
  opts: {
    outputPath?: string;
    minExamples?: number;
    validationSplit?: number;
  } = {},
): ClassifierTrainResult {
  const minExamples = opts.minExamples ?? CNB_MIN_EXAMPLES;
  const validationSplit = opts.validationSplit ?? CNB_VALIDATION_SPLIT;

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

  if (rows.length < CNB_MIN_TRAINING_EVENTS) {
    throw new Error(
      `Insufficient training data: ${rows.length} labeled events, minimum ${CNB_MIN_TRAINING_EVENTS} required.`,
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

  // Split train/validation
  const splitIdx = Math.floor(documents.length * (1 - validationSplit));
  const trainDocs = documents.slice(0, splitIdx);
  const trainTopics = eventTopics.slice(0, splitIdx);
  const valDocs = documents.slice(splitIdx);
  const valTopics = eventTopics.slice(splitIdx);

  // Build vocabulary
  const vocabulary = buildVocabulary(trainDocs, CNB_MAX_VOCABULARY);
  const idf = computeCorpusIDF(trainDocs, vocabulary);

  // Vectorize training documents
  const trainVectors = trainDocs.map((doc) => vectorize(doc, vocabulary, idf));
  const valVectors = valDocs.map((doc) => vectorize(doc, vocabulary, idf));

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

  // Train per-topic classifiers
  const classifiers: Record<
    string,
    { log_theta: Record<number, number>; platt_a: number; platt_b: number; prior: number }
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

    // Train CNB
    const cnb = trainCNB(trainVectors, trainLabels, vocabulary.size);

    // Get raw scores for Platt calibration
    const valScores = valVectors.map((v) => predictCNB(v, cnb));

    // Fit Platt scaling
    const plattParams = fitPlatt(valScores, valLabels);

    // Evaluate on validation set
    let valTp = 0;
    let valFp = 0;
    let valFn = 0;
    for (let i = 0; i < valScores.length; i++) {
      const prob = calibrate(valScores[i], plattParams);
      const predicted = prob >= CNB_PROBABILITY_THRESHOLD;
      if (predicted && valLabels[i]) valTp++;
      else if (predicted && !valLabels[i]) valFp++;
      else if (!predicted && valLabels[i]) valFn++;
    }

    const precision = valTp + valFp > 0 ? valTp / (valTp + valFp) : 0;
    const recall = valTp + valFn > 0 ? valTp / (valTp + valFn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    valPrecisions.push(precision);
    valRecalls.push(recall);

    // Serialize classifier
    const logThetaObj: Record<number, number> = {};
    for (const [idx, val] of cnb.logTheta) {
      logThetaObj[idx] = val;
    }

    classifiers[topicId] = {
      log_theta: logThetaObj,
      platt_a: plattParams.a,
      platt_b: plattParams.b,
      prior: cnb.prior,
    };

    perTopicResults.push({
      topic: topicId,
      method: 'cnb',
      examples: numPositive,
      val_precision: Math.round(precision * 1000) / 1000,
      val_recall: Math.round(recall * 1000) / 1000,
      val_f1: Math.round(f1 * 1000) / 1000,
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
    version: 1,
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
