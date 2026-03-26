# Spec 019: Classifier Training Data & Evolution

**Amends [spec 006](006-intelligence-tool.md) and [spec 013](013-topic-strategy.md).**

> **Taxonomy note**: The topic set has grown from spec 013's original 61 topics to 66 (additions: `macro.monetary-policy`, `market.payments`, `market.crypto`, `ai.research`, `devex.methodology`).

> **Amendment (2026-03)**: Phase 2 now uses **L2-regularized Logistic Regression** instead of Complement Naive Bayes (CNB). CNB suffered from class imbalance: Platt scaling B values were too high, making calibrated probability thresholds unreachable for rare topics. Logistic regression with per-topic `score_threshold` (found via F1 maximization) replaces the Platt scaling pipeline. Model version >= 3 is required; the `bm25_val_includes_title` field distinguishes v3+ models.

## Problem

The intelligence tool's topic classifier (spec 006, §Topic Classification) uses keyword/regex matching with learned confidence weights. Spec 015's Q1 2026 audit surfaced two classifier health warnings: **~31% of events are unclassified** (`unclassified_pct: 0.310`) and **5.9% are assigned to 4+ topics** (`multi_topic_pct: 0.059`), the over-classification threshold. Spec 013 identifies classifier precision as a key improvement area, and the topic lifecycle process (spec 013, §Topic Lifecycle) requires manual audit data to validate thresholds.

But there is no labeled ground truth to measure classifier precision against. The learning loop (spec 007, §J2) adjusts topic weights from forecast outcomes — a proxy for precision, not a direct measurement. Without labeled training data, we cannot:

1. **Measure precision/recall** per topic — which topics are over-tagged, which are missed?
2. **Validate the 4+ threshold** — is 4 topics genuinely over-classification, or are some events legitimately cross-domain?
3. **Evaluate classifier changes** — when keywords are added (as in the current `improve-classification` branch), how do we know precision improved vs degraded?
4. **Build a regression test suite** — classifier changes should be testable against known-correct labels.

## Goal

Add a training data generation system that:

1. Samples events from the main database using reservoir sampling (Algorithm R)
2. Produces a standalone SQLite training database with events awaiting topic labels
3. Provides CLI commands for label management (assign topics, check progress, fetch next unreviewed)
4. Provides an agent skill workflow for subagent-driven classification of each sampled event
5. Replace the keyword/regex classifier with BM25 scoring (Phase 1) and train a Complement Naive Bayes probabilistic classifier from the labeled data (Phase 2)

## Non-Goals

- Active learning or smart sampling (uniform random is sufficient at current scale)
- Persisting training databases in the main database schema (training DBs are standalone artifacts)

> **Implementation ordering**: Phase 1 (BM25 scoring, §J) ships immediately alongside the training data infrastructure — it replaces the keyword/regex classifier with no training data dependency. Phase 2 (CNB training pipeline, §J) code ships in the same deliverable, but the trained model is produced only after labeling via §A-F (≥500 events). Phase 3 (continuous improvement loop) is deferred to §K as future work.

## Scope

| In scope | Out of scope |
|----------|-------------|
| Reservoir sampling from events table | Stratified or weighted sampling |
| Standalone training SQLite database | Schema changes to main database |
| CLI commands: generate, label, progress, next, list, export, evaluate | MCP tool exposure for training commands |
| Agent skill workflow for classification | Multi-pass deduplication or content analysis |
| Single-pass O(n) sampling algorithm | Phase 3 continuous improvement loop (§K) |
| BM25 scoring engine — Phase 1 (§J) | Active learning sampling |
| Drop `regex` field from `topics.yaml` (§J) | Automated retraining triggers |
| CNB training pipeline — Phase 2 (§J) | |
| `intel classifier train` command (§J) | |

---

## A. Sampling Algorithm

### Purpose

Select a representative subset of events for human/agent labeling. The sample must be uniformly random (every event has equal probability of selection) to produce unbiased precision estimates.

### Algorithm: Reservoir Sampling (Algorithm R)

Single-pass, O(n) time, O(k) space where k = sample size.

**Step 1: Compute sample size**

```typescript
const totalEvents = db.prepare('SELECT COUNT(*) AS cnt FROM events').get().cnt;
const sampleSize = Math.max(1, Math.round(totalEvents * sampleRate));
```

At the current database size (33,309 events, 10% rate), this produces ~3,331 samples — sufficient for per-topic precision estimates with ≥30 samples per active topic.

**Step 2: Seed the PRNG**

When `--seed` is provided, use the **mulberry32** PRNG for reproducible sampling. The algorithm choice is fixed (not an implementation detail) because reproducibility requires: same seed + same PRNG + same data = same sample. The algorithm name is stored in `training_meta` as `prng_algorithm`. Without a seed, use `Math.random()`.

```typescript
const random = seed != null ? seededPrng(seed) : Math.random;
```

**Step 3: Single-pass reservoir fill**

```typescript
// Stream all events in deterministic order
const iter = db.prepare(`
  SELECT event_id, title, content, url, source, feed,
         author, topics, published_at, fetched_at, score, comments
  FROM events ORDER BY id
`).iterate();

const reservoir: EventRow[] = [];
let i = 0;

for (const row of iter) {
  if (i < sampleSize) {
    // Fill phase: first k items go directly into reservoir
    reservoir.push(row);
  } else {
    // Replace phase: item i replaces a random element with probability k/(i+1)
    const j = Math.floor(random() * (i + 1));
    if (j < sampleSize) {
      reservoir[j] = row;
    }
  }
  i++;
}
```

**Step 4: Populate `machine_confidences` from `event_topics`**

After reservoir sampling completes, batch-query `event_topics` for all sampled events to build the `machine_confidences` and `machine_scores` arrays. Use a single query instead of per-event queries to avoid N+1 overhead:

```typescript
// Batch lookup: one query for all sampled events
const ids = reservoir.map(r => r.event_id);
const placeholders = ids.map(() => '?').join(',');
const allConfs = db.prepare(`
  SELECT event_id, topic, confidence, score
  FROM event_topics WHERE event_id IN (${placeholders})
`).all(...ids);

// Group by event_id
const confByEvent = new Map<string, Map<string, { confidence: number | null; score: number | null }>>();
for (const c of allConfs) {
  if (!confByEvent.has(c.event_id)) confByEvent.set(c.event_id, new Map());
  confByEvent.get(c.event_id)!.set(c.topic, { confidence: c.confidence, score: c.score });
}

// Align confidences and scores to topic order
for (const row of reservoir) {
  const topics: string[] = JSON.parse(row.topics);
  const confMap = confByEvent.get(row.event_id) ?? new Map();
  row.machine_confidences = topics.map(t => confMap.get(t)?.confidence ?? null);
  row.machine_scores = topics.map(t => confMap.get(t)?.score ?? null);
}
```

This preserves array order alignment: `machine_topics[i]` corresponds to `machine_confidences[i]` and `machine_scores[i]`. Topics not found in `event_topics` are stored as `null` in the JSON arrays — a missing entry means "pre-confidence-tracking event" (before migration 004), not "maximum confidence." Defaulting to 1.0 would mislead threshold analysis by inflating apparent confidence for legacy events. `machine_scores` entries are `null` for events classified before BM25 (pre-Phase 1), since the keyword classifier did not produce raw scores. If the sample exceeds SQLite's `SQLITE_MAX_VARIABLE_NUMBER` (default 999), chunk the `IN` clause into batches of 500.

**Properties:**
- Each event has exactly `k/n` probability of being in the final sample (uniform)
- Single pass over the events table — no secondary queries or temp tables
- Memory: holds `k` event rows in the reservoir array. Per-row size varies: title + metadata ≈ 2KB, but `content` (full RSS article text) can be 10-50KB. Realistic estimate: ~3,331 rows × ~10KB avg = ~33MB at 10% of 33K events (upper bound ~165MB if content is consistently large). Well within Node.js default heap (1.7GB). For databases approaching 1M+ events where the reservoir alone could exceed 500MB, consider storing only `event_id` during sampling and batch-fetching full rows after selection.
- Deterministic iteration via `ORDER BY id` + seeded PRNG ensures full reproducibility given the same seed
- Concurrent safety: the source DB is opened via `withReader()`, which acquires a WAL snapshot at open time. If the collector is running concurrently, the sample sees a consistent point-in-time view of the events table — no partial inserts or mid-batch mutations.

**Why not `ORDER BY RANDOM() LIMIT k`:** SQLite's `ORDER BY RANDOM()` materializes the full result set, sorts it, and takes the top k — O(n log n) time and O(n) memory. Reservoir sampling is O(n) time and O(k) memory. At 33K events this doesn't matter, but the algorithm scales correctly if the database grows to 100K+ events.

**Why not stratified sampling:** Stratified sampling (proportional per topic) would guarantee minimum samples per topic but requires multi-topic events to be counted in each stratum, creating overrepresentation. Uniform random is simpler and produces representative samples at the current scale. If per-topic coverage is insufficient, the operator can generate a larger training set (e.g., `--sample-rate 0.2`).

---

## B. Training Database Schema

### Purpose

A standalone SQLite database containing sampled events with columns for human-assigned labels. Separate from the main intelligence database — no migrations, no shared schema. Uses its own `application_id` to prevent accidental cross-use with the main database.

### Schema

