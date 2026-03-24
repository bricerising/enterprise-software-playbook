#!/usr/bin/env node

import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath } from 'node:path';
import { Command } from 'commander';
import { loadConfig, getDbPath, type IntelConfig } from './config.js';
import { openReader, withReader, openWriter, sqliteBusyRetry, checkSqliteVersion, getMigrations } from './db.js';
import { ok, error, busyError } from './util/envelope.js';
import { parseDuration, sinceISO } from './util/time.js';
import { runCollector } from './collector/index.js';
import { searchEvents } from './queries/search.js';
import { computeTrends } from './queries/trends.js';
import { listEvents, getEvent } from './queries/events.js';
import { addEntry, listEntries, searchJournal } from './queries/journal.js';
import { querySources } from './queries/sources.js';
import { queryTopics } from './queries/topics.js';
import { queryStats } from './queries/stats.js';
import { buildPack } from './queries/pack.js';
import { computeForecast, saveSnapshot, evaluateForecasts } from './queries/forecast/index.js';
import { startMcpServer } from './mcp/server.js';
import { loadTopics, loadStatModel } from './collector/topic-classifier.js';
import { ControlClient } from './control/channel.js';
import {
  generateTrainingSet,
  getNextUnreviewed,
  updateTrainingLabel,
  trainingProgress,
  listTrainingSets,
  exportTrainingSet,
  evaluateTrainingSet,
  reclassifyTrainingSet,
  openTrainingDb,
  TRAINING_APP_ID,
} from './queries/training.js';
import { trainClassifier } from './collector/classifier.js';
import {
  checkpoint as dbCheckpoint,
  prune as dbPrune,
  incrementalVacuum,
  backup as dbBackup,
  vacuumInto,
  rebuildFts,
  rebuildTopicIndex,
  reclassifyTopics,
  optimizeFts,
  quickCheck,
} from './db-maintenance.js';
import type { IntelErrorCode } from './types.js';

const program = new Command();

program
  .name('intel')
  .description('Intelligence collector and query tool')
  .version('0.1.0')
  .option('--config <path>', 'Path to config file')
  .option('--format <format>', 'Output format: json | text', 'json')
  .option('--db <path>', 'Database path override');

function getConfig(opts: { config?: string }): IntelConfig {
  return loadConfig(opts.config);
}

/** Convert a duration string (e.g., "7d") to an ISO timestamp for query filters */
function parseSince(duration?: string): string | undefined {
  if (!duration) return undefined;
  return sinceISO(parseDuration(duration));
}

function output(data: unknown, format: string): void {
  if (format === 'text') {
    console.log(
      typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    );
  } else {
    console.log(JSON.stringify(data));
  }
}

function handleError(err: unknown, context: 'read' | 'maintenance'): void {
  if (
    err instanceof Error &&
    (err.message.includes('SQLITE_BUSY') || err.message.includes('database is locked'))
  ) {
    output(busyError(context), program.opts().format ?? 'json');
    process.exitCode = 1;
    return;
  }

  if (err instanceof Error && err.message.includes('Database not found')) {
    output(
      error({
        code: 'DB_NOT_FOUND',
        message: err.message,
        retryable: false,
        suggested_action: 'Run `intel collect --once` to create the database.',
      }),
      program.opts().format ?? 'json',
    );
    process.exitCode = 1;
    return;
  }

  output(
    error({
      code: 'INTERNAL_ERROR' as IntelErrorCode,
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
      suggested_action: 'Check logs for details.',
    }),
    program.opts().format ?? 'json',
  );
  process.exitCode = 1;
}

// --- collect ---
const collect = program.command('collect').description('Start the collector daemon');

