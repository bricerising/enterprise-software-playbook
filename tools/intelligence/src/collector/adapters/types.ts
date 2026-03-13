import type { SourceType, ContentFlag } from '../../types.js';

export interface RawEvent {
  event_id: string;
  source: SourceType;
  feed: string;
  url: string | null;
  title: string | null;
  content: string | null;
  author: string | null;
  published_at: string | null;
  tags: string[];
  score: number;
  comments: number;
  source_meta: Record<string, unknown> | null;
}

export interface Checkpoint {
  cursor: string;
  updated_at: string;
}

export interface SourceAdapter {
  source: SourceType;
  feedName: string;
  fetch(checkpoint: Checkpoint | null): AsyncGenerator<RawEvent>;
}