```sql
-- Sampled events awaiting classification
CREATE TABLE training_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT    UNIQUE NOT NULL,
  title           TEXT,
  content         TEXT,
  url             TEXT,
  source          TEXT,
  feed            TEXT,
  published_at    TEXT,
  fetched_at      TEXT,
  author          TEXT,
  score           INTEGER DEFAULT 0,
  comments        INTEGER DEFAULT 0,
  machine_topics  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(machine_topics)),
  machine_confidences TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(machine_confidences)),
  machine_scores  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(machine_scores)),
  human_topics    TEXT    CHECK (human_topics IS NULL OR json_valid(human_topics)),
  labeler         TEXT    DEFAULT 'unspecified',   -- who/what classified: model ID ("haiku"), "human", etc.
  notes           TEXT,                           -- optional labeler annotation (ambiguity notes, edge cases)
  reviewed_at     TEXT,                           -- ISO 8601 UTC timestamp
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Partial index: accelerates `next` queries (WHERE reviewed_at IS NULL ORDER BY id)
CREATE INDEX idx_training_unreviewed ON training_events(id) WHERE reviewed_at IS NULL;

-- Append-only label history for inter-rater reliability
CREATE TABLE training_labels (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT    NOT NULL REFERENCES training_events(event_id),
  human_topics TEXT    NOT NULL CHECK (json_valid(human_topics)),
  labeler      TEXT    NOT NULL,
  notes        TEXT,
  labeled_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_training_labels_event ON training_labels(event_id);

-- Metadata about the training set
CREATE TABLE training_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### Design Decisions

**Why standalone file, not main DB:**
- Training data is an artifact, not operational state — it has a different lifecycle (created, labeled, analyzed, archived)
- No risk of training labels polluting production queries
- Can be shared, versioned, or discarded without affecting the collector
- No need for migration tracking — the schema is created inline at generation time

**Schema migration strategy:**
- If a future `schema_version: 2` is needed, provide a migration script that alters the existing training DB in place (e.g., `ALTER TABLE ADD COLUMN`). A partially-labeled training set with 2,000+ reviewed events represents significant invested effort — "regenerate from scratch" is only acceptable for breaking changes that cannot be migrated.
- For non-breaking additions (new columns, new metadata keys), migrate in place. For breaking changes (renamed columns, restructured tables), export via `intel training-set export` and reimport via manual SQL or a custom script. A dedicated `intel training-set import` command is deferred to §K.8 — until it ships, breaking migrations require operator scripting against the exported JSONL.

**Why `machine_topics` stored as JSON:**
- Snapshot of the classifier's output at generation time — if the classifier changes later, the original classification is preserved for comparison
- Same format as `events.topics` for consistency

**Why separate `machine_topics` and `machine_confidences` columns:**
- `machine_topics` stores the topic ID array (same format as `events.topics`), preserving a simple comparison target against `human_topics`
- `machine_confidences` stores the corresponding per-topic confidence scores from the `event_topics` table, in the same array order as `machine_topics`
- After reservoir sampling selects events, a secondary query joins `event_topics` to populate `machine_confidences` for each sampled event
- Two columns keep topic comparison simple while preserving confidence data for threshold analysis

**Why `machine_scores` column:**
- Stores the raw classifier scores (BM25 score or CNB log-odds) corresponding to each entry in `machine_topics`, in the same array order
- Sigmoid-calibrated confidence compresses the score range — two topics with BM25 scores 4.1 and 9.0 may have similar confidences due to sigmoid saturation, but the raw scores reveal meaningful separation. Raw scores are more useful for threshold analysis (e.g., "how far above the 4.0 gate did this topic score?") and for calibrating the escalating threshold constants
- Populated from the same `event_topics` query as `machine_confidences`. If the classifier does not record raw scores (pre-BM25 events), entries are stored as `null` — same convention as `machine_confidences` for pre-migration data

**Why `human_topics` is nullable:**
- NULL = unreviewed (not yet labeled)
- Empty JSON array `[]` = reviewed and determined to match no topic
- This distinguishes "not yet looked at" from "intentionally no topic"

**Why `training_labels` append-only table:**
- Preserves all labelings for inter-rater reliability analysis — re-labeling an event appends a new row rather than losing the previous labeler's work
- `training_events.human_topics` is denormalized from the latest `training_labels` entry for fast queries; the `label` command inserts into `training_labels` and updates `training_events` in a single transaction
- Eliminates the fragile "export before re-labeling" workflow — all labeler history is preserved automatically
- Enables direct SQL queries for inter-rater agreement: `SELECT event_id, labeler, human_topics FROM training_labels WHERE event_id IN (...) ORDER BY event_id, labeler`

**Why `labeler` column:**
- Tracks who/what classified each event — model ID (`"haiku"`, `"sonnet"`), `"human"`, or a custom identifier
- Defaults to `"unspecified"` rather than `"manual"` — `"manual"` conflates "a human classified this" with "the caller forgot `--labeler`". Using `"unspecified"` makes omission visible so it can be corrected
- Enables inter-rater reliability analysis within a single training database instead of requiring separate databases per labeler
- Enables filtering by labeler for precision analysis (e.g., compare haiku vs sonnet label quality)

**Why `notes` column:**
- Labelers sometimes need to annotate edge cases: "ambiguous: could be `ai.agents` or `devex.methodology`", "title-only, low confidence", "cross-domain event, 4th topic intentionally omitted"
- The reasoning behind a label is often as valuable as the label itself for taxonomy refinement (feeding into spec 013 topic lifecycle reviews)

**Why `json_valid` CHECK constraints:**
- Consistent with the main database's JSON column validation pattern
- Cheap insurance against malformed data from buggy inserts or manual edits
- `human_topics` allows NULL (unreviewed) but validates JSON when set

**Why `application_id`:**
- The main intelligence database uses `PRAGMA application_id = 0x494E5445` ("INTE") to prevent accidentally opening the wrong file
- Training databases use `PRAGMA application_id = 0x54524E47` ("TRNG") for the same purpose — prevents passing the main DB path to a `training-set` subcommand or vice versa
- All `training-set` subcommands check `application_id` on open and produce `INVALID_QUERY` error with message `"Not a training database (expected application_id 0x54524E47). Did you pass the main intelligence database by mistake?"` if it doesn't match

**Metadata keys:**

| Key | Value | Purpose |
|-----|-------|---------|
| `schema_version` | `1` | Training DB schema version — tooling checks this on open and errors if unsupported |
| `created_at` | ISO 8601 timestamp | When the training set was generated |
| `source_db` | Absolute path | Which database was sampled |
| `sample_size` | Integer string | Number of events in the sample |
| `total_events` | Integer string | Total events at time of sampling |
| `sample_rate` | Decimal string | Configured sample rate |
| `seed` | Integer string or the string `"null"` | PRNG seed used (`"null"` = non-deterministic). Stored as the string literal `"null"`, not SQL NULL, since `training_meta.value` is `TEXT NOT NULL`. |
| `prng_algorithm` | `"mulberry32"` or `"null"` | PRNG algorithm used (`"null"` = `Math.random()`, non-deterministic). Same `TEXT NOT NULL` convention as `seed`. |
| `topics_yaml_sha256` | Hex string | SHA-256 of `topics.yaml` at generation time — ties training set to a taxonomy version |
| `classifier_config_sha256` | Hex string | SHA-256 of `topic-classifier.ts` at generation time — ties machine labels to a specific classifier version |
| `algorithm` | `reservoir_sampling_algorithm_r` | Sampling algorithm used |

**Pragmas on training DB:**
- `application_id = 0x54524E47` ("TRNG") — distinguishes training DBs from the main intelligence DB
- `journal_mode = WAL` — same write pattern as main DB
- `synchronous = NORMAL` — training data is reproducible; durability tradeoff is acceptable

---

## C. CLI Commands

### Purpose

Expose training set operations as `intel training-set` subcommands. These follow the existing CLI patterns (Commander.js, JSON envelope output, error handling via `handleError`).

### Commands

#### `intel training-set generate`

Create a training database from a random sample of events.

```
intel training-set generate                      # 10% sample, default output path
intel training-set generate --sample-rate 0.05   # 5% sample
intel training-set generate --output /path/to.db # explicit output path
intel training-set generate --seed 42            # reproducible sample
intel training-set generate --dry-run            # preview without creating DB
```

**Options:**
- `--sample-rate <rate>` — Fraction of events to sample, range (0.0, 1.0], default `0.1`
- `--output <path>` — Output database path, default `~/.local/share/intel/training-set-<timestamp>.db`. Timestamp format: `YYYY-MM-DDTHH-mm-ss` (colons replaced with hyphens for filesystem safety), e.g., `training-set-2026-03-23T14-30-00.db`.
- `--seed <number>` — Integer seed for the PRNG. Omit for non-deterministic sampling. Stored in `training_meta` for reproducibility. Validated via `Number(value)` — non-numeric values (e.g., `abc`) and non-integer values (e.g., `42.5`) produce `INVALID_QUERY` error with message `"Seed must be an integer in [0, 4294967295]."` (checked with `Number.isInteger()`). Mulberry32 operates on 32-bit unsigned integers, so valid range is [0, 2^32 - 1]; out-of-range values produce the same error.
- `--dry-run` — Show what the generation would produce without creating the training database. Reports total events, computed sample size, sample rate, and output path, then exits. Useful for verifying parameters before committing to a large training database.

The source database is resolved from the top-level `--db <path>` option (or the default `~/.local/share/intel/intel.db`).

**Output:**
```json
{
  "tool": "intel",
  "schema_version": "v2",
  "status": "ok",
  "data": {
    "path": "/Users/user/.local/share/intel/training-set-2026-03-23T14-30-00.db",
    "total_events": 33309,
    "sample_size": 3331,
    "sample_rate": 0.1,
    "algorithm": "reservoir_sampling_algorithm_r",
    "created_at": "2026-03-23T14:30:00.000Z"
  },
  "warnings": [],
  "next_cursor": null
}
```

**Validation:**
- `sample_rate` must be > 0 and <= 1.0; invalid values produce `INVALID_QUERY` error
- Source database must have > 0 events; empty DB produces `INVALID_QUERY` error with suggested action "Run `intel collect --once` first."
- Computed sample size (`sampleRate × totalEvents`) must be >= `MIN_SAMPLE_SIZE` (100); if too small, produce `INVALID_QUERY` error with message `"Sample too small: <totalEvents> events at rate <sampleRate> produces <computedSize> samples, minimum 100. Increase --sample-rate."`
- Output path must not already exist; if a file exists at the path, produce `INVALID_QUERY` error with suggested action "Delete the existing file or choose a different `--output` path." (The timestamp-based default path makes collisions unlikely, but `--output` allows arbitrary paths.)
- Output directory is created recursively if it doesn't exist

**Transaction safety:**
- All inserts into the training DB are wrapped in a single transaction (`BEGIN` / `COMMIT`). If any insert fails (e.g., disk full, I/O error), the transaction is rolled back and the partial training DB file is deleted via `fs.unlinkSync()`. This prevents a half-populated training DB from being mistaken for a complete one.
- The metadata insert and all `training_events` inserts share the same transaction — either the full training set is written or nothing is.

**Connection pattern:**
- Source DB opened via `withReader()` (read-only), wrapped in `sqliteBusyRetry()` consistent with all other read commands in `bin.ts`
- Training DB opened via `new Database()` directly (not `openWriter` — different schema, own `application_id = 0x54524E47`)
- Training DB closed after generation completes (or after rollback + unlink on failure)

#### `intel training-set next <training-db>`

Get the next unreviewed event(s) for classification.

```
intel training-set next /path/to/training.db                        # next 1 event (blind by default)
intel training-set next /path/to/training.db --limit 5              # next 5 events (blind by default)
intel training-set next /path/to/training.db --show-machine-labels  # include machine labels (for debugging/spot-checking)
```

**Options:**
- `--limit <n>` — Number of events to return, default `1`, max `50`
- `--show-machine-labels` — Include `machine_topics`, `machine_confidences`, and `machine_scores` in the output. By default these are omitted to prevent anchoring bias when feeding events to subagents for classification. Use this flag for debugging or comparing machine vs human labels after labeling.

**Output (default — blind):**
```json
{
  "tool": "intel",
  "schema_version": "v2",
  "status": "ok",
  "data": [
    {
      "event_id": "rss:techcrunch:abc123",
      "title": "NVIDIA Announces H200 GPU for AI Training",
      "content": "NVIDIA today announced the H200...",
      "url": "https://techcrunch.com/...",
      "source": "rss",
      "feed": "TechCrunch",
      "author": "Sarah Chen",
      "published_at": "2026-03-15T10:00:00Z",
      "fetched_at": "2026-03-15T10:30:00Z",
      "score": 142,
      "comments": 87
    }
  ],
  "warnings": [],
  "next_cursor": null
}
```

With `--show-machine-labels`, `machine_topics`, `machine_confidences`, and `machine_scores` are included in each event object.

**Behavior:**
- Returns events ordered by `id` (deterministic iteration)
- Only returns events where `reviewed_at IS NULL`
- Opens training DB in `readonly` mode
- Returns empty array when all events are reviewed

#### `intel training-set label <training-db> <event-id>`

Assign human-classified topics to a training event.

```
intel training-set label /path/to/training.db rss:techcrunch:abc123 \
  --topics "compute.gpu,ai.training" --labeler human
intel training-set label /path/to/training.db rss:techcrunch:abc123 \
  --topics "compute.gpu,ai.training" --labeler haiku --notes "title-only, high confidence"
