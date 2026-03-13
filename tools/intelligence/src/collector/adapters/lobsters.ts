import RSSParser from 'rss-parser';
import type { SourceType } from '../../types.js';
import type { RawEvent, Checkpoint, SourceAdapter } from './types.js';

const LOBSTERS_RSS_URL = 'https://lobste.rs/rss';

interface LobstersAdapterOptions {
  name: string;
}

export class LobstersAdapter implements SourceAdapter {
  readonly source: SourceType = 'lobsters';
  readonly feedName: string;

  constructor(opts: LobstersAdapterOptions) {
    this.feedName = opts.name;
  }

  async *fetch(checkpoint: Checkpoint | null): AsyncGenerator<RawEvent> {
    const parser: RSSParser = new RSSParser({
      timeout: 15_000,
      customFields: {
        item: [['category', 'categories', { keepArray: true }]],
      },
    });

    let feed: RSSParser.Output<Record<string, unknown>>;
    try {
      feed = await parser.parseURL(LOBSTERS_RSS_URL);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[intel] lobsters: failed to fetch RSS: ${message}`);
      return;
    }

    const checkpointCursor = checkpoint?.cursor ?? null;
    const items = feed.items ?? [];

    for (const item of items) {
      const pubDate = item.pubDate ?? item.isoDate ?? null;

      // Skip items older than or equal to the checkpoint
      if (checkpointCursor && pubDate) {
        const itemTime = new Date(pubDate).getTime();
        const cursorTime = new Date(checkpointCursor).getTime();
        if (!isNaN(itemTime) && !isNaN(cursorTime) && itemTime <= cursorTime) {
          continue;
        }
      }

      const guid = item.guid ?? item.link ?? null;
      if (!guid) continue;

      // Extract tags from Lobsters categories
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

      // Extract author from dc:creator or author field
      const rawAuthor = item.creator ?? item.author ?? null;
      const author: string | null = typeof rawAuthor === 'string' ? rawAuthor : null;

      // Build a Lobsters comments URL from the guid if possible
      let commentsUrl: string | null = null;
      if (typeof guid === 'string' && guid.startsWith('https://lobste.rs/')) {
        commentsUrl = guid;
      }

      const rawEvent: RawEvent = {
        event_id: `lobsters:${guid}`,
        source: 'lobsters',
        feed: this.feedName,
        url: item.link ?? null,
        title: item.title ?? null,
        content: item.contentSnippet ?? item.content ?? null,
        author,
        published_at: pubDate ? new Date(pubDate).toISOString() : null,
        tags,
        score: 0,
        comments: 0,
        source_meta: {
          guid,
          comments_url: commentsUrl,
          feed_title: feed.title ?? null,
        },
      };

      yield rawEvent;
    }
  }
}
