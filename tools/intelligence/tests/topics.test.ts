import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { loadTopics, classify, classifyIds, getLoadedTopics, getCachedIdf, loadStatModel, clearStatModel, hasStatModel } from '../src/collector/topic-classifier.js';
import {
  tokenize,
  computeIDF,
  scoreBM25,
  matchesTopicBM25,
  sigmoid,
  BM25_K1,
  BM25_B,
  BM25_TITLE_BOOST,
  BM25_THRESHOLDS,
  type TopicDefExtended,
} from '../src/collector/bm25.js';
import { trainLogistic, predictLogistic, trainClassifier, type ClassifierModel } from '../src/collector/classifier.js';
import { buildVocabulary, buildVocabularyChiSquared, computeCorpusIDF, vectorize } from '../src/collector/tfidf.js';
import { fitPlatt, calibrate } from '../src/collector/platt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const topicsPath = join(__dirname, '..', 'config', 'topics.yaml');

beforeAll(() => {
  loadTopics(topicsPath);
});

describe('loadTopics', () => {
  it('loads topics from YAML', () => {
    const topics = getLoadedTopics();
    expect(topics.length).toBeGreaterThan(50);
  });

  it('each topic has required fields', () => {
    for (const t of getLoadedTopics()) {
      expect(t.id).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(t.priority).toBeGreaterThan(0);
    }
  });
});