```

**Options:**
- `--topics <csv>` — Required. Comma-separated topic IDs from the taxonomy
- `--labeler <id>` — Identifier for who/what produced this label (e.g., `haiku`, `sonnet`, `human`). Default: `"unspecified"`. Stored in `labeler` column. The SKILL.md workflow should always pass `--labeler haiku` (or `--labeler sonnet`) so the labeler model is recorded per event.
- `--notes <text>` — Optional. Free-text annotation for edge cases, ambiguity notes, or classification reasoning. Stored in `notes` column.

> **No `--confidence` flag**: Subagent confidence is uncalibrated (see §D), and there is no human labeling UI that would produce meaningful confidence values. The `confidence` schema column is omitted — if a future human review workflow needs calibrated confidence, add the column via schema migration (§B). Binary signal (assigned / not assigned) is the useful ground truth.

**Output:**
```json
{
  "tool": "intel",
  "schema_version": "v2",
  "status": "ok",
  "data": {
    "event_id": "rss:techcrunch:abc123",
    "human_topics": ["compute.gpu", "ai.training"],
    "labeler": "haiku",
    "reviewed_at": "2026-03-23T15:00:00.000Z"
  },
  "warnings": [],
  "next_cursor": null
}
```

**Behavior:**
- Inserts a row into `training_labels` (append-only history) and updates `training_events` with `human_topics`, `labeler`, `notes`, and `reviewed_at` — both operations in a single transaction
- `labeler` defaults to `"unspecified"` when `--labeler` is omitted
- Returns `INVALID_QUERY` error if event_id not found in training set
- Re-labeling an already-reviewed event appends a new `training_labels` row (preserving the previous label) and overwrites `training_events.human_topics`, `labeler`, `notes`, and `reviewed_at`. When overwriting a non-null `human_topics`, the response includes a warning: `"Overwriting existing label from <labeler> at <reviewed_at>. Previous label preserved in training_labels history."` Inter-rater reliability analysis queries `training_labels` directly — no export-before-re-label workflow needed.
- Topic IDs are validated against the current taxonomy (`topics.yaml`), resolved via the same path as `topic-classifier.ts` (relative to the tool's config directory, i.e., `tools/intelligence/config/topics.yaml`). Unknown topic IDs produce a warning in the response (not an error) — the taxonomy may evolve after a training set is generated
- More than 3 topics produces a warning: `"Typical labeling target is ≤3 topics; got <n>. Proceeding — cross-domain events may legitimately need 4-5."` — not an error, since the training data must capture genuinely cross-domain events to validate the 4+ threshold. More than 5 topics produces `INVALID_QUERY` error (matches classifier max output).
- Opens training DB in read-write mode via `new Database()` (not `openWriter`). The orchestrating agent issues label commands sequentially (one per subagent completion), so write contention does not occur in the standard workflow. However, an operator may have the training DB open in `sqlite3` for inspection during labeling. To handle this, the label command retries on `SQLITE_BUSY` up to 3 times with 100ms delay (lightweight — not the full `sqliteBusyRetry` wrapper). If still busy after retries, produce `INTERNAL_ERROR` with message `"Training database is locked. Close other connections and retry."`
- To assign no topics: `--topics ""` sets `human_topics` to `[]`

#### `intel training-set progress <training-db>`

Show labeling progress for a training set.

```
intel training-set progress /path/to/training.db
intel training-set progress /path/to/training.db --verbose   # include per-topic coverage
```

**Options:**
- `--verbose` — Include per-topic label counts in the output. Shows how many reviewed events have been assigned each topic, enabling the operator to determine which topics have sufficient samples (≥30) for precision estimates.

**Output (default):**
```json
{
  "tool": "intel",
  "schema_version": "v2",
  "status": "ok",
  "data": {
    "total": 3331,
    "reviewed": 1200,
    "remaining": 2131,
    "pct_complete": 0.360
  },
  "warnings": [],
  "next_cursor": null
}
```

**Output (with `--verbose`):**
```json
{
  "tool": "intel",
  "schema_version": "v2",
  "status": "ok",
  "data": {
    "total": 3331,
    "reviewed": 1200,
    "remaining": 2131,
    "pct_complete": 0.360,
    "per_topic": [
      { "topic": "ai.foundation-models", "count": 87, "sufficient": true },
      { "topic": "data.governance", "count": 12, "sufficient": false }
    ],
    "topics_sufficient": 48,
    "topics_insufficient": 18
  },
  "warnings": [],
  "next_cursor": null
}
```

The `per_topic` array is sorted by `count` descending. `sufficient` is `true` when `count >= 30` (the minimum for per-topic precision estimates). `topics_sufficient` and `topics_insufficient` are summary counts. Per-topic counts are derived from `human_topics` JSON arrays on reviewed events via SQLite's `json_each()` table-valued function — each topic in a multi-topic label increments its own counter.

**Behavior:**
- Opens training DB in `readonly` mode
- `pct_complete` is a ratio in [0.0, 1.0], rounded to 3 decimal places (consistent with spec 015's `unclassified_pct` and `multi_topic_pct` conventions)

#### `intel training-set list`

List training databases in the default directory.

```
intel training-set list                            # list all training DBs in default directory
intel training-set list --dir /path/to/dir         # list training DBs in a specific directory
```

**Options:**
- `--dir <path>` — Directory to scan, default `~/.local/share/intel/`

**Output:**
```json
{
  "tool": "intel",
  "schema_version": "v2",
  "status": "ok",
  "data": [
    {
      "path": "/Users/user/.local/share/intel/training-set-2026-03-23T14-30-00.db",
      "created_at": "2026-03-23T14:30:00.000Z",
      "sample_size": 3331,
      "total_events": 33309,
      "reviewed": 1200,
      "remaining": 2131,
      "pct_complete": 0.360
    }
  ],
  "warnings": [],
  "next_cursor": null
}
```

**Behavior:**
- Scans the directory for `*.db` files matching the `training-set-*.db` glob pattern
- Opens each candidate in `readonly` mode inside a `try/catch`, checks `PRAGMA application_id = 0x54524E47` — files that don't match, are locked, or are corrupt are silently skipped (not errors)
- Reads `training_meta` for `created_at`, `sample_size`, `total_events` and queries review progress
- Results sorted by `created_at` descending (most recent first)
- Returns empty array if no training databases are found

#### `intel training-set export <training-db>`

Export labeled training data for external analysis.

```
intel training-set export /path/to/training.db                              # JSON envelope (default)
intel training-set export /path/to/training.db --raw                        # raw JSONL to stdout (pipe-friendly)
intel training-set export /path/to/training.db --output /path/to/out.jsonl  # JSONL to file
intel training-set export /path/to/training.db --reviewed-only              # only labeled events
```

**Options:**
- `--output <path>` — Write JSONL to file instead of stdout. If the file exists, produce `INVALID_QUERY` error. When `--output` is specified, the response envelope reports the number of exported events and the output path.
- `--reviewed-only` — Only export events where `reviewed_at IS NOT NULL`. Default exports all events.
- `--raw` — Emit raw JSONL to stdout instead of the standard JSON envelope. For pipeline compatibility (e.g., `intel training-set export db.db --raw | jq .human_topics`). Mutually exclusive with `--output` (file writes are always raw JSONL; `--raw` controls stdout format only).

**Output format:** Each training event is represented as a JSONL record:

```json
{"event_id":"rss:techcrunch:abc123","title":"...","source":"rss","feed":"TechCrunch","machine_topics":["compute.gpu","ai.training"],"machine_confidences":[0.92,0.87],"human_topics":["compute.gpu","ai.training"],"labeler":"haiku","notes":null,"reviewed_at":"2026-03-23T15:00:00.000Z"}
```

**Default output (without `--raw`):**
```json
{
  "tool": "intel",
  "schema_version": "v2",
  "status": "ok",
  "data": {
    "exported": 1200,
    "events": [
      {"event_id":"rss:techcrunch:abc123","title":"...","machine_topics":["compute.gpu"],"human_topics":["compute.gpu"],"labeler":"haiku","reviewed_at":"2026-03-23T15:00:00.000Z"}
    ]
  },
  "warnings": [],
  "next_cursor": null
}
```

**Behavior:**
- Opens training DB in `readonly` mode
- Events ordered by `id` (deterministic)
- Default output uses the standard JSON envelope (consistent with all other CLI commands). The `data.events` array contains all exported events. For large training sets (~3K events), the envelope JSON can be several MB — if memory or streaming is a concern, use `--raw` or `--output`.
- With `--raw`, raw JSONL is emitted directly to stdout (one JSON object per line, no envelope). This is the pipeline-friendly mode for `jq`, `wc -l`, etc.
- With `--output`, JSONL is written to the file and the response envelope reports `{ exported: N, path: "..." }`.

This command is in-scope because ad-hoc analysis during the labeling process benefits from JSONL export to tools like `jq`, Jupyter, or spreadsheets.

#### `intel training-set evaluate <training-db>`

Compare machine-assigned topics against human labels to measure classifier precision and recall.

```
intel training-set evaluate /path/to/training.db
intel training-set evaluate /path/to/training.db --min-samples 20
intel training-set evaluate /path/to/training.db --labeler haiku    # evaluate only haiku-labeled events
intel training-set evaluate /path/to/training.db --labeler sonnet   # compare sonnet quality
```

**Options:**
- `--min-samples <n>` — Minimum labeled samples required per topic to report precision/recall. Default `30`. Topics below this threshold are listed separately as `insufficient_data`.
- `--labeler <id>` — Only evaluate events labeled by this labeler (exact match against `training_events.labeler`). Omit to evaluate all labeled events. Enables direct comparison of labeler quality: run `evaluate --labeler haiku` and `evaluate --labeler sonnet` to compare each model's classification against the machine labels.

**Output:**
```json
{
  "tool": "intel",
  "schema_version": "v2",
  "status": "ok",
  "data": {
    "evaluated_events": 1200,
    "overall": {
      "precision": 0.74,
      "recall": 0.81,
      "f1": 0.77,
      "hamming_loss": 0.023,
      "over_classification_rate": 0.058,
      "false_over_classification_rate": 0.042
    },
    "per_topic": [
      {
        "topic": "ai.foundation-models",
        "samples": 87,
        "precision": 0.89,
        "recall": 0.93,
        "f1": 0.91,
        "false_positives": 10,
        "false_negatives": 6
      }
    ],
    "insufficient_data": [
      { "topic": "data.governance", "samples": 12 }
    ],
    "confusion_pairs": [
      { "predicted": "ai.agents", "actual": "ai.foundation-models", "count": 8, "direction": "fp" },
      { "predicted": "compute.cloud-platforms", "actual": "devex.cicd", "count": 5, "direction": "fn" }
    ]
  },
  "warnings": [],
  "next_cursor": null
}
```

**Behavior:**
- Opens training DB in `readonly` mode
- Only evaluates events where `reviewed_at IS NOT NULL` (labeled events)
- **Per-topic precision**: Of events where the machine assigned topic T, what fraction did the human also assign T? `TP / (TP + FP)`
- **Per-topic recall**: Of events where the human assigned topic T, what fraction did the machine also assign T? `TP / (TP + FN)`
- **F1**: Harmonic mean of precision and recall per topic
- **Hamming loss**: Fraction of incorrect labels across all evaluated events × all topics in the taxonomy. For each event, count the symmetric difference between machine and human topic sets, then divide by `evaluated_events × total_topics` (66). A single number that captures both false positives and false negatives per topic slot — lower is better. Complements per-topic precision/recall with a single aggregate quality metric.
- **Over-classification rate**: Fraction of evaluated events where `len(machine_topics) >= 4` — the unconditional rate, directly comparable to spec 015's `multi_topic_pct` metric
- **False over-classification rate**: Fraction of evaluated events where `len(machine_topics) >= 4` and `len(human_topics) <= 3` — measures cases where the machine over-classifies relative to the human judgment. Validates whether the 4+ threshold is correctly identifying false positives vs. legitimately cross-domain events
- **Confusion pairs**: Computed as set differences per event, not as a pairwise co-occurrence matrix. For each evaluated event: `FP topics = machine_topics - human_topics` (topics the machine wrongly added) and `FN topics = human_topics - machine_topics` (topics the machine missed). Each FP/FN topic is counted independently — an event with `machine_topics: [A, B]` and `human_topics: [B, C]` contributes one FP for A and one FN for C. The `predicted`/`actual` fields in confusion pairs represent: for FP direction, `predicted` is the wrongly-added topic and `actual` is the highest-scoring human topic on that event (to indicate what the machine may have confused it with); for FN direction, `predicted` is the highest-scoring machine topic on that event and `actual` is the missed human topic. Results sorted by count descending, limited to top 20. Both directions are reported in the same array to surface systematic misclassifications (e.g., the machine wrongly adds `ai.agents` as FP, and misses `devex.cicd` as FN)
- Overall precision/recall/F1 are macro-averaged (mean of per-topic scores for topics with sufficient data)
- `per_topic` is sorted by F1 ascending (worst-performing topics first) for triage
- Returns `INVALID_QUERY` if fewer than 10 events are reviewed
- `machine_confidences` and `machine_scores` entries that are `null` (pre-confidence-tracking or pre-BM25 events) are excluded from confidence/score threshold analysis but the event's topic assignments are still evaluated for precision/recall. The `evaluate` command measures topic set correctness (machine vs human), not confidence calibration — null confidences do not affect precision/recall/F1/Hamming loss calculations.

#### `intel classifier train <training-db>`

Train a Complement Naive Bayes classifier model from labeled training data (Phase 2, §J).

```
intel classifier train /path/to/training.db
intel classifier train /path/to/training.db --output /path/to/model.json
intel classifier train /path/to/training.db --min-examples 30
intel classifier train /path/to/training.db --validation-split 0.3
```

**Options:**
- `--output <path>` — Output model JSON path. Default: `~/.local/share/intel/classifier-model-<timestamp>.json`. Must not already exist; collisions produce `INVALID_QUERY` error.
- `--min-examples <n>` — Minimum positive examples per topic to train a CNB classifier for that topic. Topics below this threshold fall back to BM25. Default `20` (matches `CNB_MIN_EXAMPLES` in §G).
- `--validation-split <ratio>` — Fraction of labeled data held out for validation. Default `0.2` (matches `CNB_VALIDATION_SPLIT` in §G). Range (0.0, 0.5].

**Output:**
```json
{
  "tool": "intel",
  "schema_version": "v2",
  "status": "ok",
  "data": {
    "model_path": "/Users/user/.local/share/intel/classifier-model-2026-03-23T14-30-00.json",
    "vocabulary_size": 15234,
    "per_topic": [
      { "topic": "ai.foundation-models", "method": "cnb", "examples": 87, "val_precision": 0.91, "val_recall": 0.88, "val_f1": 0.89 },
      { "topic": "data.governance", "method": "bm25_fallback", "examples": 12, "reason": "below min_examples threshold" }
    ],
    "overall_validation": {
      "precision": 0.84,
      "recall": 0.79,
      "f1": 0.81
    }
  },
  "warnings": [],
  "next_cursor": null
}
```

**Validation:**
- Training DB must contain ≥500 labeled events (`CNB_MIN_TRAINING_EVENTS`); fewer produces `INVALID_QUERY` with message `"Insufficient training data: <n> labeled events, minimum 500 required."`
- Output path must not already exist
- Training DB `application_id` must be `0x54524E47`

**Behavior:**
- Opens training DB in `readonly` mode — does not modify the training database
- Pipeline: load labeled events → split train/validation → build vocabulary (capped at `CNB_MAX_VOCABULARY`) → compute TF-IDF vectors → train 66 binary CNB classifiers → fit Platt calibration on validation set → serialize model JSON
- Model file is written atomically (write to temp file, then rename) to prevent partial model files
- The trained model is **not** automatically loaded by the collector — the operator must configure the model path (see **Model loading** below). This prevents silent classifier changes during collection runs.
- Topics with fewer than `--min-examples` positive examples are listed in the output with `method: "bm25_fallback"` and are not included in the model's classifiers

**Model loading:**
- The collector reads the model path from the `classifier_model` key in the config file (e.g., `~/.config/intel/config.yaml`). When `classifier_model` is set, the collector loads the model JSON at startup and uses CNB for topics with trained classifiers, falling back to BM25 for the rest. When `classifier_model` is unset (the default), the collector uses BM25-only (Phase 1 behavior).
- The `intel collect --once` and `intel collect` commands accept `--classifier-model <path>` as an override, taking precedence over the config file value. This enables A/B comparison: run a collection pass with and without the model to compare topic assignments.
- On startup, the collector validates: model file exists, `version` field is supported, and model is not older than `MODEL_STALENESS_DAYS` (90 days). A stale model produces a warning (not an error) in the collection output. A missing or corrupt model file produces `INVALID_QUERY` with message `"Classifier model not found or invalid at <path>. Run 'intel classifier train' to produce a model, or remove 'classifier_model' from config to use BM25-only."`

> **Implementation ordering note**: The `intel classifier train` command ships alongside §A-F, but it cannot produce a model until sufficient labeled data exists (≥500 events). The command is immediately testable with synthetic data and will become operational as the labeling workflow (§D) populates the training database.

### Shared Behavior

- All `training-set` and `classifier` subcommands inherit the top-level `--format` option and support text output via the existing `output()` function.
- All subcommands that open a training DB check `PRAGMA application_id` and `training_meta.schema_version` on open. Mismatched `application_id` produces `INVALID_QUERY` error: `"Not a training database (expected application_id 0x54524E47)."` Unsupported `schema_version` produces `INVALID_QUERY` error: `"Training DB schema version <n> is not supported by this tool version (supports: 1)."`

---

## D. Agent Skill Workflow

### Purpose

Extend the existing `skills/intel/SKILL.md` with a training data generation workflow. This instructs the orchestrating agent to generate a training set and then spawn subagents to classify each event independently.

### Workflow Design

The agent skill section describes a three-phase process:

**Phase 1: Generate**
```bash
intel training-set generate --sample-rate 0.1
```

The agent captures the output path for use in Phase 2.

**Phase 2: Load taxonomy**
```bash
intel topics
```

The orchestrating agent runs `intel topics` once to capture the full topic taxonomy (66 topics across 10 categories). This output is included verbatim in each subagent's prompt — it is not re-fetched per batch.

**Phase 3: Classify (batched subagent loop)**

The orchestrating agent iterates in batches of 25 events:

1. Call `intel training-set next <db> --limit 25` to get a batch of unreviewed events (machine labels omitted by default to prevent anchoring)
2. Spawn up to 25 subagents in parallel (via Task tool), each with one event's `title`, `content`, `url`, `source`, `feed`, and the topic taxonomy from Phase 2
3. Each subagent reads its event independently, assigns 1-5 topics (targeting ≤3), and returns the classification
4. As subagents complete, the orchestrating agent calls `intel training-set label <db> <event-id> --topics <csv> --labeler haiku` for each result
5. Call `intel training-set progress <db>` every 5 batches (~125 events) to check completion and log progress
6. Repeat until `remaining` reaches 0 or the operator's requested event count is reached

At ~3,331 events with batches of 25, this requires ~133 iterations. Each batch runs subagents concurrently, keeping wall-clock time practical. Independence is preserved because each subagent receives only its own event — no shared context between events in a batch. The batch size of 25 balances orchestrator round-trip overhead (~27 tool invocations per batch: 1 `next` + 25 Task spawns + 25 sequential `label` calls, with the `progress` check amortized) against practical Task tool concurrency limits. Larger batches reduce iterations but increase the blast radius of a mid-batch failure; smaller batches add orchestrator overhead without improving classification quality.

**Cost estimate**: Each subagent receives the taxonomy (~2K tokens) plus one event (~500 tokens avg) and returns a short classification (~100 tokens). At ~3,331 events, full classification ≈ 8.3M input tokens + 0.3M output tokens. Using `haiku` model subagents (Task tool `model: "haiku"`) is recommended — topic classification from a fixed taxonomy is well within haiku's capabilities, and the 10-20x cost reduction vs. sonnet makes full-set labeling practical. `sonnet` subagents can be used for a validation subset if higher accuracy is needed.

**Partial labeling**: Full classification of ~3,331 events is a significant resource commitment. The workflow supports interruption and resumption — since `next` returns only unreviewed events by default (with machine labels omitted), the operator can stop at any point and resume later. The SKILL.md workflow should accept an optional event count (e.g., "classify 500 events") as an orchestrator-level limit — this is a workflow instruction, not a CLI flag. The orchestrating agent tracks how many events it has labeled and stops when the count is reached. Partial training sets are still useful for precision estimates on topics with sufficient samples (≥30).

### Subagent Classification Protocol

Each subagent receives:
- The event's `title`, `content`, `url`, `source`, and `feed` (from `next` output — machine labels omitted by default). The `score` and `comments` fields are **not** passed to subagents — engagement metrics could anchor classification toward "popular = relevant" rather than content-based topic matching.
- The full topic taxonomy from `intel topics` (captured once in Phase 2)
- Instructions to assign 1-5 topics, with ≤3 as the typical target

**Content size**: RSS feed content varies — some events have only a title, others include full article text. The classifier itself caps input at 3,000 characters, but subagents receive longer text since LLMs can handle it. The SKILL.md workflow should recommend truncating `content` before passing to subagents (suggested default: ~4,000 characters) to avoid wasted tokens on boilerplate footers — the exact limit is a SKILL.md concern, not a spec constant, and can be adjusted based on model context windows and classification quality. **Title-only events** (where `content` is null or empty) are still classifiable — the subagent classifies from the title, source, and feed alone. These events should not be skipped; title-only classification is valid but the subagent should note lower certainty in ambiguous cases by returning fewer topics rather than guessing.

The subagent must:
1. Read the event content independently (not anchor on `machine_topics`)
2. Match the event's primary subject matter against the taxonomy
3. Assign **1-5 topics**, targeting ≤3 for most events. Assigning 4-5 is permitted when the event is genuinely cross-domain — the training data must be able to validate whether the 4+ threshold is real over-classification or legitimate multi-topic events (Problem statement #2). The subagent should prefer fewer topics when uncertain, but not artificially cap at 3 when more are clearly warranted.
4. Return assigned topics. Subagent self-reported confidence is not calibrated, so the label command does not accept a confidence parameter. Subagents should omit topics they would rate below 0.5 rather than assigning them with low confidence.
5. If no topic matches, return empty topics (the label command stores `[]`)

### Why Subagents (not batch classification)

- **Independence**: Each classification is independent — no anchoring on previous events
- **Context isolation**: Subagent context is limited to the single event + taxonomy, preventing drift
- **Parallelism**: Multiple subagents can run concurrently (the training DB handles concurrent reads; label writes are serialized by SQLite's WAL)
- **Auditability**: Each classification is a separate, traceable operation

### Guardrails

- Do not modify the source intelligence database
- Do not skip events — even uninteresting events must be classified (or marked as no-topic) for unbiased precision measurement
- Target ≤3 topics per event as the typical case, but permit up to 5 when the event is genuinely cross-domain — artificially capping at 3 would prevent validation of the 4+ over-classification threshold
- Do not pass `--show-machine-labels` when fetching events for subagent classification — the default blind output ensures machine labels never appear in the subagent prompt
- Batch size of 25 is the default — each subagent in a batch still receives only one event, preserving independence
- **Subagent failure handling**: If a subagent times out, returns a malformed response, or fails to classify, the orchestrating agent skips that event and continues with the batch. The skipped event remains unreviewed (`reviewed_at IS NULL`) and will be picked up by a future `next` call. The orchestrator should log a warning but not halt the workflow — transient failures are expected at scale (~3K events).

---

## E. Implementation

### File Structure

```
tools/intelligence/src/
├── queries/
│   └── training.ts          — NEW: generateTrainingSet, updateTrainingLabel, trainingProgress, getNextUnreviewed, exportTrainingSet, listTrainingSets, evaluateTrainingSet
├── collector/
│   ├── bm25.ts              — NEW (Phase 1): BM25 scoring engine + tokenizer
│   ├── tfidf.ts             — NEW (Phase 2): TF-IDF vectorizer
│   ├── classifier.ts        — NEW (Phase 2): L2-regularized logistic regression (66 binary classifiers, per-topic thresholds)
│   └── topic-classifier.ts  — MODIFY (Phase 1): rewrite matchesTopic() and classify() to use BM25; (Phase 2): add classifier model loading via classifier_model config key
└── bin.ts                   — MODIFY: add training-set + classifier command groups

