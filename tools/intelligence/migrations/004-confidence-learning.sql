-- Add classifier confidence scoring and forecast learning loop.
--
-- event_topics.confidence: per-tag confidence score from the classifier.
-- Existing rows default to 1.0 (backward-compatible). New events receive
-- a computed confidence in [0, 1] based on keyword/regex hit density,
-- context validation, priority, and learned topic weights.
--
-- forecast_snapshots + forecast_outcomes: snapshot mechanism for evaluating
-- forecast accuracy over time. Created via `intel forecast --snapshot`,
-- evaluated via `intel forecast evaluate`.
--
-- topic_weights: learned per-topic precision weights updated by the
-- evaluation loop. Feeds back into classifier confidence scoring.

ALTER TABLE event_topics ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;

CREATE TABLE forecast_snapshots (
    snapshot_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    window_days   INTEGER NOT NULL,
    scenarios     TEXT NOT NULL CHECK (json_valid(scenarios))
);

CREATE TABLE forecast_outcomes (
    outcome_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id   INTEGER NOT NULL REFERENCES forecast_snapshots(snapshot_id),
    target_topic  TEXT NOT NULL,
    predicted_probability REAL NOT NULL,
    outcome       INTEGER,  -- NULL=pending, 1=observed, 0=not observed
    evaluated_at  TEXT,
    UNIQUE(snapshot_id, target_topic)
);

CREATE TABLE topic_weights (
    topic_id        TEXT PRIMARY KEY,
    weight          REAL NOT NULL DEFAULT 1.0,
    true_positives  INTEGER NOT NULL DEFAULT 0,
    false_positives INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
