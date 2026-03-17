#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, getDbPath, type IntelConfig } from './config.js';
import { openReader, withReader, openWriter, sqliteBusyRetry, checkSqliteVersion, getMigrations } from './db.js';
import { ok, error, busyError } from './util/envelope.js';
import { parseDuration, sinceISO } from './util/time.js';
import { runCollector } from './collector/index.js';
import { searchEvents } from './queries/search.js';
import { computeTrends } from './queries/trends.js';
import { listEvents, getEvent } from './queries/events.js';
import { querySources } from './queries/sources.js';
import { queryTopics } from './queries/topics.js';
import { queryStats } from './queries/stats.js';
import { buildPack } from './queries/pack.js';
import { computeForecast } from './queries/forecast.js';
import { startMcpServer } from './mcp/server.js';
import { loadTopics } from './collector/topic-classifier.js';
import { ControlClient } from './control/channel.js';
import {
  checkpoint as dbCheckpoint,
  prune as dbPrune,
  incrementalVacuum,
  backup as dbBackup,
  vacuumInto,
  rebuildFts,
  rebuildTopicIndex,
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
program
  .command('forecast')
  .description('Predict likely next developments from event chain patterns')
  .option('--lag-window <days>', 'Max days between chain links', '7')
  .option('--min-support <n>', 'Min co-occurrences for valid chain', '2')
  .option('--top-scenarios <n>', 'Max scenarios to return', '10')
  .option('--dedup <mode>', 'Dedup mode: canonical | none', 'canonical')
  .option('--window <days>', 'Analysis window in days (7, 14, or 30)', '30')
  .option('--compact', 'Return compact summary (top-N per section)')
  .option('--summary', 'Return minimal summary (top-3 scenarios, top-5 chains, change points)')
  .action((opts) => {
    try {
      const config = getConfig(program.opts());
      const dbPath = getDbPath(config, program.opts().db);
      const fmt = program.opts().format ?? 'json';

      const result = sqliteBusyRetry(() =>
        withReader(dbPath, (db) =>
          computeForecast(db, {
            lag_window_days: parseInt(opts.lagWindow, 10),
            min_support: parseInt(opts.minSupport, 10),
            top_scenarios: parseInt(opts.topScenarios, 10),
            dedup: opts.dedup,
            window_days: parseInt(opts.window, 10),
            compact: opts.compact ?? false,
            summary: opts.summary ?? false,
          }),
        ),
      );
      output(result, fmt);
    } catch (err) {
      handleError(err, 'read');
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

program.parse();
