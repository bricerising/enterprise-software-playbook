# Spec 019: Classifier Training Data

**Amends [spec 006](006-intelligence-tool.md) and [spec 013](013-topic-strategy.md).**

> **Taxonomy note**: The topic set has grown from spec 013's original 61 topics to 66 (additions: `macro.monetary-policy`, `market.payments`, `market.crypto`, `ai.research`, `devex.methodology`).

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

## Non-Goals

- Automated precision/recall computation (future work — requires completed training sets)
- Active learning or smart sampling (uniform random is sufficient at current scale)
- Persisting training databases in the main database schema (training DBs are standalone artifacts)

> **Classifier algorithm changes** and **automated retraining** are deferred to §J (Classifier Evolution Path), which describes the phased BM25 → Complement Naive Bayes evolution that consumes the training data this spec produces. The training data infrastructure (§A-F) ships first; the ML classifier follows once labeled data exists.

## Scope

| In scope | Out of scope |
|----------|-------------|
| Reservoir sampling from events table | Stratified or weighted sampling |
| Standalone training SQLite database | Schema changes to main database |
| CLI commands: generate, label, progress, next | MCP tool exposure for training commands |
| Agent skill workflow for classification | Multi-pass deduplication or content analysis |
| Single-pass O(n) sampling algorithm | |
| Classifier evolution path (§J) — phased BM25 → CNB plan | |

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

When `--seed` is provided, use a deterministic PRNG (e.g., mulberry32) for reproducible sampling. The specific PRNG algorithm is an implementation detail — the requirement is: same seed + same data = same sample. Without a seed, use `Math.random()`.

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

After reservoir sampling completes, batch-query `event_topics` for all sampled events to build the `machine_confidences` arrays. Use a single query instead of per-event queries to avoid N+1 overhead:

```typescript
// Batch lookup: one query for all sampled events
const ids = reservoir.map(r => r.event_id);
const placeholders = ids.map(() => '?').join(',');
const allConfs = db.prepare(`
  SELECT event_id, topic, confidence
  FROM event_topics WHERE event_id IN (${placeholders})
`).all(...ids);

// Group by event_id
const confByEvent = new Map<string, Map<string, number>>();
for (const c of allConfs) {
  if (!confByEvent.has(c.event_id)) confByEvent.set(c.event_id, new Map());
  confByEvent.get(c.event_id)!.set(c.topic, c.confidence);
}

// Align confidences to topic order
for (const row of reservoir) {
  const topics: string[] = JSON.parse(row.topics);
  const confMap = confByEvent.get(row.event_id) ?? new Map();
  row.machine_confidences = topics.map(t => confMap.get(t) ?? 1.0);
}
```

This preserves array order alignment: `machine_topics[i]` corresponds to `machine_confidences[i]`. Topics not found in `event_topics` default to 1.0 (the migration 004 default). If the sample exceeds SQLite's `SQLITE_MAX_VARIABLE_NUMBER` (default 999), chunk the `IN` clause into batches of 500.

**Properties:**
- Each event has exactly `k/n` probability of being in the final sample (uniform)
- Single pass over the events table — no secondary queries or temp tables
- Memory: holds `k` event rows (~3,331 rows × ~2KB avg title+metadata = ~6.5MB at 10% of 33K events; `content` column may increase per-row size but is bounded by source feed limits)
- Deterministic iteration via `ORDER BY id` + seeded PRNG ensures full reproducibility given the same seed

**Why not `ORDER BY RANDOM() LIMIT k`:** SQLite's `ORDER BY RANDOM()` materializes the full result set, sorts it, and takes the top k — O(n log n) time and O(n) memory. Reservoir sampling is O(n) time and O(k) memory. At 33K events this doesn't matter, but the algorithm scales correctly if the database grows to 100K+ events.

**Why not stratified sampling:** Stratified sampling (proportional per topic) would guarantee minimum samples per topic but requires multi-topic events to be counted in each stratum, creating overrepresentation. Uniform random is simpler and produces representative samples at the current scale. If per-topic coverage is insufficient, the operator can generate a larger training set (e.g., `--sample-rate 0.2`).

---

## B. Training Database Schema

### Purpose

