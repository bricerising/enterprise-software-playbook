# Spec 015: Collection Quality Controls

**Amends [spec 006](006-intelligence-tool.md).**

## Problem

The intelligence tool collects events from 128+ sources, classifies them into topics, and exposes them for trend analysis and forecasting. However, three upstream data quality issues degrade downstream analytics:

1. **RSS backfill floods** — When a new RSS feed is added or an existing feed resets its checkpoint, the adapter fetches the feed's entire item list (often 500–2000 items). These bulk ingests compress weeks of real-world publishing into a single poll cycle, which distorts trend acceleration (a slow trickle looks like a massive spike), inflates chain co-occurrence counts (items published weeks apart appear simultaneous), and fills the database with stale content that will be pruned shortly anyway. The forecast engine's `COALESCE(published_at, fetched_at)` mitigates the timestamp compression, but volume-based metrics (spike day detection, topic counts) still see an artificial burst.

2. **Invisible classifier gaps** — The topic classifier assigns zero topics to ~31% of events (per Q1 2026 audit). These unclassified events are invisible to trends, forecasts, and chain detection — they represent signal loss. But the `intel stats` command doesn't report this gap, and `intel forecast` doesn't surface it in its data quality metrics. Operators have no visibility into how much signal they're losing.

3. **Source concentration blind spots** — When a single source (e.g., Hacker News) dominates event volume (>40% of all events), chain detection and trend scoring are biased toward that source's editorial choices. A "trending topic" may just be a topic that Hacker News surfaced, not one that multiple independent sources confirm. The `source_diversity` field on chains partially addresses this, but there's no system-level visibility into overall source balance.

All three issues are collection-layer problems that should be addressed before data reaches the forecast engine.

## Goal

Add collection quality controls that:

1. Cap the number of items processed per RSS poll cycle to prevent backfill floods
2. Surface health metrics in `intel stats` that make classifier gaps and source concentration visible
3. Auto-generate warnings when health metrics exceed thresholds

These are upstream controls — they improve the quality of data that feeds into the forecast engine (spec 007) and confidence gates (spec 014).

## Non-Goals

- Changing the topic classifier algorithm (spec 006 §Topic Classification; improvements noted in spec 007 §Future Work)
- Adding new source adapters or feeds
- Changing trend scoring or forecast algorithms
- Building a monitoring dashboard (CLI output is the interface)
- Per-event quality scoring (spec 007 §I covers confidence-weighted classification)

## Scope

| In scope | Out of scope |
|----------|-------------|
| RSS adapter `max_items` cap per poll | Per-feed-lifetime caps or dedup across polls |
| Stats health metrics (unclassified, concentration, data age) | Historical health metric tracking or time series |
| Auto-generated health warnings on `intel stats` | Alerting, notifications, or monitoring integrations |
| Classifier coverage visibility via stats metrics | Classifier algorithm improvements |
| | Backfill caps for non-RSS adapters (HN, EDGAR, earnings) |

---

## A. RSS Backfill Cap

### Purpose

Prevent a single poll cycle from ingesting an unbounded number of items when a feed is added, reset, or returns an unusually large item list. The cap applies per-poll, preserving newest-first order so the most recent items are always captured.

### Algorithm

**Step 1: Add `max_items` to RSS feed configuration**

Extend the RSS variant of `FeedSchema` in `config.ts`:

```typescript
// RSS feed schema (Zod)
z.object({
  source: z.literal('rss'),
  url: z.string().url(),
  name: z.string(),
  category: z.string().optional(),
  poll_interval: z.number().optional(),
  // Lower bound 5: values below 5 risk missing items between polls due to checkpoint
  // races, republished items, and clock skew. Upper bound 2000: matches observed
  // backfill flood ceiling. See Decision Summary for full rationale.
  max_items: z.number().int().min(5).max(2000).optional().default(200),
  request_options: z.object({
    headers: z.record(z.string()).optional(),
  }).optional(),
})
```

`max_items` defaults to `DEFAULT_RSS_MAX_ITEMS` (200). Operators can override per-feed in `config.yaml`:

```yaml
feeds:
  - url: https://aws.amazon.com/blogs/aws/feed/
    source: rss
    name: AWS Blog
    max_items: 50          # small blog, rarely more than 50 items
```

**Step 2: Slice items in RSS adapter**

In `collector/adapters/rss.ts`, slice the parsed feed items **before** checkpoint filtering:

```typescript
async *fetch(checkpoint: Checkpoint | null): AsyncGenerator<RawEvent> {
  const feed = await this.parser.parseURL(this.feedUrl);

  // Sort by pubDate descending to guarantee newest-first order.
  // Most RSS feeds return newest-first, but the RSS 2.0 spec does not mandate
  // ordering, and some feeds (including some Atom feeds parsed by rss-parser)
  // return oldest-first. Sorting defensively ensures the slice always captures
  // the most recent items regardless of feed behavior.
  const items = feed.items ?? [];
  const sorted = [...items].sort((a, b) => {
    const rawA = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const rawB = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    const ta = Number.isNaN(rawA) ? 0 : rawA; // malformed pubDate (non-null but unparseable) → treat as undated
    const tb = Number.isNaN(rawB) ? 0 : rawB;
    return tb - ta || (a.link ?? '').localeCompare(b.link ?? ''); // descending by date; tiebreak by link for determinism
  });

  // Cap items per poll — slice before checkpoint to preserve newest-first order.
  // After slicing, checkpoint is set to the newest *processed* item (items[0]),
  // which is also the newest in the full feed (newest-first order preserved).
  const capped = sorted.slice(0, this.maxItems);

  for (const item of capped) {
    // ... existing checkpoint check and event emission ...
  }
}
```