config/
└── topics.yaml              — MODIFY (Phase 1): add negative_keywords per topic

skills/intel/
└── SKILL.md                 — MODIFY: add Training Data Generation workflow section

tools/intelligence/tests/
├── training.test.ts         — NEW: test suite for training module
└── topics.test.ts           — MODIFY (Phase 1): update tests for BM25 scoring
```

### Internal Functions

| Function | File | Description |
|----------|------|-------------|
| `generateTrainingSet(db, opts)` | `queries/training.ts` | `db` is the source reader (opened by the caller via `withReader`). When `opts.dryRun` is true, computes and returns metadata (total events, sample size, output path) without creating the training DB. Otherwise creates the training DB at `opts.outputPath` internally, populates it, and closes it before returning. Returns `IntelResponse<TrainingSetResult>` |
| `updateTrainingLabel(db, eventId, label)` | `queries/training.ts` | Set human_topics + labeler + notes + reviewed_at. Returns `IntelResponse<TrainingLabelResult>` |
| `trainingProgress(db, verbose?)` | `queries/training.ts` | Count total/reviewed/remaining. When `verbose=true`, includes per-topic label counts with sufficiency flags. Returns `IntelResponse<TrainingProgressResult>` |
| `getNextUnreviewed(db, limit, showMachineLabels?)` | `queries/training.ts` | SELECT where reviewed_at IS NULL ORDER BY id LIMIT ?. Machine labels omitted by default; included when `showMachineLabels=true`. Returns `IntelResponse<UnreviewedEvent[]>` |
| `exportTrainingSet(db, opts)` | `queries/training.ts` | Export training events. `opts.reviewedOnly` filters to labeled events. `opts.raw` controls stdout format (raw JSONL vs JSON envelope). `opts.outputPath` writes JSONL to file. Returns `IntelResponse<ExportResult>` or raw JSONL string. |
| `listTrainingSets(dir)` | `queries/training.ts` | Scan directory for `training-set-*.db` files, validate `application_id`, return metadata + progress for each. Returns `IntelResponse<TrainingSetSummary[]>` |
| `evaluateTrainingSet(db, opts)` | `queries/training.ts` | Compare `machine_topics` vs `human_topics` on reviewed events. Computes per-topic precision/recall/F1, Hamming loss, overall macro-averaged scores, over-classification rate, and confusion pairs. When `opts.labeler` is set, filters to events labeled by that labeler. Returns `IntelResponse<EvaluationResult>` |
| `tokenize(text)` | `collector/bm25.ts` | Word-boundary tokenization with stopword removal. Returns lowercase token array. |
| `computeIDF(topicDefs)` | `collector/bm25.ts` | Bootstrap IDF from keyword frequency across all 66 topics. Returns `Map<string, number>`. Replaced by corpus IDF after Phase 2 training. |
| `scoreBM25(tokens, keywords, idf, opts)` | `collector/bm25.ts` | Compute BM25 score for a document against a topic's keyword set. Applies TF saturation (k1), length normalization (b), and IDF weighting. |
| `matchesTopicBM25(event, topicDef, idf, opts)` | `collector/bm25.ts` | Full BM25 pipeline for one event × one topic: tokenize title/content, score with title boost, apply negative keyword suppression, check threshold gate, compute sigmoid confidence. Returns `BM25Result`. |
| `buildVocabulary(documents, maxSize)` | `collector/tfidf.ts` | Build vocabulary from tokenized documents, capped at `maxSize` terms by document frequency. Returns `Map<string, number>` (term → index). |
| `vectorize(tokens, vocabulary, idf)` | `collector/tfidf.ts` | Convert token array to sparse TF-IDF vector (sub-linear TF, L2 normalized). Returns `Map<number, number>` (index → weight). |
| `trainLogistic(vectors, labels, topicId)` | `collector/classifier.ts` | Train an L2-regularized logistic regression binary classifier for one topic. Returns weight vector and bias. |
| `findOptimalThreshold(scores, labels)` | `collector/classifier.ts` | Find optimal classification threshold via F1 maximization on validation set. Returns threshold and metrics. |
| `trainClassifier(trainingDb, opts)` | `collector/classifier.ts` | Full training pipeline: load data → build vocabulary → train 66 logistic classifiers → find per-topic thresholds → serialize model. Returns `ClassifierTrainResult`. |

### Types

```typescript
export interface TrainingSetOpts {
  sampleRate: number;      // (0.0, 1.0], default 0.1
  outputPath?: string;     // override output DB path
  sourceDbPath: string;    // for metadata recording
  seed?: number;           // PRNG seed for reproducibility (omit for non-deterministic)
  dryRun?: boolean;        // preview metadata without creating DB
}

export interface TrainingSetResult {
  path: string;
  total_events: number;
  sample_size: number;
  sample_rate: number;
  algorithm: string;
  created_at: string;
}

export interface TrainingLabel {
  human_topics: string[];  // topic IDs from taxonomy
  labeler?: string;        // who/what classified (e.g., "haiku", "sonnet", "human"); defaults to "unspecified"
  notes?: string;          // optional annotation for edge cases
}

export interface TrainingLabelResult {
  event_id: string;
  human_topics: string[];
  labeler: string;          // defaults to "unspecified" when --labeler omitted
  reviewed_at: string;
}

export interface TrainingProgressResult {
  total: number;
  reviewed: number;
  remaining: number;
  pct_complete: number;
  per_topic?: TopicCoverage[];        // present when verbose=true
  topics_sufficient?: number;         // present when verbose=true
  topics_insufficient?: number;       // present when verbose=true
}

export interface TopicCoverage {
  topic: string;
  count: number;
  sufficient: boolean;                // count >= 30
}

export interface TrainingSetSummary {
  path: string;
  created_at: string;
  sample_size: number;
  total_events: number;
  reviewed: number;
  remaining: number;
  pct_complete: number;
}