A standalone SQLite database containing sampled events with columns for human-assigned labels. Separate from the main intelligence database — no migrations, no application_id check, no shared schema.

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
  machine_topics  TEXT    NOT NULL DEFAULT '[]',  -- JSON array: classifier topic IDs
  machine_confidences TEXT NOT NULL DEFAULT '[]', -- JSON array: confidence per topic (same order as machine_topics)
  human_topics    TEXT,                           -- JSON array: agent/human labels (NULL = unreviewed)
  confidence      REAL,                           -- labeler confidence (0.0-1.0)
  reviewed_at     TEXT,                           -- ISO 8601 UTC timestamp
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Partial index: accelerates `next` queries (WHERE reviewed_at IS NULL ORDER BY id)
CREATE INDEX idx_training_unreviewed ON training_events(id) WHERE reviewed_at IS NULL;

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

**Why `machine_topics` stored as JSON:**
- Snapshot of the classifier's output at generation time — if the classifier changes later, the original classification is preserved for comparison
- Same format as `events.topics` for consistency

**Why separate `machine_topics` and `machine_confidences` columns:**
- `machine_topics` stores the topic ID array (same format as `events.topics`), preserving a simple comparison target against `human_topics`
- `machine_confidences` stores the corresponding per-topic confidence scores from the `event_topics` table, in the same array order as `machine_topics`
- After reservoir sampling selects events, a secondary query joins `event_topics` to populate `machine_confidences` for each sampled event
- Two columns keep topic comparison simple while preserving confidence data for threshold analysis

**Why `human_topics` is nullable:**
- NULL = unreviewed (not yet labeled)
- Empty JSON array `[]` = reviewed and determined to match no topic
- This distinguishes "not yet looked at" from "intentionally no topic"

**Metadata keys:**

| Key | Value | Purpose |
|-----|-------|---------|
| `created_at` | ISO 8601 timestamp | When the training set was generated |
| `source_db` | Absolute path | Which database was sampled |
| `sample_size` | Integer string | Number of events in the sample |
| `total_events` | Integer string | Total events at time of sampling |
| `sample_rate` | Decimal string | Configured sample rate |
| `seed` | Integer string or `null` | PRNG seed used (null = non-deterministic) |
| `topics_yaml_sha256` | Hex string | SHA-256 of `topics.yaml` at generation time — ties training set to a taxonomy version |
| `classifier_config_sha256` | Hex string | SHA-256 of `topic-classifier.ts` at generation time — ties machine labels to a specific classifier version |
| `algorithm` | `reservoir_sampling_algorithm_r` | Sampling algorithm used |

**Pragmas on training DB:**
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
```

**Options:**
- `--sample-rate <rate>` — Fraction of events to sample, range (0.0, 1.0], default `0.1`
- `--output <path>` — Output database path, default `~/.local/share/intel/training-set-<timestamp>.db`
- `--seed <number>` — Integer seed for the PRNG. Omit for non-deterministic sampling. Stored in `training_meta` for reproducibility.

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
- Output path must not already exist; if a file exists at the path, produce `INVALID_QUERY` error with suggested action "Delete the existing file or choose a different `--output` path." (The timestamp-based default path makes collisions unlikely, but `--output` allows arbitrary paths.)
- Output directory is created recursively if it doesn't exist

**Connection pattern:**
- Source DB opened via `withReader()` (read-only), wrapped in `sqliteBusyRetry()` consistent with all other read commands in `bin.ts`
- Training DB opened via `new Database()` directly (not `openWriter` — different schema, no application_id)
- Training DB closed after generation completes

#### `intel training-set next <training-db>`

Get the next unreviewed event(s) for classification.

```
intel training-set next /path/to/training.db                  # next 1 event
intel training-set next /path/to/training.db --limit 5        # next 5 events
intel training-set next /path/to/training.db --blind          # omit machine labels (for unbiased classification)
```

**Options:**
- `--limit <n>` — Number of events to return, default `1`, max `50`
- `--blind` — Omit `machine_topics` and `machine_confidences` from the output. Use this when feeding events to subagents for classification to prevent anchoring bias on the classifier's output.

**Output (default):**
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
      "machine_topics": ["compute.gpu", "ai.training", "ai.foundation-models"],
      "machine_confidences": [0.92, 0.87, 0.73],
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

With `--blind`, `machine_topics` and `machine_confidences` are omitted from each event object.

**Behavior:**
- Returns events ordered by `id` (deterministic iteration)
- Only returns events where `reviewed_at IS NULL`
- Opens training DB in `readonly` mode
- Returns empty array when all events are reviewed

#### `intel training-set label <training-db> <event-id>`

Assign human-classified topics to a training event.

```
intel training-set label /path/to/training.db rss:techcrunch:abc123 \
  --topics "compute.gpu,ai.training" \
  --confidence 0.95