**Why sort before slicing:** While most RSS feeds return items newest-first, the RSS 2.0 spec does not mandate item ordering. Some feeds — particularly Atom feeds (also parsed by `rss-parser`) — may return items oldest-first or in arbitrary order. Without sorting, `slice(0, maxItems)` on an oldest-first feed would capture the *oldest* N items, exactly the opposite of the intent. Sorting by `pubDate` descending guarantees we always capture the most recent items. Items without a `pubDate` sort to the end (treated as epoch 0), which is safe — undated items are least likely to be the newest content. Items with a non-null but unparseable `pubDate` (e.g., `"not-a-date"`) are also treated as undated via the `Number.isNaN` guard — `new Date("not-a-date").getTime()` returns `NaN`, which would make sort comparisons unpredictable without the guard. A secondary tiebreaker on `link` ensures deterministic ordering when multiple items share the same `pubDate` (common with batch-published CMS content), so the same items are consistently captured across runs. Note: the tiebreaker does not help when both items also lack `link` (both compare as `''`), but this edge case — items with neither `pubDate` nor `link` — is vanishingly rare in practice and does not affect correctness, only determinism for those specific items.

**Why guard `feed.items`:** The `feed.items ?? []` guard handles the edge case where `rss-parser` returns `undefined` for `items` on a malformed feed (valid XML but no `<item>` elements). Without the guard, the spread `[...feed.items]` would throw a TypeError.

**Why slice before checkpoint filtering:** Slicing first ensures we process the N most recent items. If we filtered by checkpoint first, a backfill scenario (no checkpoint) would process all items up to the cap from the oldest end, missing the newest content.

**Why per-poll, not per-feed-lifetime:** A per-lifetime cap would require tracking cumulative ingestion counts across restarts, adding state complexity for marginal benefit. The per-poll cap addresses the acute problem (backfill floods) and naturally converges: after the first capped poll, subsequent polls process only new items (checkpoint filtering handles this).

**First-run gap behavior:** On the very first poll (no checkpoint), the adapter processes the `max_items` newest items and sets a checkpoint at the newest item. Items beyond the cap — the oldest items in the feed — are permanently skipped; they will not be ingested on subsequent polls because the checkpoint is now ahead of them. This is intentional: the cap prioritizes recency over completeness, and the skipped items are the least relevant (oldest content from before the system existed). Operators who need historical completeness for a specific feed should temporarily set a higher `max_items` for that feed's first poll, then lower it.

**Inter-poll gap behavior:** If a feed publishes more than `max_items` new items between two poll cycles, only the newest `max_items` are processed — the oldest items in that batch are permanently skipped because the checkpoint advances to the newest processed item. Operators should set `max_items` above the feed's expected inter-poll volume, or reduce the poll interval. In practice this is rare: most RSS feeds publish 5–20 items/day, well below the default 200 cap.

**Truncation logging:** When the cap truncates items, the adapter logs the event so operators have visibility into what was skipped:

```typescript
if (sorted.length > this.maxItems) {
  this.logger.info(
    `Capped feed "${this.name}": processed ${this.maxItems} of ${sorted.length} items`
  );
}
```

### Interface Changes

```typescript
// In FeedSchema RSS variant (config.ts)
max_items?: number;  // default: 200; caps items processed per poll cycle
```

### Files

| File | Change |
|------|--------|
| `config.ts` | Add `max_items` to RSS `FeedSchema` variant with default 200 |
| `collector/adapters/rss.ts` | Accept `max_items` from feed config in constructor; guard `feed.items ?? []`; sort with pubDate tiebreaker on link; slice to `this.maxItems` before checkpoint filtering; log when cap truncates |

---

## B. Stats Health Metrics

### Purpose

Extend `intel stats` with health metrics that make classifier gaps, source concentration, and data age visible to operators. These metrics surface problems that are otherwise hidden — the operator sees event counts but not the quality behind them.

### Algorithm

**Step 1: Compute health metrics**

Add the following queries to `queryStats()` in `queries/stats.ts`:

**Unclassified events:**

```sql
-- Total events and unclassified events (no entry in event_topics)
-- FILTER (WHERE ...) requires SQLite 3.30+; better-sqlite3 bundles 3.44+.
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (
    WHERE NOT EXISTS (
      SELECT 1 FROM event_topics et WHERE et.event_id = e.event_id
    )
  ) AS unclassified
FROM events e;
```

```typescript
const unclassified_events = result.unclassified;
const unclassified_pct = result.total > 0
  ? Math.round((result.unclassified / result.total) * 1000) / 1000
  : 0;
```

**Multi-topic events** (events assigned to `MIN_OVER_CLASSIFICATION_TOPICS` (4) or more topics, indicating possible over-classification):