export interface UnreviewedEvent {
  event_id: string;
  title: string | null;
  content: string | null;
  url: string | null;
  source: string;
  feed: string | null;
  author: string | null;
  machine_topics?: string[];            // omitted by default; included when showMachineLabels=true
  machine_confidences?: (number | null)[];  // omitted by default; null entries = pre-confidence-tracking events
  machine_scores?: (number | null)[];       // omitted by default; null entries = pre-BM25 events (raw BM25/CNB scores)
  published_at: string | null;
  fetched_at: string;
  score: number;
  comments: number;
}

export interface EvaluationOpts {
  minSamples: number;       // minimum labeled samples per topic to report metrics, default 30
  labeler?: string;         // filter to events labeled by this labeler (exact match); omit for all labeled events
}

export interface EvaluationResult {
  evaluated_events: number;
  overall: {
    precision: number;      // macro-averaged across topics with sufficient data
    recall: number;
    f1: number;
    hamming_loss: number;  // symmetric_diff(machine, human) / (evaluated_events × total_topics)
    over_classification_rate: number;      // fraction where machine assigns 4+ topics (unconditional)
    false_over_classification_rate: number; // fraction where machine 4+ topics AND human ≤3
  };
  per_topic: TopicEvaluation[];
  insufficient_data: { topic: string; samples: number }[];
  confusion_pairs: { predicted: string; actual: string; count: number; direction: 'fp' | 'fn' }[];
}

export interface TopicEvaluation {
  topic: string;
  samples: number;
  precision: number;
  recall: number;
  f1: number;
  false_positives: number;
  false_negatives: number;
}

// --- Classifier types (§J) ---

export interface BM25Opts {
  k1: number;              // TF saturation parameter (default 1.2)
  b: number;               // length normalization parameter (default 0.75)
  titleBoost: number;      // title keyword multiplier (default 3.0)
}

export interface BM25Result {
  score: number;           // raw BM25 score
  confidence: number;      // sigmoid-calibrated confidence in (0, 1)
  matched: boolean;        // score >= threshold for this topic's rank position
  suppressed: boolean;     // true if negative keyword matched
}

export interface EscalatingThresholds {
  thresholds: number[];    // [4.0, 5.5, 7.0, 8.5, 10.0] — 1st through 5th topic
}

export interface SigmoidParams {
  a: number;               // Platt scaling parameter A
  b: number;               // Platt scaling parameter B
}

export interface ClassifierModel {
  version: number;
  created_at: string;
  vocabulary: Record<string, number>;   // term → index
  idf: number[];                        // IDF weights per vocabulary term
  classifiers: Record<string, {         // topic_id → classifier params
    log_theta: Record<number, number>;  // sparse: term_index → log(complement_theta)
    platt_a: number;                    // Platt scaling sigmoid parameter A
    platt_b: number;                    // Platt scaling sigmoid parameter B
    prior: number;                      // log prior P(class)
  }>;
  training_meta: {
    training_db: string;
    num_examples: number;
    num_positive_per_topic: Record<string, number>;
    training_date: string;
  };
}

export interface ClassifierTrainResult {
  model_path: string;
  vocabulary_size: number;
  per_topic: Array<{
    topic: string;
    method: 'cnb' | 'bm25_fallback';
    examples: number;
    val_precision?: number;
    val_recall?: number;
    val_f1?: number;
    reason?: string;        // present when method is 'bm25_fallback'
  }>;
  overall_validation: {
    precision: number;
    recall: number;
    f1: number;
  };
}

export interface TopicDefExtended {
  id: string;
  keywords: string[];
  negative_keywords?: string[];
  context_required?: boolean;    // true = all keywords for this topic need context_terms co-occurrence
  context_terms?: string[];      // terms that must co-occur when context_required is true
  priority?: number;             // 1-100, default 50
}
```

### Dependencies

No new runtime dependencies. BM25 scoring, TF-IDF vectorization, Complement Naive Bayes, and Platt scaling are all implemented in pure TypeScript. Uses `better-sqlite3` (already a dependency) for the training database and model training data access.

---

## F. Tests

### Test Cases

**File**: `tools/intelligence/tests/training.test.ts`

**`generateTrainingSet` (9 tests)**:
1. Creates training database with correct sample size (100 seeded events × 0.1 = 10 samples)
2. Stores metadata correctly in `training_meta` (algorithm, sample_rate, total_events, source_db, classifier_config_sha256)
3. Errors on empty database (0 events → `INVALID_QUERY` status)
4. Errors when output path already exists (`INVALID_QUERY` status)
5. All sampled events have `human_topics IS NULL` initially
6. `machine_topics` contains valid JSON arrays from source events
7. Sample size respects `--sample-rate` (0.2 rate on 100 events → 20 samples)
8. Training DB has `application_id = 0x54524E47` ("TRNG")
9. Rolls back and deletes partial file on insert failure (simulate by making output dir read-only mid-write or using a full-disk mock)

**`updateTrainingLabel` (7 tests)**:
10. Sets `human_topics`, `labeler`, `notes`, and `reviewed_at` on a valid event and inserts a `training_labels` row
11. Returns `INVALID_QUERY` error for non-existent event_id
12. Empty topics list stores `[]` (valid JSON, distinct from NULL)
13. `labeler` defaults to `"unspecified"` when omitted; `notes` defaults to NULL when omitted
14. Re-labeling updates `training_events` and appends a new `training_labels` row (previous label preserved)
15. Re-labeling a previously reviewed event produces overwrite warning in response
16. `training_labels` table contains all historical labels for an event after multiple re-labelings

**`trainingProgress` (3 tests)**:
17. Reports correct counts before and after labeling
18. `pct_complete` is 0.0 with no reviews, approaches 1.0 as reviews complete
19. With `verbose=true`, returns per-topic counts with correct `sufficient` flags (≥30 threshold)

**`getNextUnreviewed` (4 tests)**:
20. Returns unreviewed events ordered by `id` with machine labels omitted by default
21. Returns empty array when all events are reviewed
22. Respects `limit` parameter
23. Includes `machine_topics`, `machine_confidences`, and `machine_scores` when `showMachineLabels=true`

**`listTrainingSets` (3 tests)**:
24. Discovers training DBs in directory and returns metadata + progress
25. Skips non-training DB files (wrong `application_id`) without error
26. Returns empty array when directory contains no training DBs

**`exportTrainingSet` (4 tests)**:
27. Default export returns JSON envelope with `data.events` array containing all events
28. `--raw` exports raw JSONL (one JSON object per line, no envelope)
29. `--reviewed-only` filters to labeled events only
30. Errors when output path already exists

**`evaluateTrainingSet` (8 tests)**:
31. Computes correct per-topic precision and recall from known machine vs human labels
32. Reports over-classification rate (machine 4+ topics) and false over-classification rate (machine 4+ topics, human ≤3 topics)
33. Topics below `minSamples` threshold appear in `insufficient_data`, not `per_topic`
34. Confusion pairs correctly identify systematic misclassifications as set differences — event with `machine: [A, B]` and `human: [B, C]` produces FP for A and FN for C
35. Returns `INVALID_QUERY` when fewer than 10 events are reviewed
36. Hamming loss is correctly computed as `sum(symmetric_diff) / (evaluated_events × total_topics)` for known input
37. `--labeler` filter restricts evaluation to events labeled by the specified labeler
38. Events with null `machine_confidences` / `machine_scores` are still included in precision/recall evaluation (only confidence/score analysis excludes them)

**`application_id validation` (1 test)**:
39. Opening the main intelligence DB as a training DB produces `INVALID_QUERY` error

**`generate --dry-run` (2 tests)**:
40. Dry run returns total events, computed sample size, sample rate, and output path without creating any file
41. Dry run still validates parameters (e.g., invalid sample rate produces `INVALID_QUERY`)

**`reservoir sampling uniformity` (1 test, separate `describe.skip` group)**:
42. Statistical test: run sampling 1,000 times on a 100-element dataset at 10% rate. Collect each element's selection frequency and apply a **chi-squared goodness-of-fit test** against the expected uniform distribution (each element selected with p = 0.10). Use α = 0.001 (chi-squared critical value for 99 df ≈ 148.23). This tests the aggregate distribution in a single assertion, avoiding the ~10% false positive rate inherent in 100 independent per-element binomial tests. Tag with extended timeout (e.g., `{ timeout: 60_000 }`). This test validates a mathematical property of Algorithm R, not application logic — it should be in a `describe.skip` group (or tagged `@slow`) so it doesn't run in the default `vitest run` and can be invoked explicitly when the sampling implementation changes.

**`reservoir sampling determinism` (1 test)**:
43. Generate two training sets from the same 100-event database with the same seed. Assert the `event_id` arrays are identical (ordered array equality, not just set equality). This validates the full reproducibility guarantee: same seed + same PRNG + same data = same sample in the same order.

**File**: `tools/intelligence/tests/topics.test.ts` (additions for §J)

**BM25 tokenizer (4 tests)**:
44. Word-boundary tokenization splits on non-alphanumeric characters and lowercases tokens
45. Stopwords ("the", "a", "is", "and", etc.) are removed from token output
46. "chip" does not appear as a token when input is "archipelago" (no substring match)
47. "react" does not appear as a token when input is "reactive" (word boundary respected)

**BM25 scoring (6 tests)**:
48. Title keywords receive `BM25_TITLE_BOOST` (3.0×) multiplier over content keywords
49. Repeated keyword in content produces diminishing returns (TF saturation with k1=1.2)
50. Long documents score lower than short documents with the same keyword density (length normalization with b=0.75)
51. Keywords appearing in fewer topics produce higher scores than keywords in many topics (IDF weighting)
52. A single incidental keyword match scores below `BM25_THRESHOLDS[0]` (4.0) and is not classified
53. Escalating thresholds enforce: 2nd topic requires ≥5.5, 3rd ≥7.0, 4th ≥8.5, 5th ≥10.0

**Negative keywords (3 tests)**:
54. A topic with matching negative keyword is suppressed regardless of positive BM25 score
55. Negative keyword matching is case-insensitive
56. Topics without `negative_keywords` defined are unaffected (no-op)

**BM25 confidence (2 tests)**:
57. Sigmoid-calibrated confidence output is in the range (0, 1) for all finite BM25 scores
58. Higher BM25 scores produce strictly higher confidence values (monotonicity)

**BM25 context/priority (2 tests)**:
59. A `context_required` keyword only contributes to the topic score when at least one `context_term` is also present as a BM25 token match
60. Topic `priority` field multiplies the final BM25 score: priority 100 doubles score vs. priority 50 (neutral)

**Regex deprecation (1 test)**:
61. `TopicDefExtended` type does not include a `regex` field; loading `topics.yaml` produces topic definitions with only `keywords`, `negative_keywords`, `context_required`, `context_terms`, and `priority`

**BM25 bootstrap IDF (2 tests)**:
62. Keywords appearing in fewer topics produce higher IDF values than keywords appearing in many topics
63. `computeIDF` is deterministic: same topic definitions produce identical IDF maps

**CNB training pipeline (5 tests)**:
64. `trainClassifier` produces a valid `ClassifierModel` JSON with vocabulary, IDF, and per-topic classifiers
65. Topics with ≥`min_examples` positive examples use CNB; topics below threshold report `bm25_fallback`
66. Vocabulary size is capped at `CNB_MAX_VOCABULARY` (20,000) — excess terms sorted by document frequency are dropped
67. Platt calibration produces outputs in (0, 1) for all raw CNB scores in the validation set
68. Model serialization round-trips: `JSON.parse(JSON.stringify(model))` produces an identical model object

**CNB prediction (3 tests)**:
69. `predictCNB` produces scores for all 66 topics given a document vector
70. Platt-calibrated output from CNB is in range [0.01, 0.99] for realistic input vectors (not degenerate)
71. Topics below `min_examples` at training time fall back to BM25 scoring at prediction time

**`intel classifier train` CLI (4 tests)**:
72. Returns `INVALID_QUERY` when training DB has fewer than 500 labeled events
73. Produces a valid model JSON file when given ≥500 labeled events (synthetic fixture)
74. `--min-examples` flag is respected: setting to 50 changes which topics use CNB vs BM25 fallback
75. Output path collision produces `INVALID_QUERY` error

### Test Fixtures

- Seeded database with 100 events via `openWriter` + direct inserts
- Temp directory cleanup in `afterEach`
- Follows `tests/journal.test.ts` pattern (mkdtempSync, rmSync)

---

## G. Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_SAMPLE_RATE` | `0.1` | Default fraction of events to sample |
| `MIN_SAMPLE_SIZE` | `100` | Minimum resulting sample size — if `sampleRate × totalEvents < 100`, produce `INVALID_QUERY` with suggested action to increase `--sample-rate`. Guards against accidentally tiny samples regardless of database size. |
| `MAX_SAMPLE_RATE` | `1.0` | Maximum sample rate (full dataset) |
| `MAX_NEXT_LIMIT` | `50` | Maximum events returned by `next` command |
| `MIN_TOPIC_SAMPLES` | `30` | Minimum labeled samples per topic for precision estimates (used by `progress --verbose`) |
| `TRAINING_APP_ID` | `0x54524E47` | SQLite `application_id` for training databases ("TRNG") |
| `SAMPLING_ALGORITHM` | `"reservoir_sampling_algorithm_r"` | Algorithm identifier stored in `training_meta` and `generate` output |
| `BM25_K1` | `1.2` | TF saturation parameter — diminishing returns for repeated terms. Standard BM25 default. |
| `BM25_B` | `0.75` | Document length normalization — penalizes long boilerplate-heavy content. Standard BM25 default. |
| `BM25_TITLE_BOOST` | `2.0` | Title keyword multiplier — keywords in the title carry 2× the weight of content keywords |
| `BM25_THRESHOLDS` | `[10.0, 14.0, 18.0, 22.0, 26.0]` | Escalating minimum BM25 score for 1st through 5th topic assignment. Directly targets over-classification. |
| `BM25_SIGMOID_MIDPOINT` | `14.0` | Sigmoid midpoint for BM25→confidence calibration: `1 / (1 + exp(-(score - midpoint) / temperature))` |
| `BM25_SIGMOID_TEMPERATURE` | `4.0` | Sigmoid temperature for BM25→confidence calibration. Lower values produce a sharper transition. |
| `CLASSIFIER_MIN_EXAMPLES` | `20` | Minimum positive training examples per topic to train a logistic classifier. Topics below this fall back to BM25. |
| `CLASSIFIER_MIN_TRAINING_EVENTS` | `500` | Minimum total labeled events required to run `intel classifier train`. Guards against training on insufficient data. |
| `CLASSIFIER_MAX_VOCABULARY` | `20000` | Maximum vocabulary size for TF-IDF vectorization. Terms beyond this cap are dropped by document frequency. |
| `CLASSIFIER_VALIDATION_SPLIT` | `0.2` | Fraction of labeled data held out for validation during `intel classifier train`. Range (0.0, 0.5]. |
| `CLASSIFIER_MIN_MODEL_VERSION` | `3` | Minimum model version required. Models below this version are rejected at load time. Version 3+ includes `bm25_val_includes_title` and per-topic `score_threshold`. |
| `MODEL_STALENESS_DAYS` | `90` | Warn if the classifier model file is older than this many days. Aligns with quarterly retraining cadence. |

