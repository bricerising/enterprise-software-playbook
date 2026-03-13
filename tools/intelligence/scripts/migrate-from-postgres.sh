#!/usr/bin/env bash
# Migrate data from rising-intelligence Postgres (Docker) to intel SQLite.
#
# Usage: ./migrate-from-postgres.sh [DB_PATH]
#
# Requires: docker, sqlite3, python3

set -euo pipefail

DB_PATH="${1:-$HOME/.local/share/intel/intelligence.db}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PG_CONTAINER="rising-intelligence-postgres-1"
PG_USER="rising"
PG_DB="rising_intelligence"
EXPORT_FILE="/tmp/intel-export.jsonl"

echo "==> Target: $DB_PATH"
mkdir -p "$(dirname "$DB_PATH")"

# Remove existing DB if present (fresh migration)
if [ -f "$DB_PATH" ]; then
  echo "==> Removing existing database"
  rm -f "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm"
fi

# Create schema
echo "==> Creating schema"
sqlite3 "$DB_PATH" < "$SCRIPT_DIR/migrate-from-postgres.sql"

# Export raw_events from Postgres as JSON lines
echo "==> Exporting events from Postgres..."

docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -t -A -c "
SELECT json_build_object(
  'event_id', event_id,
  'source', CASE WHEN source::text = 'news' THEN 'lobsters' ELSE source::text END,
  'feed', source_meta->>'feed_name',
  'url', url,
  'title', title,
  'content', text,
  'author', COALESCE(author_display_name, author_handle, author_id),
  'published_at', CASE WHEN published_at IS NOT NULL
    THEN to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
    ELSE NULL END,
  'fetched_at', to_char(fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
  'topics', COALESCE(to_json(topics), '[]'::json),
  'tags', COALESCE(to_json(tags), '[]'::json),
  'score', COALESCE(engagement_score, 0),
  'comments', COALESCE(engagement_comments, 0),
  'source_meta', source_meta::text
)
FROM raw_events
ORDER BY COALESCE(published_at, fetched_at) ASC;
" > "$EXPORT_FILE"

EVENT_COUNT=$(wc -l < "$EXPORT_FILE" | tr -d ' ')
echo "==> Exported $EVENT_COUNT events"

# Import into SQLite
echo "==> Importing into SQLite..."

python3 <<PYEOF
import json, sqlite3, sys, re

db_path = "$DB_PATH"
jsonl_path = "$EXPORT_FILE"

conn = sqlite3.connect(db_path)
conn.execute("PRAGMA synchronous = NORMAL")
conn.execute("PRAGMA foreign_keys = ON")

# --- Canonical URL normalization ---
TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "ref", "source", "via", "fbclid", "gclid", "mc_cid", "mc_eid",
}

def canonical_url(url):
    if not url:
        return None
    try:
        from urllib.parse import urlparse, urlunparse, parse_qs, urlencode
        p = urlparse(url)
        host = p.hostname.lower() if p.hostname else ""
        # Strip tracking params
        params = parse_qs(p.query, keep_blank_values=False)
        cleaned = {k: v for k, v in params.items() if k.lower() not in TRACKING_PARAMS}
        query = urlencode(cleaned, doseq=True)
        # Strip trailing slash and fragment
        path = p.path.rstrip("/") or "/"
        return urlunparse((p.scheme, host, path, "", query, ""))
    except Exception:
        return None

# --- Import events ---
cursor = conn.cursor()
inserted = 0
skipped = 0

with open(jsonl_path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as e:
            print(f"  WARN: malformed JSON: {e}", file=sys.stderr)
            skipped += 1
            continue

        topics = json.dumps(row.get("topics") or [])
        tags = json.dumps(row.get("tags") or [])
        canon = canonical_url(row.get("url"))

        try:
            cursor.execute("""
                INSERT OR IGNORE INTO events
                    (event_id, source, feed, url, canonical_url, title, content, author,
                     published_at, fetched_at, topics, tags, score, comments, source_meta)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                row["event_id"],
                row["source"],
                row.get("feed"),
                row.get("url"),
                canon,
                row.get("title"),
                row.get("content"),
                row.get("author"),
                row.get("published_at"),
                row["fetched_at"],
                topics,
                tags,
                row.get("score", 0) or 0,
                row.get("comments", 0) or 0,
                row.get("source_meta"),
            ))
            if cursor.rowcount > 0:
                inserted += 1
                # Populate event_topics side table
                event_topics = row.get("topics") or []
                for topic in event_topics:
                    cursor.execute(
                        "INSERT OR IGNORE INTO event_topics (event_id, topic) VALUES (?, ?)",
                        (row["event_id"], topic)
                    )
        except Exception as e:
            eid = row.get("event_id", "?")
            print(f"  WARN: skipping {eid}: {e}", file=sys.stderr)
            skipped += 1

        if inserted % 2000 == 0 and inserted > 0:
            conn.commit()
            print(f"  ... {inserted} events")

conn.commit()
conn.close()
print(f"==> Done: {inserted} imported, {skipped} skipped")
PYEOF

# Build checkpoints from latest event per source+feed
echo "==> Building checkpoints..."
sqlite3 "$DB_PATH" <<'SQL'
INSERT OR REPLACE INTO checkpoints (source, feed, cursor, updated_at)
SELECT
    source,
    COALESCE(feed, ''),
    MAX(event_id),
    MAX(fetched_at)
FROM events
GROUP BY source, COALESCE(feed, '');
SQL

# Build collector_health from event data
echo "==> Building collector health..."
sqlite3 "$DB_PATH" <<'SQL'
INSERT OR REPLACE INTO collector_health (source, feed, last_polled_at, last_success_at, events_in_poll)
SELECT
    source,
    COALESCE(feed, ''),
    MAX(fetched_at),
    MAX(fetched_at),
    0
FROM events
GROUP BY source, COALESCE(feed, '');
SQL

# Report
echo ""
echo "=== Migration Summary ==="
sqlite3 "$DB_PATH" <<'SQL'
SELECT '  Events:       ' || COUNT(*) FROM events;
SELECT '  With topics:  ' || COUNT(*) FROM events WHERE topics != '[]';
SELECT '  Event topics: ' || COUNT(*) FROM event_topics;
SELECT '  Sources:      ' || COUNT(DISTINCT source) FROM events;
SELECT '  Feeds:        ' || COUNT(DISTINCT feed) FROM events WHERE feed IS NOT NULL;
SELECT '  Checkpoints:  ' || COUNT(*) FROM checkpoints;
SELECT '  Health rows:  ' || COUNT(*) FROM collector_health;
SELECT '  Canonical URLs: ' || COUNT(*) FROM events WHERE canonical_url IS NOT NULL;
SELECT '  Date range:   ' || MIN(COALESCE(published_at, fetched_at)) || ' -> ' || MAX(COALESCE(published_at, fetched_at)) FROM events;
SELECT '  DB size:      ' || ROUND(page_count * page_size / 1024.0 / 1024.0, 1) || ' MB' FROM pragma_page_count(), pragma_page_size();
SELECT '  FTS indexed:  ' || COUNT(*) FROM events_fts;
SELECT '  Schema ver:   ' || user_version FROM pragma_user_version;
SELECT '  App ID:       0x' || printf('%08X', application_id) FROM pragma_application_id;
SQL

echo ""
echo "==> Database ready at: $DB_PATH"

# Cleanup
rm -f "$EXPORT_FILE"