```

**Options:**
- `--topics <csv>` — Required. Comma-separated topic IDs from the taxonomy
- `--confidence <score>` — Labeler confidence, range [0.0, 1.0], default `1.0`

**Output:**
```json
{
  "tool": "intel",
  "schema_version": "v2",
  "status": "ok",
  "data": {
    "event_id": "rss:techcrunch:abc123",
    "human_topics": ["compute.gpu", "ai.training"],
    "confidence": 0.95,
    "reviewed_at": "2026-03-23T15:00:00.000Z"
  },
  "warnings": [],
  "next_cursor": null
}
```

**Behavior:**
- Sets `human_topics` (JSON array), `confidence`, and `reviewed_at` on the specified event
- Returns `INVALID_QUERY` error if event_id not found in training set
- Re-labeling an already-reviewed event overwrites `human_topics`, `confidence`, and `reviewed_at` — correcting a label should not require regenerating the set
- Topic IDs are validated against the current taxonomy (`topics.yaml`). Unknown topic IDs produce a warning in the response (not an error) — the taxonomy may evolve after a training set is generated
- More than 3 topics produces a warning: `"Labeling convention is ≤3 topics; got <n>. Proceeding anyway."` — not an error, since the labeler may have a valid reason, but a visible reminder of the calibration target
- Opens training DB in read-write mode via `new Database()` (not `openWriter`)
- To assign no topics: `--topics ""` sets `human_topics` to `[]`

#### `intel training-set progress <training-db>`

Show labeling progress for a training set.

```
intel training-set progress /path/to/training.db
```

**Output:**
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

**Behavior:**
- Opens training DB in `readonly` mode
- `pct_complete` is a ratio in [0.0, 1.0], rounded to 3 decimal places (consistent with spec 015's `unclassified_pct` and `multi_topic_pct` conventions)

### Shared Behavior

- All `training-set` subcommands inherit the top-level `--format` option and support text output via the existing `output()` function.

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

The orchestrating agent iterates in batches of 10 events:

1. Call `intel training-set next <db> --limit 10 --blind` to get a batch of unreviewed events (machine labels omitted to prevent anchoring)
2. Spawn up to 10 subagents in parallel (via Task tool), each with one event's `title`, `content`, `url`, `source`, `feed`, and the topic taxonomy from Phase 2
3. Each subagent reads its event independently, assigns 1-3 topics, and returns the classification
4. As subagents complete, the orchestrating agent calls `intel training-set label <db> <event-id> --topics <csv> --confidence <score>` for each result
5. Periodically call `intel training-set progress <db>` to check completion
6. Repeat until `remaining` reaches 0 or `--max-events` limit is reached

At ~3,331 events with batches of 10, this requires ~333 iterations. Each batch runs subagents concurrently, keeping wall-clock time practical. Independence is preserved because each subagent receives only its own event — no shared context between events in a batch.

**Cost estimate**: Each subagent receives the taxonomy (~2K tokens) plus one event (~500 tokens avg) and returns a short classification (~100 tokens). At ~3,331 events, full classification ≈ 8.3M input tokens + 0.3M output tokens. Using haiku-class subagents is recommended for this task — topic classification from a fixed taxonomy is well within haiku's capabilities, and the 10-20x cost reduction vs. sonnet makes full-set labeling practical. Sonnet-class subagents can be used for a validation subset if higher accuracy is needed.

**Partial labeling**: Full classification of ~3,331 events is a significant resource commitment. The workflow supports interruption and resumption — since `next --blind` returns only unreviewed events, the operator can stop at any point and resume later. The SKILL.md workflow should accept an optional event count (e.g., "classify 500 events") to enable incremental labeling sessions. Partial training sets are still useful for precision estimates on topics with sufficient samples (≥30).

### Subagent Classification Protocol

Each subagent receives:
- The event's `title`, `content`, `url`, `source`, and `feed` (from `next --blind` output — no machine labels)
- The full topic taxonomy from `intel topics` (captured once in Phase 2)
- Instructions to assign 1-3 topics with confidence

**Content size**: RSS feed content varies — some events have only a title, others include full article text. The classifier itself caps input at 3,000 characters, but subagents receive the full `content` since LLMs can handle longer text. If token cost is a concern, the orchestrating agent may truncate `content` to a reasonable limit (e.g., 5,000 characters) before passing to subagents.

The subagent must:
1. Read the event content independently (not anchor on `machine_topics`)
2. Match the event's primary subject matter against the taxonomy
3. Assign **1-3 topics** — no more, to avoid the over-classification problem
4. Set confidence to **1.0** (default). Subagent self-reported confidence is not calibrated — treat it as a binary "classified / not classified" signal rather than a probability. The `confidence` field exists primarily for human reviewers who can meaningfully distinguish certainty levels. Subagents should use `1.0` for all assigned topics and omit topics they would rate below 0.5.
5. If no topic matches, return empty topics with confidence 0.0

### Why Subagents (not batch classification)

- **Independence**: Each classification is independent — no anchoring on previous events
- **Context isolation**: Subagent context is limited to the single event + taxonomy, preventing drift
- **Parallelism**: Multiple subagents can run concurrently (the training DB handles concurrent reads; label writes are serialized by SQLite's WAL)
- **Auditability**: Each classification is a separate, traceable operation

### Guardrails

- Do not modify the source intelligence database
- Do not skip events — even uninteresting events must be classified (or marked as no-topic) for unbiased precision measurement
- Do not assign more than 3 topics per event — this is the labeling convention to calibrate against over-classification
- Always use `--blind` when fetching events for subagent classification — machine labels must not appear in the subagent prompt
- Batch size of 10 is the default — each subagent in a batch still receives only one event, preserving independence

---

## E. Implementation

### File Structure

```
tools/intelligence/src/
├── queries/
│   └── training.ts          — NEW: generateTrainingSet, updateTrainingLabel, trainingProgress, getNextUnreviewed
└── bin.ts                   — MODIFY: add training-set command group

