-- Decision journal: records decisions with context, rationale, and signal references.

CREATE TABLE journal_entries (
    entry_id    TEXT    PRIMARY KEY,
    context     TEXT    NOT NULL,
    decision    TEXT    NOT NULL,
    rationale   TEXT,
    signal_refs TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(signal_refs)),
    tags        TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_journal_created_at ON journal_entries(created_at);

-- Full-text search on context, decision, rationale
CREATE VIRTUAL TABLE journal_fts USING fts5(
    context,
    decision,
    rationale,
    content='journal_entries',
    content_rowid='rowid',
    tokenize="unicode61 tokenchars '-_' remove_diacritics 1"
);

-- Keep FTS in sync via triggers
CREATE TRIGGER journal_fts_insert AFTER INSERT ON journal_entries BEGIN
    INSERT INTO journal_fts(rowid, context, decision, rationale)
        VALUES (new.rowid, new.context, new.decision, new.rationale);
END;

CREATE TRIGGER journal_fts_delete AFTER DELETE ON journal_entries BEGIN
    INSERT INTO journal_fts(journal_fts, rowid, context, decision, rationale)
        VALUES ('delete', old.rowid, old.context, old.decision, old.rationale);
END;

CREATE TRIGGER journal_fts_update AFTER UPDATE OF context, decision, rationale ON journal_entries BEGIN
    INSERT INTO journal_fts(journal_fts, rowid, context, decision, rationale)
        VALUES ('delete', old.rowid, old.context, old.decision, old.rationale);
    INSERT INTO journal_fts(rowid, context, decision, rationale)
        VALUES (new.rowid, new.context, new.decision, new.rationale);
END;
