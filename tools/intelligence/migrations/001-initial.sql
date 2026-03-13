-- Collected events (append-only, deduped by event_id)
CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT    UNIQUE NOT NULL,
    source      TEXT    NOT NULL CHECK(source IN ('rss','hackernews','lobsters','edgar')),
    feed        TEXT,
    url           TEXT,
    canonical_url TEXT,
    title       TEXT,
    content     TEXT,
    author      TEXT,
    published_at TEXT,
    fetched_at  TEXT    NOT NULL,
    topics      TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(topics)),
    tags        TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
    score       INTEGER DEFAULT 0,
    comments    INTEGER DEFAULT 0,
    source_meta     TEXT    CHECK (source_meta IS NULL OR json_valid(source_meta)),
    content_flags   TEXT    CHECK (content_flags IS NULL OR json_valid(content_flags)),
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_events_source_fetched  ON events(source, fetched_at);
CREATE INDEX idx_events_fetched         ON events(fetched_at);
CREATE INDEX idx_events_published       ON events(published_at);
CREATE INDEX idx_events_canonical_url   ON events(canonical_url) WHERE canonical_url IS NOT NULL;

-- Full-text search
CREATE VIRTUAL TABLE events_fts USING fts5(
    title,
    content,
    content='events',
    content_rowid='id',
    tokenize="unicode61 tokenchars '-_' remove_diacritics 1"
);

-- Keep FTS in sync via triggers
CREATE TRIGGER events_fts_insert AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER events_fts_delete AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
END;

CREATE TRIGGER events_fts_update AFTER UPDATE OF title, content ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO events_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
END;

-- Normalized topic index for fast topic queries and trend computation
CREATE TABLE event_topics (
    event_id TEXT NOT NULL,
    topic    TEXT NOT NULL,
    PRIMARY KEY (event_id, topic),
    FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);
CREATE INDEX idx_event_topics_topic ON event_topics(topic);

-- Per-source polling cursors
CREATE TABLE checkpoints (
    source     TEXT NOT NULL,
    feed       TEXT NOT NULL DEFAULT '',
    cursor     TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source, feed)
);

-- Collector health: updated each poll cycle, even when no new events are found
CREATE TABLE collector_health (
    source          TEXT NOT NULL,
    feed            TEXT NOT NULL DEFAULT '',
    last_polled_at  TEXT NOT NULL,
    last_success_at TEXT,
    last_error      TEXT,
    events_in_poll  INTEGER NOT NULL DEFAULT 0,
    http_etag       TEXT,
    http_last_modified TEXT,
    PRIMARY KEY (source, feed)
);