skills/intel/
└── SKILL.md                 — MODIFY: add Training Data Generation workflow section

tools/intelligence/tests/
└── training.test.ts         — NEW: test suite for training module
```

### Internal Functions

| Function | File | Description |
|----------|------|-------------|
| `generateTrainingSet(db, opts)` | `queries/training.ts` | Reservoir sample → create training DB → insert samples + metadata. Returns `IntelResponse<TrainingSetResult>` |
| `updateTrainingLabel(db, eventId, label)` | `queries/training.ts` | Set human_topics + confidence + reviewed_at. Returns `IntelResponse<TrainingLabelResult>` |
| `trainingProgress(db)` | `queries/training.ts` | Count total/reviewed/remaining. Returns `IntelResponse<TrainingProgressResult>` |
| `getNextUnreviewed(db, limit, blind?)` | `queries/training.ts` | SELECT where reviewed_at IS NULL ORDER BY id LIMIT ?. When `blind=true`, omits machine_topics/machine_confidences. Returns `IntelResponse<UnreviewedEvent[]>` |

### Types

```typescript
export interface TrainingSetOpts {
  sampleRate: number;      // (0.0, 1.0], default 0.1
  outputPath?: string;     // override output DB path
  sourceDbPath: string;    // for metadata recording
  seed?: number;           // PRNG seed for reproducibility (omit for non-deterministic)
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
  confidence: number;      // [0.0, 1.0]
}

export interface TrainingLabelResult {
  event_id: string;
  human_topics: string[];
  confidence: number;
  reviewed_at: string;
}

