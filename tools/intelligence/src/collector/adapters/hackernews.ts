import type { SourceType } from '../../types.js';
import type { RawEvent, Checkpoint, SourceAdapter } from './types.js';

const HN_API_BASE = 'https://hacker-news.firebaseio.com/v0';

/** Inter-request delay in milliseconds to avoid hammering the API */
const INTER_REQUEST_DELAY_MS = 100;

type HNMode = 'new' | 'top' | 'best';

const MODE_ENDPOINTS: Record<HNMode, string> = {
  new: 'newstories',
  top: 'topstories',
  best: 'beststories',
};

interface HNItem {
  id: number;
  type?: string;
  title?: string;
  url?: string;
  text?: string;
  by?: string;
  time?: number;
  score?: number;
  descendants?: number;
  kids?: number[];
  deleted?: boolean;
  dead?: boolean;
}

interface HackerNewsAdapterOptions {
  name: string;
  modes?: HNMode[];
  max_items?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HackerNewsAdapter implements SourceAdapter {
  readonly source: SourceType = 'hackernews';
  readonly feedName: string;

  private readonly modes: HNMode[];
  private readonly maxItems: number;

  constructor(opts: HackerNewsAdapterOptions) {
    this.feedName = opts.name;
    this.modes = opts.modes ?? ['new', 'top'];
    this.maxItems = opts.max_items ?? 100;
  }

  async *fetch(checkpoint: Checkpoint | null): AsyncGenerator<RawEvent> {
    const cursorId = checkpoint ? parseInt(checkpoint.cursor, 10) : 0;
    const seenIds = new Set<number>();
    let maxItemId = cursorId;

    for (const mode of this.modes) {
      const endpoint = MODE_ENDPOINTS[mode];
      let storyIds: number[];

      try {
        const res = await globalThis.fetch(`${HN_API_BASE}/${endpoint}.json`);
        if (!res.ok) {
          throw new Error(`HN API ${endpoint} returned ${res.status}`);
        }
        storyIds = (await res.json()) as number[];
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[intel] hackernews: failed to fetch ${endpoint}: ${message}`);
        continue;
      }

      // Limit to maxItems, and skip IDs we have already processed
      const toFetch = storyIds
        .filter((id) => id > cursorId && !seenIds.has(id))
        .slice(0, this.maxItems);

      for (const itemId of toFetch) {
        seenIds.add(itemId);

        let item: HNItem;
        try {
          const res = await globalThis.fetch(`${HN_API_BASE}/item/${itemId}.json`);
          if (!res.ok) continue;
          item = (await res.json()) as HNItem;
        } catch {
          // Skip items that fail to fetch
          continue;
        }

        if (!item || item.deleted || item.dead) {
          await delay(INTER_REQUEST_DELAY_MS);
          continue;
        }

        // Track highest item ID for checkpoint
        if (item.id > maxItemId) {
          maxItemId = item.id;
        }

        const publishedAt = item.time
          ? new Date(item.time * 1000).toISOString()
          : null;

        const rawEvent: RawEvent = {
          event_id: `hn:${item.id}`,
          source: 'hackernews',
          feed: this.feedName,
          url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
          title: item.title ?? null,
          content: item.text ?? null,
          author: item.by ?? null,
          published_at: publishedAt,
          tags: [],
          score: item.score ?? 0,
          comments: item.descendants ?? 0,
          source_meta: {
            hn_id: item.id,
            hn_type: item.type ?? 'story',
            mode,
            kids_count: item.kids?.length ?? 0,
          },
        };

        yield rawEvent;

        // Rate-limit inter-request delay
        await delay(INTER_REQUEST_DELAY_MS);
      }
    }
  }
}