---

## H. Risks

| Risk | Mitigation |
|------|-----------|
| Memory for large databases | At 10% of 100K events = 10K rows × ~10KB avg (metadata + content) = ~100MB. Well within Node.js default heap (1.7GB). For 1M+ events where the reservoir could approach 500MB+, consider storing only `event_id` during sampling and batch-fetching full rows after selection. |
| Training DB not managed by migrations | Intentional — training DBs are standalone artifacts with their own `schema_version`. Non-breaking changes migrate in place (`ALTER TABLE`); breaking changes use export → reimport (§C `export`). See §B schema migration strategy. |
| Subagent classification quality | LLM classification is a proxy for human labeling — but at scale it provides a stronger signal than no labeled data. Quality can be validated by sampling a subset for human review. Subagent confidence scores are treated as binary (assigned / not assigned) since LLM self-reported confidence is uncalibrated — do not use confidence values from subagents for threshold decisions. |
| Concurrent label writes | SQLite WAL handles this safely. Sequential processing is the default; concurrent subagents work but writes are serialized by SQLite. |
| Sampling bias from `ORDER BY id` | Deterministic iteration order for reproducibility. Since `id` is auto-increment and events are inserted chronologically, this produces a temporally representative sample. |
| Cross-source duplicates in sample | The same story may appear from multiple sources (e.g., HN + RSS) with different `event_id` values. Reservoir sampling operates on `event_id`, so both may appear in the sample. The `canonical_url` column enables dedup in volume queries (spec 015) but the training set intentionally preserves duplicates — they test whether the classifier produces consistent labels across sources. |
| Partial generation failure (disk full, I/O error) | All inserts are wrapped in a single transaction. On failure: rollback + delete partial file. See §C `generate` transaction safety. |
| Training set staleness vs. 120-day retention | The source DB prunes events older than 120 days (spec 006). Training sets snapshot event data at generation time, so labeled data is preserved — but training sets older than ~120 days reference events no longer in the source DB. Cross-referencing (e.g., `evaluate` command, regression tests) should use the training DB's snapshot, not re-query the source DB. |
| Full content storage inflates training DB | Full RSS article content (10-50KB per event) pushes the training DB to 33-165MB for ~3,331 events. The classifier caps at 3,000 chars and subagents are recommended ~4,000 chars, so most content goes unused. However, the training DB is a self-contained artifact that outlives the source DB's 120-day retention — the full content is the only preserved copy. Tradeoff accepted: storage is cheap, and future analysis (e.g., longer-context classifiers) may benefit from full content. |
| BM25 threshold calibration | Initial thresholds [4.0, 5.5, 7.0, 8.5, 10.0] are estimates. If too aggressive (high), recall drops; if too permissive (low), over-classification persists. Mitigation: Brier score loop (spec 007 §J2) provides online correction; training data (§A-F) enables retroactive validation; thresholds are constants (§G), not buried in logic. |
| Bootstrap IDF diverges from corpus IDF | Bootstrap IDF (keyword frequency across 66 topics) approximates corpus statistics but may over-weight rare keywords that are common in actual RSS content. Mitigation: Phase 2's corpus IDF from real training data replaces bootstrap IDF; the Brier score loop corrects for systematic errors in the interim. |
| CNB overfitting on small training set | With 500 minimum labeled events spread across 66 topics, some topics may have ≤20 examples — too few for reliable CNB training. Mitigation: per-topic `min_examples` threshold (default 20); topics below threshold fall back to BM25; vocabulary cap (20K) limits model complexity; 20% validation holdout catches overfitting before model deployment. |
| Model file size | CNB model with 20K vocabulary × 66 topics: ~1-2MB JSON. Acceptable for a file loaded once at startup. If vocabulary grows beyond 50K terms, consider binary serialization. |
| Two-classifier maintenance burden | BM25 fallback + CNB primary creates two code paths to test and maintain. Mitigation: fallback is per-topic (not a global mode switch); as training data grows, fewer topics use fallback; converges to CNB-only when all topics have sufficient examples. |
| Confidence scale shift after `reclassify` | Phase 1 changes the confidence formula from the current compressed [0.5, 0.8] range to full-range sigmoid-calibrated BM25 scores. After `intel db reclassify`, all `event_topics` confidence scores shift to the new scale. The Brier score loop (spec 007, §J2) has learned `topic_weights` against the old distribution — these weights become miscalibrated after the scale change. Mitigation: the Brier loop will re-learn weights from new forecast outcomes, but there is a transition period (1-2 forecast cycles) where confidence-weighted chain detection may over- or under-weight topics. This is acceptable because chain detection already uses binary topic presence as the primary signal, with confidence as a secondary weight. |

---

## I. Decision Summary

### Training Data Infrastructure (§A-F)