export interface TrainingProgressResult {
  total: number;
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
  machine_topics?: string[];       // omitted when blind=true
  machine_confidences?: number[];  // omitted when blind=true
  published_at: string | null;
  fetched_at: string;
  score: number;
  comments: number;
}
```

### Dependencies

No new dependencies. Uses `better-sqlite3` (already a dependency) for the training database.

---

## F. Tests

### Test Cases

**File**: `tools/intelligence/tests/training.test.ts`

**`generateTrainingSet` (7 tests)**:
1. Creates training database with correct sample size (100 seeded events × 0.1 = 10 samples)
2. Stores metadata correctly in `training_meta` (algorithm, sample_rate, total_events, source_db, classifier_config_sha256)
3. Errors on empty database (0 events → `INVALID_QUERY` status)
4. Errors when output path already exists (`INVALID_QUERY` status)
5. All sampled events have `human_topics IS NULL` initially
6. `machine_topics` contains valid JSON arrays from source events
7. Sample size respects `--sample-rate` (0.2 rate on 100 events → 20 samples)

**`updateTrainingLabel` (3 tests)**:
8. Sets `human_topics`, `confidence`, and `reviewed_at` on a valid event
9. Returns `INVALID_QUERY` error for non-existent event_id
10. Empty topics list stores `[]` (valid JSON, distinct from NULL)

**`trainingProgress` (2 tests)**:
11. Reports correct counts before and after labeling
12. `pct_complete` is 0.0 with no reviews, approaches 1.0 as reviews complete

**`getNextUnreviewed` (3 tests)**:
13. Returns unreviewed events ordered by `id`
14. Returns empty array when all events are reviewed
15. Respects `limit` parameter

**`getNextUnreviewed` with `--blind` (1 test)**:
16. Omits `machine_topics` and `machine_confidences` when blind option is set

**`reservoir sampling uniformity` (1 test)**:
17. Statistical test: run sampling 1,000 times on a 100-element dataset at 10% rate. Collect each element's selection frequency and apply a **chi-squared goodness-of-fit test** against the expected uniform distribution (each element selected with p = 0.10). Use α = 0.001 (chi-squared critical value for 99 df ≈ 148.23). This tests the aggregate distribution in a single assertion, avoiding the ~10% false positive rate inherent in 100 independent per-element binomial tests. Tag with extended timeout (e.g., `{ timeout: 30_000 }`) — this is compute-intensive and will be the slowest test in the suite.

### Test Fixtures

- Seeded database with 100 events via `openWriter` + direct inserts
- Temp directory cleanup in `afterEach`
- Follows `tests/journal.test.ts` pattern (mkdtempSync, rmSync)

---

## G. Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_SAMPLE_RATE` | `0.1` | Default fraction of events to sample |
| `MIN_SAMPLE_RATE` | `0.001` | Minimum sample rate (prevent accidentally tiny samples) |
| `MAX_SAMPLE_RATE` | `1.0` | Maximum sample rate (full dataset) |
| `MAX_NEXT_LIMIT` | `50` | Maximum events returned by `next` command |

---

## H. Risks

| Risk | Mitigation |
|------|-----------|
| Memory for large databases | At 10% of 100K events = 10K rows × ~2KB metadata + variable content = ~20-60MB. Well within Node.js heap. For 1M+ events, consider streaming to training DB during sampling. |
| Training DB not managed by migrations | Intentional — training DBs are ephemeral artifacts. If schema changes, regenerate the training set. |
| Subagent classification quality | LLM classification is a proxy for human labeling — but at scale it provides a stronger signal than no labeled data. Quality can be validated by sampling a subset for human review. Subagent confidence scores are treated as binary (assigned / not assigned) since LLM self-reported confidence is uncalibrated — do not use confidence values from subagents for threshold decisions. |
| Concurrent label writes | SQLite WAL handles this safely. Sequential processing is the default; concurrent subagents work but writes are serialized by SQLite. |
| Sampling bias from `ORDER BY id` | Deterministic iteration order for reproducibility. Since `id` is auto-increment and events are inserted chronologically, this produces a temporally representative sample. |
| Cross-source duplicates in sample | The same story may appear from multiple sources (e.g., HN + RSS) with different `event_id` values. Reservoir sampling operates on `event_id`, so both may appear in the sample. The `canonical_url` column enables dedup in volume queries (spec 015) but the training set intentionally preserves duplicates — they test whether the classifier produces consistent labels across sources. |

---

## I. Decision Summary

