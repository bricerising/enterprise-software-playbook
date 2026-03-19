import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOPICS_PATH = join(__dirname, '..', '..', 'config', 'topics.yaml');

export interface TopicDef {
  id: string;
  label: string;
  keywords: string[];
  regex?: string[];
  priority: number;
  context_required?: boolean;
  context_terms?: string[];
}

export interface ClassifiedTopic {
  id: string;
  confidence: number;
}

interface TopicMatchResult {
  id: string;
  priority: number;
  confidence: number;
}

let loadedTopics: TopicDef[] = [];
let topicWeights: Map<string, number> = new Map();

export function loadTopics(topicsPath?: string, db?: Database.Database): TopicDef[] {
  const path = topicsPath ?? DEFAULT_TOPICS_PATH;
  if (!existsSync(path)) {
    console.error(`[intel] Topics file not found: ${path}`);
    return [];
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as { topics: TopicDef[] };
  loadedTopics = (parsed.topics ?? []).map((t) => ({
    ...t,
    keywords: (t.keywords ?? []).map((k) => k.toLowerCase()),
    context_terms: (t.context_terms ?? []).map((c) => c.toLowerCase()),
    priority: t.priority ?? 1,
  }));

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

export function getLoadedTopics(): TopicDef[] {
  return loadedTopics;
}

/**
 * Classify text into topics with confidence scores. Returns up to maxTopics
 * ClassifiedTopic entries, sorted by priority (highest first).
 */
export function classify(
  title: string | null,
  content: string | null,
  maxTopics = 5,
): ClassifiedTopic[] {
  if (loadedTopics.length === 0) return [];

  const combined = [title ?? '', content ?? ''].join(' ');
  const lowerCombined = combined.toLowerCase();

  const matches: TopicMatchResult[] = [];

  for (const topic of loadedTopics) {
    const result = matchesTopic(topic, lowerCombined, combined);
    if (result.matched) {
      matches.push({ id: topic.id, priority: topic.priority, confidence: result.confidence });
    }
  }

  // Sort by priority descending, take top N
  matches.sort((a, b) => b.priority - a.priority);
  return matches.slice(0, maxTopics).map((m) => ({ id: m.id, confidence: m.confidence }));
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

function matchesTopic(
  topic: TopicDef,
  lowerText: string,
  originalText: string,
): { matched: boolean; confidence: number } {
  let keywordHits = 0;
  let regexHits = 0;

  // Count keyword hits (case-insensitive)
  for (const kw of topic.keywords) {
    if (lowerText.includes(kw)) {
      keywordHits++;
    }
  }

  // Count regex pattern hits
  if (topic.regex) {
    for (const rawPattern of topic.regex) {
      try {
        // Handle (?i) inline flag — JS uses 'i' flag on constructor instead
        let pattern = rawPattern;
        let flags = '';
        if (pattern.startsWith('(?i)')) {
          pattern = pattern.slice(4);
          flags = 'i';
        }
        const re = new RegExp(pattern, flags);
        if (re.test(originalText)) {
          regexHits++;
        }
      } catch {
        // Invalid regex — skip
      }
    }
  }

  if (keywordHits === 0 && regexHits === 0) {
    return { matched: false, confidence: 0 };
  }

  // Context validation for short acronyms
  let contextPassed = true;
  if (topic.context_required && topic.context_terms && topic.context_terms.length > 0) {
    contextPassed = topic.context_terms.some((term) => lowerText.includes(term));
    if (!contextPassed) {
      return { matched: false, confidence: 0 };
    }
  }

  // Confidence formula:
  // base = 0.5 + min(keywordHits - 1, 3) × 0.1 + regexHits × 0.05   (capped at 0.8)
  // contextBoost = context_required && passed ? 1.25 : 1.0
  // priorityFactor = 0.6 + 0.4 × (priority / 100)
  // raw_confidence = min(1.0, base × contextBoost × priorityFactor)
  // final_confidence = min(1.0, raw_confidence × topic_weight)
  const base = Math.min(0.8, 0.5 + Math.min(keywordHits - 1, 3) * 0.1 + regexHits * 0.05);
  const contextBoost = topic.context_required && contextPassed ? 1.25 : 1.0;
  const priorityFactor = 0.6 + 0.4 * (topic.priority / 100);
  const rawConfidence = Math.min(1.0, base * contextBoost * priorityFactor);
  const weight = topicWeights.get(topic.id) ?? 1.0;
  const finalConfidence = Math.min(1.0, rawConfidence * weight);

  return {
    matched: true,
    confidence: Math.round(finalConfidence * 1000) / 1000,
  };
}
