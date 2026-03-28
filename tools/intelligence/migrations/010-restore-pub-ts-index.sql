-- Restore expression index lost when migration 007 dropped/recreated the events table.
-- Every forecast query using COALESCE(published_at, fetched_at) depends on this.
CREATE INDEX IF NOT EXISTS idx_events_pub_ts
  ON events(COALESCE(published_at, fetched_at));

-- Add score column to event_topics for machine_scores in training sets.
-- training.ts queries this column but no prior migration creates it.
ALTER TABLE event_topics ADD COLUMN score REAL;