```sql
SELECT COUNT(*) AS multi_topic_events
FROM (
  SELECT et.event_id
  FROM event_topics et
  GROUP BY et.event_id
  HAVING COUNT(*) >= :min_over_classification_topics  -- MIN_OVER_CLASSIFICATION_TOPICS (4)
);
```

**Top source concentration:**

```sql
-- COALESCE guards against NULL source values, which would create a NULL group
-- in GROUP BY and could become the "top source" with a NULL name.
SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS cnt
FROM events
GROUP BY source
ORDER BY cnt DESC
LIMIT 1;
```

```typescript
const topRow = topSourceResult ?? { source: '', cnt: 0 };
const top_source_name = topRow.source;
const top_source_pct = totalEvents > 0
  ? Math.round((topRow.cnt / totalEvents) * 1000) / 1000
  : 0;
```

**Data age:**

```sql
SELECT
  MIN(COALESCE(published_at, fetched_at)) AS oldest,
  MAX(COALESCE(published_at, fetched_at)) AS newest
FROM events;
```

```typescript
const data_age_days = Math.floor(
  (new Date(newest).getTime() - new Date(oldest).getTime()) / (1000 * 60 * 60 * 24)
);
```

**Step 2: Auto-generate health warnings**

After computing metrics, generate warnings when thresholds are exceeded:

```typescript
const health_warnings: HealthWarning[] = [];

if (unclassified_pct > UNCLASSIFIED_WARNING_THRESHOLD) {
  health_warnings.push({
    type: 'unclassified',
    severity: unclassified_pct > UNCLASSIFIED_CRITICAL_THRESHOLD ? 'critical' : 'warning',
    message:
      `${(unclassified_pct * 100).toFixed(1)}% of events are unclassified ` +
      `(threshold: ${UNCLASSIFIED_WARNING_THRESHOLD * 100}%). ` +
      'Review topic classifier coverage — unclassified events are invisible to trends and forecasts.',
  });
}

if (top_source_pct > SOURCE_CONCENTRATION_THRESHOLD) {
  health_warnings.push({
    type: 'concentration',
    severity: top_source_pct > CONCENTRATION_CRITICAL_THRESHOLD ? 'critical' : 'warning',
    message:
      `Source "${top_source_name}" accounts for ${(top_source_pct * 100).toFixed(1)}% of events ` +
      `(threshold: ${SOURCE_CONCENTRATION_THRESHOLD * 100}%). ` +
      'High concentration biases trend scoring and chain detection toward one source\'s editorial choices.',
  });
}

if (data_age_days < MIN_DATA_AGE_DAYS) {
  health_warnings.push({
    type: 'data_age',
    severity: data_age_days < DATA_AGE_CRITICAL_THRESHOLD ? 'critical' : 'warning',
    message:
      `Data spans only ${data_age_days} days (threshold: ${MIN_DATA_AGE_DAYS}). ` +
      'Lifecycle classification and chain detection need ≥90 days of data for reliable results.',
  });
}

// Denominator is totalEvents (not classified events) for consistency with
// unclassified_pct and top_source_pct — all use the same base.
// See Decision Summary for the denominator rationale.
const multi_topic_pct = totalEvents > 0
  ? Math.round((multi_topic_events / totalEvents) * 1000) / 1000
  : 0;
if (multi_topic_pct > MULTI_TOPIC_WARNING_THRESHOLD) {
  health_warnings.push({
    type: 'over_classification',
    severity: multi_topic_pct > OVER_CLASSIFICATION_CRITICAL_THRESHOLD ? 'critical' : 'warning',
    message:
      `${(multi_topic_pct * 100).toFixed(1)}% of events are assigned to 4+ topics ` +
      `(threshold: ${MULTI_TOPIC_WARNING_THRESHOLD * 100}%). ` +
      'High over-classification rates may inflate chain co-occurrence counts — review classifier precision.',
  });
}
```

### Interface Changes

```typescript
type HealthWarningType = 'unclassified' | 'concentration' | 'data_age' | 'over_classification';
type HealthWarningSeverity = 'warning' | 'critical';

interface HealthWarning {
  type: HealthWarningType;        // discriminator for programmatic filtering
  severity: HealthWarningSeverity; // consumer-facing priority level
  message: string;                // human-readable description with threshold context
}

interface StatsData {
  // ... existing fields from spec 006 ...
  unclassified_events: number;     // events with no topic assignment
  unclassified_pct: number;        // fraction (0.0–1.0), 3 decimal places
  multi_topic_events: number;      // events assigned to 4+ topics
  multi_topic_pct: number;         // fraction (0.0–1.0), 3 decimal places; consistent with unclassified_pct/top_source_pct
  top_source_name: string;         // source with highest event count
  top_source_pct: number;          // that source's share (0.0–1.0), 3 decimal places
  data_age_days: number;           // days between oldest and newest event
  health_warnings: HealthWarning[];// auto-generated warnings (may be empty)
}
```

All new fields are **required** (always present). `health_warnings` is an empty array when no thresholds are exceeded.

