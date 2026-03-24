/**
 * TF-IDF vectorizer for document classification.
 *
 * Builds a vocabulary from tokenized documents, then converts documents
 * to sparse TF-IDF vectors for use with logistic regression classifiers.
 */

import { tokenize } from './bm25.js';

/**
 * Build a vocabulary from tokenized documents, capped at maxSize terms
 * by document frequency. Returns a Map<term, index>.
 */
export function buildVocabulary(
  documents: string[][],
  maxSize: number,
): Map<string, number> {
  // Count document frequency for each term
  const docFreq = new Map<string, number>();
  for (const doc of documents) {
    const uniqueTerms = new Set(doc);
    for (const term of uniqueTerms) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  // Sort by document frequency descending (most common terms first)
  // and cap at maxSize
  const sorted = [...docFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxSize);

  const vocabulary = new Map<string, number>();
  let index = 0;
  for (const [term] of sorted) {
    vocabulary.set(term, index++);
  }

  return vocabulary;
}

/**
 * Compute IDF weights for vocabulary terms from document collection.
 */
export function computeCorpusIDF(
  documents: string[][],
  vocabulary: Map<string, number>,
): number[] {
  const N = documents.length;
  const idf = new Array(vocabulary.size).fill(0);

  // Count document frequency per vocabulary term
  const docFreq = new Map<number, number>();
  for (const doc of documents) {
    const seen = new Set<number>();
    for (const token of doc) {
      const idx = vocabulary.get(token);
      if (idx !== undefined && !seen.has(idx)) {
        seen.add(idx);
        docFreq.set(idx, (docFreq.get(idx) ?? 0) + 1);
      }
    }
  }

  for (const [idx, df] of docFreq) {
    idf[idx] = Math.log((N + 1) / (df + 1)) + 1; // smooth IDF
  }

  return idf;
}

/**
 * Convert a token array to a sparse TF-IDF vector.
 * Uses sub-linear TF (1 + log(tf)) and optional L2 normalization.
 * Returns Map<index, weight> (sparse representation).
 *
 * Set normalize=true for logistic regression (standard for LR).
 * Set normalize=false if the downstream classifier handles its own normalization.
 */
export function vectorize(
  tokens: string[],
  vocabulary: Map<string, number>,
  idf: number[],
  normalize = true,
): Map<number, number> {
  // Count term frequencies
  const tf = new Map<number, number>();
  for (const token of tokens) {
    const idx = vocabulary.get(token);
    if (idx !== undefined) {
      tf.set(idx, (tf.get(idx) ?? 0) + 1);
    }
  }

  // Compute TF-IDF with sub-linear TF
  const vector = new Map<number, number>();
  let norm = 0;

  for (const [idx, freq] of tf) {
    const sublinearTf = 1 + Math.log(freq);
    const tfidf = sublinearTf * (idf[idx] ?? 1);
    vector.set(idx, tfidf);
    norm += tfidf * tfidf;
  }

  // L2 normalization
  if (normalize && norm > 0) {
    const normFactor = Math.sqrt(norm);
    for (const [idx, val] of vector) {
      vector.set(idx, val / normFactor);
    }
  }

  return vector;
}

/**
 * Build a vocabulary using chi-squared feature selection.
 * For each term, computes the max chi-squared statistic across all topics,
 * then selects the top maxSize terms. This picks discriminative terms
 * instead of merely common ones.
 *
 * @param documents  Tokenized documents (one string[] per doc)
 * @param topicLabels  Per-document topic labels (parallel to documents)
 * @param maxSize  Maximum vocabulary size
 */
export function buildVocabularyChiSquared(
  documents: string[][],
  topicLabels: string[][],
  maxSize: number,
): Map<string, number> {
  const N = documents.length;

  // Collect all unique topics
  const allTopics = new Set<string>();
  for (const labels of topicLabels) {
    for (const t of labels) allTopics.add(t);
  }

  // Build per-document term presence sets and per-topic doc membership
  const docTermSets: Set<string>[] = [];
  const topicDocSets = new Map<string, Set<number>>();
  for (const t of allTopics) topicDocSets.set(t, new Set());

  const allTerms = new Set<string>();

  for (let i = 0; i < N; i++) {
    const termSet = new Set(documents[i]);
    docTermSets.push(termSet);
    for (const term of termSet) allTerms.add(term);
    for (const t of topicLabels[i]) {
      topicDocSets.get(t)!.add(i);
    }
  }

  // For each term, compute document frequency
  const termDocFreq = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    for (const term of docTermSets[i]) {
      termDocFreq.set(term, (termDocFreq.get(term) ?? 0) + 1);
    }
  }

  // For each term, compute max chi-squared across all topics
  const termMaxChi = new Map<string, number>();

  for (const term of allTerms) {
    const termDf = termDocFreq.get(term)!;
    let maxChi = 0;

    for (const [topic, topicDocs] of topicDocSets) {
      const topicSize = topicDocs.size;

      // Count docs that have both this term AND this topic
      let a = 0; // term present, topic positive
      for (const docIdx of topicDocs) {
        if (docTermSets[docIdx].has(term)) a++;
      }
      const b = termDf - a;           // term present, topic negative
      const c = topicSize - a;        // term absent, topic positive
      const d = N - a - b - c;        // term absent, topic negative

      // Chi-squared: N*(ad - bc)^2 / ((a+b)(c+d)(a+c)(b+d))
      const denom = (a + b) * (c + d) * (a + c) * (b + d);
      if (denom === 0) continue;
      const chi2 = (N * (a * d - b * c) ** 2) / denom;
      if (chi2 > maxChi) maxChi = chi2;
    }

    termMaxChi.set(term, maxChi);
  }

  // Sort by chi-squared descending, take top maxSize
  const sorted = [...termMaxChi.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxSize);

  const vocabulary = new Map<string, number>();
  let index = 0;
  for (const [term] of sorted) {
    vocabulary.set(term, index++);
  }

  return vocabulary;
}

export { tokenize };
