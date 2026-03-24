/**
 * BM25 scoring engine for topic classification.
 *
 * Replaces substring keyword matching with tokenized BM25 scoring.
 * Word-boundary tokenization eliminates false matches ("chip"/"archipelago"),
 * TF saturation dampens repeated terms, IDF weights rare keywords higher,
 * and title boost prioritizes headline keywords.
 */

// --- Constants (§G) ---

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const BM25_TITLE_BOOST = 2.0;
export const BM25_THRESHOLDS: number[] = [8.0, 13.0, 18.0, 23.0, 28.0];
export const BM25_SIGMOID_MIDPOINT = 14.0;
export const BM25_SIGMOID_TEMPERATURE = 4.0;

/** Fixed stopword list — changing this changes BM25 scores and breaks reproducibility. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by',
  'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his',
  'i', 'in', 'is', 'it', 'its', 'not', 'of', 'on', 'or',
  'she', 'so', 'that', 'the', 'their', 'this', 'to', 'was',
  'we', 'were', 'will', 'with', 'you',
]);

// --- Types ---

export interface BM25Opts {
  k1: number;
  b: number;
  titleBoost: number;
}

export interface BM25Result {
  topicId: string;
  score: number;
  confidence: number;
  matched: boolean;
  suppressed: boolean;
}

export interface EscalatingThresholds {
  thresholds: number[];
}

export interface TopicDefExtended {
  id: string;
  label: string;
  keywords: string[];
  negative_keywords?: string[];
  context_required?: boolean;
  context_terms?: string[];
  priority: number;
}

// --- Tokenizer ---

/**
 * Word-boundary tokenization with stopword removal.
 * Splits on non-alphanumeric characters, lowercases, removes stopwords.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

// --- IDF ---

/**
 * Bootstrap IDF from keyword frequency across all topic definitions.
 * Keywords appearing in fewer topics produce higher IDF.
 * Replaced by corpus IDF after Phase 2 training.
 */