**Empty-database behavior:** When the `events` table contains zero rows, stats metrics use safe defaults: `unclassified_events: 0`, `unclassified_pct: 0`, `multi_topic_events: 0`, `multi_topic_pct: 0`, `top_source_name: ''`, `top_source_pct: 0`, `data_age_days: 0`. The `unclassified_pct`, `multi_topic_pct`, and `top_source_pct` computations guard against division by zero (`totalEvents > 0` check). The `top_source` query returns no rows when the table is empty — the implementation should handle this with a fallback (`topRow ?? { source: '', cnt: 0 }`). The `data_age_days < 90` health warning will fire (0 < 90).

### Output Example

```json
{
  "tool": "intel",
  "schema_version": "v2",
  "status": "ok",
  "data": {
    "database": "~/.local/share/intel/intelligence.db",
    "size_mb": 42.3,
    "sqlite_version": "3.51.3",
    "events_total": 15230,
    "events_24h": 487,
    "events_7d": 3201,
    "sources": 12,
    "topics_active_7d": 38,
    "oldest_event": "2025-12-15T00:00:00Z",
    "newest_event": "2026-03-22T14:35:00Z",
    "unclassified_events": 4721,
    "unclassified_pct": 0.310,
    "multi_topic_events": 892,
    "multi_topic_pct": 0.059,
    "top_source_name": "hackernews",
    "top_source_pct": 0.423,
    "data_age_days": 97,
    "health_warnings": [
      {
        "type": "unclassified",
        "severity": "warning",
        "message": "31.0% of events are unclassified (threshold: 20%). Review topic classifier coverage — unclassified events are invisible to trends and forecasts."
      },
      {
        "type": "concentration",
        "severity": "warning",
        "message": "Source \"hackernews\" accounts for 42.3% of events (threshold: 30%). High concentration biases trend scoring and chain detection toward one source's editorial choices."
      }
    ]
  }
}
```

### Files

| File | Change |
|------|--------|
| `queries/stats.ts` | Add health metric queries, warning generation, `logTopicCountDistribution` diagnostic, and updated `StatsData` interface. Use `computeDataSpan` from `queries/shared.ts` (introduced by spec 014) for `data_age_days` computation — pass no `windowStart` for all-time scope. |

### Classifier Coverage Tracking

The health metrics above also serve as the visibility mechanism for the classifier's 31% gap (Q1 2026 audit). This is **measurement only** — it does not change the classifier.

**Key metrics for classifier coverage:**

1. **`unclassified_pct`** — the headline metric. Should trend downward as topics are refined (spec 013) and classifier precision improves (spec 007 §Future Work).

2. **`multi_topic_events`** — the over-classification metric. Events tagged with 4+ topics are likely false positives in at least some assignments. Tracking this alongside `unclassified_pct` prevents the temptation to reduce unclassified events by loosening classifier thresholds (which would inflate multi-topic counts). **Note:** The 4+ threshold is heuristic — the Q1 2026 audit did not measure the actual distribution of per-event topic counts. The implementation includes a one-time diagnostic query (see `logTopicCountDistribution` in Internal Functions) that logs the per-event topic count distribution so the threshold can be validated empirically.

3. **Health warnings** — auto-generated when `unclassified_pct > 20%`. This creates operator awareness without requiring manual audits.

**What this does NOT do:**

- Does not change the topic classifier algorithm
- Does not add new classification strategies (negative examples, embeddings, etc.)
- Does not enforce a minimum coverage threshold that blocks collection

**Future work (per spec 007 §Future Work):** Classifier precision improvements that would reduce the 31% gap:

1. **Negative examples** — Train the classifier with explicit "not this topic" examples for commonly over-tagged categories
2. **Title-topic coherence scoring** — Post-hoc validation using embedding similarity
3. **Confidence-weighted chain volumes** — Use confidence scores in chain detection volume computation (currently only affects evidence relevance)
4. **Windowed health metrics** — Add 7d/30d variants of `unclassified_pct` and `top_source_pct` (e.g., `unclassified_pct_7d`) so operators can see whether coverage is improving or degrading over time. The existing `events_7d` field already establishes a windowed-count precedent. Out of scope for this spec but a natural follow-up.

---

## Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_RSS_MAX_ITEMS` | 200 | Default cap on RSS items processed per poll cycle |
| `UNCLASSIFIED_WARNING_THRESHOLD` | 0.20 | Warn when >20% of events have no topic |
| `SOURCE_CONCENTRATION_THRESHOLD` | 0.30 | Warn when one source exceeds 30% of events |
| `MIN_DATA_AGE_DAYS` | 90 | Warn when data spans fewer than 90 days. **Note:** Intentionally aligned with spec 014's `MIN_LIFECYCLE_DAYS`; if either changes, evaluate whether the other should follow. |
| `MIN_OVER_CLASSIFICATION_TOPICS` | 4 | Per-event topic count threshold for over-classification detection. Heuristic — validated by `logTopicCountDistribution` diagnostic |
| `MULTI_TOPIC_WARNING_THRESHOLD` | 0.10 | Warn when >10% of events are assigned to `MIN_OVER_CLASSIFICATION_TOPICS`+ topics |
| `UNCLASSIFIED_CRITICAL_THRESHOLD` | 0.50 | Escalate unclassified warning to `critical` severity above 50% |
| `CONCENTRATION_CRITICAL_THRESHOLD` | 0.60 | Escalate concentration warning to `critical` severity above 60% |
| `DATA_AGE_CRITICAL_THRESHOLD` | 30 | Escalate data_age warning to `critical` severity below 30 days |
| `OVER_CLASSIFICATION_CRITICAL_THRESHOLD` | 0.25 | Escalate over_classification warning to `critical` severity above 25% |

