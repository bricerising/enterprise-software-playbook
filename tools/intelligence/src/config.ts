import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const FeedSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('rss'),
    url: z.string().url(),
    name: z.string(),
    category: z.string().optional(),
    poll_interval: z.number().positive().optional(),
    request_options: z
      .object({
        headers: z.record(z.string()).optional(),
      })
      .optional(),
  }),
  z.object({
    source: z.literal('hackernews'),
    name: z.string(),
    modes: z.array(z.enum(['new', 'top', 'best'])).optional().default(['new', 'top']),
    poll_interval: z.number().positive().optional(),
    max_items: z.number().positive().optional().default(100),
  }),
  z.object({
    source: z.literal('lobsters'),
    name: z.string(),
    poll_interval: z.number().positive().optional(),
  }),
  z.object({
    source: z.literal('edgar'),
    name: z.string(),
    form_types: z.array(z.string()).optional().default(['8-K', '10-K', '10-Q']),
    poll_interval: z.number().positive().optional(),
    entities: z.array(z.string()).optional(),
  }),
]);

const CollectorSchema = z.object({
  poll_interval_seconds: z.number().positive().default(300),
  fetch_content: z.boolean().default(true),
  content_timeout_ms: z.number().positive().default(10000),
  max_content_length: z.number().positive().default(50000),
  retention_days: z.number().positive().default(30),
  edgar_contact: z.string().email().optional(),
  edgar_max_rps: z.number().positive().max(10).default(2),
  synchronous: z.enum(['normal', 'full']).default('normal'),
  batch_size: z.number().positive().default(100),
  wal_autocheckpoint: z.number().nonnegative().default(1000),
  journal_size_limit_bytes: z.number().int().default(67108864),
  blocked_domains: z.array(z.string()).default([]),
});

const OutputSchema = z.object({
  format: z.enum(['json', 'text']).default('json'),
  timezone: z.string().default('America/New_York'),
});

const ConfigSchema = z.object({
  database: z.string().default('~/.local/share/intel/intelligence.db'),
  collector: CollectorSchema.default({}),
  feeds: z.array(FeedSchema).default([]),
  topics_file: z.string().optional(),
  output: OutputSchema.default({}),
});

export type IntelConfig = z.infer<typeof ConfigSchema>;
export type FeedConfig = z.infer<typeof FeedSchema>;

function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Validate EDGAR-specific config constraints.
 * - edgar_contact required if any EDGAR feeds exist
 * - edgar_max_rps <= 10
 */
function validateEdgar(config: IntelConfig): string[] {
  const errors: string[] = [];
  const hasEdgar = config.feeds.some((f) => f.source === 'edgar');

  if (hasEdgar) {
    if (!config.collector.edgar_contact) {
      errors.push(
        'collector.edgar_contact is required when EDGAR feeds are configured. ' +
          'SEC EDGAR requires a contact email in the User-Agent header.',
      );
    }
    if (config.collector.edgar_max_rps > 10) {
      errors.push(
        `collector.edgar_max_rps is ${config.collector.edgar_max_rps}, maximum is 10. ` +
          'SEC fair access policy limits requests to 10/second.',
      );
    }
  }

  return errors;
}

export function loadConfig(configPath?: string): IntelConfig {
  const paths = configPath
    ? [configPath]
    : [
        expandHome('~/.config/intel/config.yaml'),
        expandHome('~/.config/intel/config.yml'),
      ];

  let rawYaml: string | undefined;
  let usedPath: string | undefined;

  for (const p of paths) {
    const expanded = expandHome(p);
    if (existsSync(expanded)) {
      rawYaml = readFileSync(expanded, 'utf-8');
      usedPath = expanded;
      break;
    }
  }

  let raw: unknown = {};
  if (rawYaml) {
    raw = parseYaml(rawYaml);
  }

  const parsed = ConfigSchema.parse(raw);
  parsed.database = expandHome(parsed.database);

  if (parsed.topics_file) {
    parsed.topics_file = expandHome(parsed.topics_file);
  }

  // Validate EDGAR constraints
  const edgarErrors = validateEdgar(parsed);
  if (edgarErrors.length > 0) {
    throw new Error(`Configuration errors:\n${edgarErrors.map((e) => `  - ${e}`).join('\n')}`);
  }

  return parsed;
}

export function getDbPath(config: IntelConfig, cliOverride?: string): string {
  return cliOverride ? expandHome(cliOverride) : config.database;
}