collect
  .option('--once', 'Single poll cycle, then exit')
  .option('--daemon', 'Run in background')
  .action(async (opts) => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      config.database = dbPath;

      await runCollector({ config, once: opts.once });
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

collect
  .command('status')
  .description('Check if daemon is running')
  .action(() => {
    const { running, pid } = ControlClient.isDaemonRunning();
    const fmt = program.opts().format ?? 'json';
    output(ok({ running, pid: pid ?? null }), fmt);
  });

collect
  .command('stop')
  .description('Stop background daemon')
  .action(async () => {
    try {
      const result = await ControlClient.sendCommand('stop');
      output(ok(result), program.opts().format ?? 'json');
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

// --- trends ---
program
  .command('trends')
  .description('Compute trending topics from recent events')
  .option('--window <duration>', 'Time window (e.g., 15m, 60m)', '60m')
  .option('--top <n>', 'Number of top trends', '10')
  .option('--since <duration>', 'Override window start')
  .option('--dedup <mode>', 'Dedup mode: canonical | none', 'canonical')
  .action((opts) => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      const result = sqliteBusyRetry(() =>
        withReader(dbPath, (db) =>
          computeTrends(db, {
            window: opts.window,
            top: parseInt(opts.top, 10),
            since: opts.since,
            dedup: opts.dedup,
          }),
        ),
      );
      output(result, fmt);
    } catch (err) {
      handleError(err, 'read');
    }
  });

// --- search ---
program
  .command('search <query>')
  .description('Full-text search across collected events')
  .option('--source <source>', 'Filter by source')
  .option('--topic <topic>', 'Filter by topic')
  .option('--since <duration>', 'Time bound')
  .option('--limit <n>', 'Max results', '20')
  .option('--cursor <token>', 'Pagination cursor')
  .action((query, opts) => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      const result = sqliteBusyRetry(() =>
        withReader(dbPath, (db) =>
          searchEvents(db, query, {
            source: opts.source,
            topic: opts.topic,
            since: parseSince(opts.since),
            limit: parseInt(opts.limit, 10),
            cursor: opts.cursor,
          }),
        ),
      );
      output(result, fmt);
    } catch (err) {
      handleError(err, 'read');
    }
  });

// --- events ---
program
  .command('events')
  .description('Browse events with filters')
  .option('--id <event_id>', 'Get single event by ID')
  .option('--topic <topic>', 'Filter by topic')
  .option('--source <source>', 'Filter by source')
  .option('--since <duration>', 'Time bound')
  .option('--limit <n>', 'Max results', '20')
  .option('--cursor <token>', 'Pagination cursor')
  .option('--raw', 'Return raw unsanitized content')
  .action((opts) => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      if (opts.id) {
        const result = sqliteBusyRetry(() =>
          withReader(dbPath, (db) => getEvent(db, opts.id, { raw: opts.raw })),
        );
        output(result, fmt);
      } else {
        const result = sqliteBusyRetry(() =>
          withReader(dbPath, (db) =>
            listEvents(db, {
              topic: opts.topic,
              source: opts.source,
              since: parseSince(opts.since),
              limit: parseInt(opts.limit, 10),
              cursor: opts.cursor,
            }),
          ),
        );
        output(result, fmt);
      }
    } catch (err) {
      handleError(err, 'read');
    }
  });

// --- sources ---
program
  .command('sources')
  .description('Check data source health and freshness')
  .option('--stale <duration>', 'Only stale sources')
  .action((opts) => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      const result = sqliteBusyRetry(() =>
        withReader(dbPath, (db) =>
          querySources(db, { stale: parseSince(opts.stale) }),
        ),
      );
      output(result, fmt);
    } catch (err) {
      handleError(err, 'read');
    }
  });

// --- topics ---
program
  .command('topics')
  .description('List configured topics')
  .option('--active', 'Only topics with events in last 7d')
  .option('--match <keyword>', 'Filter by keyword')
  .action((opts) => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      // Load configured topics from YAML allowlist
      const topicDefs = loadTopics(config.topics_file);
      const configuredTopics = topicDefs.map((t) => t.id);

      const result = sqliteBusyRetry(() =>
        withReader(dbPath, (db) =>
          queryTopics(db, {
            configuredTopics,
            active: opts.active,
            match: opts.match,
          }),
        ),
      );
      output(result, fmt);
    } catch (err) {
      handleError(err, 'read');
    }
  });

// --- stats ---
program
  .command('stats')
  .description('Database overview')
  .action(() => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      const result = sqliteBusyRetry(() =>
        withReader(dbPath, (db) => queryStats(db, dbPath)),
      );
      output(result, fmt);
    } catch (err) {
      handleError(err, 'read');
    }
  });

// --- pack ---
program
  .command('pack')
  .description('Produce a bounded evidence bundle')
  .option('--since <duration>', 'Time window', '6h')
  .option('--top <n>', 'Number of trends', '10')
  .option('--max-events <n>', 'Max events per trend', '5')
  .action((opts) => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      const result = sqliteBusyRetry(() =>
        withReader(dbPath, (db) =>
          buildPack(db, {
            since: opts.since,
            top: parseInt(opts.top, 10),
            maxEvents: parseInt(opts.maxEvents, 10),
          }),
        ),
      );
      output(result, fmt);
    } catch (err) {
      handleError(err, 'read');
    }
  });