---

## Implementation

### File Structure

```
tools/intelligence/src/
├── config.ts                          — max_items on RSS FeedSchema
├── collector/adapters/rss.ts          — slice items to max_items; log when cap truncates
└── queries/
    ├── shared.ts                      — computeDataSpan(), computeTopicCounts() (introduced by spec 014; consumed here)
    └── stats.ts                       — health metrics, warnings, topic count diagnostic, updated StatsData
```

### Internal Functions

| Function | Section | Description |
|----------|---------|-------------|
| `queryStats` | B | Extended with health metric queries and warning generation; uses `computeDataSpan` and `computeTopicCounts` from `queries/shared.ts` (introduced by spec 014) for `data_age_days` and per-topic counts |
| `computeHealthWarnings` | B | Generate `HealthWarning` objects from metric thresholds |
| `logTopicCountDistribution` | B | One-time diagnostic: query `SELECT topic_count, COUNT(*) FROM (SELECT event_id, COUNT(*) as topic_count FROM event_topics GROUP BY event_id) GROUP BY topic_count ORDER BY topic_count` and log the result at `debug` level. Called on first `queryStats` invocation when the `over_classification` warning fires, to provide context for threshold tuning. Gated by a "has run" flag (in-memory; re-runs on process restart, which is fine for a diagnostic). Logging at `debug` avoids noise in normal `intel stats` output. Log format: `Topic count distribution: 1→8432 (55.4%), 2→4201 (27.6%), 3→1892 (12.4%), 4→512 (3.4%), 5→193 (1.3%)` — each bucket shows the topic count, event count, and percentage of classified events. |

### Dependencies

No new dependencies. Health metric queries use existing SQLite tables and indexes.

---

## Tests

### Test Cases

**File**: `tools/intelligence/tests/rss-adapter.test.ts`

**`RSS backfill cap` (11 tests)**:
- RSS adapter with `max_items: 5` processes at most 5 items from a feed with 20 items
- Default `max_items` is 200 when not specified in config
- Items are sliced newest-first (first 5 items of the feed, not last 5)
- When items are truncated, an info log is emitted with the feed name and item counts
- After first capped poll (no checkpoint), second poll with no new items yields zero events (checkpoint set at newest processed item, not newest in feed)
- Feed returning items in oldest-first order still yields the newest N items after sorting (verifies defensive sort-by-pubDate)
- Feed with items missing `pubDate` sorts undated items to the end; newest dated items are captured first
- Feed with malformed `pubDate` (non-null but unparseable, e.g., `"not-a-date"`) treats those items as undated (sorted to end), not as sort-destabilizing NaN
- Feed with multiple items sharing the same `pubDate` produces deterministic order (tiebreak by link)
- Feed where `rss-parser` returns `undefined` for `items` (malformed feed) yields zero events without throwing
- Feed publishing more than `max_items` new items between two polls: only the newest `max_items` are processed; older items in that batch are permanently skipped (validates documented inter-poll gap behavior)

**File**: `tools/intelligence/tests/stats.test.ts` (additions to existing test suite, or new file if none exists)

**`stats health metrics` (5 tests)**:
- `unclassified_events` and `unclassified_pct` are present and consistent (pct = events / total)
- `multi_topic_events` and `multi_topic_pct` are present and consistent (pct = events / total); counts events with 4+ topic assignments
- `top_source_name` and `top_source_pct` identify the dominant source
- `data_age_days` reflects the timestamp range of stored events
- `health_warnings` is an array of `HealthWarning` objects (may be empty); each has `type`, `severity`, and `message`

**`health warnings` (7 tests)**:
- Warning with `type: 'unclassified'` generated when `unclassified_pct > 0.20`; `severity: 'warning'` at 0.25, `severity: 'critical'` at 0.55
- Warning with `type: 'concentration'` generated when `top_source_pct > 0.30`; `severity: 'warning'` at 0.40, `severity: 'critical'` at 0.65
- Warning with `type: 'data_age'` generated when `data_age_days < 90`; `severity: 'warning'` at 60 days, `severity: 'critical'` at 20 days
- Warning with `type: 'over_classification'` generated when `multi_topic_events / total > 0.10`; `severity: 'warning'` at 0.15, `severity: 'critical'` at 0.30
- No warnings when all metrics are within thresholds
- Every warning has a `severity` field with value from `'warning' | 'critical'`
- Severity escalates correctly at critical thresholds (unclassified > 50%, concentration > 60%, data_age < 30 days, over_classification > 25%)

**`config validation` (4 tests)**:
- RSS feed with `max_items: 0` or negative value fails validation
- RSS feed with `max_items` below 5 (lower bound) fails validation (e.g., `max_items: 1`)
- RSS feed with `max_items` above 2000 (upper bound) fails validation
- RSS feed without `max_items` defaults to 200

**`existing field regression` (2 tests)**:
- All existing `StatsData` fields from spec 006 are still present (events_total, events_24h, events_7d, sources, etc.)
- Existing stats output structure (tool, schema_version, status, data) is preserved