| Decision | Selected | Rationale |
|----------|----------|-----------|
| Reservoir sampling (Algorithm R) | O(n) single-pass, O(k) memory | Optimal for large datasets; uniform probability; no temp tables or multi-pass. Optional seeded PRNG for reproducibility. |
| Standalone training database | Separate SQLite file | Different lifecycle than operational data; can be shared/versioned/discarded independently |
| 10% default sample rate | `DEFAULT_SAMPLE_RATE = 0.1` | At 33K events → ~3.3K samples; sufficient for per-topic precision with ≥30 samples per active topic |
| Add to existing intel SKILL.md | New section, not new skill | Training data generation is an intel operation; adding a new top-level skill would fragment the intel workflow |
| Blind mode for `next` command | `--blind` omits machine labels | Structurally prevents anchoring bias — subagents cannot see classifier output even if orchestrating agent doesn't filter |
| Batch confidence query | Single `IN` query, not per-event | Avoids N+1 overhead during training set generation; chunked at 500 for SQLite variable limits |
| Store `classifier_config_sha256` | SHA-256 of `topic-classifier.ts` | Ties machine labels to a specific classifier version — enables tracing whether labels came from old or new classifier |
| Batched subagent classification | 10 subagents per batch, each classifying one event | Prevents anchoring (one event per subagent), enables parallelism (10x throughput vs sequential), practical for ~3K events |
| No MCP exposure for training commands | CLI only | Training is an occasional operation, not a real-time agent tool; CLI is sufficient |
| `human_topics` nullable vs empty array | NULL = unreviewed, `[]` = no topics | Distinguishes "not yet looked at" from "intentionally no topic" — critical for progress tracking |
| Max 3 topics per training label | Labeling convention | Calibrates against the 4+ over-classification threshold (spec 015); if labels rarely need 3, the classifier is over-tagging |
| JSON storage for topics | Consistent with `events.topics` | Same format, same parsing, enables direct comparison |
| Relabel overwrites previous label | Idempotent update | Correcting a label should not require regenerating the training set |
| Topic validation as warning, not error | Warn on unknown topic IDs | Taxonomy evolves; training sets may outlive a given `topics.yaml` version |
| Store `topics_yaml_sha256` in metadata | SHA-256 hash of topics.yaml | Ties training set to a taxonomy version for meaningful precision/recall evaluation |
| Partial index on unreviewed events | `WHERE reviewed_at IS NULL` on `id` | Trivially cheap; accelerates `next` queries; consistent with "scales correctly" design philosophy |
| Warn on >3 topics in `label` | Warning, not error | Reminds labeler of calibration target without blocking legitimate multi-topic assignments |
| Haiku-class subagents | Default model recommendation | Topic classification from a fixed taxonomy is within haiku's capabilities; 10-20x cost reduction makes full-set labeling practical |
| Binary subagent confidence | Subagents use 1.0 for all assigned topics | LLM self-reported confidence is uncalibrated; binary signal (assigned / not assigned) is the useful ground truth |
| Phase 1: BM25 before ML | BM25 scoring ships without training data | Fixes most damaging problems immediately (substring matching, no term weighting); validates tokenizer and IDF code reused by Phase 2; buys time for labeled training data |
| Phase 2: Complement Naive Bayes | CNB over logistic regression, embeddings, or fastText | Zero new dependencies (pure TypeScript); designed for class imbalance; calibrated with Platt scaling; interpretable per-term contributions; 12 positive examples viable via complement formulation |
| Not sentence embeddings | Rejected MiniLM/ONNX approach | ~60MB dependency footprint; poor interpretability (384-dim vectors); cosine similarity poorly calibrated; overkill for vocabulary-driven taxonomy |
| Not fastText | Rejected native binding approach | Native addon portability issues; less maintained npm bindings; dependency weight unjustified vs pure-TS CNB |
| Not LLM triage | Rejected API-based classification | Violates offline operation constraint; poorly calibrated confidence; API dependency for core pipeline function |
| Phased rollout | BM25 → CNB, not single-step ML | Training data doesn't exist yet; BM25 is a validated intermediate step; BM25 code (tokenizer, IDF) is reused by Phase 2's TF-IDF vectorizer |

---

## J. Classifier Evolution Path

### Purpose

The training data infrastructure (§A-F) exists to measure and improve classifier quality. This section describes the phased evolution of the classifier algorithm itself — the intended consumer of the labeled training data.

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

**Changes:**

1. **Tokenized BM25 scoring engine** — new file `src/collector/bm25.ts`
   - Word-boundary tokenization (eliminates "chip"/"archipelago", "react"/"reactive" false matches)
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

**Files:**
- `src/collector/topic-classifier.ts` — rewrite `matchesTopic()` to use BM25
- `src/collector/bm25.ts` — new: BM25 engine + tokenizer
- `config/topics.yaml` — add `negative_keywords` per topic
- `tests/topics.test.ts` — update tests for BM25 scoring

**Expected impact:**
- Over-classification (4+ topics): 24.5% → <10%
- False positives from substring matching: eliminated
- Unclassified rate: may increase slightly (acceptable — false negatives are less damaging than false positives for chain analysis)

