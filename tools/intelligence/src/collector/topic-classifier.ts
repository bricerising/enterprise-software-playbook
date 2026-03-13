import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

interface TopicMatch {
  id: string;
  priority: number;
}

let loadedTopics: TopicDef[] = [];

export function loadTopics(topicsPath?: string): TopicDef[] {
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
  return loadedTopics;
}

export function getLoadedTopics(): TopicDef[] {
  return loadedTopics;
}

/**
 * Classify text into topics. Returns up to maxTopics topic IDs,
 * sorted by priority (highest first).
 */
export function classify(
  title: string | null,
  content: string | null,
  maxTopics = 5,
): string[] {
  if (loadedTopics.length === 0) return [];

  const combined = [title ?? '', content ?? ''].join(' ');
  const lowerCombined = combined.toLowerCase();

  const matches: TopicMatch[] = [];

  for (const topic of loadedTopics) {
    if (matchesTopic(topic, lowerCombined, combined)) {
      matches.push({ id: topic.id, priority: topic.priority });
    }
  }

  // Sort by priority descending, take top N
  matches.sort((a, b) => b.priority - a.priority);
  return matches.slice(0, maxTopics).map((m) => m.id);
}

function matchesTopic(topic: TopicDef, lowerText: string, originalText: string): boolean {
  let keywordMatch = false;

  // Check keywords (case-insensitive)
  for (const kw of topic.keywords) {
    if (lowerText.includes(kw)) {
      keywordMatch = true;
      break;
    }
  }

  // Check regex patterns
  if (!keywordMatch && topic.regex) {
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
          keywordMatch = true;
          break;
        }
      } catch {
        // Invalid regex — skip
      }
    }
  }

  if (!keywordMatch) return false;

  // Context validation for short acronyms
  if (topic.context_required && topic.context_terms && topic.context_terms.length > 0) {
    const hasContext = topic.context_terms.some((term) => lowerText.includes(term));
    if (!hasContext) return false;
  }

  return true;
}