### Test Fixtures

- A database fixture with known counts of unclassified events (events with empty `event_topics`)
- A database fixture with skewed source distribution (one source at 60%)
- A database fixture with events spanning only 30 days (data age warning)

---

## Risks

| Risk | Mitigation |
|------|-----------|
| `max_items: 200` may truncate legitimate high-volume feeds | 200 is generous — most RSS feeds return 20–50 items; operators can increase per-feed (up to 2000) |
| Sort-by-pubDate assumes `pubDate` is parseable and correct | A feed with missing `pubDate` values will sort those items to the end (epoch 0 fallback). A feed with malformed `pubDate` (non-null but unparseable) is handled by the `Number.isNaN` guard — also treated as undated. A feed with future-dated `pubDate` values will sort those first. All are acceptable: undated/malformed items are deprioritized, and future-dated items are rare and still valid content | `Number.isNaN` guard on parsed timestamps; `rss-parser` normalizes common date formats |
| Health metric queries add overhead to `intel stats` | Queries use existing indexes (`idx_event_topics_topic`, `idx_events_source_fetched`); negligible cost for ~15K events |
| Warning thresholds may be too strict or too lenient | Thresholds are configurable constants; values chosen from Q1 2026 audit data (31% unclassified, ~40% HN concentration) |
| Operators may ignore health warnings | Warnings surface automatically with structured `type` discriminators — no action required to see them; they appear in every `intel stats` invocation and are filterable by type |
| `FILTER` clause requires SQLite 3.30+ | `better-sqlite3` bundles 3.44+; safe for the bundled engine. Not a concern unless queries are run against an external SQLite instance, which is not a current use case |

---

## Decision Summary

| Decision | Selected | Rationale |
|----------|----------|-----------|
| Per-poll cap, not per-feed-lifetime | `max_items` per poll cycle | Per-lifetime requires cross-restart state tracking; per-poll is stateless and addresses the acute backfill problem |
| Sort by pubDate descending before slicing | Defensive ordering | RSS 2.0 does not mandate item order; some feeds (especially Atom) return oldest-first. Sorting guarantees newest-first regardless of feed behavior; items without pubDate sort to the end |
| Slice before checkpoint, not after | Newest-first preservation | After sorting, slicing before checkpoint ensures we process the N most recent items, not stale backfill |
| Default 200 items, range 5–2000 | `DEFAULT_RSS_MAX_ITEMS = 200`, `.min(5).max(2000)` | Most RSS feeds return 20–50 items; 200 is permissive enough to not interfere with normal operation while capping pathological cases. Lower bound of 5: values below 5 risk missing items between polls on even low-volume feeds (a feed publishing once daily would need `max_items >= 1` per poll, but checkpoint races, republished items, and clock skew make very low caps fragile — 5 provides headroom while still being meaningfully restrictive for testing/debugging). Upper bound of 2000 prevents the cap from being effectively disabled — 2000 matches the upper end of observed backfill floods in the problem statement |
| Unclassified threshold at 20% | `UNCLASSIFIED_WARNING_THRESHOLD = 0.20` | Current rate is 31%; 20% is achievable with topic improvements (spec 013) and represents a meaningful coverage level |
| Concentration threshold at 30% | `SOURCE_CONCENTRATION_THRESHOLD = 0.30` | With 128+ sources, no single source should dominate; 30% is the point where chain detection becomes source-biased |
| Data age threshold at 90 days | `MIN_DATA_AGE_DAYS = 90` | Aligned with spec 014's `MIN_LIFECYCLE_DAYS`; lifecycle classification needs 90d of history for the 90d acceleration window |
| All-time scope for stats metrics | Not window-scoped | `intel stats` is a system health overview, not a per-analysis-window view; all-time scope matches existing `events_total`, `events_7d` semantics |
| Structured health warnings with type and severity | `HealthWarning` objects with `type`, `severity`, and `message` | The `type` field enables programmatic filtering; `severity` (`'warning' | 'critical'`) lets consumers prioritize without hardcoding threshold knowledge — e.g., `unclassified_pct` at 0.25 is `warning`, at 0.55 is `critical`. Critical thresholds: unclassified > 50%, concentration > 60%, data_age < 30 days, over_classification > 25%. `message` remains human-readable for CLI display. Only two severity levels: all current warnings are actionable (`warning` or `critical`); an `info` level was considered but excluded since no current warning type generates it — if a future spec adds informational-only warnings, the type can be extended then |
| Measurement only for classifier coverage (§B subsection) | No classifier changes | Spec 007 §Future Work defines the improvement roadmap; this spec makes the gap visible so future work can be prioritized |
| `multi_topic_events` threshold at 4+ topics | `MIN_OVER_CLASSIFICATION_TOPICS = 4` | Most events should have 1–3 topics; 4+ suggests over-classification. The 5-topic cap in the classifier (spec 006) means 4+ is in the top 40% of possible assignments. Extracted to a named constant for tunability. **Caveat:** This threshold is heuristic — the Q1 2026 audit measured unclassified rate (31%) but not the per-event topic count distribution. The `logTopicCountDistribution` diagnostic (see Internal Functions) logs the distribution on first run so the threshold can be validated or adjusted empirically |
| Multi-topic warning threshold at 10% | `MULTI_TOPIC_WARNING_THRESHOLD = 0.10` | If >10% of events have 4+ topics, the classifier is likely over-tagging — which inflates chain co-occurrence counts. The threshold is conservative; a well-tuned classifier should produce 4+ topic events rarely |
| Expose `multi_topic_pct` alongside `multi_topic_events` | Required field on `StatsData` | Consistent with `unclassified_pct` and `top_source_pct` — all count-based metrics have a corresponding percentage field so consumers don't have to compute it themselves |
| `multi_topic_pct` denominator is total events, not classified events | `multi_topic_events / totalEvents` | Unclassified events (0 topics) can never be over-classified, so using classified events as the denominator (`totalEvents - unclassifiedEvents`) would give a higher and arguably more accurate rate of classifier over-tagging. However, total events is used for consistency with `unclassified_pct` and `top_source_pct` (all use the same denominator), and because the system-wide view ("what fraction of all events are over-tagged") is more intuitive for operators than a classifier-internal view. The difference is modest: at 31% unclassified, a 10% system-wide rate corresponds to ~14.5% of classified events |

