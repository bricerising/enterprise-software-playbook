-- Add 'earnings' to the source CHECK constraint on the events table.
-- SQLite CHECK constraints cannot be altered in-place; recreate the table.

-- Drop FTS table and triggers first (they reference the events table)
DROP TRIGGER IF EXISTS events_fts_insert;
DROP TRIGGER IF EXISTS events_fts_delete;
DROP TRIGGER IF EXISTS events_fts_update;
DROP TABLE IF EXISTS events_fts;

CREATE TABLE events_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT    UNIQUE NOT NULL,
    source      TEXT    NOT NULL CHECK(source IN ('rss','hackernews','lobsters','edgar','earnings')),
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

INSERT INTO events_new SELECT * FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

-- Recreate indexes
CREATE INDEX idx_events_source_fetched  ON events(source, fetched_at);
CREATE INDEX idx_events_fetched         ON events(fetched_at);
CREATE INDEX idx_events_published       ON events(published_at);
CREATE INDEX idx_events_canonical_url   ON events(canonical_url) WHERE canonical_url IS NOT NULL;

-- Recreate FTS table
CREATE VIRTUAL TABLE events_fts USING fts5(
    title,
    content,
    content='events',
    content_rowid='id',
    tokenize="unicode61 tokenchars '-_' remove_diacritics 1"
);

-- Re-populate FTS from existing data
INSERT INTO events_fts(rowid, title, content)
    SELECT id, title, content FROM events;

-- Recreate FTS sync triggers
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