export function computeIDF(topicDefs: TopicDefExtended[]): Map<string, number> {
  const N = topicDefs.length;
  const docFreq = new Map<string, number>();

  for (const td of topicDefs) {
    // Tokenize each keyword phrase and count unique tokens per topic
    const topicTokens = new Set<string>();
    for (const kw of td.keywords) {
      for (const token of tokenize(kw)) {
        topicTokens.add(token);
      }
    }
    for (const token of topicTokens) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [token, df] of docFreq) {
    // Standard BM25 IDF: ln((N - df + 0.5) / (df + 0.5) + 1)
    idf.set(token, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }

  return idf;
}

/**
 * Build IDF from a corpus of documents (title+content pairs).
 * Uses actual document frequencies across the corpus instead of topic keyword counts.
 * Falls back to bootstrap IDF for tokens not seen in the corpus.
 */
export function buildCorpusIDF(
  documents: Array<{ title: string | null; content: string | null }>,
  bootstrapIdf?: Map<string, number>,
  opts?: { maxIdf?: number },
): Map<string, number> {
  const N = documents.length;
  const maxIdf = opts?.maxIdf ?? Infinity;
  const docFreq = new Map<string, number>();

  for (const doc of documents) {
    const text = ((doc.title ?? '') + ' ' + (doc.content ?? '')).slice(0, 3000);
    const uniqueTokens = new Set(tokenize(text));
    for (const token of uniqueTokens) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [token, df] of docFreq) {
    idf.set(token, Math.min(maxIdf, Math.log((N - df + 0.5) / (df + 0.5) + 1)));
  }

  // Merge bootstrap IDF for tokens not in the corpus
  if (bootstrapIdf) {
    for (const [token, val] of bootstrapIdf) {
      if (!idf.has(token)) {
        idf.set(token, Math.min(maxIdf, val));
      }
    }
  }

  return idf;
}

// --- BM25 Scoring ---

/**
 * Compute BM25 score for a document's tokens against a topic's keyword set.
 * Applies TF saturation (k1), length normalization (b), and IDF weighting.
 */
export function scoreBM25(
  tokens: string[],
  keywords: string[],
  idf: Map<string, number>,
  opts: BM25Opts,
  avgDocLen: number,
): number {
  if (tokens.length === 0 || keywords.length === 0) return 0;

  // Build a set of keyword tokens for matching
  const keywordTokenSet = new Set<string>();
  for (const kw of keywords) {
    for (const t of tokenize(kw)) {
      keywordTokenSet.add(t);
    }
  }

  // Count term frequencies in the document
  const tf = new Map<string, number>();
  for (const token of tokens) {
    if (keywordTokenSet.has(token)) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
  }

  const docLen = tokens.length;
  let score = 0;

  for (const [term, freq] of tf) {
    const termIdf = idf.get(term) ?? Math.log((66 + 0.5) / (0.5) + 1); // default for unknown tokens
    // BM25 TF component with saturation and length normalization
    const tfNorm =
      (freq * (opts.k1 + 1)) /
      (freq + opts.k1 * (1 - opts.b + opts.b * (docLen / avgDocLen)));
    score += termIdf * tfNorm;
  }

  return score;
}

/**
 * Full BM25 pipeline for one event × one topic.
 * Tokenizes title/content, scores with title boost, applies negative keyword
 * suppression, checks threshold gate, computes sigmoid confidence.
 */
export function matchesTopicBM25(
  title: string | null,
  content: string | null,
  topicDef: TopicDefExtended,
  idf: Map<string, number>,
  opts?: {
    tokens?: string[];
    titleTokens?: string[];
    avgDocLen?: number;
  },
): BM25Result {
  const bm25Opts: BM25Opts = { k1: BM25_K1, b: BM25_B, titleBoost: BM25_TITLE_BOOST };
  const text = ((title ?? '') + ' ' + (content ?? '')).slice(0, 3000);
  const tokens = opts?.tokens ?? tokenize(text);
  const titleTokens = opts?.titleTokens ?? tokenize((title ?? '').slice(0, 200));
  const avgDocLen = opts?.avgDocLen ?? 150; // Reasonable default for news articles

  // Check negative keywords — suppress if any match
  if (topicDef.negative_keywords && topicDef.negative_keywords.length > 0) {
    const negTokenSet = new Set<string>();
    for (const nk of topicDef.negative_keywords) {
      for (const t of tokenize(nk)) {
        negTokenSet.add(t);
      }
    }
    for (const token of tokens) {
      if (negTokenSet.has(token)) {
        return { topicId: topicDef.id, score: 0, confidence: 0, matched: false, suppressed: true };
      }
    }
  }

  // Context validation — if context_required, check context_terms are present
  if (topicDef.context_required && topicDef.context_terms && topicDef.context_terms.length > 0) {
    const contextTokenSet = new Set<string>();
    for (const ct of topicDef.context_terms) {
      for (const t of tokenize(ct)) {
        contextTokenSet.add(t);
      }
    }
    const hasContext = tokens.some((t) => contextTokenSet.has(t));
    if (!hasContext) {
      return { topicId: topicDef.id, score: 0, confidence: 0, matched: false, suppressed: false };
    }
  }

  // Score content tokens
  const contentScore = scoreBM25(tokens, topicDef.keywords, idf, bm25Opts, avgDocLen);

  // Score title tokens with boost
  const titleScore =
    scoreBM25(titleTokens, topicDef.keywords, idf, bm25Opts, avgDocLen) * bm25Opts.titleBoost;

  // Combined score: use the higher of content (includes title) and boosted title-only
  // Title keywords are already in `tokens`, so we add title boost on top
  let rawScore = contentScore + titleScore;

  // Apply priority multiplier: priority 50 = neutral (1.0×), priority 100 = 2.0×
  const priorityMultiplier = (topicDef.priority ?? 50) / 50;
  rawScore *= priorityMultiplier;

  // Sigmoid confidence: 1 / (1 + exp(-(score - midpoint) / temperature))
  const confidence = sigmoid(rawScore);

  const matched = rawScore >= BM25_THRESHOLDS[0];

  return {
    topicId: topicDef.id,
    score: rawScore,
    confidence: Math.round(confidence * 1000) / 1000,
    matched,
    suppressed: false,
  };
}

/**
 * Sigmoid calibration: maps BM25 score to (0, 1) confidence.
 */
export function sigmoid(score: number): number {
  const raw = 1 / (1 + Math.exp(-(score - BM25_SIGMOID_MIDPOINT) / BM25_SIGMOID_TEMPERATURE));
  // Clamp to (0, 1) exclusive — avoid exactly 0.0 or 1.0
  return Math.min(Math.max(raw, 1e-6), 1 - 1e-6);
}