---

## Verification

```bash
# 1. Type-checks cleanly
cd tools/intelligence && npx tsc --noEmit

# 2. All tests pass
npx vitest run tests/stats.test.ts

# 3. Verify config accepts max_items on RSS feeds
cat ~/.config/intel/config.yaml | grep max_items

# 4. Verify stats includes new health metrics
intel stats | jq '{unclassified_events, unclassified_pct, multi_topic_events, multi_topic_pct, top_source_name, top_source_pct, data_age_days, health_warnings}'

# 5. Verify health_warnings is populated when thresholds exceeded
intel stats | jq '.data.health_warnings'
# Expected: array of {type, message} objects (or [] if metrics are within thresholds)

# 5b. Verify warning types are filterable
intel stats | jq '[.data.health_warnings[].type]'
# Expected: subset of ["unclassified", "concentration", "data_age", "over_classification"]

# 6. Verify unclassified_pct consistency
intel stats | jq '{events_total: .data.events_total, unclassified: .data.unclassified_events, pct: .data.unclassified_pct}'
# Verify: unclassified / events_total ≈ pct

# 7. Verify RSS backfill cap (add a feed and run once)
intel collect --once 2>&1 | grep -i "items"
# Expected: no single feed processes more than max_items (default 200) events

# 7b. Verify truncation logging (add a feed with low max_items to trigger cap)
intel collect --once 2>&1 | grep -i "capped feed"
# Expected: log line like 'Capped feed "FeedName": processed 50 of 312 items'

# 8. Verify default max_items is applied
node -e "const {loadConfig} = require('./dist/config.js'); const c = loadConfig(); console.log(c.feeds.filter(f => f.source === 'rss').map(f => ({name: f.name, max_items: f.max_items})))"
# Expected: max_items = 200 for feeds without explicit override
```

---

## Known Limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| **RSS cap is per-poll, not per-feed-lifetime** | A feed reset still ingests up to `max_items` items per cycle; multiple cycles can still accumulate backfill | Per-poll cap addresses the acute burst; checkpoint filtering prevents re-processing on subsequent polls |
| **First-run gap: oldest items are permanently skipped** | On the first poll (no checkpoint), items beyond `max_items` are never ingested because the checkpoint advances past them | Intentional: the cap prioritizes recency over completeness. Operators needing historical data should temporarily increase `max_items` for that feed's first poll |
| **Inter-poll gap: high-volume feeds can lose items between polls** | If a feed publishes more than `max_items` new items between two poll cycles (e.g., `max_items: 50` on a feed publishing 80 items/day with a 24h poll interval), the oldest items in that batch are permanently skipped — the checkpoint advances to the newest processed item, leaving a gap | Same recency-over-completeness tradeoff as first-run. Operators should set `max_items` above the feed's expected inter-poll volume, or reduce the poll interval. In practice this is rare: most RSS feeds publish 5–20 items/day, well below the default 200 cap |
| **Health metrics are all-time, not windowed** | A source that was dominant 3 months ago still inflates `top_source_pct` even if current collection is balanced | `intel stats` shows all-time health; spec 014's `data_quality` provides window-scoped metrics for forecast context |
| **Classifier coverage tracking is passive** | No enforcement mechanism prevents high unclassified rates from degrading analytics | Active enforcement would require defining "minimum acceptable coverage" — premature until classifier improvements (spec 007 §Future Work) are implemented |
| **`multi_topic_events` threshold (4+) is heuristic** | Some events legitimately span 4 topics (e.g., a cross-domain announcement) | The metric flags volume, not individual events; high counts prompt classifier review, not automatic re-classification |
| **Non-RSS adapters are not capped** | Other adapter types (API-based, scraping, etc.) could exhibit similar backfill floods but are not addressed by this spec's `max_items` cap | RSS is the dominant adapter type and the source of observed backfill floods; non-RSS adapters should be evaluated separately if backfill floods are observed from non-RSS sources |
| **Health warnings are not persisted** | No historical record of when warnings first appeared or were resolved | Warnings are computed on-demand from current data; the `type` discriminator enables future persistence by type if needed — but a time series would require a new table, out of scope for this spec |