// --- forecast ---
const forecast = program
  .command('forecast')
  .description('Predict likely next developments from event chain patterns')
  .option('--lag-window <days>', 'Max days between chain links', '7')
  .option('--min-support <n>', 'Min co-occurrences for valid chain', '2')
  .option('--top-scenarios <n>', 'Max scenarios to return', '10')
  .option('--dedup <mode>', 'Dedup mode: canonical | none', 'canonical')
  .option('--window <days>', 'Analysis window in days (7, 14, 30, 60, 90, or 120)', '120')
  .option('--compact', 'Return compact summary (top-N per section)')
  .option('--summary', 'Return minimal summary (top-3 scenarios, top-5 chains, change points)')
  .option('--with-context', 'Inline top event titles per change point and top chain topic')
  .option('--topics <topics>', 'Comma-separated topic IDs to filter output (e.g., ai.foundation-models,compute.gpu)')
  .option('--section <sections>', 'Comma-separated sections to include (e.g., lifecycles,entropy)')
  .option('--snapshot', 'Save forecast snapshot for later evaluation')
  .action((opts) => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';
      const windowDays = parseInt(opts.window, 10);

      if (opts.snapshot) {
        // Snapshot requires a writer connection
        const result = sqliteBusyRetry(() => {
          const writer = openWriter(dbPath);
          try {
            const forecast = computeForecast(writer, {
              lag_window_days: parseInt(opts.lagWindow, 10),
              min_support: parseInt(opts.minSupport, 10),
              top_scenarios: parseInt(opts.topScenarios, 10),
              dedup: opts.dedup,
              window_days: windowDays,
              compact: opts.compact ?? false,
              summary: opts.summary ?? false,
              with_context: opts.withContext ?? false,
              topics: opts.topics ? opts.topics.split(',').map((t: string) => t.trim()) : undefined,
              sections: opts.section ? opts.section.split(',').map((s: string) => s.trim()) : undefined,
            });
            const snap = saveSnapshot(writer, forecast.data.scenarios, windowDays);
            return ok({ forecast: forecast.data, snapshot: snap });
          } finally {
            writer.close();
          }
        });
        output(result, fmt);
      } else {
        const result = sqliteBusyRetry(() =>
          withReader(dbPath, (db) =>
            computeForecast(db, {
              lag_window_days: parseInt(opts.lagWindow, 10),
              min_support: parseInt(opts.minSupport, 10),
              top_scenarios: parseInt(opts.topScenarios, 10),
              dedup: opts.dedup,
              window_days: windowDays,
              compact: opts.compact ?? false,
              summary: opts.summary ?? false,
              with_context: opts.withContext ?? false,
              topics: opts.topics ? opts.topics.split(',').map((t: string) => t.trim()) : undefined,
              sections: opts.section ? opts.section.split(',').map((s: string) => s.trim()) : undefined,
            }),
          ),
        );
        output(result, fmt);
      }
    } catch (err) {
      handleError(err, 'read');
    }
  });

