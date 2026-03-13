import RSSParser from 'rss-parser';
import type { SourceType } from '../../types.js';
import type { RawEvent, Checkpoint, SourceAdapter } from './types.js';

interface RssAdapterOptions {
  /** Feed URL to fetch */
  url: string;
  /** Human-readable name for this feed */
  name: string;
  /** Optional request headers (e.g. Authorization) */
  request_options?: {
    headers?: Record<string, string>;
  };
  /**
   * Previously stored ETag for conditional GET.
   * Loaded from collector_health.http_etag.
   */
  httpEtag?: string | null;
  /**
   * Previously stored Last-Modified for conditional GET.
   * Loaded from collector_health.http_last_modified.
   */
  httpLastModified?: string | null;
}

export class RssAdapter implements SourceAdapter {
  readonly source: SourceType = 'rss';
  readonly feedName: string;

  private readonly url: string;
  private readonly requestHeaders: Record<string, string>;
  private readonly httpEtag: string | null;
  private readonly httpLastModified: string | null;

  /** Populated after a successful fetch for the caller to persist */
  public responseEtag: string | null = null;
  public responseLastModified: string | null = null;

  constructor(opts: RssAdapterOptions) {
    this.url = opts.url;
    this.feedName = opts.name;
    this.requestHeaders = opts.request_options?.headers ?? {};
    this.httpEtag = opts.httpEtag ?? null;
    this.httpLastModified = opts.httpLastModified ?? null;
  }

  async *fetch(checkpoint: Checkpoint | null): AsyncGenerator<RawEvent> {
    const headers: Record<string, string> = { ...this.requestHeaders };

    // Conditional GET support
    if (this.httpEtag) {
      headers['If-None-Match'] = this.httpEtag;
    }
    if (this.httpLastModified) {
      headers['If-Modified-Since'] = this.httpLastModified;
    }

    const parser: RSSParser = new RSSParser({
      timeout: 15_000,
      headers,
      requestOptions: {},
    });

    let feed: RSSParser.Output<Record<string, unknown>>;
    try {
      feed = await parser.parseURL(this.url);
    } catch (err: unknown) {
      // 304 Not Modified — no new content
      if (err instanceof Error && err.message.includes('304')) {
        return;
      }
      throw err;
    }

    // Extract conditional GET headers from the feed metadata if available.
    // rss-parser does not expose response headers directly, so we store
    // what we can from the feed itself. The caller should also capture
    // these from the HTTP layer if using a custom fetch wrapper.

    const checkpointCursor = checkpoint?.cursor ?? null;
    let latestPubDate: string | null = null;

    const items = feed.items ?? [];

    for (const item of items) {
      const pubDate = item.pubDate ?? item.isoDate ?? null;

      // Skip items we have already seen (based on checkpoint cursor = pubDate)
      if (checkpointCursor && pubDate) {
        const itemTime = new Date(pubDate).getTime();
        const cursorTime = new Date(checkpointCursor).getTime();
        if (!isNaN(itemTime) && !isNaN(cursorTime) && itemTime <= cursorTime) {
          continue;
        }
      }

      // Track latest pubDate for new checkpoint
      if (pubDate) {
        if (!latestPubDate || new Date(pubDate) > new Date(latestPubDate)) {
          latestPubDate = pubDate;
        }
      }

      const guid = item.guid ?? item.link ?? null;
      if (!guid) continue;

      const eventId = `rss:${this.feedName}:${guid}`;

      const tags: string[] = [];
      if (item.categories) {
        for (const cat of item.categories) {
          if (typeof cat === 'string') {
            tags.push(cat);
          } else if (cat && typeof (cat as Record<string, unknown>)._ === 'string') {
            tags.push((cat as Record<string, string>)._);
          }
        }
      }

      const rawEvent: RawEvent = {
        event_id: eventId,
        source: 'rss',
        feed: this.feedName,
        url: item.link ?? null,
        title: item.title ?? null,
        content: item.contentSnippet ?? item.content ?? null,
        author: typeof (item.creator ?? item.author ?? null) === 'string'
          ? (item.creator ?? item.author ?? null) as string
          : null,
        published_at: pubDate ? new Date(pubDate).toISOString() : null,
        tags,
        score: 0,
        comments: 0,
        source_meta: {
          feed_title: feed.title ?? null,
          feed_url: this.url,
          guid: item.guid ?? null,
        },
      };

      yield rawEvent;
    }
  }
}
