/**
 * TF-IDF vectorizer for document classification.
 *
 * Builds a vocabulary from tokenized documents, then converts documents
 * to sparse TF-IDF vectors for use with Complement Naive Bayes.
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
 * Set normalize=false for CNB — its weight normalization handles scaling,
 * and double-normalization crushes the discriminative signal.
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

  // L2 normalization (skip for CNB which uses its own weight normalization)
  if (normalize && norm > 0) {
    const normFactor = Math.sqrt(norm);
    for (const [idx, val] of vector) {
      vector.set(idx, val / normFactor);
    }
  }

  return vector;
}

export { tokenize };
