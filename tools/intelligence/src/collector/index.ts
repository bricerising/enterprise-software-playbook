import type Database from 'better-sqlite3';
import type { FeedConfig, IntelConfig } from '../config.js';
import type { RawEvent, SourceAdapter } from './adapters/types.js';
import { RssAdapter } from './adapters/rss.js';
import { HackerNewsAdapter } from './adapters/hackernews.js';
import { LobstersAdapter } from './adapters/lobsters.js';
import { EdgarAdapter } from './adapters/edgar.js';
import { EarningsAdapter } from './adapters/earnings.js';
import { classify, loadTopics } from './topic-classifier.js';
import { loadCheckpoint, saveCheckpoint, updateCollectorHealth } from './checkpoints.js';
import { fetchContent } from './content-fetcher.js';
import { canonicalizeUrl } from '../util/url.js';
import { formatISO } from '../util/time.js';
import { openWriter, checkSqliteVersion } from '../db.js';
import { quickCheck } from '../db-maintenance.js';
import { ControlClient } from '../control/channel.js';

const DEFAULT_BATCH_SIZE = 100;

interface CollectorOpts {
  config: IntelConfig;
  once?: boolean;
  onCycle?: () => void;
}

function loadCollectorHealth(
  db: Database.Database,
  source: string,
  feed: string,
): { httpEtag: string | null; httpLastModified: string | null } {
  const row = db
    .prepare('SELECT http_etag, http_last_modified FROM collector_health WHERE source = ? AND feed = ?')
    .get(source, feed) as { http_etag: string | null; http_last_modified: string | null } | undefined;
  return {
    httpEtag: row?.http_etag ?? null,
    httpLastModified: row?.http_last_modified ?? null,
  };
}

function createAdapter(feed: FeedConfig, config: IntelConfig, db: Database.Database): SourceAdapter {
  switch (feed.source) {
    case 'rss': {
      const health = loadCollectorHealth(db, 'rss', feed.name);
      return new RssAdapter({
        url: feed.url,
        name: feed.name,
        request_options: feed.request_options,
        httpEtag: health.httpEtag,
        httpLastModified: health.httpLastModified,
      });
    }
    case 'hackernews':
      return new HackerNewsAdapter({
        name: feed.name,
        modes: feed.modes,
        max_items: feed.max_items,
      });
    case 'lobsters':
      return new LobstersAdapter({ name: feed.name });
    case 'edgar':
      return new EdgarAdapter({
        name: feed.name,
        form_types: feed.form_types,
        entities: feed.entities,
        edgar_contact: config.collector.edgar_contact!,
        edgar_max_rps: config.collector.edgar_max_rps,
      });
    case 'earnings':
      return new EarningsAdapter({
        name: feed.name,
        tickers: feed.tickers,
        form_types: feed.form_types,
        edgar_contact: config.collector.edgar_contact!,
        edgar_max_rps: config.collector.edgar_max_rps,
      });
  }
}

/** Enrichment upsert — exact SQL from spec */
const UPSERT_SQL = `
INSERT INTO events (event_id, source, feed, url, canonical_url, title, content, author,
                    published_at, fetched_at, topics, tags, score, comments,
                    source_meta, content_flags)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(event_id) DO UPDATE SET
  content       = COALESCE(events.content, excluded.content),
  canonical_url = COALESCE(events.canonical_url, excluded.canonical_url),
  content_flags = COALESCE(events.content_flags, excluded.content_flags),
  score         = MAX(events.score, excluded.score),
  comments      = MAX(events.comments, excluded.comments),
  fetched_at    = excluded.fetched_at
WHERE events.content IS NULL AND excluded.content IS NOT NULL
   OR events.canonical_url IS NULL AND excluded.canonical_url IS NOT NULL
   OR events.content_flags IS NULL AND excluded.content_flags IS NOT NULL
   OR excluded.score > events.score
   OR excluded.comments > events.comments;
`;