| Decision | Selected | Rationale |
|----------|----------|-----------|
| Reservoir sampling (Algorithm R) | O(n) single-pass, O(k) memory | Optimal for large datasets; uniform probability; no temp tables or multi-pass. Optional seeded PRNG for reproducibility. |
| Standalone training database | Separate SQLite file | Different lifecycle than operational data; can be shared/versioned/discarded independently |
| 10% default sample rate | `DEFAULT_SAMPLE_RATE = 0.1` | At 33K events → ~3.3K samples; sufficient for per-topic precision with ≥30 samples per active topic |
| Add to existing intel SKILL.md | New section, not new skill | Training data generation is an intel operation; adding a new top-level skill would fragment the intel workflow |
| Blind-by-default for `next` command | Machine labels omitted unless `--show-machine-labels` | Safe default: subagents cannot see classifier output even if orchestrating agent doesn't opt in. Debugging uses explicit `--show-machine-labels` flag. |
| Batch confidence query | Single `IN` query, not per-event | Avoids N+1 overhead during training set generation; chunked at 500 for SQLite variable limits |
| Store `classifier_config_sha256` | SHA-256 of `topic-classifier.ts` | Ties machine labels to a specific classifier version — enables tracing whether labels came from old or new classifier |
| Batched subagent classification | 25 subagents per batch, each classifying one event | Prevents anchoring (one event per subagent), enables parallelism (25x throughput vs sequential), ~133 iterations for ~3K events. Balances orchestrator round-trip overhead against blast radius of mid-batch failures. |
| No MCP exposure for training commands | CLI only | Training is an occasional operation, not a real-time agent tool; CLI is sufficient |
| `human_topics` nullable vs empty array | NULL = unreviewed, `[]` = no topics | Distinguishes "not yet looked at" from "intentionally no topic" — critical for progress tracking |
| Up to 5 topics, ≤3 typical target | Soft labeling convention | Allows subagents to assign 4-5 topics for genuinely cross-domain events — required to validate whether the 4+ threshold is real over-classification or legitimate (Problem #2). Hard cap at 5 matches classifier max output. |
| JSON storage for topics | Consistent with `events.topics` | Same format, same parsing, enables direct comparison |
| Append-only `training_labels` table | Preserves all label history; `training_events` denormalized from latest | Eliminates fragile export-before-re-label workflow; enables inter-rater reliability via direct SQL queries on label history |
| Topic validation as warning, not error | Warn on unknown topic IDs | Taxonomy evolves; training sets may outlive a given `topics.yaml` version |
| Store `topics_yaml_sha256` in metadata | SHA-256 hash of topics.yaml | Ties training set to a taxonomy version for meaningful precision/recall evaluation |
| Partial index on unreviewed events | `WHERE reviewed_at IS NULL` on `id` | Trivially cheap; accelerates `next` queries; consistent with "scales correctly" design philosophy |
| Warn on >3 topics, error on >5 in `label` | Warning at 4-5, error at 6+ | Reminds labeler of ≤3 target without blocking legitimately cross-domain events; hard cap at 5 matches classifier max output |
| Haiku subagents (`model: "haiku"`) | Default model recommendation | Topic classification from a fixed taxonomy is within haiku's capabilities; 10-20x cost reduction makes full-set labeling practical; `--labeler haiku` records the model per event |
| No `confidence` column | Binary signal only (assigned / not assigned) | LLM self-reported confidence is uncalibrated; a column that's always 1.0 adds cognitive overhead without information. Add via schema migration if calibrated confidence is needed later. |
| Mulberry32 PRNG | Fixed algorithm, stored in metadata | Reproducibility requires same PRNG across tool versions; changing algorithm would silently break `--seed` guarantees |
| Schema version in metadata | `schema_version: 1` checked on open | Enables clear error messages when tooling encounters a training DB from a different version |
| `labeler` column with `"unspecified"` default | Tracks who/what classified each event | Enables inter-rater reliability within a single DB; enables filtering by labeler for precision analysis; `"unspecified"` distinguishes "caller didn't specify" from intentional `"human"` or `"haiku"` |
| `notes` column | Optional free-text annotation | Edge-case reasoning is valuable for taxonomy refinement; feeds into spec 013 topic lifecycle reviews |
| `json_valid` CHECK constraints | On `machine_topics`, `machine_confidences`, `human_topics` | Consistent with main DB pattern; cheap insurance against malformed data; `human_topics` allows NULL but validates JSON when set |
| Training DB `application_id` | `0x54524E47` ("TRNG") | Prevents accidentally passing main DB to training-set commands or vice versa; same pattern as main DB's `0x494E5445` ("INTE") |
| Transactional generation | Single transaction for all inserts | Prevents partial training DBs on failure; rollback + unlink on error |
| `list` command scans by glob + `application_id` | `training-set-*.db` pattern, validated on open | Discovers training DBs without a registry; silently skips non-training files; no false positives via `application_id` check |
| `progress --verbose` per-topic coverage | Optional flag with ≥30 sufficiency threshold | Helps operator determine when enough data exists per topic without cluttering default output |
| `export` command in-scope | JSON envelope by default, `--raw` for JSONL | Default uses standard JSON envelope (consistent with all other commands); `--raw` flag enables pipeline-friendly JSONL for `jq`, Jupyter, etc. |
| `evaluate` command in-scope | Per-topic precision/recall/F1, confusion pairs, over-classification rate | The primary payoff of the training data investment — without it, labeled data has no actionable output. Validates spec 015's 4+ threshold and identifies systematic misclassifications. |
| `machine_confidences` null for missing entries | `null` instead of `1.0` default | A missing `event_topics` entry means "pre-confidence-tracking" (before migration 004), not "maximum confidence." Defaulting to 1.0 inflates apparent confidence for legacy events. |
| `MIN_SAMPLE_SIZE` over `MIN_SAMPLE_RATE` | Minimum 100 resulting samples | A rate floor (e.g., 0.001) doesn't prevent tiny samples — 0.001 × 33K = 33 events, below per-topic thresholds. Validating the resulting sample size catches the actual problem regardless of database size. |
| `--dry-run` on `generate` | Preview without creating DB | Lets operator verify parameters (sample size, output path) before committing to a large training database; avoids generate-delete-regenerate cycles |
| `--labeler` filter on `evaluate` | Filter evaluated events by labeler | Enables direct comparison of labeler quality (haiku vs sonnet vs human) without exporting to JSONL and scripting; complements the `labeler` column and inter-rater reliability design |
| Hamming loss in `evaluate` output | `symmetric_diff / (events × topics)` | Standard multi-label metric that captures both FP and FN in a single number; complements per-topic precision/recall with an aggregate quality signal |
| `machine_scores` column in training DB | Raw BM25/CNB scores alongside confidence | Sigmoid-calibrated confidence compresses the score range — raw scores preserve threshold-analysis information (e.g., how far above the gate a topic scored). `null` for pre-BM25 events, same convention as `machine_confidences`. |

### Classifier Evolution (§J)

| Decision | Selected | Rationale |
|----------|----------|-----------|
| Phase 1: BM25 before ML | BM25 scoring ships without training data | Fixes most damaging problems immediately (substring matching, no term weighting); validates tokenizer and IDF code reused by Phase 2; buys time for labeled training data |
| Phase 2: Complement Naive Bayes | CNB over logistic regression, embeddings, or fastText | Zero new dependencies (pure TypeScript); designed for class imbalance; calibrated with Platt scaling; interpretable per-term contributions; 12 positive examples viable via complement formulation |
| Not sentence embeddings | Rejected MiniLM/ONNX approach | ~60MB dependency footprint; poor interpretability (384-dim vectors); cosine similarity poorly calibrated; overkill for vocabulary-driven taxonomy |
| Not fastText | Rejected native binding approach | Native addon portability issues; less maintained npm bindings; dependency weight unjustified vs pure-TS CNB |
| Not LLM triage | Rejected API-based classification | Violates offline operation constraint; poorly calibrated confidence; API dependency for core pipeline function |
| Phased rollout | BM25 → CNB, not single-step ML | Training data doesn't exist yet; BM25 is a validated intermediate step; BM25 code (tokenizer, IDF) is reused by Phase 2's TF-IDF vectorizer |
| Ship Phases 1-2 with training data | Single deliverable | Phase 1 (BM25) is immediately useful with no training data dependency; Phase 2 code ships ready but model awaits labeling; avoids a second integration cycle for classifier work |
| `intel classifier train` min 500 labeled events | `CNB_MIN_TRAINING_EVENTS = 500` | Below ~500 events, per-topic sample sizes are too small for reliable CNB training even with the complement formulation; 500 across 66 topics averages ~7.6 per topic, but the distribution is uneven — popular topics get enough, rare topics fall back to BM25 |
| 20% validation holdout | `CNB_VALIDATION_SPLIT = 0.2` | Standard ML practice; 80/20 split balances training set size against validation reliability; validation set fits Platt calibration and reports per-topic metrics |
| Atomic model write | Write to temp file, then rename | Prevents partial model files from being accidentally loaded; same pattern as SQLite's WAL checkpoint |
| No auto-load of trained model | Operator configures `classifier_model` config key or `--classifier-model` CLI flag | Silent classifier changes during collection would be surprising; explicit configuration ensures the operator reviews validation metrics before deploying. Stale model (>90 days) produces warning, not error. |
| Drop `regex` from `topics.yaml` | Remove `regex` field from all 13 topics | BM25 word-boundary tokenization handles all 13 regex use cases (case-insensitive acronyms, multi-word phrases). The one structured pattern (CVE IDs) converts to a `"CVE"` keyword. Eliminates a code path (regex compilation, `(?i)` flag conversion) without loss of classification quality. |
| `classifyIds()` preserved as thin wrapper | Backward-compatible shim over new `classify()` | Existing callers continue to work; returns `string[]` of topic IDs by delegating to the new BM25-based `classify()` and extracting `.topic` from each result |

---

## J. Classifier Evolution Path

> **Scope note**: Phases 1-2 are implementation scope, shipping alongside §A-F as a single deliverable. Phase 1 (BM25 scoring) takes effect immediately with no training data dependency — it replaces the keyword/regex classifier at ship time. Phase 2 (CNB training pipeline) code ships, but the trained model is produced only after sufficient labeling (≥500 events via §A-F). Phase 3 (Continuous Improvement Loop) is deferred to §K as future work.

### Current Classifier Problems

The keyword/regex classifier (spec 006, §Topic Classification) has six structural problems that training data alone cannot fix:

1. **One-hit classification**: A single keyword substring match triggers topic assignment. "electricity" in a medieval manuscript triggers `macro.energy`.
2. **Substring matching**: `lowerText.includes(kw)` means "chip" matches "archipelago", "react" matches "reactive", "arm" matches "swarm".
3. **No negative signal**: The classifier can only add topics, never suppress. `compute.cloud-platforms` has keywords like "new feature" and "preview" — terms in any product announcement.
4. **No term importance weighting**: "kubernetes" (highly specific) and "cloud" (generic) contribute equally to a topic match.
5. **No title vs. content distinction**: A keyword in the title (strong signal) and buried in boilerplate (weak signal) are treated identically.
6. **Poor confidence calibration**: The formula starts at 0.5 for any single hit and compresses into [0.5, 0.8], providing little discriminatory value for the Brier score feedback loop (spec 007, §J2).

### Phase 1: BM25 Scoring (no training data required)

Replace substring keyword matching with tokenized BM25 scoring — the same algorithm behind Elasticsearch and SQLite FTS5 ranking.

> **Calibration note**: Phase 1 parameters (k1, b, title boost multiplier, score thresholds) are initial estimates. The training data produced by §A-F will retroactively validate whether these parameters are well-tuned, and the Brier score loop (spec 007, §J2) provides online correction.

**Changes:**

1. **Tokenized BM25 scoring engine** — new file `src/collector/bm25.ts`
   - Word-boundary tokenization (eliminates "chip"/"archipelago", "react"/"reactive" false matches)
   - Stopword removal using a fixed, hardcoded list (~30 terms): `a, an, and, are, as, at, be, but, by, for, from, had, has, have, he, her, his, i, in, is, it, its, not, of, on, or, she, so, that, the, their, this, to, was, we, were, will, with, you`. The list is a constant in `bm25.ts`, not configurable — changing the stopword list changes BM25 scores, which would break reproducibility of training set evaluations and Brier score history. If a stopword needs to be added or removed, treat it as a classifier change (tracked via `classifier_config_sha256` in training metadata).
   - TF saturation (k1=1.2): diminishing returns for repeated terms
   - Document length normalization (b=0.75): penalizes long boilerplate-heavy content
   - IDF weighting: rare keywords score higher than common keywords
   - Title boost (3x): keywords in the title carry 3x the weight of content keywords

2. **Negative keywords** — new `negative_keywords` field in `topics.yaml`
   - Per-topic terms that suppress classification regardless of positive score
   - Example: `macro.energy` negative: `["medieval", "manuscript", "metaphor", "figurative"]`

3. **Minimum score threshold + escalating gate**
   - Require BM25 score >= 4.0 to classify (eliminates single-incidental-keyword false positives)
   - Escalating threshold for additional topics: 1st=4.0, 2nd=5.5, 3rd=7.0, 4th=8.5, 5th=10.0
   - Directly targets the over-classification problem

4. **Sigmoid-calibrated confidence**
   - Map BM25 scores to (0,1) via sigmoid: `confidence = 1 / (1 + exp(-(score - midpoint) / temperature))`
   - Replaces the compressed [0.5, 0.8] confidence range with a full-range calibrated output

5. **Bootstrap IDF** (until training data exists)
   - Compute pseudo-IDF from keyword frequency across all 66 topics
   - "kubernetes" in 1 topic → high IDF; "cloud" in 5 topics → low IDF
   - Replaced by corpus IDF once Phase 2 trains on real data

6. **Context-aware matching and priority** (carried forward from current classifier)
   - The current classifier uses `context_required` / `context_terms` for short acronyms (RAG, EKS, ARM) to prevent false matches when these appear as common words. Word-boundary tokenization in BM25 eliminates most of these false matches (e.g., "arm" no longer matches inside "swarm"), but acronyms that are also common words (e.g., "GO" the language vs. "go" the verb) still need context gating. BM25 retains the `context_required` mechanism: if a keyword is flagged `context_required`, at least one `context_term` must also appear as a BM25 token match for the topic score to count.
   - The current `priority` field (1-100) on topics is incorporated as a BM25 score multiplier: `final_score = bm25_score × (priority / 50)`. Priority 50 (default) is neutral; priority 100 doubles the score; priority 1 nearly zeroes it. This preserves the existing operator tuning knob while letting BM25 handle the heavy lifting.

7. **Content length cap** (carried forward from current classifier)
   - The current classifier caps input at 3,000 characters to prevent boilerplate/sidebar false positives. BM25 inherits this cap: `tokenize()` operates on `(title + ' ' + content).slice(0, 3000)`. The cap is applied before tokenization so that BM25's length normalization (parameter `b`) sees the capped length, not the original. This prevents long RSS articles with keyword-dense footers from inflating topic scores.

8. **Drop `regex` field from `topics.yaml`**
   - 13 topics currently use `regex` patterns. All but one are case-insensitive word-boundary variants (e.g., `(?i)\bLLM\b`, `(?i)\bRAG\b`, `(?i)\bearnings guidance\b`) — these are redundant with BM25's word-boundary tokenization, which already matches whole tokens case-insensitively.
   - The one exception is `security.vulnerabilities`'s CVE pattern (`CVE-\\d{4}-\\d+`). Convert this to the keyword `"CVE"` — BM25 word-boundary tokenization matches the "CVE" token in strings like "CVE-2024-12345", and the topic's other keywords (`vulnerability`, `exploit`, `zero-day`) provide sufficient disambiguation. The structured format validation (correct year/ID) is not the classifier's job.
   - Migration: remove the `regex` field from all 13 topics in `topics.yaml`. No regex patterns are carried forward — BM25 tokenization + keywords replaces them entirely. The `matchesTopic()` rewrite (above) has no regex code path.
   - The `TopicDef` type in `topic-classifier.ts` drops the `regex` field. Any code that reads `regex` from `topics.yaml` is removed.

**New `classify()` flow:**

The existing `classify()` function (which returns up to 5 topics sorted by priority) is replaced with a BM25-based flow:

```typescript
function classify(event: EventRow, topicDefs: TopicDefExtended[], idf: Map<string, number>): ClassifyResult {
  // 1. Tokenize once (shared across all 66 topics)
  const text = ((event.title ?? '') + ' ' + (event.content ?? '')).slice(0, 3000);
  const tokens = tokenize(text);
  const titleTokens = tokenize((event.title ?? '').slice(0, 200));

  // 2. Score all topics
  const scored = topicDefs
    .map(td => matchesTopicBM25(event, td, idf, { tokens, titleTokens }))
    .filter(r => r.matched && !r.suppressed);

  // 3. Sort by score descending (not priority — BM25 score already incorporates priority)
  scored.sort((a, b) => b.score - a.score);

  // 4. Apply escalating threshold gate per rank position
  //    1st topic: ≥4.0, 2nd: ≥5.5, 3rd: ≥7.0, 4th: ≥8.5, 5th: ≥10.0
  const result: TopicMatch[] = [];
  for (let i = 0; i < scored.length && i < BM25_THRESHOLDS.length; i++) {
    if (scored[i].score >= BM25_THRESHOLDS[i]) {
      result.push({ topic: scored[i].topicId, confidence: scored[i].confidence });
    } else {
      break; // escalating: if rank i fails, rank i+1 cannot pass
    }
  }

  return { topics: result };
}
```

Key differences from the current `classify()`:
- Sort by BM25 score (which already incorporates priority as a multiplier), not by priority alone
- Escalating thresholds enforce diminishing returns: the 2nd topic must score higher than the 1st topic's minimum, etc.
- The `break` on threshold failure means topics are contiguous by score — no gaps where the 1st and 3rd topics pass but the 2nd fails
- `classifyIds()` is preserved as a thin wrapper: calls `classify()` and returns `result.topics.map(t => t.topic)`. Existing callers are unaffected.

**Files:**
- `src/collector/topic-classifier.ts` — rewrite `matchesTopic()` and `classify()` to use BM25
- `src/collector/bm25.ts` — new: BM25 engine + tokenizer
- `config/topics.yaml` — add `negative_keywords` per topic; remove `regex` field from all 13 topics that use it
- `tests/topics.test.ts` — update tests for BM25 scoring

**Expected impact:**
- Over-classification (4+ topics): spec 015 reports `multi_topic_pct: 0.059` (5.9% of all events), but this understates the problem — among *classified* events only, the rate is higher since 31% of events are unclassified and excluded from the numerator. BM25's escalating thresholds should reduce over-classification to <3% of all events.
- False positives from substring matching: eliminated
- Unclassified rate: may increase slightly (acceptable — false negatives are less damaging than false positives for chain analysis)

**Dependency on training data:** None. Phase 1 ships independently.

**Transition plan for existing events:**
- Since `matchesTopic()` and `classify()` are rewritten in place, `intel db reclassify` automatically uses BM25 after upgrading — no separate migration step is needed.
- The operator **should** run `intel db reclassify` after upgrading to Phase 1. This re-classifies all events in the database using BM25, replacing keyword-derived topic assignments and confidence scores. Without reclassify, existing events retain stale keyword-based labels while new events get BM25 labels, creating an inconsistent mix that distorts `intel stats` metrics and chain detection.
- Reclassify is already an O(n) pass over the events table (spec 006, `intel db reclassify`). At 33K events × 66 topics, this completes in seconds.
- The verification step for Phase 1 (§Verification) includes `intel collect --once && intel stats` — the `reclassify` step should be run first to establish a clean baseline: `intel db reclassify && intel stats`.

### Phase 2: TF-IDF + Complement Naive Bayes (requires labeled training data)

Once §A-F produces labeled training data (minimum ~500 events, ideally 2,000+), train a proper probabilistic multi-label classifier.

**Why Complement Naive Bayes (CNB):**

| Criterion | CNB | Logistic Regression | Embeddings (MiniLM) | fastText |
|---|---|---|---|---|
| TypeScript impl | Pure TS, ~200 lines | Needs optimizer (~1000 lines) or ONNX | ONNX Runtime (~60MB) | Native binding (~30MB) |
| Class imbalance | Designed for it (learns from complement) | Requires explicit balancing | Good | Moderate |
| Min training data | Low (12 positives viable via complement) | Moderate | Minimal (pretrained) | Moderate |
| Calibration | Good with Platt scaling | Naturally calibrated | Poor (cosine != probability) | Poor |
| Interpretability | High (per-term contributions) | High | Low (384-dim vectors) | Moderate |
| Dependencies | Zero | Zero or ONNX | ~60MB ONNX + model | ~30MB native |

CNB is specifically designed for imbalanced multi-label text classification. For rare topics like `data.governance` (~12 in a 10% sample), CNB still has ~2,988 negative examples to learn from via the complement formulation. It produces inspectable per-term contributions for debugging, and with Platt scaling produces calibrated probabilities for the Brier score loop. Implementable in pure TypeScript with zero new dependencies.

**Architecture:**

```
title + content → Tokenize → TF-IDF vector (10-20K vocab)
                                    ↓
                    66 independent CNB binary classifiers
                                    ↓
                         Platt sigmoid calibration
                                    ↓
                      × topic_weight (Brier loop, spec 007 §J2)
                                    ↓
                    Threshold filter → Top-5 by score
```

**CNB threshold and topic selection:**

CNB outputs Platt-calibrated probabilities in (0, 1) — unlike BM25's raw scores, these are directly interpretable as classification confidence. The threshold filter works as follows:

1. Each of the 66 CNB classifiers produces a calibrated probability. Multiply by `topic_weight` (Brier loop correction).
2. Apply a fixed probability threshold: topics with calibrated probability < `CNB_PROBABILITY_THRESHOLD` (0.3) are discarded. This is intentionally lower than 0.5 because CNB with Platt scaling tends to produce conservative probabilities for rare topics — a 0.5 cutoff would suppress valid classifications for low-frequency topics.
3. Sort remaining topics by calibrated probability descending.
4. Take top 5.

Phase 1's escalating thresholds are **not** applied to CNB — they exist to compensate for BM25's uncalibrated scores. Platt-calibrated probabilities are self-regulating: a topic that genuinely fits the event produces a high probability regardless of how many other topics also match. Over-classification is controlled by the probability threshold and the natural sparsity of well-calibrated CNB output (most topics score well below 0.3 for any given event).

For topics that fall back to BM25 (insufficient training data), Phase 1's escalating thresholds still apply to those topics' scores. The two scoring methods are unified after thresholding: BM25 sigmoid confidence and CNB calibrated probability are both in (0, 1) and are directly comparable for the final top-5 sort.

**Components:**
- `src/collector/tfidf.ts` — TF-IDF vectorizer (sub-linear TF, L2 normalization, 10-20K vocabulary)
- `src/collector/naive-bayes.ts` — Complement NB (66 binary classifiers, sparse log-theta vectors)
- `src/collector/platt.ts` — Platt scaling (sigmoid calibration, 2 parameters per topic)
- CLI command: `intel classifier train <training-db>` — offline training pipeline
- Model file: single JSON (~500KB-2MB), versioned, loaded on startup

**Model serialization format:** See `ClassifierModel` in §E Types.

**Fallback strategy:** Topics with <20 training examples fall back to Phase 1 BM25 scoring. As training data grows, fewer topics use the fallback.

**Integration with existing learning loop:** The Brier score feedback loop (spec 007, §J2) already updates `topic_weights`. Phase 2's calibrated probabilities feed more meaningful scores into this loop. The `topicWeight` multiplier is retained as an online correction factor that adjusts for classifier drift between retraining cycles.

**Dependency on training data:** Requires a completed (or partially completed) training set from §A-F with ≥500 labeled events.

### Phase 3: Continuous Improvement Loop

> **Future work**: Phase 3 is deferred to §K.7. It is included here for completeness — the items below are not implementation scope for this deliverable.

Once the training pipeline is established:

1. **Periodic retraining**: Retrain when training set grows by 500+ new labels via `intel classifier train`
2. **Regression test suite**: High-confidence labels (≥0.95) from training data become CI fixtures (see §K.2)
3. **Active learning sampling**: Bias next sampling round toward events where the classifier is uncertain (confidence 0.3-0.7) or disagrees between BM25 and CNB
4. **Confidence-weighted chains**: Chain detection (spec 007) weights co-occurrences by calibrated confidence rather than treating all classifications equally
5. **Quarterly retraining aligned with spec 013 topic lifecycle reviews**: New topics, retired topics, and keyword changes trigger a retrain cycle

### Evaluation Matrix

| Criterion | Current (Keyword) | Phase 1 (BM25) | Phase 2 (CNB) |
|---|---|---|---|
| Precision | Poor | Good | Very Good |
| Recall | Good (broad) | Good | Very Good |
| Over-classification | Poor | Good | Very Good |
| Dependencies | Zero | Zero | Zero |
| Inference latency | <1ms | <1ms | <1ms |
| Training data required | None | None | 500+ labels |
| Interpretability | High | High | High |
| Calibration quality | Poor | Moderate | Good (Platt) |
| Serializable model | N/A | ~50KB JSON | ~1MB JSON |

### Risks

| Risk | Phase | Mitigation |
|---|---|---|
| BM25 threshold tuning is wrong | 1 | Use the existing Brier score loop to learn per-topic thresholds. Start conservative (higher threshold) and let the learning loop adjust. |
| Insufficient training data for rare topics | 2 | CNB handles this via complement formulation. Topics with <20 examples fall back to BM25. |
| Vocabulary drift over 120-day retention | 2 | Retrain quarterly (aligned with spec 013). New vocabulary terms not in the trained model are still captured by the BM25 fallback. |
| Model staleness | 2 | Version field in model JSON. `intel classifier train` produces latest version. Warn if model is older than 90 days. |
| Two-classifier complexity (BM25 fallback + CNB primary) | 2 | Fallback is per-topic, triggered only when training data is insufficient. Converges to CNB-only as training data grows. |

---

## K. Future Work

1. **Precision/recall computation**: Now in-scope as the `intel training-set evaluate` command (§C). Once a training set is sufficiently labeled (≥10 events), the command computes per-topic precision/recall/F1, overall macro-averaged scores, over-classification rate, and confusion pairs.

2. **Classifier regression tests**: Extract high-confidence labels from completed training sets into a fixed test suite that runs on CI. Prevents classifier regressions when keywords, BM25 thresholds, or CNB models are modified.

3. **Active learning**: Use initial labeling results to identify topics with low precision and over-sample events from those topics in subsequent training sets. In Phase 3, bias sampling toward events where the classifier is uncertain (confidence 0.3-0.7).

4. **Adaptive batch sizing**: The current workflow uses a fixed batch of 25 subagents (a SKILL.md convention, not a code constant). A future optimization could tune batch size based on available concurrency and error rates.

5. **Inter-rater reliability**: Double-label a random subset (e.g., 5%) by running classification twice — once with `--labeler haiku`, once with `--labeler sonnet` — and compute Cohen's kappa to estimate inter-rater agreement. Low agreement on specific topics would indicate ambiguous taxonomy definitions (feeding back into spec 013's topic lifecycle). The append-only `training_labels` table (§B) preserves all historical labels — re-labeling an event appends a new row rather than overwriting the previous label, so inter-rater comparison queries `training_labels` directly without requiring an export-before-re-label workflow. Alternatively, generate two training sets from the same seed and label each with a different model — the `labeler` column distinguishes them if results are merged for analysis.