**Dependency on training data:** None. Phase 1 ships independently.

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

**Components:**
- `src/collector/tfidf.ts` — TF-IDF vectorizer (sub-linear TF, L2 normalization, 10-20K vocabulary)
- `src/collector/naive-bayes.ts` — Complement NB (66 binary classifiers, sparse log-theta vectors)
- `src/collector/platt.ts` — Platt scaling (sigmoid calibration, 2 parameters per topic)
- CLI command: `intel classifier train <training-db>` — offline training pipeline
- Model file: single JSON (~500KB-2MB), versioned, loaded on startup

**Model serialization format:**

```typescript
interface ClassifierModel {
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
```

**Fallback strategy:** Topics with <20 training examples fall back to Phase 1 BM25 scoring. As training data grows, fewer topics use the fallback.

**Integration with existing learning loop:** The Brier score feedback loop (spec 007, §J2) already updates `topic_weights`. Phase 2's calibrated probabilities feed more meaningful scores into this loop. The `topicWeight` multiplier is retained as an online correction factor that adjusts for classifier drift between retraining cycles.

**Dependency on training data:** Requires a completed (or partially completed) training set from §A-F with ≥500 labeled events.

### Phase 3: Continuous Improvement Loop

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

1. **Precision/recall computation**: Once a training set is fully labeled, compute per-topic precision (% of machine labels confirmed by human labels) and recall (% of human labels present in machine output). This would be a new `intel training-set evaluate <db>` command.

2. **Classifier regression tests**: Extract high-confidence labels from completed training sets into a fixed test suite that runs on CI. Prevents classifier regressions when keywords, BM25 thresholds, or CNB models are modified.

3. **Active learning**: Use initial labeling results to identify topics with low precision and over-sample events from those topics in subsequent training sets. In Phase 3, bias sampling toward events where the classifier is uncertain (confidence 0.3-0.7).

4. **Adaptive batch sizing**: The current workflow uses a fixed batch of 10 subagents (a SKILL.md convention, not a code constant). A future optimization could tune batch size based on available concurrency and error rates.

5. **Inter-rater reliability**: Double-label a random subset (e.g., 5%) by running classification twice — once with haiku, once with sonnet — and compute Cohen's kappa to estimate inter-rater agreement. Low agreement on specific topics would indicate ambiguous taxonomy definitions (feeding back into spec 013's topic lifecycle). This is cheap to implement: generate a second training set with the same seed (identical sample), classify with a different model, and compare `human_topics` across the two databases.

6. **Confidence-weighted chain detection**: Once Phase 2 produces calibrated confidence scores, chain detection (spec 007) can weight co-occurrences by confidence rather than treating all topic assignments equally. A 0.95-confidence assignment contributes more than a 0.55-confidence assignment.

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

sqlite3 <training-db-path> "SELECT key, value FROM training_meta"
# Expected: 9 rows (created_at, source_db, sample_size, total_events, sample_rate, seed, topics_yaml_sha256, classifier_config_sha256, algorithm)

sqlite3 <training-db-path> "SELECT COUNT(*) FROM training_events WHERE human_topics IS NULL"
# Expected: same as total count (all unreviewed)

# 5. Fetch next unreviewed event (blind mode for classification workflow)
intel training-set next <training-db-path> --blind
# Expected: JSON with 1 event including title, content — no machine_topics or machine_confidences

# 6. Label an event
intel training-set label <training-db-path> <event-id> --topics "ai.foundation-models,compute.gpu" --confidence 0.9
# Expected: JSON with human_topics, confidence, reviewed_at

# 7. Check progress
intel training-set progress <training-db-path>
# Expected: total ~3331, reviewed 1, remaining ~3330, pct_complete ~0.000
```

### Phase 1: BM25 scoring (§J)

```bash
# 1. Run collection and compare topic assignments
intel collect --once
intel stats
# Expected: multi_topic_pct (over-classification) < 0.10 (down from 0.245)

# 2. Spot-check known false positives are eliminated
# Search for events previously misclassified (e.g., non-tech content tagged with tech topics)
intel events --topic macro.energy --since 24h --limit 10
# Expected: no medieval manuscripts, no figurative "electricity" references

# 3. Verify negative keywords suppress correctly
# Check topics.yaml negative_keywords are loaded and applied

# 4. Test suite passes with BM25 threshold tests
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
