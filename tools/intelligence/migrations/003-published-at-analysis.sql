-- Optimize temporal analysis by indexing the real-world event date.
--
-- The forecast module uses COALESCE(published_at, fetched_at) to analyze
-- events by their actual publication time rather than database ingestion time.
-- Without this, bulk RSS ingests that fetch hundreds of events at once compress
-- weeks of real-world signal into a single calendar day, breaking chain
-- detection (which requires topic co-movement across 3+ distinct days).
--
-- This expression index accelerates WHERE-clause filtering on the coalesced
-- timestamp. The ~0.5% of events lacking published_at fall back to fetched_at.

CREATE INDEX IF NOT EXISTS idx_events_pub_ts
  ON events(COALESCE(published_at, fetched_at));