6. **Confidence-weighted chain detection**: Once Phase 2 produces calibrated confidence scores, chain detection (spec 007) can weight co-occurrences by confidence rather than treating all topic assignments equally. A 0.95-confidence assignment contributes more than a 0.55-confidence assignment.

7. **Phase 3 continuous improvement loop**: The items listed in §J Phase 3 are explicitly deferred: periodic retraining triggers (retrain on 500+ new labels), active learning sampling (bias toward uncertain events with confidence 0.3-0.7), confidence-weighted chain detection, and quarterly retraining aligned with spec 013 topic lifecycle reviews. These require operational experience with Phases 1-2 before the trigger thresholds and retraining cadence can be validated.

8. **Training set import command**: Counterpart to `export` — `intel training-set import <training-db> <jsonl-file>` would load labeled events from JSONL into a training database. Required to complete the §B schema migration strategy's "export → reimport" path for breaking schema changes. Until this ships, breaking migrations require operator scripting against the exported JSONL (see §B). A dedicated command would close the round-trip and make breaking schema changes safe for non-technical operators.

---

## Verification

### Training data infrastructure (§A-F)

```bash
# 1. Type-checks cleanly
cd tools/intelligence && npx tsc --noEmit

# 2. All tests pass
npx vitest run tests/training.test.ts

# 3. Generate a training set (with seed for reproducibility)
intel training-set generate --sample-rate 0.1 --seed 42
# Expected: JSON output with path, sample_size ~3331, total_events ~33309

# 4. Verify training database contents
sqlite3 <training-db-path> "SELECT COUNT(*) FROM training_events"
# Expected: ~3331

sqlite3 <training-db-path> "PRAGMA application_id"
# Expected: 1414808391 (0x54524E47 = "TRNG")

sqlite3 <training-db-path> "SELECT key, value FROM training_meta"
# Expected: 11 rows (schema_version, created_at, source_db, sample_size, total_events, sample_rate, seed, prng_algorithm, topics_yaml_sha256, classifier_config_sha256, algorithm)

sqlite3 <training-db-path> "SELECT COUNT(*) FROM training_events WHERE human_topics IS NULL"
# Expected: same as total count (all unreviewed)

# 5. Fetch next unreviewed event (blind mode for classification workflow)
intel training-set next <training-db-path>
# Expected: JSON with 1 event including title, content — no machine_topics or machine_confidences (blind by default)

# 6. Label an event
intel training-set label <training-db-path> <event-id> --topics "ai.foundation-models,compute.gpu" --labeler haiku
# Expected: JSON with human_topics, labeler: "haiku", reviewed_at

# 7. Check progress
intel training-set progress <training-db-path>
# Expected: total ~3331, reviewed 1, remaining ~3330, pct_complete ~0.000

# 8. Check progress with per-topic coverage
intel training-set progress <training-db-path> --verbose
# Expected: same as above plus per_topic array, topics_sufficient, topics_insufficient

# 9. List training databases
intel training-set list
# Expected: JSON array with one entry showing path, created_at, sample_size, reviewed, pct_complete

# 10. Export labeled data
intel training-set export <training-db-path> --reviewed-only --raw | head -1 | jq .human_topics
# Expected: ["ai.foundation-models", "compute.gpu"]
```

### Phase 1: BM25 scoring (§J)

```bash
# 1. Reclassify existing events with BM25, then check stats baseline
intel db reclassify && intel stats
# Expected: multi_topic_pct (over-classification) < 0.03 (down from 0.059)

# 2. Run a fresh collection pass to verify new events are classified with BM25
intel collect --once && intel stats

# 3. Spot-check known false positives are eliminated
# Search for events previously misclassified (e.g., non-tech content tagged with tech topics)
intel events --topic macro.energy --since 24h --limit 10
# Expected: no medieval manuscripts, no figurative "electricity" references

# 4. Verify negative keywords suppress correctly
# Check topics.yaml negative_keywords are loaded and applied

# 5. Test suite passes with BM25 threshold tests
npx vitest run tests/topics.test.ts
```

### Phase 2: CNB classifier (§J)

```bash
# 1. Train the classifier on labeled training data
intel classifier train <training-db-path>
# Expected: JSON output with model path, vocabulary size, per-topic training counts

# 2. Validate model quality on held-out data
# The train command reports per-topic precision/recall on a 20% held-out validation set
# Expected: macro-averaged precision > 0.80, recall > 0.75

# 3. Verify calibration quality
# Compare Brier scores on validation set: Phase 2 should be lower than Phase 1
# Expected: avg Brier score < 0.15

# 4. End-to-end pipeline
intel collect --once && intel stats && intel forecast --summary
# Expected: lower multi_topic_pct, lower unclassified_pct, forecast scenarios use calibrated confidences
```

---

## Cross-References

- **Spec 006** (Intelligence Tool) — amended with training-set CLI commands and classifier evolution path (§J)
- **Spec 007** §J2 (Learning Loop) — training labels provide direct precision measurement vs. forecast-derived weights; Phase 2's calibrated probabilities improve Brier score feedback quality
- **Spec 013** (Topic Strategy) — training labels validate topic design principles (P1-P6) and inform quarterly reviews; completed training sets feed into the `intel topics audit` flow as labeled ground truth; Phase 3 retraining aligns with quarterly topic lifecycle reviews
- **Spec 015** (Collection Quality Controls) — training labels validate the 4+ over-classification threshold; Phase 1 BM25 directly targets the `multi_topic_pct` health warning