---

## Cross-References

- **Spec 006** (Intelligence Tool) — RSS adapter and stats query are amended
- **Spec 007** §I (Confidence-Weighted Classification) — classifier precision improvements that would reduce the unclassified gap
- **Spec 007** §Future Work — negative examples, title-topic coherence, confidence-weighted chain volumes
- **Spec 013** (Topic Strategy) — topic refinement that improves classifier coverage
- **Spec 014** (Forecast Confidence Gates) — downstream consumer of collection quality

### Shared concerns with spec 014

- **90-day threshold:** This spec's `MIN_DATA_AGE_DAYS` and spec 014's `MIN_LIFECYCLE_DAYS` are intentionally aligned at 90. They are separate constants (one triggers a stats warning, the other gates lifecycle confidence), but changing one without evaluating the other would produce inconsistent messaging. If either constant is tuned, review the other.
- **`data_age_days` computation:** Both specs compute `data_age_days` from the same `MIN/MAX(COALESCE(published_at, fetched_at))` query — this spec in `queries/stats.ts` (all-time), spec 014 in `forecast/index.ts` (window-scoped). Spec 014 introduces `queries/shared.ts` with a `computeDataSpan(db, windowStart?)` function. This spec consumes that shared function (passing no `windowStart` for all-time scope).
- **Window-scoped field naming:** This spec's `StatsData` uses `unclassified_pct`, `top_source_name`, and `top_source_pct` (all-time scope). Spec 014's `DataQuality` uses the `window_` prefix for the same concepts: `window_unclassified_pct`, `window_top_source_name`, `window_top_source_pct`. The field names are intentionally different across all three pairs so consumers cannot accidentally conflate window-scoped and all-time values. The scoping difference is intentional: system health reflects all-time data, forecast quality reflects the analysis window.
- **Windowed health metric convergence:** §B Future Work item 4 (windowed `unclassified_pct_7d`/`top_source_pct_7d`) would naturally converge with spec 014's window-scoped `data_quality` metrics (`window_unclassified_pct`, `window_top_source_pct`). When implemented, consider whether windowed stats metrics should share computation with `data_quality` (via `queries/shared.ts`) or remain independent queries — the scoping and rounding semantics should align to avoid a third variant of "unclassified percentage."

### Integration test

Add a cross-spec integration test in `tools/intelligence/tests/cross-spec-integration.test.ts` that verifies the relationship between the two `unclassified_pct` values:

```typescript
test('unclassified percentage queries use consistent logic', async () => {
  const stats = await queryStats(db);
  const forecast = await computeForecast(db, { window: 90 });

  // Both values should be in valid range
  expect(stats.unclassified_pct).toBeGreaterThanOrEqual(0);
  expect(stats.unclassified_pct).toBeLessThanOrEqual(1);
  expect(forecast.data_quality.window_unclassified_pct).toBeGreaterThanOrEqual(0);
  expect(forecast.data_quality.window_unclassified_pct).toBeLessThanOrEqual(1);

  // When the forecast window covers all data (window >= data_age_days),
  // both values should be nearly identical (same data, same query logic).
  // Allow a small tolerance for rounding (3 decimal places → ±0.001).
  if (forecast.data_quality.data_age_days <= 90) {
    expect(Math.abs(stats.unclassified_pct - forecast.data_quality.window_unclassified_pct))
      .toBeLessThanOrEqual(0.001);
  } else {
    // When the window is narrower than all-time, divergence depends on how much
    // the unclassified rate differs between older and newer events. A 15pp tolerance
    // catches query bugs (wrong table, missing join) while allowing natural variation
    // from classifier improvements over time — classifier precision improvements
    // (spec 007 §Future Work, spec 013) are an expected outcome of the playbook and
    // can produce >5pp divergence between all-time and recent-window rates.
    expect(Math.abs(stats.unclassified_pct - forecast.data_quality.window_unclassified_pct))
      .toBeLessThan(0.15);
  }
});
```

### Implementation ordering

Specs 014 and 015 can be implemented independently and in parallel. This spec's RSS backfill cap (§A) and stats health metrics (§B) have no dependencies on spec 014. The only shared artifact is `queries/shared.ts` for `computeDataSpan` and `computeTopicCounts`. **Spec 014 owns creation of `queries/shared.ts`** (see spec 014 §Implementation ordering). This spec is a consumer — it imports `computeDataSpan` and passes no `windowStart` for all-time scope. **Recommended approach:** Land `queries/shared.ts` as a small prerequisite PR before either spec's main implementation, so both can import from it without coordination. If that's impractical and both specs are implemented in parallel on separate branches, expect a trivial merge conflict on `queries/shared.ts` — the function signatures are identical, so resolution is straightforward.

### Schema version

If this spec co-ships with spec 014, a single `schema_version` bump from `"v1"` to `"v2"` covers both. If this spec ships independently, the new required fields on `StatsData` warrant the same version bump — `StatsData` consumers with strict schema validation need to update. See spec 014's schema version section for the coordinated approach. There are no external consumers of the stats API today — the only consumer is the `intel` CLI itself — so no deprecation period or v1 compatibility shim is needed.