forecast
  .command('evaluate')
  .description('Evaluate pending forecast outcomes and update topic weights')
  .action(() => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      const writer = openWriter(dbPath);
      try {
        const result = evaluateForecasts(writer);
        output(ok(result), fmt);
      } finally {
        writer.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

// --- mcp ---
program
  .command('mcp')
  .description('Start MCP server (stdio transport)')
  .action(async () => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      await startMcpServer(dbPath);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

// --- db ---
const db = program.command('db').description('Database maintenance');

db.command('schema')
  .description('Show schema version and application_id')
  .action(() => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      const result = sqliteBusyRetry(() =>
        withReader(dbPath, (reader) => {
          const userVersion = reader.pragma('user_version', { simple: true }) as number;
          const appId = reader.pragma('application_id', { simple: true }) as number;
          const migrations = getMigrations();
          const pendingCount = migrations.filter((m) => m.version > userVersion).length;
          return ok({
            schema_version: userVersion,
            application_id: `0x${appId.toString(16).toUpperCase().padStart(8, '0')}`,
            migrations_available: migrations.length,
            migrations_pending: pendingCount,
          });
        }),
      );
      output(result, fmt);
    } catch (err) {
      handleError(err, 'read');
    }
  });

db.command('checkpoint')
  .description('Force WAL checkpoint')
  .option('--mode <mode>', 'PASSIVE | FULL | RESTART | TRUNCATE', 'passive')
  .action(async (opts) => {
    try {
      const { running } = ControlClient.isDaemonRunning();
      if (running) {
        const result = await ControlClient.sendCommand('checkpoint', {
          mode: opts.mode.toLowerCase(),
        });
        output(ok(result.data), program.opts().format ?? 'json');
        return;
      }

      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const writer = openWriter(dbPath);
      try {
        const result = dbCheckpoint(writer, opts.mode.toLowerCase());
        output(ok(result), program.opts().format ?? 'json');
      } finally {
        writer.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

db.command('prune')
  .description('Delete events older than retention_days')
  .action(async () => {
    try {
      const config = getConfig(program.opts());
      const { running } = ControlClient.isDaemonRunning();
      if (running) {
        const result = await ControlClient.sendCommand('prune', {
          retention_days: config.collector.retention_days,
        });
        output(ok(result.data), program.opts().format ?? 'json');
        return;
      }

      const dbPath = getDbPath(config, program.opts().db);
      const writer = openWriter(dbPath);
      try {
        const result = dbPrune(writer, config.collector.retention_days);
        output(ok(result), program.opts().format ?? 'json');
      } finally {
        writer.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

db.command('vacuum')
  .description('Run INCREMENTAL auto_vacuum')
  .option('--pages <n>', 'Max pages to reclaim')
  .action(async (opts) => {
    try {
      const { running } = ControlClient.isDaemonRunning();
      if (running) {
        const result = await ControlClient.sendCommand('vacuum', {
          pages: opts.pages ? parseInt(opts.pages, 10) : undefined,
        });
        output(ok(result.data), program.opts().format ?? 'json');
        return;
      }

      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const writer = openWriter(dbPath);
      try {
        incrementalVacuum(writer, opts.pages ? parseInt(opts.pages, 10) : undefined);
        output(ok({ status: 'completed' }), program.opts().format ?? 'json');
      } finally {
        writer.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

db.command('incremental-vacuum')
  .description('Reclaim free pages')
  .option('--pages <n>', 'Max pages to reclaim')
  .action(async (opts) => {
    try {
      const { running } = ControlClient.isDaemonRunning();
      if (running) {
        const result = await ControlClient.sendCommand('incremental-vacuum', {
          pages: opts.pages ? parseInt(opts.pages, 10) : undefined,
        });
        output(ok(result.data), program.opts().format ?? 'json');
        return;
      }

      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const writer = openWriter(dbPath);
      try {
        incrementalVacuum(writer, opts.pages ? parseInt(opts.pages, 10) : undefined);
        output(ok({ status: 'completed' }), program.opts().format ?? 'json');
      } finally {
        writer.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

db.command('backup <path>')
  .description('Online backup to target path')
  .option('--mode <mode>', 'incremental | vacuum-into', 'incremental')
  .action(async (targetPath, opts) => {
    try {
      const { running } = ControlClient.isDaemonRunning();
      if (running) {
        const result = await ControlClient.sendCommand('backup', {
          path: targetPath,
          mode: opts.mode,
        });
        output(ok(result.data), program.opts().format ?? 'json');
        return;
      }

      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const writer = openWriter(dbPath);
      try {
        if (opts.mode === 'vacuum-into') {
          vacuumInto(writer, targetPath);
        } else {
          await dbBackup(writer, targetPath);
        }
        output(ok({ status: 'completed', path: targetPath }), program.opts().format ?? 'json');
      } finally {
        writer.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

db.command('rebuild-fts')
  .description('Rebuild FTS index from events table')
  .action(async () => {
    try {
      const { running } = ControlClient.isDaemonRunning();
      if (running) {
        const result = await ControlClient.sendCommand('rebuild-fts');
        output(ok(result.data), program.opts().format ?? 'json');
        return;
      }

      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const writer = openWriter(dbPath);
      try {
        rebuildFts(writer);
        output(ok({ status: 'completed' }), program.opts().format ?? 'json');
      } finally {
        writer.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

db.command('rebuild-topic-index')
  .description('Rebuild event_topics from events.topics JSON')
  .action(async () => {
    try {
      const { running } = ControlClient.isDaemonRunning();
      if (running) {
        const result = await ControlClient.sendCommand('rebuild-topic-index');
        output(ok(result.data), program.opts().format ?? 'json');
        return;
      }

      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const writer = openWriter(dbPath);
      try {
        const count = rebuildTopicIndex(writer);
        output(ok({ status: 'completed', topic_rows: count }), program.opts().format ?? 'json');
      } finally {
        writer.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

db.command('reclassify')
  .description('Re-run topic classifier on all events using current topics.yaml')
  .action(async () => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const writer = openWriter(dbPath);
      try {
        const result = reclassifyTopics(writer);
        output(ok({ status: 'completed', ...result }), program.opts().format ?? 'json');
      } finally {
        writer.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

db.command('optimize-fts')
  .description('Merge FTS index segments')
  .action(async () => {
    try {
      const { running } = ControlClient.isDaemonRunning();
      if (running) {
        const result = await ControlClient.sendCommand('optimize-fts');
        output(ok(result.data), program.opts().format ?? 'json');
        return;
      }

      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const writer = openWriter(dbPath);
      try {
        optimizeFts(writer);
        output(ok({ status: 'completed' }), program.opts().format ?? 'json');
      } finally {
        writer.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

db.command('quick-check')
  .description('Fast integrity check')
  .action(() => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      const result = sqliteBusyRetry(() =>
        withReader(dbPath, (reader) => {
          const check = quickCheck(reader);
          return ok(check);
        }),
      );
      output(result, fmt);
    } catch (err) {
      handleError(err, 'read');
    }
  });

// --- journal ---
const journal = program.command('journal').description('Decision journal');

journal
  .command('add')
  .description('Record a decision')
  .requiredOption('--context <text>', 'What situation prompted the decision')
  .requiredOption('--decision <text>', 'What was decided')
  .option('--rationale <text>', 'Why this option was chosen')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--refs <json>', 'JSON array of signal refs [{type,id}]')
  .action((opts) => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      const writer = openWriter(dbPath);
      try {
        const tags = opts.tags
          ? opts.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
          : undefined;
        let signalRefs: Array<{ type: 'event' | 'topic'; id: string }> | undefined;
        if (opts.refs) {
          try {
            signalRefs = JSON.parse(opts.refs);
          } catch {
            output(
              error({
                code: 'INVALID_QUERY',
                message: 'Invalid JSON in --refs.',
                retryable: false,
                suggested_action: 'Provide valid JSON array, e.g. [{"type":"event","id":"rss:test:1"}]',
              }),
              fmt,
            );
            process.exitCode = 1;
            return;
          }
        }
        const result = addEntry(writer, {
          context: opts.context,
          decision: opts.decision,
          rationale: opts.rationale,
          tags,
          signal_refs: signalRefs,
        });
        output(result, fmt);
      } finally {
        writer.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

journal
  .command('list')
  .description('List journal entries')
  .option('--since <duration>', 'Time bound (e.g., 7d)')
  .option('--tag <tag>', 'Filter by tag')
  .option('--limit <n>', 'Max results', '20')
  .option('--cursor <token>', 'Pagination cursor')
  .action((opts) => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      const result = sqliteBusyRetry(() =>
        withReader(dbPath, (db) =>
          listEntries(db, {
            since: parseSince(opts.since),
            tag: opts.tag,
            limit: parseInt(opts.limit, 10),
            cursor: opts.cursor,
          }),
        ),
      );
      output(result, fmt);
    } catch (err) {
      handleError(err, 'read');
    }
  });

journal
  .command('search <query>')
  .description('Full-text search across journal entries')
  .option('--since <duration>', 'Time bound (e.g., 7d)')
  .option('--limit <n>', 'Max results', '20')
  .option('--cursor <token>', 'Pagination cursor')
  .action((query, opts) => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      const result = sqliteBusyRetry(() =>
        withReader(dbPath, (db) =>
          searchJournal(db, query, {
            since: parseSince(opts.since),
            limit: parseInt(opts.limit, 10),
            cursor: opts.cursor,
          }),
        ),
      );
      output(result, fmt);
    } catch (err) {
      handleError(err, 'read');
    }
  });

// --- training-set ---
const trainingSet = program.command('training-set').description('Training data management');

trainingSet
  .command('generate')
  .description('Generate a training database from a random sample of events')
  .option('--sample-rate <rate>', 'Fraction of events to sample (0.0, 1.0]', '0.1')
  .option('--output <path>', 'Output database path')
  .option('--seed <number>', 'Integer seed for reproducible sampling')
  .option('--dry-run', 'Preview without creating DB')
  .action((opts) => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      const sampleRate = parseFloat(opts.sampleRate);
      let seed: number | undefined;
      if (opts.seed != null) {
        seed = Number(opts.seed);
      }

      const result = sqliteBusyRetry(() =>
        withReader(dbPath, (db) =>
          generateTrainingSet(db, {
            sampleRate,
            outputPath: opts.output,
            sourceDbPath: dbPath,
            seed,
            dryRun: opts.dryRun ?? false,
          }),
        ),
      );
      output(result, fmt);
    } catch (err) {
      handleError(err, 'read');
    }
  });

trainingSet
  .command('next <training-db>')
  .description('Get next unreviewed event(s) for classification')
  .option('--limit <n>', 'Number of events to return', '1')
  .option('--show-machine-labels', 'Include machine labels in output')
  .action((trainingDbPath, opts) => {
    try {
      const fmt = program.opts().format ?? 'json';
      const db = openTrainingDb(trainingDbPath, true);
      try {
        const result = getNextUnreviewed(
          db,
          parseInt(opts.limit, 10),
          opts.showMachineLabels ?? false,
        );
        output(result, fmt);
      } finally {
        db.close();
      }
    } catch (err) {
      handleError(err, 'read');
    }
  });

trainingSet
  .command('label <training-db> <event-id>')
  .description('Assign human-classified topics to a training event')
  .requiredOption('--topics <csv>', 'Comma-separated topic IDs')
  .option('--labeler <id>', 'Who/what produced this label')
  .option('--notes <text>', 'Optional annotation')
  .action((trainingDbPath, eventId, opts) => {
    try {
      const fmt = program.opts().format ?? 'json';
      const db = openTrainingDb(trainingDbPath, false);
      try {
        const topics = opts.topics === ''
          ? []
          : opts.topics.split(',').map((t: string) => t.trim()).filter(Boolean);
        const result = updateTrainingLabel(db, eventId, {
          human_topics: topics,
          labeler: opts.labeler,
          notes: opts.notes,
        });
        output(result, fmt);
      } finally {
        db.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

trainingSet
  .command('progress <training-db>')
  .description('Show labeling progress')
  .option('--verbose', 'Include per-topic coverage')
  .action((trainingDbPath, opts) => {
    try {
      const fmt = program.opts().format ?? 'json';
      const db = openTrainingDb(trainingDbPath, true);
      try {
        const result = trainingProgress(db, opts.verbose ?? false);
        output(result, fmt);
      } finally {
        db.close();
      }
    } catch (err) {
      handleError(err, 'read');
    }
  });

trainingSet
  .command('list')
  .description('List training databases')
  .option('--dir <path>', 'Directory to scan')
  .action((opts) => {
    try {
      const fmt = program.opts().format ?? 'json';
      const result = listTrainingSets(opts.dir);
      output(result, fmt);
    } catch (err) {
      handleError(err, 'read');
    }
  });

trainingSet
  .command('export <training-db>')
  .description('Export labeled training data')
  .option('--output <path>', 'Write JSONL to file')
  .option('--reviewed-only', 'Only export labeled events')
  .option('--raw', 'Emit raw JSONL to stdout')
  .action((trainingDbPath, opts) => {
    try {
      const fmt = program.opts().format ?? 'json';
      const db = openTrainingDb(trainingDbPath, true);
      try {
        const result = exportTrainingSet(db, {
          reviewedOnly: opts.reviewedOnly ?? false,
          raw: opts.raw ?? false,
          outputPath: opts.output,
        });
        if (typeof result === 'string') {
          // Raw JSONL output
          console.log(result);
        } else {
          output(result, fmt);
        }
      } finally {
        db.close();
      }
    } catch (err) {
      handleError(err, 'read');
    }
  });

trainingSet
  .command('evaluate <training-db>')
  .description('Evaluate classifier accuracy against human labels')
  .option('--min-samples <n>', 'Minimum samples per topic for metrics', '30')
  .option('--labeler <id>', 'Filter to events labeled by this labeler')
  .option('--model <path>', 'Load a stat model for ensemble evaluation (re-classifies on the fly)')
  .action((trainingDbPath, opts) => {
    try {
      const fmt = program.opts().format ?? 'json';
      if (opts.model) {
        loadTopics();
        if (!loadStatModel(opts.model)) {
          output(error({
            code: 'INVALID_QUERY',
            message: `Failed to load model: ${opts.model}`,
            retryable: false,
            suggested_action: 'Check that the model file exists and is version ≥3.',
          }), fmt);
          return;
        }
      }
      const db = openTrainingDb(trainingDbPath, true);
      try {
        const result = evaluateTrainingSet(db, {
          minSamples: parseInt(opts.minSamples, 10),
          labeler: opts.labeler,
          reclassify: !!opts.model,
        });
        output(result, fmt);
      } finally {
        db.close();
      }
    } catch (err) {
      handleError(err, 'read');
    }
  });

trainingSet
  .command('reclassify <training-db>')
  .description('Re-run topic classifier on all events (preserves human labels)')
  .option('--model <path>', 'Load a stat model for ensemble classification')
  .action((trainingDbPath, opts) => {
    try {
      const fmt = program.opts().format ?? 'json';
      if (opts.model) {
        loadTopics();
        if (!loadStatModel(opts.model)) {
          output(error({
            code: 'INVALID_QUERY',
            message: `Failed to load model: ${opts.model}`,
            retryable: false,
            suggested_action: 'Check that the model file exists and is version ≥3.',
          }), fmt);
          return;
        }
      }
      const db = openTrainingDb(trainingDbPath, false);
      try {
        const result = reclassifyTrainingSet(db);
        output(result, fmt);
      } finally {
        db.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

// --- classifier ---
const classifier = program.command('classifier').description('Classifier training and management');

classifier
  .command('train <training-db>')
  .description('Train a logistic regression classifier from labeled training data')
  .option('--output <path>', 'Output model JSON path')
  .option('--min-examples <n>', 'Minimum positive examples per topic', '20')
  .option('--validation-split <ratio>', 'Fraction of data held out for validation', '0.2')
  .action((trainingDbPath, opts) => {
    try {
      const fmt = program.opts().format ?? 'json';
      const db = openTrainingDb(trainingDbPath, true);
      try {
        const result = trainClassifier(db, {
          outputPath: opts.output,
          minExamples: parseInt(opts.minExamples, 10),
          validationSplit: parseFloat(opts.validationSplit),
        });
        output(ok(result), fmt);
      } finally {
        db.close();
      }
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

classifier
  .command('deploy <model-path>')
  .description('Copy a trained model to the default path for the collector to use')
  .action((modelPath) => {
    try {
      const fmt = program.opts().format ?? 'json';
      const resolved = resolvePath(modelPath);

      if (!existsSync(resolved)) {
        output(error({
          code: 'INVALID_QUERY',
          message: `Model file not found: ${resolved}`,
          retryable: false,
          suggested_action: 'Check the path to your trained model.',
        }), fmt);
        process.exitCode = 1;
        return;
      }

      // Validate it's a valid model
      try {
        const raw = JSON.parse(readFileSync(resolved, 'utf-8'));
        if (!raw.version || raw.version < 3) {
          output(error({
            code: 'INVALID_QUERY',
            message: `Model version ${raw.version ?? 'unknown'} is not supported (need ≥3).`,
            retryable: false,
            suggested_action: 'Re-train with logistic regression.',
          }), fmt);
          process.exitCode = 1;
          return;
        }
      } catch (parseErr) {
        output(error({
          code: 'INVALID_QUERY',
          message: `Invalid model file: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          retryable: false,
          suggested_action: 'Ensure the file is valid JSON.',
        }), fmt);
        process.exitCode = 1;
        return;
      }

      const defaultDir = joinPath(
        process.env.HOME ?? process.env.USERPROFILE ?? '.',
        '.local', 'share', 'intel',
      );
      const targetPath = joinPath(defaultDir, 'classifier-model.json');

      if (!existsSync(defaultDir)) {
        mkdirSync(defaultDir, { recursive: true });
      }

      copyFileSync(resolved, targetPath);
      output(ok({
        source: resolved,
        deployed_to: targetPath,
        status: 'deployed',
      }), fmt);
    } catch (err) {
      handleError(err, 'maintenance');
    }
  });

program.parse();