const UPSERT_TOPICS_SQL = `
INSERT OR IGNORE INTO event_topics (event_id, topic) VALUES (?, ?);
`;

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function runCollector(opts: CollectorOpts): Promise<void> {
  const { config, once = false } = opts;
  const batchSize = config.collector.batch_size || DEFAULT_BATCH_SIZE;

  // Load topics
  loadTopics(config.topics_file);

  // Open writer connection
  const db = openWriter(config.database, {
    synchronous: config.collector.synchronous,
    walAutocheckpoint: config.collector.wal_autocheckpoint,
    journalSizeLimit: config.collector.journal_size_limit_bytes,
  });

  // Check for unclean shutdown via stale PID file
  const { running, pid } = ControlClient.isDaemonRunning();
  if (!running && pid !== undefined) {
    // Stale PID file detected — previous unclean shutdown
    console.error('[intel] Stale PID file detected — running integrity check...');
    const check = quickCheck(db);
    if (!check.ok) {
      db.close();
      throw new Error(
        `Database integrity check failed after unclean shutdown. ` +
          `Errors: ${check.errors.join('; ')}. ` +
          `Run 'intel db quick-check' for details. Do not start the collector until corruption is resolved.`,
      );
    }
    console.error('[intel] Integrity check passed.');
  }

  // Check SQLite version
  const versionRow = db.prepare('SELECT sqlite_version() as v').get() as { v: string };
  const versionCheck = checkSqliteVersion(versionRow.v);
  if (!versionCheck.walResetFixed) {
    console.error(
      `[intel] WARNING: SQLite ${versionRow.v} may have WAL-reset bug. ` +
        'Consider upgrading to >= 3.52.0 or a patched backport.',
    );
  }

  const upsertStmt = db.prepare(UPSERT_SQL);
  const upsertTopicsStmt = db.prepare(UPSERT_TOPICS_SQL);
  const lastPollTimes = new Map<string, number>();
  let lastOptimize = Date.now();

  const pollOnce = async () => {
    for (const feedConfig of config.feeds) {
      const feedKey = `${feedConfig.source}:${feedConfig.name}`;
      const pollInterval =
        (('poll_interval' in feedConfig ? feedConfig.poll_interval : undefined) ??
          config.collector.poll_interval_seconds) * 1000;

      const lastPoll = lastPollTimes.get(feedKey) ?? 0;
      if (Date.now() - lastPoll < pollInterval) continue;

      const adapter = createAdapter(feedConfig, config, db);
      const checkpoint = loadCheckpoint(db, feedConfig.source, feedConfig.name);
      const adapterCheckpoint = checkpoint
        ? { cursor: checkpoint.cursor, updated_at: checkpoint.updated_at }
        : null;

      console.error(`[intel] Polling ${feedKey}...`);

      const events: Array<{
        raw: RawEvent;
        canonical_url: string | null;
        topics: string[];
        content: string | null;
        contentFlags: string[];
      }> = [];

      try {
        for await (const raw of adapter.fetch(adapterCheckpoint)) {
          // Async work: URL canonicalization + topic classification
          const canonical = canonicalizeUrl(raw.url);
          const topics = classify(raw.title, raw.content);

          // Async work: content extraction if enabled and no content yet
          let content = raw.content;
          let contentFlags: string[] = [];
          if (
            config.collector.fetch_content &&
            !content &&
            raw.url
          ) {
            try {
              const extracted = await fetchContent(raw.url, {
                timeoutMs: config.collector.content_timeout_ms,
                maxLength: config.collector.max_content_length,
                blockedDomains: config.collector.blocked_domains,
              });
              content = extracted.content;
              contentFlags = extracted.flags;
            } catch {
              contentFlags = ['fetch_failed'];
            }
          } else if (content) {
            contentFlags = ['extracted'];
          }

          events.push({
            raw,
            canonical_url: canonical,
            topics,
            content,
            contentFlags,
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[intel] Error polling ${feedKey}: ${errorMsg}`);
        updateCollectorHealth(db, feedConfig.source, feedConfig.name, 0, errorMsg);
        lastPollTimes.set(feedKey, Date.now());
        continue;
      }

      // Sync work: batched DB writes
      const batches = chunk(events, batchSize);
      for (const batch of batches) {
        const writeBatch = db.transaction(() => {
          for (const event of batch) {
            const now = formatISO();
            upsertStmt.run(
              event.raw.event_id,
              event.raw.source,
              event.raw.feed,
              event.raw.url,
              event.canonical_url,
              event.raw.title,
              event.content,
              event.raw.author,
              event.raw.published_at,
              now,
              JSON.stringify(event.topics),
              JSON.stringify(event.raw.tags),
              event.raw.score,
              event.raw.comments,
              event.raw.source_meta ? JSON.stringify(event.raw.source_meta) : null,
              event.contentFlags.length > 0
                ? JSON.stringify(event.contentFlags)
                : null,
            );

            // Insert topic index rows
            for (const topic of event.topics) {
              upsertTopicsStmt.run(event.raw.event_id, topic);
            }
          }

          // Update checkpoint to last event in batch
          const lastEvent = batch[batch.length - 1];
          if (lastEvent) {
            saveCheckpoint(
              db,
              feedConfig.source,
              feedConfig.name,
              lastEvent.raw.event_id,
            );
          }
        });
        writeBatch();
      }

      // Update collector health (outside batch transaction)
      // Pass response ETag/Last-Modified from RSS adapter for conditional GET
      const responseEtag = adapter instanceof RssAdapter ? adapter.responseEtag : null;
      const responseLastModified = adapter instanceof RssAdapter ? adapter.responseLastModified : null;
      updateCollectorHealth(
        db,
        feedConfig.source,
        feedConfig.name,
        events.length,
        null,
        responseEtag,
        responseLastModified,
      );
      lastPollTimes.set(feedKey, Date.now());

      console.error(`[intel] ${feedKey}: ${events.length} events`);

      // Inter-feed pause with jitter
      if (!once) {
        const jitter = 1000 + Math.random() * 2000;
        await sleep(jitter);
      }
    }

    // Periodic PRAGMA optimize (daily)
    if (Date.now() - lastOptimize > 86_400_000) {
      db.pragma('optimize');
      lastOptimize = Date.now();
      console.error('[intel] Ran PRAGMA optimize');
    }

    opts.onCycle?.();
  };

  try {
    if (once) {
      await pollOnce();
    } else {
      // Continuous polling loop
      while (true) {
        await pollOnce();
        await sleep(5000); // 5s between full poll cycles
      }
    }
  } finally {
    db.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
