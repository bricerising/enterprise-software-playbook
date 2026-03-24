/**
 * Diagnostic: understand why CNB training produces all-zero F1 scores.
 * Checks content availability, score distributions, and Platt calibration.
 */
import Database from 'better-sqlite3';
import { tokenize } from './src/collector/bm25.js';
import { buildVocabulary, computeCorpusIDF, vectorize } from './src/collector/tfidf.js';
import { trainCNB, predictCNB, CNB_VALIDATION_SPLIT, CNB_MAX_VOCABULARY, CNB_MIN_EXAMPLES } from './src/collector/naive-bayes.js';
import { fitPlatt, calibrate } from './src/collector/platt.js';
import { loadTopics } from './src/collector/topic-classifier.js';
import { join } from 'node:path';

const DB_PATH = join(process.env.HOME!, '.local/share/intel/training-set-2026-03-23T17-44-52.db');
const db = new Database(DB_PATH, { readonly: true });

// 1. Check content availability
const contentStats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN content IS NULL OR content = '' THEN 1 ELSE 0 END) as empty_content,
    SUM(CASE WHEN title IS NULL OR title = '' THEN 1 ELSE 0 END) as empty_title,
    AVG(LENGTH(COALESCE(content,''))) as avg_content_len,
    AVG(LENGTH(COALESCE(title,''))) as avg_title_len
  FROM training_events WHERE reviewed_at IS NOT NULL
`).get() as any;

console.log('\n=== Content Stats ===');
console.log(contentStats);

// 2. Sample some documents to verify tokenization
const sampleRows = db.prepare(`
  SELECT event_id, title, content, human_topics
  FROM training_events WHERE reviewed_at IS NOT NULL AND human_topics IS NOT NULL
  LIMIT 5
`).all() as any[];

console.log('\n=== Sample Documents (first 5) ===');
for (const row of sampleRows) {
  const text = ((row.title ?? '') + ' ' + (row.content ?? '')).slice(0, 3000);
  const tokens = tokenize(text);
  const topics = JSON.parse(row.human_topics);
  console.log(`  ${row.event_id}: ${tokens.length} tokens, topics=${JSON.stringify(topics)}, title="${(row.title ?? '').slice(0, 80)}"`);
}

// 3. Run training for a specific well-populated topic and dump diagnostics
const rows = db.prepare(`
  SELECT event_id, title, content, human_topics
  FROM training_events
  WHERE reviewed_at IS NOT NULL AND human_topics IS NOT NULL
`).all() as any[];

const documents: string[][] = [];
const eventTopics: string[][] = [];
for (const row of rows) {
  const text = ((row.title ?? '') + ' ' + (row.content ?? '')).slice(0, 3000);
  documents.push(tokenize(text));
  eventTopics.push(JSON.parse(row.human_topics));
}

const splitIdx = Math.floor(documents.length * (1 - CNB_VALIDATION_SPLIT));
const trainDocs = documents.slice(0, splitIdx);
const trainTopics = eventTopics.slice(0, splitIdx);
const valDocs = documents.slice(splitIdx);
const valTopics = eventTopics.slice(splitIdx);

console.log(`\n=== Training Split ===`);
console.log(`  Train: ${trainDocs.length}, Validation: ${valDocs.length}`);
console.log(`  Avg tokens per doc: ${(documents.reduce((s, d) => s + d.length, 0) / documents.length).toFixed(1)}`);

// Build vocab and vectors
const vocabulary = buildVocabulary(trainDocs, CNB_MAX_VOCABULARY);
const idf = computeCorpusIDF(trainDocs, vocabulary);
const trainVectors = trainDocs.map(doc => vectorize(doc, vocabulary, idf, false));
const valVectors = valDocs.map(doc => vectorize(doc, vocabulary, idf, false));

console.log(`  Vocabulary size: ${vocabulary.size}`);

// Check a few topics
const testTopics = ['security.vulnerabilities', 'ai.foundation-models', 'market.earnings', 'ai.agents'];

for (const topicId of testTopics) {
  const trainLabels = trainTopics.map(t => t.includes(topicId));
  const valLabels = valTopics.map(t => t.includes(topicId));
  const nPosTrain = trainLabels.filter(l => l).length;
  const nPosVal = valLabels.filter(l => l).length;

  if (nPosTrain < CNB_MIN_EXAMPLES) {
    console.log(`\n=== ${topicId}: SKIPPED (${nPosTrain} train examples) ===`);
    continue;
  }

  const cnb = trainCNB(trainVectors, trainLabels, vocabulary.size);

  // Raw scores on validation set
  const valScores = valVectors.map(v => predictCNB(v, cnb));
  const posScores = valScores.filter((_, i) => valLabels[i]);
  const negScores = valScores.filter((_, i) => !valLabels[i]);

  console.log(`\n=== ${topicId} ===`);
  console.log(`  Train: ${nPosTrain} pos / ${trainLabels.length - nPosTrain} neg`);
  console.log(`  Val: ${nPosVal} pos / ${valLabels.length - nPosVal} neg`);
  console.log(`  CNB prior: ${cnb.prior.toFixed(4)}`);
  console.log(`  CNB theta entries: ${cnb.logTheta.size}`);

  if (posScores.length > 0) {
    console.log(`  Pos scores: min=${Math.min(...posScores).toFixed(4)}, max=${Math.max(...posScores).toFixed(4)}, mean=${(posScores.reduce((a,b) => a+b, 0) / posScores.length).toFixed(4)}`);
  }
  if (negScores.length > 0) {
    console.log(`  Neg scores: min=${Math.min(...negScores).toFixed(4)}, max=${Math.max(...negScores).toFixed(4)}, mean=${(negScores.reduce((a,b) => a+b, 0) / negScores.length).toFixed(4)}`);
  }

  // Platt calibration
  const platt = fitPlatt(valScores, valLabels);
  console.log(`  Platt params: a=${platt.a.toFixed(6)}, b=${platt.b.toFixed(6)}`);

  const calibratedPos = posScores.map(s => calibrate(s, platt));
  const calibratedNeg = negScores.map(s => calibrate(s, platt));

  if (calibratedPos.length > 0) {
    console.log(`  Calibrated pos: min=${Math.min(...calibratedPos).toFixed(4)}, max=${Math.max(...calibratedPos).toFixed(4)}, mean=${(calibratedPos.reduce((a,b) => a+b, 0) / calibratedPos.length).toFixed(4)}`);
    console.log(`  Pos above 0.3: ${calibratedPos.filter(p => p >= 0.3).length}/${calibratedPos.length}`);
  }
  if (calibratedNeg.length > 0) {
    console.log(`  Calibrated neg: min=${Math.min(...calibratedNeg).toFixed(4)}, max=${Math.max(...calibratedNeg).toFixed(4)}, mean=${(calibratedNeg.reduce((a,b) => a+b, 0) / calibratedNeg.length).toFixed(4)}`);
    console.log(`  Neg above 0.3: ${calibratedNeg.filter(p => p >= 0.3).length}/${calibratedNeg.length}`);
  }
}

db.close();