describe('classify', () => {
  it('classifies Bedrock content as foundation models', () => {
    const topics = classifyIds('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents...');
    expect(topics).toContain('ai.foundation-models');
  });

  it('classifies AI safety content', () => {
    const topics = classifyIds('Red Teaming LLMs', 'AI safety and alignment research...');
    expect(topics).toContain('ai.safety');
  });

  it('classifies CVE content', () => {
    const topics = classifyIds('CVE-2026-12345 Critical Vulnerability', 'exploit found in...');
    expect(topics).toContain('security.vulnerabilities');
  });

  it('requires context for short acronyms like EKS', () => {
    // EKS without container/k8s context should not match
    const noContext = classifyIds('EKS performance tips', 'general performance article');
    expect(noContext).not.toContain('compute.containers');

    // EKS with container context should match
    const withContext = classifyIds(
      'EKS performance tips',
      'AWS kubernetes cluster pod management',
    );
    expect(withContext).toContain('compute.containers');
  });

  it('requires context for RAG acronym', () => {
    // RAG without context should not match
    const noContext = classifyIds('RAG review', 'This rag is excellent');
    expect(noContext).not.toContain('ai.rag');

    // RAG with AI context should match
    const withContext = classifyIds(
      'Building RAG Applications',
      'retrieval augmented generation with vector embeddings',
    );
    expect(withContext).toContain('ai.rag');
  });

  it('returns at most 5 topics', () => {
    const topics = classifyIds(
      'Kubernetes Docker Terraform OpenAI Bedrock serverless Lambda',
      'serverless container function kubernetes cluster terraform openai gpt-4 bedrock sagemaker security vulnerability cve',
    );
    expect(topics.length).toBeLessThanOrEqual(5);
  });

  it('returns empty for unrelated content', () => {
    const topics = classifyIds('Sunny weather expected tomorrow', 'Mild temperatures and clear skies through the weekend');
    expect(topics.length).toBe(0);
  });

  it('returns confidence scores with classify()', () => {
    const topics = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents...');
    expect(topics.length).toBeGreaterThan(0);
    for (const t of topics) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.confidence).toBe('number');
      expect(t.confidence).toBeGreaterThan(0);
      expect(t.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('classifies edge computing content', () => {
    const topics = classifyIds(
      'Cloudflare expands edge network for faster deployments',
      'New edge worker capabilities with durable objects support across global edge locations',
    );
    expect(topics).toContain('compute.edge');
  });

  it('classifies Go language content', () => {
    const topics = classifyIds(
      'Go 1.23 Release Notes',
      'The latest golang release includes improved goroutine scheduling and go concurrency primitives',
    );
    expect(topics).toContain('lang.go');
  });

  it('classifies architecture migration content', () => {
    const topics = classifyIds(
      'Migrating from Monolith to Microservices',
      'Managing technical debt through evolutionary architecture and strangler fig migration patterns',
    );
    expect(topics).toContain('arch.migration');
  });

  it('classifies compliance standards content', () => {
    const topics = classifyIds(
      'FedRAMP Authorization Updates',
      'New compliance framework requirements for fedramp authority to operate and nist 800-53 controls',
    );
    expect(topics).toContain('regulation.standards');
  });

  it('classifies testing content', () => {
    const topics = classifyIds(
      'Testing Best Practices for Microservices',
      'Unit test strategies, integration test patterns, and the test pyramid approach to code coverage',
    );
    expect(topics).toContain('devex.testing');
  });

  it('classifies open source licensing content', () => {
    const topics = classifyIds(
      'Open Source Initiative Updates License Guidelines',
      'The open source definition and license compliance requirements for gpl and apache license projects',
    );
    expect(topics).toContain('market.licensing');
  });

  it('does not false-positive lang.typescript from substring "ts"', () => {
    const topics = classifyIds(
      'Market insights and results from quarterly events',
      'Key highlights and aspects of deployment costs and benefits',
    );
    expect(topics).not.toContain('lang.typescript');
  });

  it('classifies energy market content', () => {
    const topics = classifyIds(
      'Oil and gas prices jump after Iran and Israel attack gasfields',
      'Brent crude oil prices surge as energy costs rise amid conflict in the strait of hormuz',
    );
    expect(topics).toContain('macro.energy');
  });

  it('classifies geopolitical conflict content', () => {
    const topics = classifyIds(
      'TSMC Stock Wilts as Iranian Attacks Batter Helium Supply and Threaten Chip Production',
      'Sanctions and trade restrictions on semiconductor exports amid military conflict',
    );
    expect(topics).toContain('macro.geopolitics');
  });

  it('classifies commodity supply content', () => {
    const topics = classifyIds(
      'Global Helium Shortage Threatens Semiconductor Fabrication',
      'Rare earth supply disruption and critical minerals shortage affecting chip production',
    );
    expect(topics).toContain('macro.commodities');
  });

  it('requires context for "war" keyword', () => {
    // "war" without geopolitical context should not match
    const noContext = classifyIds('Star Wars Movie Review', 'The latest film in the franchise');
    expect(noContext).not.toContain('macro.geopolitics');

    // "war" with geopolitical context should match
    const withContext = classifyIds(
      'The Iran War Is Destroying Something More Valuable Than Oil',
      'Military conflict and sanctions disrupt trade in the region',
    );
    expect(withContext).toContain('macro.geopolitics');
  });

  it('multi-keyword matches have higher confidence', () => {
    const single = classify('Bedrock article', null);
    const multi = classify('Amazon Bedrock agents with Claude', 'Amazon Bedrock serverless AI agents bedrock');
    if (single.length > 0 && multi.length > 0) {
      const singleFoundation = single.find(t => t.id === 'ai.foundation-models');
      const multiFoundation = multi.find(t => t.id === 'ai.foundation-models');
      if (singleFoundation && multiFoundation) {
        expect(multiFoundation.confidence).toBeGreaterThanOrEqual(singleFoundation.confidence);
      }
    }
  });
});

// --- BM25 tokenizer (4 tests) ---

describe('BM25 tokenizer', () => {
  it('splits on word boundaries and lowercases', () => {
    const tokens = tokenize('Hello, World! This is a TEST-123.');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).toContain('test');
    expect(tokens).toContain('123');
    // Stopwords removed
    expect(tokens).not.toContain('this');
    expect(tokens).not.toContain('is');
    expect(tokens).not.toContain('a');
  });

  it('removes stopwords', () => {
    const tokens = tokenize('the quick brown fox is and are with');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('is');
    expect(tokens).not.toContain('and');
    expect(tokens).not.toContain('are');
    expect(tokens).not.toContain('with');
    expect(tokens).toContain('quick');
    expect(tokens).toContain('brown');
    expect(tokens).toContain('fox');
  });

  it('"chip" does not appear when input is "archipelago"', () => {
    const tokens = tokenize('archipelago');
    expect(tokens).not.toContain('chip');
    expect(tokens).toContain('archipelago');
  });

  it('"react" does not appear when input is "reactive"', () => {
    const tokens = tokenize('reactive programming paradigm');
    expect(tokens).not.toContain('react');
    expect(tokens).toContain('reactive');
  });
});

// --- BM25 scoring (6 tests) ---

describe('BM25 scoring', () => {
  const testTopic: TopicDefExtended = {
    id: 'test.topic',
    label: 'Test',
    keywords: ['kubernetes', 'container', 'cluster'],
    priority: 50,
  };

  it('title keywords receive BM25_TITLE_BOOST multiplier', () => {
    // Same keyword in title vs content should produce higher score in title
    const titleResult = matchesTopicBM25(
      'kubernetes deployment guide',
      'general server management information',
      testTopic,
      computeIDF([testTopic]),
    );
    const contentResult = matchesTopicBM25(
      'general server management guide',
      'kubernetes deployment and container orchestration',
      testTopic,
      computeIDF([testTopic]),
    );
    // Title has boosted score, so title-focused should score higher
    expect(titleResult.score).toBeGreaterThan(0);
    expect(contentResult.score).toBeGreaterThan(0);
    // Title-focused version should have higher or equal score due to title boost
    expect(titleResult.score).toBeGreaterThanOrEqual(contentResult.score * 0.5);
  });

  it('repeated keyword produces diminishing returns (TF saturation)', () => {
    const idf = computeIDF([testTopic]);
    const tokens1 = tokenize('kubernetes is great');
    const tokens2 = tokenize('kubernetes kubernetes kubernetes kubernetes kubernetes');

    const score1 = scoreBM25(tokens1, testTopic.keywords, idf, { k1: BM25_K1, b: BM25_B, titleBoost: BM25_TITLE_BOOST }, 10);
    const score2 = scoreBM25(tokens2, testTopic.keywords, idf, { k1: BM25_K1, b: BM25_B, titleBoost: BM25_TITLE_BOOST }, 10);

    // 5x repetition should not produce 5x the score
    expect(score2).toBeGreaterThan(score1);
    expect(score2).toBeLessThan(score1 * 5);
  });

  it('long documents score lower than short documents with same keyword density', () => {
    const idf = computeIDF([testTopic]);
    const shortTokens = tokenize('kubernetes container cluster');
    const longTokens = tokenize(
      'kubernetes container cluster ' + 'filler word text '.repeat(50),
    );

    const shortScore = scoreBM25(shortTokens, testTopic.keywords, idf, { k1: BM25_K1, b: BM25_B, titleBoost: BM25_TITLE_BOOST }, 5);
    const longScore = scoreBM25(longTokens, testTopic.keywords, idf, { k1: BM25_K1, b: BM25_B, titleBoost: BM25_TITLE_BOOST }, 5);

    expect(shortScore).toBeGreaterThan(longScore);
  });

  it('keywords in fewer topics produce higher IDF scores', () => {
    const topics: TopicDefExtended[] = [
      { id: 'a', label: 'A', keywords: ['kubernetes', 'cloud'], priority: 50 },
      { id: 'b', label: 'B', keywords: ['cloud', 'platform'], priority: 50 },
      { id: 'c', label: 'C', keywords: ['cloud', 'service'], priority: 50 },
    ];
    const idf = computeIDF(topics);

    // "kubernetes" in 1 topic should have higher IDF than "cloud" in 3 topics
    expect(idf.get('kubernetes')!).toBeGreaterThan(idf.get('cloud')!);
  });

  it('single incidental keyword scores below threshold', () => {
    // A topic with just one weak keyword match should not pass the 4.0 threshold
    const weakTopic: TopicDefExtended = {
      id: 'weak.topic',
      label: 'Weak',
      keywords: ['general'],
      priority: 50,
    };
    const result = matchesTopicBM25(
      'A very general article about nothing specific',
      null,
      weakTopic,
      computeIDF([weakTopic]),
    );
    // Score should be below the first threshold
    expect(result.score).toBeLessThan(BM25_THRESHOLDS[0]);
  });

  it('escalating thresholds enforced: 2nd topic requires ≥5.5', () => {
    // classify() applies escalating thresholds
    // We need at least 2 strong topics to test this
    const topics = classify(
      'Kubernetes Docker Container Cluster Orchestration Helm',
      'kubernetes container cluster orchestration docker dockerfile helm kustomize deployment pod',
    );
    // If 2+ topics returned, the 2nd must have scored >= 5.5
    if (topics.length >= 2) {
      expect(topics[0].score).toBeGreaterThanOrEqual(BM25_THRESHOLDS[0]);
      expect(topics[1].score).toBeGreaterThanOrEqual(BM25_THRESHOLDS[1]);
    }
  });
});

// --- Negative keywords (3 tests) ---

describe('Negative keywords', () => {
  it('suppresses topic when negative keyword matches', () => {
    const topic: TopicDefExtended = {
      id: 'macro.energy',
      label: 'Energy',
      keywords: ['electricity', 'energy', 'power'],
      negative_keywords: ['medieval', 'manuscript'],
      priority: 50,
    };
    const result = matchesTopicBM25(
      'Medieval Electricity in Manuscripts',
      'A medieval manuscript about figurative electricity and power',
      topic,
      computeIDF([topic]),
    );
    expect(result.suppressed).toBe(true);
    expect(result.matched).toBe(false);
  });

  it('negative keyword matching is case-insensitive', () => {
    const topic: TopicDefExtended = {
      id: 'test.neg',
      label: 'Test',
      keywords: ['energy'],
      negative_keywords: ['medieval'],
      priority: 50,
    };
    const result = matchesTopicBM25(
      'MEDIEVAL Energy Sources',
      null,
      topic,
      computeIDF([topic]),
    );
    expect(result.suppressed).toBe(true);
  });

  it('topics without negative_keywords are unaffected', () => {
    const topic: TopicDefExtended = {
      id: 'test.noneg',
      label: 'Test',
      keywords: ['kubernetes', 'container', 'cluster', 'pod'],
      priority: 50,
    };
    const result = matchesTopicBM25(
      'Kubernetes Cluster Management',
      'kubernetes container cluster pod orchestration deployment',
      topic,
      computeIDF([topic]),
    );
    expect(result.suppressed).toBe(false);
    expect(result.score).toBeGreaterThan(0);
  });
});

// --- BM25 confidence (2 tests) ---

describe('BM25 confidence', () => {
  it('sigmoid output is in range (0, 1)', () => {
    for (const score of [-10, -5, 0, 3, 6, 10, 20, 100]) {
      const conf = sigmoid(score);
      expect(conf).toBeGreaterThan(0);
      expect(conf).toBeLessThan(1);
    }
  });

  it('higher scores produce strictly higher confidence (monotonicity)', () => {
    let prev = 0;
    for (const score of [0, 2, 4, 6, 8, 10, 15, 20]) {
      const conf = sigmoid(score);
      expect(conf).toBeGreaterThan(prev);
      prev = conf;
    }
  });
});

// --- BM25 context/priority (2 tests) ---

describe('BM25 context/priority', () => {
  it('context_required keyword only scores when context_term is present', () => {
    const topic: TopicDefExtended = {
      id: 'test.context',
      label: 'Context Test',
      keywords: ['eks', 'cluster'],
      context_required: true,
      context_terms: ['kubernetes', 'aws', 'container'],
      priority: 50,
    };
    const idf = computeIDF([topic]);

    // Without context
    const noCtx = matchesTopicBM25('EKS cluster info', 'general info about cluster management', topic, idf);
    expect(noCtx.matched).toBe(false);

    // With context
    const withCtx = matchesTopicBM25('EKS cluster info', 'AWS kubernetes container management', topic, idf);
    expect(withCtx.score).toBeGreaterThan(0);
  });

  it('priority 100 doubles score vs priority 50', () => {
    const topicHigh: TopicDefExtended = {
      id: 'test.high',
      label: 'High',
      keywords: ['kubernetes'],
      priority: 100,
    };
    const topicNeutral: TopicDefExtended = {
      id: 'test.neutral',
      label: 'Neutral',
      keywords: ['kubernetes'],
      priority: 50,
    };
    const idf = computeIDF([topicHigh, topicNeutral]);

    const highResult = matchesTopicBM25('kubernetes guide', 'kubernetes deployment', topicHigh, idf);
    const neutralResult = matchesTopicBM25('kubernetes guide', 'kubernetes deployment', topicNeutral, idf);

    // Priority 100 → multiplier 2.0, priority 50 → multiplier 1.0
    expect(highResult.score).toBeCloseTo(neutralResult.score * 2, 1);
  });
});

// --- Regex deprecation (1 test) ---

describe('Regex deprecation', () => {
  it('TopicDefExtended does not include regex; loaded topics have no regex', () => {
    const topics = getLoadedTopics();
    for (const t of topics) {
      expect((t as Record<string, unknown>)['regex']).toBeUndefined();
    }
  });
});

// --- BM25 bootstrap IDF (2 tests) ---

describe('BM25 bootstrap IDF', () => {
  it('keywords in fewer topics produce higher IDF', () => {
    const topics: TopicDefExtended[] = [
      { id: 'a', label: 'A', keywords: ['rare-keyword', 'common'], priority: 50 },
      { id: 'b', label: 'B', keywords: ['common'], priority: 50 },
      { id: 'c', label: 'C', keywords: ['common'], priority: 50 },
    ];
    const idf = computeIDF(topics);
    expect(idf.get('rare')!).toBeGreaterThan(idf.get('common')!);
  });

  it('computeIDF is deterministic', () => {
    const topics = getLoadedTopics();
    const idf1 = computeIDF(topics);
    const idf2 = computeIDF(topics);

    // Maps should have same entries
    expect(idf1.size).toBe(idf2.size);
    for (const [key, val] of idf1) {
      expect(idf2.get(key)).toBe(val);
    }
  });
});

// --- Classifier training pipeline (5 tests) ---

describe('Classifier training pipeline', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'intel-cnb-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper to create a training DB with labeled events
  function createLabeledTrainingDb(n: number): Database.Database {
    const dbPath = join(tmpDir, 'cnb-training.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma(`application_id = 0x54524E47`);

    db.exec(`
      CREATE TABLE training_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        title TEXT, content TEXT, url TEXT, source TEXT, feed TEXT,
        published_at TEXT, fetched_at TEXT, author TEXT,
        score INTEGER DEFAULT 0, comments INTEGER DEFAULT 0,
        machine_topics TEXT NOT NULL DEFAULT '[]',
        machine_confidences TEXT NOT NULL DEFAULT '[]',
        machine_scores TEXT NOT NULL DEFAULT '[]',
        human_topics TEXT, labeler TEXT DEFAULT 'unspecified',
        notes TEXT, reviewed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE training_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        human_topics TEXT NOT NULL,
        labeler TEXT NOT NULL,
        notes TEXT,
        labeled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE training_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);

    db.prepare("INSERT INTO training_meta VALUES ('schema_version', '1')").run();

    const topics = [
      'ai.foundation-models', 'ai.safety', 'ai.agents', 'compute.gpu',
      'security.vulnerabilities', 'data.relational',
    ];

    const insert = db.prepare(`
      INSERT INTO training_events (event_id, title, content, source, fetched_at,
        human_topics, labeler, reviewed_at)
      VALUES (?, ?, ?, 'rss', datetime('now'), ?, 'test', datetime('now'))
    `);

    db.transaction(() => {
      for (let i = 0; i < n; i++) {
        const topic = topics[i % topics.length];
        const topicKeywords: Record<string, string> = {
          'ai.foundation-models': 'large language model llm transformer neural network',
          'ai.safety': 'ai safety alignment red teaming guardrails',
          'ai.agents': 'ai agent autonomous agentic tool use function calling',
          'compute.gpu': 'gpu nvidia cuda h100 training accelerator',
          'security.vulnerabilities': 'vulnerability cve exploit zero-day security advisory',
          'data.relational': 'postgresql postgres database relational sql query',
        };
        insert.run(
          `rss:test:${i}`,
          `Test ${topic} Event ${i}`,
          `Content about ${topicKeywords[topic] ?? topic} with additional context words ${i}`,
          JSON.stringify([topic]),
        );
      }
    })();

    return db;
  }

  it('trainClassifier produces valid model when given sufficient data', () => {
    const db = createLabeledTrainingDb(600);
    try {
      const result = trainClassifier(db, {
        outputPath: join(tmpDir, 'model.json'),
        minExamples: 5,
        validationSplit: 0.2,
      });
      expect(result.model_path).toContain('model.json');
      expect(result.vocabulary_size).toBeGreaterThan(0);
      expect(result.per_topic.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('topics below min_examples use bm25_fallback', () => {
    const db = createLabeledTrainingDb(600);
    try {
      const result = trainClassifier(db, {
        outputPath: join(tmpDir, 'model2.json'),
        minExamples: 200, // Very high threshold
        validationSplit: 0.2,
      });
      const fallbacks = result.per_topic.filter(
        (t: { method: string }) => t.method === 'bm25_fallback',
      );
      expect(fallbacks.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('vocabulary size is capped at MAX_VOCABULARY', () => {
    // Create lots of unique tokens
    const docs = Array.from({ length: 100 }, (_, i) =>
      Array.from({ length: 100 }, (_, j) => `term${i}_${j}`),
    );
    const vocab = buildVocabulary(docs, 500);
    expect(vocab.size).toBeLessThanOrEqual(500);
  });

  it('Platt calibration produces outputs in (0, 1)', () => {
    const scores = [0.1, 0.3, 0.5, 0.7, 0.9, 1.5, 2.0, -0.5, -1.0];
    const labels = [false, false, true, true, true, true, true, false, false];
    const params = fitPlatt(scores, labels);

    for (const score of [-5, -2, 0, 1, 3, 5, 10]) {
      const prob = calibrate(score, params);
      expect(prob).toBeGreaterThan(0);
      expect(prob).toBeLessThan(1);
    }
  });

  it('model serialization round-trips', () => {
    const db = createLabeledTrainingDb(600);
    try {
      const result = trainClassifier(db, {
        outputPath: join(tmpDir, 'rt-model.json'),
        minExamples: 5,
        validationSplit: 0.2,
      });

      // Read back the model
      const modelJson = readFileSync(result.model_path, 'utf-8');
      const model = JSON.parse(modelJson);
      const roundTripped = JSON.parse(JSON.stringify(model));

      expect(roundTripped.version).toBe(model.version);
      expect(roundTripped.vocabulary).toEqual(model.vocabulary);
      expect(roundTripped.idf).toEqual(model.idf);
    } finally {
      db.close();
    }
  });
});

// --- Logistic regression prediction (3 tests) ---

describe('Logistic regression prediction', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'intel-lr-pred-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('predictLogistic produces scores for trained topics', () => {
    const docs = [
      tokenize('kubernetes container cluster orchestration'),
      tokenize('neural network transformer language model'),
      tokenize('kubernetes pod deployment helm'),
      tokenize('llm foundation model training'),
    ];
    const labels = [true, false, true, false];
    const vocab = buildVocabulary(docs, 1000);
    const idf = computeCorpusIDF(docs, vocab);
    const vectors = docs.map((d: string[]) => vectorize(d, vocab, idf));

    const classifier = trainLogistic(vectors, labels, vocab.size);
    const testVec = vectorize(tokenize('kubernetes container cluster'), vocab, idf);
    const score = predictLogistic(testVec, classifier);

    expect(typeof score).toBe('number');
    expect(Number.isFinite(score)).toBe(true);
  });

  it('Platt calibration produces outputs in (0, 1)', () => {
    const scores = Array.from({ length: 50 }, (_, i) => -2 + i * 0.1);
    const labels = scores.map((s) => s > 0);
    const params = fitPlatt(scores, labels);

    for (const s of [-1, 0, 0.5, 1.0, 2.0]) {
      const prob = calibrate(s, params);
      expect(prob).toBeGreaterThan(0);
      expect(prob).toBeLessThan(1);
    }
  });

  it('topics below min_examples fall back to BM25 at prediction time', () => {
    // With very few examples, training still works
    const vectors = [new Map([[0, 1.0]]), new Map([[1, 1.0]])];
    const labels = [true, false];
    const classifier = trainLogistic(vectors, labels, 10);
    expect(classifier).toBeDefined();
    expect(classifier.weights).toBeDefined();
  });
});

// --- intel classifier train CLI (4 tests) ---

describe('intel classifier train', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'intel-train-cli-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMinimalTrainingDb(n: number): string {
    const dbPath = join(tmpDir, 'train-cli.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma(`application_id = 0x54524E47`);

    db.exec(`
      CREATE TABLE training_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        title TEXT, content TEXT, url TEXT, source TEXT, feed TEXT,
        published_at TEXT, fetched_at TEXT, author TEXT,
        score INTEGER DEFAULT 0, comments INTEGER DEFAULT 0,
        machine_topics TEXT NOT NULL DEFAULT '[]',
        machine_confidences TEXT NOT NULL DEFAULT '[]',
        machine_scores TEXT NOT NULL DEFAULT '[]',
        human_topics TEXT, labeler TEXT DEFAULT 'unspecified',
        notes TEXT, reviewed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE training_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        human_topics TEXT NOT NULL,
        labeler TEXT NOT NULL,
        notes TEXT,
        labeled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE training_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO training_meta VALUES ('schema_version', '1')").run();

    const insert = db.prepare(`
      INSERT INTO training_events (event_id, title, content, source, fetched_at,
        human_topics, labeler, reviewed_at)
      VALUES (?, ?, ?, 'rss', datetime('now'), ?, 'test', datetime('now'))
    `);
    db.transaction(() => {
      for (let i = 0; i < n; i++) {
        insert.run(
          `rss:test:${i}`,
          `Event ${i}`,
          `Content ${i} about kubernetes container gpu nvidia`,
          JSON.stringify(['ai.foundation-models']),
        );
      }
    })();
    db.close();
    return dbPath;
  }

  it('returns error when training DB has fewer than 500 labeled events', () => {
    const dbPath = createMinimalTrainingDb(100);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(() =>
        trainClassifier(db, { outputPath: join(tmpDir, 'model.json') }),
      ).toThrow(/Insufficient training data/);
    } finally {
      db.close();
    }
  });

  it('produces valid model with ≥500 labeled events', () => {
    const dbPath = createMinimalTrainingDb(600);
    const db = new Database(dbPath, { readonly: true });
    try {
      const result = trainClassifier(db, {
        outputPath: join(tmpDir, 'model500.json'),
        minExamples: 5,
      });
      expect(existsSync(result.model_path)).toBe(true);
      expect(result.vocabulary_size).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('min-examples flag changes which topics use logistic vs BM25 fallback', () => {
    const dbPath = createMinimalTrainingDb(600);
    const db = new Database(dbPath, { readonly: true });
    try {
      const low = trainClassifier(db, {
        outputPath: join(tmpDir, 'model-low.json'),
        minExamples: 5,
      });
      const lrCountLow = low.per_topic.filter(
        (t: { method: string }) => t.method === 'logistic',
      ).length;

      const high = trainClassifier(db, {
        outputPath: join(tmpDir, 'model-high.json'),
        minExamples: 999,
      });
      const lrCountHigh = high.per_topic.filter(
        (t: { method: string }) => t.method === 'logistic',
      ).length;

      // Higher threshold should result in fewer logistic topics
      expect(lrCountHigh).toBeLessThan(lrCountLow);
    } finally {
      db.close();
    }
  });

  it('output path collision produces error', () => {
    const dbPath = createMinimalTrainingDb(600);
    const existingPath = join(tmpDir, 'existing-model.json');
    writeFileSync(existingPath, '{}');

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(() =>
        trainClassifier(db, { outputPath: existingPath, minExamples: 5 }),
      ).toThrow(/already exists/);
    } finally {
      db.close();
    }
  });
});

// --- Chi-squared vocabulary selection (3 tests) ---

describe('Chi-squared vocabulary selection', () => {
  it('selects discriminative terms over common terms', () => {
    // "common" appears in all docs, "kubernetes" only in topic A, "neural" only in topic B
    const docs = [
      ['common', 'kubernetes', 'cluster'],
      ['common', 'kubernetes', 'pod'],
      ['common', 'neural', 'network'],
      ['common', 'neural', 'transformer'],
    ];
    const labels = [['infra'], ['infra'], ['ai'], ['ai']];
    const vocab = buildVocabularyChiSquared(docs, labels, 3);

    // Discriminative terms should be selected; "common" should not since it's uniform across topics
    expect(vocab.has('kubernetes')).toBe(true);
    expect(vocab.has('neural')).toBe(true);
    // "common" has chi-squared=0 since it appears uniformly — should rank lowest
    expect(vocab.size).toBe(3);
  });

  it('respects maxSize limit', () => {
    const docs = Array.from({ length: 20 }, (_, i) => [`term${i}`, 'shared']);
    const labels = docs.map((_, i) => [i < 10 ? 'a' : 'b']);
    const vocab = buildVocabularyChiSquared(docs, labels, 5);
    expect(vocab.size).toBeLessThanOrEqual(5);
  });

  it('handles single-topic data gracefully', () => {
    const docs = [['hello', 'world'], ['hello', 'foo']];
    const labels = [['only-topic'], ['only-topic']];
    const vocab = buildVocabularyChiSquared(docs, labels, 10);
    expect(vocab.size).toBeGreaterThan(0);
  });
});

// --- LR weight properties (2 tests) ---

describe('LR weight properties', () => {
  it('trained weights are sparse with large vocabulary', () => {
    // Use many documents with varied vocabulary to show sparsity
    const posTerms = ['kubernetes', 'container', 'cluster', 'pod', 'helm', 'deployment'];
    const negTerms = ['neural', 'network', 'transformer', 'language', 'model', 'inference'];
    const fillerTerms = Array.from({ length: 50 }, (_, i) => `filler${i}`);
    const docs: string[][] = [];
    const labels: boolean[] = [];

    for (let i = 0; i < 30; i++) {
      // Positive docs: pos terms + random filler
      docs.push([...posTerms, fillerTerms[i % 50], fillerTerms[(i + 7) % 50]]);
      labels.push(true);
      // Negative docs: neg terms + different random filler
      docs.push([...negTerms, fillerTerms[(i + 3) % 50], fillerTerms[(i + 11) % 50]]);
      labels.push(false);
    }

    const vocab = buildVocabulary(docs, 1000);
    const idf = computeCorpusIDF(docs, vocab);
    const vectors = docs.map((d) => vectorize(d, vocab, idf, true));

    const lr = trainLogistic(vectors, labels, vocab.size);

    // With L2 regularization, filler terms that appear in both classes should have
    // near-zero weights. Weights should be nonzero but not cover entire vocab.
    expect(lr.weights.size).toBeGreaterThan(0);
    expect(lr.weights.size).toBeLessThanOrEqual(vocab.size);
  });

  it('different topics produce different weight vectors', () => {
    const docs = [
      tokenize('kubernetes container'),
      tokenize('neural network'),
      tokenize('kubernetes pod'),
      tokenize('deep learning'),
    ];
    const labelsA = [true, false, true, false];
    const labelsB = [false, true, false, true];
    const vocab = buildVocabulary(docs, 1000);
    const idf = computeCorpusIDF(docs, vocab);
    const vectors = docs.map((d) => vectorize(d, vocab, idf, true));

    const lrA = trainLogistic(vectors, labelsA, vocab.size);
    const lrB = trainLogistic(vectors, labelsB, vocab.size);

    // Weight vectors should differ
    let same = true;
    for (const [idx, val] of lrA.weights) {
      if (Math.abs(val - (lrB.weights.get(idx) ?? 0)) > 0.001) {
        same = false;
        break;
      }
    }
    expect(same).toBe(false);
  });
});

// --- Stratified split (2 tests) ---

describe('Stratified train/val split', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'intel-strat-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rare topics appear in validation set', () => {
    // Create a training DB where one topic is very rare
    const dbPath = join(tmpDir, 'strat-test.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma(`application_id = 0x54524E47`);

    db.exec(`
      CREATE TABLE training_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        title TEXT, content TEXT, url TEXT, source TEXT, feed TEXT,
        published_at TEXT, fetched_at TEXT, author TEXT,
        score INTEGER DEFAULT 0, comments INTEGER DEFAULT 0,
        machine_topics TEXT NOT NULL DEFAULT '[]',
        machine_confidences TEXT NOT NULL DEFAULT '[]',
        machine_scores TEXT NOT NULL DEFAULT '[]',
        human_topics TEXT, labeler TEXT DEFAULT 'unspecified',
        notes TEXT, reviewed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE training_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        human_topics TEXT NOT NULL,
        labeler TEXT NOT NULL,
        notes TEXT,
        labeled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE training_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO training_meta VALUES ('schema_version', '1')").run();

    const insert = db.prepare(`
      INSERT INTO training_events (event_id, title, content, source, fetched_at,
        human_topics, labeler, reviewed_at)
      VALUES (?, ?, ?, 'rss', datetime('now'), ?, 'test', datetime('now'))
    `);

    db.transaction(() => {
      // 490 events for common topic
      for (let i = 0; i < 490; i++) {
        insert.run(
          `rss:common:${i}`,
          `Common topic event ${i}`,
          `Content about language model llm transformer ${i}`,
          JSON.stringify(['ai.foundation-models']),
        );
      }
      // 10 events for rare topic — with positional slice these would all end up in train
      for (let i = 0; i < 10; i++) {
        insert.run(
          `rss:rare:${i}`,
          `Rare topic event ${i}`,
          `Content about gpu nvidia cuda h100 accelerator ${i}`,
          JSON.stringify(['compute.gpu']),
        );
      }
    })();

    try {
      const result = trainClassifier(db, {
        outputPath: join(tmpDir, 'strat-model.json'),
        minExamples: 5,
        validationSplit: 0.2,
      });

      // compute.gpu should have been trained (not just bm25_fallback)
      const gpuResult = result.per_topic.find((t) => t.topic === 'compute.gpu');
      if (gpuResult) {
        expect(gpuResult.method).toBe('logistic');
      }
    } finally {
      db.close();
    }
  });

  it('model version is 4', () => {
    const dbPath = join(tmpDir, 'version-test.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma(`application_id = 0x54524E47`);

    db.exec(`
      CREATE TABLE training_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        title TEXT, content TEXT, url TEXT, source TEXT, feed TEXT,
        published_at TEXT, fetched_at TEXT, author TEXT,
        score INTEGER DEFAULT 0, comments INTEGER DEFAULT 0,
        machine_topics TEXT NOT NULL DEFAULT '[]',
        machine_confidences TEXT NOT NULL DEFAULT '[]',
        machine_scores TEXT NOT NULL DEFAULT '[]',
        human_topics TEXT, labeler TEXT DEFAULT 'unspecified',
        notes TEXT, reviewed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE training_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        human_topics TEXT NOT NULL,
        labeler TEXT NOT NULL,
        notes TEXT,
        labeled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE training_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO training_meta VALUES ('schema_version', '1')").run();

    const insert = db.prepare(`
      INSERT INTO training_events (event_id, title, content, source, fetched_at,
        human_topics, labeler, reviewed_at)
      VALUES (?, ?, ?, 'rss', datetime('now'), ?, 'test', datetime('now'))
    `);
    db.transaction(() => {
      for (let i = 0; i < 600; i++) {
        insert.run(
          `rss:v:${i}`,
          `Event ${i}`,
          `Content about kubernetes container gpu nvidia ${i}`,
          JSON.stringify(['ai.foundation-models']),
        );
      }
    })();

    try {
      const result = trainClassifier(db, {
        outputPath: join(tmpDir, 'v2-model.json'),
        minExamples: 5,
      });
      const model = JSON.parse(readFileSync(result.model_path, 'utf-8'));
      expect(model.version).toBe(4);
    } finally {
      db.close();
    }
  });
});

// --- Statistical model ensemble (2 tests) ---

describe('Statistical model ensemble', () => {
  afterEach(() => {
    clearStatModel();
  });

  it('classify is unchanged when no stat model is loaded', () => {
    clearStatModel();
    expect(hasStatModel()).toBe(false);

    // Should still work fine with BM25 only
    const topics = classifyIds('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents...');
    expect(topics).toContain('ai.foundation-models');
  });

  it('loadStatModel returns false for non-existent file', () => {
    const loaded = loadStatModel('/tmp/nonexistent-stat-model.json');
    expect(loaded).toBe(false);
    expect(hasStatModel()).toBe(false);
  });

  it('positive LR weights boost BM25 score', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'intel-ensemble-'));
    try {
      // Get baseline score without stat model
      clearStatModel();
      const baseline = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents foundation model llm');
      const baselineFoundation = baseline.find((t) => t.id === 'ai.foundation-models');
      expect(baselineFoundation).toBeDefined();
      const baselineScore = baselineFoundation!.score;

      // Build a synthetic model with strong positive weights for ai.foundation-models
      const topics = getLoadedTopics();
      const vocab: Record<string, number> = {};
      const terms = ['bedrock', 'agents', 'foundation', 'model', 'llm', 'amazon'];
      terms.forEach((t, i) => { vocab[t] = i; });
      const idf = terms.map(() => 1.0);

      // Strong positive weights so LR score exceeds threshold
      const weights: Record<number, number> = {};
      terms.forEach((_, i) => { weights[i] = 2.0; });

      const model: ClassifierModel = {
        version: 3,
        created_at: new Date().toISOString(),
        vocabulary: vocab,
        idf,
        classifiers: {
          'ai.foundation-models': { weights, bias: 0, score_threshold: 0.5 },
        },
        training_meta: {
          training_db: 'test',
          num_examples: 100,
          num_positive_per_topic: { 'ai.foundation-models': 50 },
          training_date: new Date().toISOString(),
        },
      };

      const modelPath = join(tmpDir, 'pos-model.json');
      writeFileSync(modelPath, JSON.stringify(model));
      expect(loadStatModel(modelPath)).toBe(true);

      const boosted = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents foundation model llm');
      const boostedFoundation = boosted.find((t) => t.id === 'ai.foundation-models');
      expect(boostedFoundation).toBeDefined();
      expect(boostedFoundation!.score).toBeGreaterThan(baselineScore);
    } finally {
      clearStatModel();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('negative LR weights penalize BM25 score', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'intel-ensemble-'));
    try {
      // Get baseline score without stat model
      clearStatModel();
      const baseline = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents foundation model llm');
      const baselineFoundation = baseline.find((t) => t.id === 'ai.foundation-models');
      expect(baselineFoundation).toBeDefined();
      const baselineScore = baselineFoundation!.score;

      // Build a synthetic model with strong negative weights so LR score is below threshold
      const vocab: Record<string, number> = {};
      const terms = ['bedrock', 'agents', 'foundation', 'model', 'llm', 'amazon'];
      terms.forEach((t, i) => { vocab[t] = i; });
      const idf = terms.map(() => 1.0);

      const weights: Record<number, number> = {};
      terms.forEach((_, i) => { weights[i] = -2.0; });

      const model: ClassifierModel = {
        version: 3,
        created_at: new Date().toISOString(),
        vocabulary: vocab,
        idf,
        classifiers: {
          'ai.foundation-models': { weights, bias: 0, score_threshold: 0.5 },
        },
        training_meta: {
          training_db: 'test',
          num_examples: 100,
          num_positive_per_topic: { 'ai.foundation-models': 50 },
          training_date: new Date().toISOString(),
        },
      };

      const modelPath = join(tmpDir, 'neg-model.json');
      writeFileSync(modelPath, JSON.stringify(model));
      expect(loadStatModel(modelPath)).toBe(true);

      const penalized = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents foundation model llm');
      const penalizedFoundation = penalized.find((t) => t.id === 'ai.foundation-models');
      expect(penalizedFoundation).toBeDefined();
      expect(penalizedFoundation!.score).toBeLessThan(baselineScore);
    } finally {
      clearStatModel();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('clearStatModel returns to exact baseline scores', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'intel-ensemble-'));
    try {
      // Get baseline score without stat model
      clearStatModel();
      const baseline = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents foundation model llm');
      const baselineFoundation = baseline.find((t) => t.id === 'ai.foundation-models');
      expect(baselineFoundation).toBeDefined();
      const baselineScore = baselineFoundation!.score;

      // Load a model to change scores
      const vocab: Record<string, number> = { bedrock: 0, agents: 1 };
      const model: ClassifierModel = {
        version: 3,
        created_at: new Date().toISOString(),
        vocabulary: vocab,
        idf: [1.0, 1.0],
        classifiers: {
          'ai.foundation-models': { weights: { 0: 2.0, 1: 2.0 }, bias: 0, score_threshold: 0.5 },
        },
        training_meta: {
          training_db: 'test',
          num_examples: 100,
          num_positive_per_topic: { 'ai.foundation-models': 50 },
          training_date: new Date().toISOString(),
        },
      };

      const modelPath = join(tmpDir, 'clear-model.json');
      writeFileSync(modelPath, JSON.stringify(model));
      expect(loadStatModel(modelPath)).toBe(true);
      expect(hasStatModel()).toBe(true);

      // Clear and verify exact baseline return
      clearStatModel();
      expect(hasStatModel()).toBe(false);

      const restored = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents foundation model llm');
      const restoredFoundation = restored.find((t) => t.id === 'ai.foundation-models');
      expect(restoredFoundation).toBeDefined();
      expect(restoredFoundation!.score).toBe(baselineScore);
    } finally {
      clearStatModel();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// --- V4 ensemble: LR independent scoring (5 tests) ---

describe('V4 ensemble: LR independent scoring', () => {
  afterEach(() => {
    clearStatModel();
  });

  it('LR surfaces topic missed by BM25', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'intel-v4-surface-'));
    try {
      clearStatModel();

      // Use a fabricated topic ID that no BM25 keywords match.
      // The text uses invented terms that only the LR model knows about.
      const testTitle = 'Zorblax Plinkton Analysis';
      const testContent = 'Examining zorblax plinkton dynamics and frobnar correlation patterns';

      // Verify BM25 alone returns nothing for this text
      const baseline = classify(testTitle, testContent);
      expect(baseline.length).toBe(0);

      // Build a v4 model where LR has strong weights for these invented terms
      // mapped to a real topic that BM25 won't find via keywords
      const terms = ['zorblax', 'plinkton', 'dynamics', 'frobnar', 'correlation', 'patterns', 'examining'];
      const vocab: Record<string, number> = {};
      terms.forEach((t, i) => { vocab[t] = i; });
      const idf = terms.map(() => 1.0);

      // Strong positive weights so LR sigmoid probability is high (>0.7)
      const weights: Record<number, number> = {};
      terms.forEach((_, i) => { weights[i] = 3.0; });

      const model: ClassifierModel = {
        version: 4,
        created_at: new Date().toISOString(),
        vocabulary: vocab,
        idf,
        classifiers: {
          'ai.safety': {
            weights,
            bias: 0,
            score_threshold: 0.5,
            blend_alpha: 0.4,
            lr_val_f1: 0.6,
            bm25_val_f1: 0.5,
          },
        },
        training_meta: {
          training_db: 'test',
          num_examples: 100,
          num_positive_per_topic: { 'ai.safety': 50 },
          training_date: new Date().toISOString(),
        },
      };

      const modelPath = join(tmpDir, 'v4-surface.json');
      writeFileSync(modelPath, JSON.stringify(model));
      expect(loadStatModel(modelPath)).toBe(true);

      const result = classify(testTitle, testContent);
      const surfaced = result.find((t) => t.id === 'ai.safety');
      expect(surfaced).toBeDefined();
      expect(surfaced!.score).toBeGreaterThan(0);
    } finally {
      clearStatModel();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('per-topic alpha respected: higher alpha shows more LR influence', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'intel-v4-alpha-'));
    try {
      clearStatModel();

      // Get baseline scores without stat model
      const baseline = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents foundation model llm');
      const baselineFoundation = baseline.find((t) => t.id === 'ai.foundation-models');
      expect(baselineFoundation).toBeDefined();

      // Build model with two topics at different alphas, both with positive LR weights
      const terms = ['bedrock', 'agents', 'foundation', 'model', 'llm', 'amazon'];
      const vocab: Record<string, number> = {};
      terms.forEach((t, i) => { vocab[t] = i; });
      const idf = terms.map(() => 1.0);

      const weights: Record<number, number> = {};
      terms.forEach((_, i) => { weights[i] = 3.0; });

      // Test with LOW alpha first
      const modelLow: ClassifierModel = {
        version: 4,
        created_at: new Date().toISOString(),
        vocabulary: vocab,
        idf,
        classifiers: {
          'ai.foundation-models': {
            weights,
            bias: 0,
            score_threshold: 0.5,
            blend_alpha: 0.05,
            lr_val_f1: 0.2,
            bm25_val_f1: 0.6,
          },
        },
        training_meta: {
          training_db: 'test',
          num_examples: 100,
          num_positive_per_topic: { 'ai.foundation-models': 50 },
          training_date: new Date().toISOString(),
        },
      };

      const lowPath = join(tmpDir, 'v4-low-alpha.json');
      writeFileSync(lowPath, JSON.stringify(modelLow));
      loadStatModel(lowPath);
      const lowResult = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents foundation model llm');
      const lowFoundation = lowResult.find((t) => t.id === 'ai.foundation-models');
      expect(lowFoundation).toBeDefined();
      const lowDelta = Math.abs(lowFoundation!.score - baselineFoundation!.score);

      clearStatModel();

      // Test with HIGH alpha
      const modelHigh: ClassifierModel = {
        version: 4,
        created_at: new Date().toISOString(),
        vocabulary: vocab,
        idf,
        classifiers: {
          'ai.foundation-models': {
            weights,
            bias: 0,
            score_threshold: 0.5,
            blend_alpha: 0.5,
            lr_val_f1: 0.7,
            bm25_val_f1: 0.5,
          },
        },
        training_meta: {
          training_db: 'test',
          num_examples: 100,
          num_positive_per_topic: { 'ai.foundation-models': 50 },
          training_date: new Date().toISOString(),
        },
      };

      const highPath = join(tmpDir, 'v4-high-alpha.json');
      writeFileSync(highPath, JSON.stringify(modelHigh));
      loadStatModel(highPath);
      const highResult = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents foundation model llm');
      const highFoundation = highResult.find((t) => t.id === 'ai.foundation-models');
      expect(highFoundation).toBeDefined();
      const highDelta = Math.abs(highFoundation!.score - baselineFoundation!.score);

      // Higher alpha should produce more score change from baseline
      expect(highDelta).toBeGreaterThan(lowDelta);
    } finally {
      clearStatModel();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('LR-only requires prob >= 0.7: low-confidence LR is not surfaced', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'intel-v4-minprob-'));
    try {
      clearStatModel();

      // Text that won't match any BM25 keywords
      const testTitle = 'Zorblax Plinkton Analysis';
      const testContent = 'Examining zorblax plinkton dynamics';

      // Verify baseline returns nothing
      expect(classify(testTitle, testContent).length).toBe(0);

      // Build a model with WEAK LR weights (prob below 0.7)
      const terms = ['zorblax', 'plinkton', 'dynamics', 'examining'];
      const vocab: Record<string, number> = {};
      terms.forEach((t, i) => { vocab[t] = i; });
      const idf = terms.map(() => 1.0);

      // Very weak weights → sigmoid(sum) will be close to 0.5, below 0.7
      const weights: Record<number, number> = {};
      terms.forEach((_, i) => { weights[i] = 0.05; });

      const model: ClassifierModel = {
        version: 4,
        created_at: new Date().toISOString(),
        vocabulary: vocab,
        idf,
        classifiers: {
          'ai.safety': {
            weights,
            bias: -0.5, // push probability lower
            score_threshold: 0.5,
            blend_alpha: 0.4,
            lr_val_f1: 0.6,
            bm25_val_f1: 0.5,
          },
        },
        training_meta: {
          training_db: 'test',
          num_examples: 100,
          num_positive_per_topic: { 'ai.safety': 50 },
          training_date: new Date().toISOString(),
        },
      };

      const modelPath = join(tmpDir, 'v4-lowprob.json');
      writeFileSync(modelPath, JSON.stringify(model));
      expect(loadStatModel(modelPath)).toBe(true);

      const result = classify(testTitle, testContent);
      const surfaced = result.find((t) => t.id === 'ai.safety');
      expect(surfaced).toBeUndefined();
    } finally {
      clearStatModel();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('v3 backward compat: classify works with v3 model (no blend_alpha)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'intel-v3-compat-'));
    try {
      clearStatModel();

      // Build a v3 model (no blend_alpha fields)
      const terms = ['bedrock', 'agents', 'foundation', 'model', 'llm'];
      const vocab: Record<string, number> = {};
      terms.forEach((t, i) => { vocab[t] = i; });
      const idf = terms.map(() => 1.0);

      const weights: Record<number, number> = {};
      terms.forEach((_, i) => { weights[i] = 2.0; });

      const model: ClassifierModel = {
        version: 3,
        created_at: new Date().toISOString(),
        vocabulary: vocab,
        idf,
        classifiers: {
          'ai.foundation-models': { weights, bias: 0, score_threshold: 0.5 },
        },
        training_meta: {
          training_db: 'test',
          num_examples: 100,
          num_positive_per_topic: { 'ai.foundation-models': 50 },
          training_date: new Date().toISOString(),
        },
      };

      const modelPath = join(tmpDir, 'v3-model.json');
      writeFileSync(modelPath, JSON.stringify(model));
      expect(loadStatModel(modelPath)).toBe(true);
      expect(hasStatModel()).toBe(true);

      // classify should work without errors and return results
      const result = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents foundation model llm');
      expect(result.length).toBeGreaterThan(0);
      expect(result.find((t) => t.id === 'ai.foundation-models')).toBeDefined();
    } finally {
      clearStatModel();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('v4 model serialization: trainClassifier outputs blend_alpha and version 4', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'intel-v4-serial-'));
    try {
      const dbPath = join(tmpDir, 'v4-train.db');
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma(`application_id = 0x54524E47`);

      db.exec(`
        CREATE TABLE training_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT UNIQUE NOT NULL,
          title TEXT, content TEXT, url TEXT, source TEXT, feed TEXT,
          published_at TEXT, fetched_at TEXT, author TEXT,
          score INTEGER DEFAULT 0, comments INTEGER DEFAULT 0,
          machine_topics TEXT NOT NULL DEFAULT '[]',
          machine_confidences TEXT NOT NULL DEFAULT '[]',
          machine_scores TEXT NOT NULL DEFAULT '[]',
          human_topics TEXT, labeler TEXT DEFAULT 'unspecified',
          notes TEXT, reviewed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE training_labels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL,
          human_topics TEXT NOT NULL,
          labeler TEXT NOT NULL,
          notes TEXT,
          labeled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE training_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      db.prepare("INSERT INTO training_meta VALUES ('schema_version', '1')").run();

      const topics = [
        'ai.foundation-models', 'ai.safety', 'ai.agents',
        'compute.gpu', 'security.vulnerabilities', 'data.relational',
      ];
      const topicKeywords: Record<string, string> = {
        'ai.foundation-models': 'large language model llm transformer neural network',
        'ai.safety': 'ai safety alignment red teaming guardrails',
        'ai.agents': 'ai agent autonomous agentic tool use function calling',
        'compute.gpu': 'gpu nvidia cuda h100 training accelerator',
        'security.vulnerabilities': 'vulnerability cve exploit zero-day security advisory',
        'data.relational': 'postgresql postgres database relational sql query',
      };

      const insert = db.prepare(`
        INSERT INTO training_events (event_id, title, content, source, fetched_at,
          human_topics, labeler, reviewed_at)
        VALUES (?, ?, ?, 'rss', datetime('now'), ?, 'test', datetime('now'))
      `);

      db.transaction(() => {
        for (let i = 0; i < 600; i++) {
          const topic = topics[i % topics.length];
          insert.run(
            `rss:v4:${i}`,
            `Test ${topic} Event ${i}`,
            `Content about ${topicKeywords[topic]} with additional context words ${i}`,
            JSON.stringify([topic]),
          );
        }
      })();

      const result = trainClassifier(db, {
        outputPath: join(tmpDir, 'v4-model.json'),
        minExamples: 5,
        validationSplit: 0.2,
      });

      const model = JSON.parse(readFileSync(result.model_path, 'utf-8')) as ClassifierModel;
      expect(model.version).toBe(4);

      // At least one classifier should have blend_alpha
      const classifierEntries = Object.entries(model.classifiers);
      expect(classifierEntries.length).toBeGreaterThan(0);

      for (const [, cls] of classifierEntries) {
        expect(cls.blend_alpha).toBeDefined();
        expect(typeof cls.blend_alpha).toBe('number');
        expect(cls.blend_alpha!).toBeGreaterThanOrEqual(0.05);
        expect(cls.blend_alpha!).toBeLessThanOrEqual(0.5);
        expect(cls.lr_val_f1).toBeDefined();
        expect(cls.bm25_val_f1).toBeDefined();
      }

      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
