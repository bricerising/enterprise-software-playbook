# Spec 014: Forecast Confidence Gates

**Amends [spec 007](007-intelligence-forecast-module.md).**

## Problem

The forecast engine (spec 007) produces lifecycle phases, chain co-movement patterns, and scenario projections from the event database. However, it treats all data as equally trustworthy regardless of volume, age, or coverage. The Q1 2026 blind spot audit identified three gaps where insufficient data produces misleading outputs:

1. **Cold-start overconfidence** — A topic with 12 days of data receives the same `phase_confidence` as one with 120 days. The lifecycle classifier assigns phases like "emerging" or "accelerating" based on acceleration vectors, but acceleration from 0 → 3 events over 12 days is noise, not signal. Consumers have no way to distinguish "confidently emerging" from "we barely have data."

2. **Spurious chains from low-volume topics** — Chain detection (spec 007 §B) requires only `min_support >= 2` co-occurrence pairs. Two topics that each have 8 total events can produce a chain with support=2 and lift=4.0 — statistically "significant" but practically meaningless. The chain looks identical to one backed by 500 events per topic.

3. **Scenario probability collapse** — Scenario probabilities (the `probability` field on `ScenarioItem` — spec 007's softmax-normalized output) are rounded to 2 decimal places (`Math.round(x * 100) / 100`). When many scenarios cluster near 0.005, they all round to 0.01 and become indistinguishable. The rounding also masks a degenerate state: when all scenario probabilities are below 0.01, the output contains only zeros — a silent failure.

All three issues share a root cause: the forecast engine lacks confidence gates that distinguish "real signal" from "insufficient data."

## Goal

Add confidence gates to the forecast engine that:

1. Flag lifecycle items computed from insufficient data (`cold_start`, `insufficient_data`)
2. Assign confidence tiers to every chain based on underlying topic volume, source diversity, and support
3. Increase scenario `probability` rounding precision and warn when probabilities collapse
4. Surface a top-level `data_quality` object on every forecast response so consumers can assess data sufficiency without inspecting individual items

All changes are additive — existing fields retain their semantics. New fields are either optional booleans (omitted when false) or required enums/objects (always present). Note: adding new required fields (`confidence_tier`, `min_chain_tier`, `data_quality`) changes the response shape — consumers that perform strict JSON schema validation will need to update their schemas. See the schema version note in Risks.

## Non-Goals

- Changing the lifecycle phase classification algorithm (spec 007 §A)
- Changing the chain detection SQL or statistical metrics (spec 007 §B)
- Changing the Bayesian scenario projection formula (spec 007 §C)
- Adding new CLI flags or MCP tool parameters
- Modifying data retention or collection behavior (see spec 015 for collection-side controls)

## Scope

| In scope | Out of scope |
|----------|-------------|
| Lifecycle cold-start flag and confidence cap | Custom cold-start thresholds per topic |
| Insufficient-data flag for low-volume topics | Minimum volume enforcement (events are still classified) |
| Chain confidence tiers (spurious/low/moderate/high) | Chain filtering by tier (consumers decide) |
| Scenario `probability` rounding precision increase (2→3 decimal places) | Scenario algorithm changes |
| Top-level `data_quality` object on ForecastData | Historical data quality tracking |
| Warning when all scenario probabilities < 0.01 | Automatic fallback behavior |

---

## A. Lifecycle Cold-Start Guard

### Purpose

Prevent the lifecycle classifier from producing high-confidence phases when the underlying data is too young or too sparse to support them. A topic in cold-start mode may still have a phase assignment, but consumers know to treat it as provisional.

### Algorithm

**Step 1: Compute data age**

In `computeForecast()`, before lifecycle computation, query the event timestamp range. This queries `events` directly (no join to `event_topics`) because cold-start measures *system maturity*, not classified-event maturity — excluding unclassified events would understate data age if early events were predominantly unclassified:

```sql
SELECT
  MIN(COALESCE(published_at, fetched_at)) AS min_ts,
  MAX(COALESCE(published_at, fetched_at)) AS max_ts
FROM events e
WHERE e.fetched_at >= :window_start;
```

```typescript
const data_age_days = (min_ts == null || max_ts == null)
  ? 0  // no events in window, or all timestamps NULL — treat as zero-age
  : Math.floor(
      (new Date(max_ts).getTime() - new Date(min_ts).getTime()) / (1000 * 60 * 60 * 24)
    );
```

**NULL guard:** `COALESCE(published_at, fetched_at)` returns `NULL` only when both columns are `NULL`. In practice `fetched_at` is always set at ingestion, but `computeDataSpan` should guard against `NULL` min/max timestamps (which produce `NaN` via `new Date(null)`) by returning `data_age_days: 0` — the same safe default used for an empty dataset.

**Step 2: Cold-start flag and graduated confidence cap**

When `data_age_days < MIN_LIFECYCLE_DAYS` (90):

- Set `cold_start: true` on every `LifecycleItem`
- Apply a graduated confidence cap that scales linearly from `MIN_COLD_START_CONFIDENCE` (0.3) at 0 days to 1.0 at 90 days. This avoids a sharp discontinuity at the 90-day boundary — day 89 data gets a cap of ~0.99 rather than jumping from 0.5 to uncapped.

```typescript
if (data_age_days < MIN_LIFECYCLE_DAYS) {
  const capFraction = data_age_days / MIN_LIFECYCLE_DAYS; // 0.0–1.0
  const confidenceCap = MIN_COLD_START_CONFIDENCE + capFraction * (1.0 - MIN_COLD_START_CONFIDENCE);

  for (const item of lifecycles) {
    item.cold_start = true;
    item.phase_confidence = Math.min(item.phase_confidence, confidenceCap);
  }
}
```

At representative data ages:
| `data_age_days` | `confidenceCap` |
|-----------------|-----------------|
| 0 | 0.30 |
| 30 | 0.53 |
| 60 | 0.77 |
| 89 | 0.99 |
| 90+ | uncapped |

**Short-window note:** Analysis windows shorter than `MIN_LIFECYCLE_DAYS` (90) will always trigger cold-start — e.g., `--window 30` produces `data_age_days ≈ 30` and `cold_start: true` on every lifecycle item regardless of system age. This is intentional: lifecycle acceleration vectors computed from < 90 days of data are less reliable even if the system has been running for years. The graduated cap ensures these short-window forecasts still return useful (if attenuated) results rather than being suppressed entirely.

**Step 3: Insufficient-data flag**

For each topic, count events in the analysis window:

```sql
SELECT et.topic, COUNT(*) AS event_count
FROM event_topics et
JOIN events e ON e.event_id = et.event_id
WHERE e.fetched_at >= :window_start
GROUP BY et.topic;
```

When a topic has `event_count < MIN_TOPIC_EVENTS` (50):

- Set `insufficient_data: true` on that topic's `LifecycleItem`

```typescript
if (topicEventCount < MIN_TOPIC_EVENTS) {
  item.insufficient_data = true;
}
```

### Interface Changes

```typescript
interface LifecycleItem {
  // ... existing fields from spec 007 ...
  cold_start?: boolean;         // true when data_age_days < 90; omitted when false
  insufficient_data?: boolean;  // true when topic has < 50 events; omitted when false
}
```

Both flags are optional booleans, omitted when false. This is backward compatible — existing consumers that don't check these fields continue to work unchanged.

**Interpreting the flags in combination:** The two flags measure different things — `cold_start` reflects system maturity (global data age), while `insufficient_data` reflects topic-level volume. They can appear independently:

| `cold_start` | `insufficient_data` | Interpretation |
|---|---|---|
| true | true | Young system AND sparse topic — lowest confidence; treat phase as speculative |
| true | absent | Young system but topic has reasonable volume — phase direction may be right, but acceleration history is incomplete |
| absent | true | Mature system but niche topic — other topics are reliable, but this one lacks volume for meaningful phase classification |
| absent | absent | Sufficient data on both dimensions — phase classification is well-supported |

Consumers should treat either flag as a reason to lower trust in the phase assignment. When both are present, the lifecycle item is at its least reliable.

**`--section` filtering note:** The `cold_start` and `insufficient_data` flags only appear on lifecycle items — when the lifecycle section is excluded via `--section` filtering, no lifecycle items exist and these flags are absent from the response. The `data_quality.cold_start` boolean (§D) is always present regardless of section filtering and reflects the same data-age condition, so consumers using `--section scenarios` (without lifecycles) can still assess cold-start status via `data_quality`.

### Files

| File | Change |
|------|--------|
| `forecast/types.ts` | Add `cold_start?` and `insufficient_data?` to `LifecycleItem` |
| `forecast/lifecycle.ts` | Apply cold-start cap and insufficient-data flag after phase classification |
| `forecast/index.ts` | Compute `data_age_days` via shared utility; pass to lifecycle computation |
| `queries/shared.ts` | Extract `computeDataSpan(db, windowStart?)` — shared timestamp-range query used by both forecast (window-scoped) and stats (all-time). Extract `computeTopicCounts(db, windowStart)` — shared per-topic event count query used by lifecycle (§A Step 3) and chains (§B). Prevents shared SQL from drifting between call sites. |

---

## B. Chain Minimum Volume Gate

### Purpose

Classify every chain by the quality of its underlying data. A chain between two high-volume, multi-source topics is fundamentally more trustworthy than one between two topics with barely enough events to produce a co-occurrence. The confidence tier makes this distinction explicit without filtering chains out.

### Algorithm

For each chain, evaluate three signals from the underlying topic data:

1. **Topic volume** — event count for both `from_topic` and `to_topic` in the analysis window (computed in §A Step 3)
2. **Source diversity** — the chain's existing `source_diversity` field (spec 007 §B)
3. **Support** — the chain's existing `support` field

Assign tier via cascading evaluation — disqualify first (`spurious`), then check from most restrictive (`high`) to least (`moderate`), defaulting to `low`:

| Tier | Topic volume (both) | Source diversity | Support | Interpretation |
|------|-------------------|-----------------|---------|---------------|
| `spurious` | Either < 50 | any | any | Insufficient topic data; chain may be noise |
| `high` | Both ≥ 500 | ≥ 0.6 | ≥ 30 | Strong multi-source signal |
| `moderate` | Both ≥ 100 | ≥ 0.5 | ≥ 10 | Reasonable data backing |
| `low` | *(fallthrough)* | | | Anything that passes `spurious` but doesn't qualify for `moderate` or `high` |

The `low` tier is a catch-all for chains that have sufficient topic data (both ≥ 50) but fail to meet `moderate` criteria. This includes: topics with 50–99 events regardless of diversity/support, topics with ≥ 100 events but low diversity (< 0.5), topics with ≥ 100 events and adequate diversity but low support (< 10), etc.

Evaluation order: check `spurious` first, then `high` (most restrictive), then `moderate`, then default to `low`.

```typescript
function assignConfidenceTier(
  chain: ChainItem,
  topicCounts: Map<string, number>,
): ConfidenceTier {
  const fromCount = topicCounts.get(chain.from_topic) ?? 0;
  const toCount = topicCounts.get(chain.to_topic) ?? 0;
  const minCount = Math.min(fromCount, toCount);

  if (minCount < MIN_CHAIN_TOPIC_EVENTS) return 'spurious';

  if (
    minCount >= CHAIN_TIER_HIGH_VOLUME &&
    chain.source_diversity >= CHAIN_TIER_HIGH_DIVERSITY &&
    chain.support >= CHAIN_TIER_HIGH_SUPPORT
  ) return 'high';

  if (
    minCount >= CHAIN_TIER_MODERATE_VOLUME &&
    chain.source_diversity >= CHAIN_TIER_MODERATE_DIVERSITY &&
    chain.support >= CHAIN_TIER_MODERATE_SUPPORT
  ) return 'moderate';

  return 'low';
}
```

### Interface Changes

```typescript
type ConfidenceTier = 'spurious' | 'low' | 'moderate' | 'high';

interface ChainItem {
  // ... existing fields from spec 007 ...
  confidence_tier: ConfidenceTier;  // required; always present
}
```

`confidence_tier` is a **required** field on `ChainItem` — not optional. Every chain has a tier. This propagates to `RankedChainItem` (which extends `ChainItem`) and is available for scenario projection consumers.

**Relationship to the existing `confidence` field:** `ChainItem` already has a `confidence: number` field (spec 007 §B) — a statistical metric measuring how reliably the trigger topic predicts the target (`support / spike_days_A`). The new `confidence_tier` is a *data-quality* classification measuring whether the chain has sufficient underlying data to be trustworthy. They are complementary, not redundant: a chain can have high statistical `confidence` (0.9) but a `spurious` tier (because both topics have < 50 events — the 0.9 is computed from too little data to be meaningful).

### Files

| File | Change |
|------|--------|
| `forecast/types.ts` | Add `ConfidenceTier` type and `confidence_tier` field to `ChainItem` |
| `forecast/chains.ts` | Compute tier for each chain after detection; accepts topic count map |

---

## C. Scenario Probability Floor

### Purpose

Increase probability precision so that closely-ranked scenarios remain distinguishable, and surface a warning when all scenarios collapse to near-zero probabilities (indicating insufficient chain data for meaningful projection).

### Algorithm

**Step 1: Increase rounding precision**

Change scenario `probability` rounding from 2 to 3 decimal places:

```typescript
// Before (spec 007):
probability: Math.round(probability * 100) / 100

// After:
probability: Math.round(probability * 1000) / 1000
```

This preserves probabilities like 0.005 and 0.003 that previously both rounded to 0.01.

**Why round at all:** Rounding prevents floating-point representation noise (e.g., `0.004999999999999997` from softmax arithmetic) from leaking into JSON output and confusing consumers who compare probabilities across runs. Three decimal places retain enough precision for ranking while keeping output clean. The `SCENARIO_DECIMAL_PLACES` constant makes this tunable if 3 proves insufficient. Note: `probability` is spec 007's temperature-scaled softmax output — the values are softmax-normalized and sum to ~1.0, but should be used for ranking, not real-world likelihood estimation.

**Step 2: Propagate worst chain tier to scenarios**

Each scenario is derived from one or more chains. The scenario inherits the *worst* (lowest) confidence tier among its contributing chains, so consumers can assess whether the scenario's data foundation is trustworthy without inspecting individual chains.

**Accessing contributing chains:** Spec 007's `ScenarioItem` exposes `trigger_topics: string[]` and `supporting_chains: number` (a count), but not the chain objects themselves. During scenario construction in `scenarios.ts`, the builder already iterates over the active `RankedChainItem[]` that contribute to each scenario (to compute `supporting_chains` and `trigger_topics`). The `min_chain_tier` computation hooks into this same loop — it reads `confidence_tier` from each contributing chain during construction, before the chain references are discarded. No new data structure is needed; the tier is resolved at build time.

```typescript
const tierOrder: Record<ConfidenceTier, number> = {
  spurious: 0, low: 1, moderate: 2, high: 3,
};

// Invariant: tiers is non-empty — every scenario has >= 1 contributing chain.
// Defensive fallback to 'spurious' + error log instead of throwing, so a bug in
// scenario construction degrades the tier rather than crashing the forecast command.
function worstTier(tiers: ConfidenceTier[]): ConfidenceTier {
  if (tiers.length === 0) {
    logger.error('worstTier called with empty tiers array — returning spurious as fallback');
    return 'spurious';
  }
  return tiers.reduce((worst, t) =>
    tierOrder[t] < tierOrder[worst] ? t : worst
  );
}

// During scenario construction, while iterating contributing chains:
scenario.min_chain_tier = worstTier(
  contributingChains.map(c => c.confidence_tier)
);
```

A scenario built entirely from `spurious` chains will have `min_chain_tier: 'spurious'`, making it immediately apparent that the projection lacks reliable chain data — even if the probability itself looks reasonable.

**Step 3: Low-probability warning**

After scenario computation, check if all scenario probabilities are below 0.01:

```typescript
if (scenarios.length > 0 && scenarios.every(s => s.probability < 0.01)) {
  warnings.push(
    'All scenario probabilities are below 0.01 — chain data may be insufficient for meaningful projection. ' +
    'Consider widening the analysis window or lowering min_support.'
  );
}
```

The warning is added to the `IntelResponse` envelope's `warnings` array. No scenarios are removed.

### Interface Changes

```typescript
interface ScenarioItem {
  // ... existing fields from spec 007 ...
  min_chain_tier: ConfidenceTier;  // worst confidence tier among contributing chains
}
```

`min_chain_tier` is a **required** field. `probability` remains `number` (now rounded to 3 decimal places instead of 2). `warnings` is already `string[]` on the envelope.

### Files

| File | Change |
|------|--------|
| `forecast/types.ts` | Add `min_chain_tier` field to `ScenarioItem` |
| `forecast/scenarios.ts` | Change `probability` rounding from `* 100 / 100` to `* 1000 / 1000`; compute `min_chain_tier` from contributing chains |
| `forecast/index.ts` | Add low-probability warning check after scenario computation |

---

## D. Data Quality Object

### Purpose

Surface a top-level summary of data quality on every forecast response so consumers can quickly assess whether the forecast is based on sufficient, balanced data — without inspecting individual lifecycle items or chains.

### Algorithm

Compute the following metrics during `computeForecast()`:

```typescript
const data_quality: DataQuality = {
  data_age_days,                                        // from §A Step 1
  cold_start: data_age_days < MIN_LIFECYCLE_DAYS,       // from §A Step 2
  total_events: events_analyzed,                        // from window query
  lifecycle_topic_count: lifecycles.length,                  // denominator for insufficient_data_pct
  insufficient_data_count: countInsufficientData(lifecycles), // from §A Step 3
  insufficient_data_pct: lifecycles.length > 0             // from §A Step 3; 0 when no lifecycle items
    ? Math.round((countInsufficientData(lifecycles) / lifecycles.length) * 1000) / 1000
    : 0,
  window_unclassified_pct: unclassifiedCount / totalCount, // events with empty topics array (window-scoped)
  window_top_source_name: topSourceRow.source,                 // name of the most prolific source
  window_top_source_pct: topSourceCount / totalCount,          // largest source's share
  chain_tier_counts: countChainTiers(chains),           // from §B tier assignment
};
```

**`lifecycle_topic_count` / `insufficient_data_count` / `insufficient_data_pct`** — total lifecycle topics, count flagged, and fraction of topics in the lifecycle output that have `insufficient_data: true` (fewer than `MIN_TOPIC_EVENTS` events in the analysis window). `lifecycle_topic_count` makes `DataQuality` self-contained — consumers can verify the percentage without inspecting the lifecycle array. The count provides a lifecycle-level summary parallel to `chain_tier_counts`; the percentage (rounded to 3 decimal places for consistency with `window_unclassified_pct` and `window_top_source_pct`) makes it immediately interpretable ("32% of topics have insufficient data" vs "12 topics"). When the lifecycle section is excluded via `--section` filtering, all three are 0 (no lifecycle items exist to be flagged). The percentage guards against division by zero (`lifecycles.length > 0` check).

```typescript
function countInsufficientData(lifecycles: LifecycleItem[]): number {
  return lifecycles.filter(item => item.insufficient_data === true).length;
}
```

**`window_unclassified_pct`** — fraction of events in the analysis window where the classifier assigned zero topics (the `topics` JSON array is `[]`). Scoped to the analysis window, not all-time. Named `window_unclassified_pct` (not `unclassified_pct`) to disambiguate from spec 015's all-time `StatsData.unclassified_pct` — see Cross-References for the scoping rationale.

```sql
SELECT COUNT(*) AS unclassified
FROM events e
WHERE e.fetched_at >= :window_start
  AND NOT EXISTS (
    SELECT 1 FROM event_topics et WHERE et.event_id = e.event_id
  );
```

**`window_top_source_pct`** — fraction of events from the single most prolific source. High concentration (> 0.5) means the forecast is dominated by one feed's editorial choices.

```sql
SELECT source, COUNT(*) AS cnt
FROM events
WHERE fetched_at >= :window_start
GROUP BY source
ORDER BY cnt DESC
LIMIT 1;
```

### Interface Changes

```typescript
interface ChainTierCounts {
  spurious: number;
  low: number;
  moderate: number;
  high: number;
}

interface DataQuality {
  data_age_days: number;           // days between oldest and newest event in window
  cold_start: boolean;             // true when data_age_days < 90
  total_events: number;            // events analyzed in window
  lifecycle_topic_count: number;   // total lifecycle topics (denominator for insufficient_data_pct)
  insufficient_data_count: number; // topics with insufficient_data: true (< 50 events)
  insufficient_data_pct: number;   // fraction of lifecycle topics with insufficient data (0.0–1.0), 3 decimal places
  window_unclassified_pct: number; // fraction of events with no topic (0.0–1.0), window-scoped
  window_top_source_name: string;  // name of the source with the highest event count, window-scoped
  window_top_source_pct: number;   // fraction from largest source (0.0–1.0), window-scoped
  chain_tier_counts: ChainTierCounts; // distribution of chain confidence tiers
}

interface ForecastData {
  // ... existing fields from spec 007 ...
  data_quality: DataQuality;       // always present; survives --section filtering
}
```

`data_quality` is **always present** on `ForecastData`, even when `--section` filtering is used. It is not a filterable section — it is metadata about the data, not a forecast output section. In `forecast/index.ts`, attach `data_quality` to the response *after* section filtering runs, so it is never subject to section inclusion/exclusion logic. This ensures consumers always have access to quality context regardless of which sections they requested.

**Empty-dataset behavior:** When the analysis window contains zero events (e.g., new installation, aggressive window filtering), `data_quality` is still present with safe defaults: `data_age_days: 0`, `cold_start: true`, `total_events: 0`, `lifecycle_topic_count: 0`, `insufficient_data_count: 0`, `insufficient_data_pct: 0`, `window_unclassified_pct: 0`, `window_top_source_name: ''`, `window_top_source_pct: 0`, `chain_tier_counts: { spurious: 0, low: 0, moderate: 0, high: 0 }`. The `window_unclassified_pct`, `window_top_source_pct`, and `insufficient_data_pct` computations guard against division by zero (`total_events > 0` / `lifecycles.length > 0` checks). **`window_top_source_name` is `''` (empty string), not `null`** — this keeps the type as `string` rather than `string | null`, avoiding null checks in every consumer. An empty string is unambiguous in context: when `total_events` is 0, the source name is meaningless regardless of its value.

### Files

| File | Change |
|------|--------|
| `forecast/types.ts` | Add `ChainTierCounts`, `DataQuality` interfaces (including `lifecycle_topic_count`); add `data_quality` field to `ForecastData` |
| `forecast/index.ts` | Compute `DataQuality` from event queries (using `queries/shared.ts` for `data_age_days`); attach to response; exclude from section filtering |

---

## Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `MIN_LIFECYCLE_DAYS` | 90 | Data age threshold below which cold-start applies. **Note:** Intentionally aligned with spec 015's `MIN_DATA_AGE_DAYS`; if either changes, evaluate whether the other should follow. |
| `MIN_COLD_START_CONFIDENCE` | 0.3 | Floor of the graduated confidence cap at 0 days of data. At 0 days, the lifecycle classifier has a single point-in-time snapshot — too little for trend detection but enough to suggest a phase direction. A floor of 0.3 communicates "low but non-zero confidence" so consumers can still use the phase as a weak hint rather than discarding it entirely. Lower values (0.1, 0.0) would make cold-start phases effectively invisible to consumers that filter on confidence > 0.2 |
| `MIN_TOPIC_EVENTS` | 50 | Minimum events for a topic to not be flagged as insufficient |
| `MIN_CHAIN_TOPIC_EVENTS` | 50 | Minimum events per topic for a chain to avoid `spurious` tier. **Note:** Intentionally aligned with `MIN_TOPIC_EVENTS`; both gate data quality at the same volume floor. If either is tuned, evaluate whether the other should follow. |
| `CHAIN_TIER_HIGH_VOLUME` | 500 | Minimum topic volume (both topics) for `high` confidence tier |
| `CHAIN_TIER_HIGH_DIVERSITY` | 0.6 | Minimum source diversity for `high` confidence tier |
| `CHAIN_TIER_HIGH_SUPPORT` | 30 | Minimum support for `high` confidence tier |
| `CHAIN_TIER_MODERATE_VOLUME` | 100 | Minimum topic volume (both topics) for `moderate` confidence tier |
| `CHAIN_TIER_MODERATE_DIVERSITY` | 0.5 | Minimum source diversity for `moderate` confidence tier |
| `CHAIN_TIER_MODERATE_SUPPORT` | 10 | Minimum support for `moderate` confidence tier |
| `SCENARIO_DECIMAL_PLACES` | 3 | Decimal places for scenario `probability` rounding |

---

## Implementation

### File Structure

```
tools/intelligence/src/queries/
├── shared.ts       — computeDataSpan(), computeTopicCounts() shared queries (used by forecast + stats)
└── forecast/
    ├── types.ts        — DataQuality, ConfidenceTier, updated LifecycleItem/ChainItem/ScenarioItem/ForecastData
    ├── index.ts        — data_quality assembly, low-probability warning
    ├── lifecycle.ts    — graduated cold-start cap, insufficient-data flag
    ├── chains.ts       — confidence tier assignment
    └── scenarios.ts    — probability rounding precision change, min_chain_tier computation
```

### Internal Functions

| Function | Section | Description |
|----------|---------|-------------|
| `computeDataSpan` | A, D | Query min/max timestamps; return `data_age_days`. Lives in `queries/shared.ts`; accepts optional `windowStart` parameter (omit for all-time, pass for window-scoped). Shared with spec 015's stats computation. |
| `computeTopicCounts` | A, B | Query per-topic event counts in analysis window. Lives in `queries/shared.ts`; accepts `windowStart` parameter. Shared with spec 015 (which may need per-topic counts for future windowed metrics). Prevents the `GROUP BY et.topic` SQL from drifting between call sites. |
| `applyColdStartGuard` | A | Apply graduated confidence cap and flag lifecycle items when data is young |
| `assignConfidenceTier` | B | Classify chain by topic volume, diversity, support |
| `worstTier` | C | Return the lowest confidence tier from a list of tiers; returns `'spurious'` with error log on empty input (defensive fallback) |
| `countChainTiers` | D | Count chains per confidence tier; returns `ChainTierCounts` |
| `countInsufficientData` | D | Count lifecycle items with `insufficient_data: true`; returns `number` |
| `computeDataQuality` | D | Assemble `DataQuality` from computed metrics |

### Dependencies

No new dependencies. All computations use existing SQLite queries and in-memory processing.

**Index coverage:** The new queries are served by existing indexes — §A Step 3 (`GROUP BY et.topic`) uses `idx_event_topics_topic`; §D unclassified-event subquery uses the primary key join on `event_id`; §D top-source query uses `idx_events_source_fetched`. No new indexes are needed.

---

## Tests

**File**: `tools/intelligence/tests/forecast.test.ts` (additions to existing test suite)

### Test Cases

**`lifecycle cold-start guard` (6 tests)**:
- When data age < 90 days, all lifecycle items have `cold_start: true`
- Graduated confidence cap scales linearly: at 30 days, cap ≈ 0.53; at 60 days, cap ≈ 0.77
- Boundary: at 89 days, cap ≈ 0.993 and `cold_start: true`; at 90 days, uncapped and `cold_start` absent (verifies `<` not `<=` comparison)
- When data age >= 90 days, `cold_start` is absent from lifecycle items and confidence is uncapped
- Topics with < 50 events have `insufficient_data: true`; topics with >= 50 do not
- Both flags can coexist: a sparse topic in a young dataset has both `cold_start: true` and `insufficient_data: true`

**`chain confidence tiers` (5 tests)**:
- Every chain has a `confidence_tier` field (not undefined)
- Chain between topics with < 50 events each → `spurious`
- Chain between topics with 100+ events, diversity >= 0.5, support >= 10 → `moderate`
- Chain between topics with 500+ events, diversity >= 0.6, support >= 30 → `high`
- Tier propagates to `RankedChainItem`

**`scenario probability precision and chain tier propagation` (5 tests)**:
- Probabilities retain 3 decimal places (e.g., 0.005 not rounded to 0.01)
- When all probabilities < 0.01, warnings array contains low-probability warning
- When at least one probability >= 0.01, no low-probability warning
- Every scenario has a `min_chain_tier` field (not undefined)
- Scenario built from one `high` chain and one `spurious` chain has `min_chain_tier: 'spurious'`

**`worstTier` (3 tests)**:
- Single-element array returns that tier (e.g., `['high']` → `'high'`)
- All-same-tier array returns that tier (e.g., `['moderate', 'moderate']` → `'moderate'`)
- Empty array returns `'spurious'` (defensive fallback) without throwing

**`data quality object` (14 tests)**:
- `data_quality` is always present on `ForecastData`
- `data_quality.cold_start` matches `data_age_days < 90` condition
- `data_quality.lifecycle_topic_count` equals the number of lifecycle items in the response
- `data_quality.insufficient_data_count` matches count of lifecycle items with `insufficient_data: true`
- `data_quality.insufficient_data_pct` equals `insufficient_data_count / lifecycle_topic_count` rounded to 3 decimal places
- `data_quality.insufficient_data_count`, `insufficient_data_pct`, and `lifecycle_topic_count` are all 0 when lifecycle section is excluded via `--section`
- `data_quality.window_unclassified_pct` is between 0.0 and 1.0
- `data_quality.window_top_source_name` is a non-empty string (window-scoped; distinct from `StatsData.top_source_name`)
- `data_quality.window_top_source_pct` is between 0.0 and 1.0 (window-scoped; distinct from `StatsData.top_source_pct`)
- `data_quality.chain_tier_counts` has all four tier keys and values sum to total chain count
- `data_quality.chain_tier_counts` values match individual chain `confidence_tier` assignments
- `data_quality` survives `--section` filtering (present even when sections are restricted)
- With zero events in window, `data_quality` returns safe defaults: `data_age_days: 0`, `cold_start: true`, `total_events: 0`, `lifecycle_topic_count: 0`, `insufficient_data_count: 0`, `insufficient_data_pct: 0`, `window_unclassified_pct: 0`, `window_top_source_name: ''`, `window_top_source_pct: 0`, `chain_tier_counts: { spurious: 0, low: 0, moderate: 0, high: 0 }`

**`existing field regression` (3 tests)**:
- All existing `LifecycleItem` fields from spec 007 are still present and retain their semantics (phase, phase_confidence, acceleration, etc.)
- All existing `ChainItem` fields from spec 007 are still present (confidence, lift, support, source_diversity, etc.)
- All existing `ScenarioItem` fields from spec 007 are still present (target_topic, trigger_topics, supporting_chains, probability, timeframe_days, etc.)

### Test Fixtures

Extend existing fixtures with:
- A "young dataset" fixture with events spanning only 30 days (tests cold-start graduated cap)
- A "medium dataset" fixture with events spanning 60 days (tests graduated cap midpoint)
- A "sparse topic" fixture with a topic having only 10 events (tests insufficient-data)
- A "high-volume" fixture with 500+ events per topic (tests `high` confidence tier)

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Cold-start flag is too conservative (90 days) for fast-moving topics | 90 days aligns with the 90d lifecycle window; graduated confidence cap (0.3→1.0) softens the impact for datasets approaching the threshold |
| `spurious` tier label may alarm consumers | Label is descriptive, not pejorative; documentation clarifies it means "insufficient data," not "definitely wrong" |
| Rounding change (2→3 decimals) may break consumers that parse probabilities as strings | Probabilities are `number` type in JSON; 0.005 and 0.01 are both valid floats; no string-parsing contract exists |
| `data_quality` computation adds two SQL queries per forecast | Both queries scan the analysis window (bounded); negligible cost vs. existing chain detection SQL |
| `MIN_TOPIC_EVENTS = 50` may flag legitimate niche topics | Flag is informational, not filtering; niche topics still get lifecycle phases and chain participation |
| `data_quality.window_unclassified_pct` vs spec 015's `StatsData.unclassified_pct` use different scoping (window vs all-time) | Consumers using both `intel forecast` and `intel stats` will see different values for conceptually similar metrics. The `window_` prefix on the forecast field disambiguates the scoping at the API level — consumers cannot accidentally conflate the two fields. Inline JSDoc comments at both call sites further specify the scoping |
| New required fields change response shape for strict-schema consumers | `schema_version` on `IntelResponse` should be bumped from `"v1"` to `"v2"` when this spec lands. Consumers that ignore unknown fields are unaffected; consumers with strict validation should key on the version bump |

---

## Decision Summary

| Decision | Selected | Rationale |
|----------|----------|-----------|
| 90-day cold-start threshold | `MIN_LIFECYCLE_DAYS = 90` | Matches the longest lifecycle acceleration window (90d); below this, the 90d acceleration is computed from incomplete data |
| Graduated confidence cap during cold-start | Linear scale from `MIN_COLD_START_CONFIDENCE = 0.3` (at 0 days) to 1.0 (at 90 days) | Avoids a sharp discontinuity at the 90-day boundary; a 60-day dataset gets a cap of ~0.77 instead of a binary 0.5-or-uncapped jump. Floor of 0.3 (not 0.0 or 0.1) keeps cold-start phases usable as weak hints — consumers filtering on confidence > 0.2 still see them; a lower floor would make them effectively invisible |
| 50-event minimum for sufficient data | `MIN_TOPIC_EVENTS = 50` | At 50 events over 120 days (~0.4/day), acceleration vectors have enough datapoints to be meaningful; below this, daily volume fluctuations dominate |
| Four confidence tiers for chains | `spurious / low / moderate / high` | Four tiers provide enough granularity for consumer decisions (filter spurious, prefer high) without over-engineering |
| Confidence tier is required, not optional | Always present on ChainItem | Consumers should always consider data quality; an optional field is too easy to ignore |
| `min_chain_tier` on scenarios | Required `ConfidenceTier` on `ScenarioItem` | Scenarios inherit the worst chain tier so consumers can assess data quality without inspecting individual chains; a scenario from `spurious` chains is immediately identifiable |
| `window_top_source_name` on `DataQuality` | Required string alongside `window_top_source_pct` | Consumers need to know *which* source dominates, not just the percentage; avoids requiring a separate `intel stats` call |
| 3 decimal places for scenario probabilities | `SCENARIO_DECIMAL_PLACES = 3` | 2 decimal places caused silent information loss; 3 preserves differentiation for closely-ranked scenarios |
| Warning, not error, for sub-0.01 probabilities | Warning in envelope | Sub-0.01 probabilities are informational (insufficient chain data), not a computation failure; the forecast is still valid, just low-confidence |
| `data_quality` always present, not filterable | Metadata, not a section | Quality context is a prerequisite for interpreting any section; filtering it out defeats its purpose |
| `window_` prefix for all window-scoped metrics on `DataQuality` | Disambiguated field names: `window_unclassified_pct`, `window_top_source_name`, `window_top_source_pct` | Spec 015's `StatsData` has `unclassified_pct`, `top_source_name`, and `top_source_pct` (all-time scope). This spec's metrics are window-scoped. Using the same field names on different interfaces creates a footgun — the `window_` prefix makes the scoping explicit at the API level for all three fields, not just `unclassified_pct`. No external consumers exist yet, so this is the cheapest moment to establish distinct names |
| `lifecycle_topic_count`, `insufficient_data_count`, and `insufficient_data_pct` on `DataQuality` | Lifecycle-level data quality summary (denominator + count + percentage) | The count parallels `chain_tier_counts`; `lifecycle_topic_count` makes `DataQuality` self-contained (consumers can verify `insufficient_data_pct` without inspecting the lifecycle array); the percentage (rounded to 3dp for consistency with `window_unclassified_pct` and `window_top_source_pct`) makes the count immediately interpretable ("32% of topics have insufficient data" vs "12 topics"). Consistent with spec 015's pattern of pairing counts with percentages (`unclassified_events`/`unclassified_pct`, `multi_topic_events`/`multi_topic_pct`). All three return 0 when lifecycle section is excluded via `--section`, since no lifecycle items exist to be flagged |
| Optional boolean flags (omitted when false) | Backward compatible | Existing consumers never see `cold_start` or `insufficient_data` unless conditions apply; no breaking changes |
| Bump `schema_version` from `"v1"` to `"v2"` | Required fields change response shape | New required fields (`confidence_tier`, `min_chain_tier`, `data_quality`) alter the output contract. Bumping the version lets strict-schema consumers detect the change. Applied once when both spec 014 and 015 land (single version bump for both). |
| `chain_tier_counts` on `DataQuality` | Summary distribution of chain confidence tiers | Consumers who want to assess overall chain quality can read tier counts directly from `data_quality` without iterating all chains; lightweight to compute (single pass over chains during §B tier assignment) |
| Shared `computeDataSpan` in `queries/shared.ts` | Prevent SQL drift | Both this spec and spec 015 compute `data_age_days` from the same SQL pattern; a shared function with optional `windowStart` parameter keeps them in sync. Named `computeDataSpan` (not `computeDataAge`) because it measures the span between oldest and newest event, not how old the data is |
| No forecast-level warning for high source concentration | `data_quality.window_top_source_pct` is exposed but no warning is generated | Source concentration warnings belong in `intel stats` (spec 015's `SOURCE_CONCENTRATION_THRESHOLD`), which is the system-health view. The forecast `data_quality` object reports the metric for consumers who want to act on it, but generating a duplicate warning in the forecast envelope would create noise — operators already see it in stats |

---

## Verification

```bash
# 1. Type-checks cleanly with new interfaces
cd tools/intelligence && npx tsc --noEmit

# 2. All existing + new tests pass
npx vitest run tests/forecast.test.ts

# 3. Verify data_quality is always present (now includes lifecycle_topic_count, insufficient_data_count/pct, window_top_source_name, and chain_tier_counts)
intel forecast | jq '.data.data_quality'
# Expected: { data_age_days, cold_start, total_events, lifecycle_topic_count, insufficient_data_count, insufficient_data_pct, window_unclassified_pct, window_top_source_name, window_top_source_pct, chain_tier_counts }

# 3b. Verify insufficient_data_count matches lifecycle items
intel forecast | jq '{insufficient_data_count: .data.data_quality.insufficient_data_count, actual: [.data.lifecycles[] | select(.insufficient_data == true)] | length}'
# Expected: both values equal

# 4. Verify data_quality survives --section filtering
intel forecast --section scenarios | jq '.data.data_quality'
# Expected: same object as above (not null)

# 5. Verify cold_start flag and graduated cap on lifecycle items (requires young dataset)
intel forecast --window 30 | jq '.data.lifecycles[:3] | .[] | {topic, phase_confidence, cold_start}'
# Expected: phase_confidence values capped proportionally to data age (not a flat 0.5)

# 6. Verify confidence_tier on every chain
intel forecast | jq '[.data.chains[].confidence_tier] | unique'
# Expected: subset of ["spurious", "low", "moderate", "high"]

# 7. Verify no chain is missing confidence_tier
intel forecast | jq '[.data.chains[] | select(.confidence_tier == null)] | length'
# Expected: 0

# 8. Verify scenario probabilities have 3 decimal places
intel forecast | jq '[.data.scenarios[].probability]'
# Expected: values like 0.045, 0.012, 0.005 (not all 0.01)

# 9. Verify low-probability warning when applicable
intel forecast --window 7 --min-support 1 | jq '.warnings'

# 10. Verify confidence_tier propagates to ranked_chains
intel forecast | jq '.data.ranked_chains[0].confidence_tier'
# Expected: one of "spurious", "low", "moderate", "high"

# 11. Verify min_chain_tier on every scenario
intel forecast | jq '[.data.scenarios[] | select(.min_chain_tier == null)] | length'
# Expected: 0

# 12. Verify min_chain_tier values
intel forecast | jq '[.data.scenarios[] | {scenario: .label, min_chain_tier}]'
# Expected: each scenario has min_chain_tier from ["spurious", "low", "moderate", "high"]

# 13. Verify window_top_source_name is present in data_quality
intel forecast | jq '.data.data_quality.window_top_source_name'
# Expected: non-null string (e.g., "hackernews")

# 14. Verify chain_tier_counts sums match total chains
intel forecast | jq '{tiers: .data.data_quality.chain_tier_counts, total_chains: (.data.chains | length)}'
# Expected: sum of tier values equals total_chains
```

---

## Known Limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| **Cold-start is global, not per-topic** | If the overall dataset is young (< 90 days), all topics are flagged cold-start even if some have dense data | Per-topic data age is too noisy (a topic's first event may be a false positive); global data age is a better proxy for "system maturity" |
| **`MIN_TOPIC_EVENTS` is absolute, not rate-based** | The 50-event threshold doesn't scale with window size: 49 events in a 30-day window (~1.6/day) is flagged insufficient, while 51 events in a 120-day window (~0.4/day) passes. A rate-based threshold would be more consistent across window sizes | An absolute floor keeps the implementation simple (one constant, no window-size dependency) and ensures a minimum statistical sample size regardless of window — acceleration vectors need a baseline number of datapoints, not a rate. If window-sensitive thresholds are needed, a future spec can introduce `MIN_TOPIC_EVENTS_PER_DAY * window_days` with a floor |
| **Confidence tiers are heuristic** | The volume/diversity/support thresholds are based on observed data patterns, not a statistical model | Thresholds are conservative and documented; can be tuned via constants as more data accumulates |
| **`unclassified_pct` includes intentionally unclassified events** | Some events (e.g., generic tech news) legitimately match no topic; they inflate the unclassified percentage | The metric is a data quality signal, not a classifier error rate; high values prompt investigation, not automatic action |
| **No per-chain topic volume in output** | Consumers can see the tier but not the underlying topic counts that determined it | Adding per-chain topic counts would double chain output size; the tier is a sufficient summary for most consumers |
| **Over-classified events can inflate chain tiers** | A chain between two high-volume topics may reach `high` tier even if many co-occurrences come from over-classified events (4+ topics per event, per spec 015). The tier measures volume and diversity, not classification precision | Spec 015 surfaces `multi_topic_events` so operators can detect over-classification; chain tiers would need to discount over-classified co-occurrences to fully address this, which requires per-event topic count awareness in chain detection — out of scope for this spec |

---

## Cross-References

- **Spec 007** §A (Lifecycle Positioning) — cold-start guard amends phase confidence semantics
- **Spec 007** §B (Chain Detection) — confidence tier extends ChainItem interface
- **Spec 007** §C (Scenario Projection) — `probability` rounding change and `min_chain_tier` amend scenario output
- **Spec 015** (Collection Quality Controls) — upstream data quality improvements reduce how often confidence gates trigger

### Shared concerns with spec 015

- **90-day threshold:** This spec's `MIN_LIFECYCLE_DAYS` and spec 015's `MIN_DATA_AGE_DAYS` are intentionally aligned at 90. They are separate constants (one gates lifecycle confidence, the other triggers a stats warning), but changing one without evaluating the other would produce inconsistent messaging. If either constant is tuned, review the other.
- **`data_age_days` computation:** Both specs compute `data_age_days` from the same `MIN/MAX(COALESCE(published_at, fetched_at))` query — this spec in `forecast/index.ts` (window-scoped), spec 015 in `queries/stats.ts` (all-time). This spec introduces `queries/shared.ts` with a `computeDataSpan(db, windowStart?)` function that both call sites use. The optional `windowStart` parameter controls scoping: omit for all-time (stats), pass for window-scoped (forecast).
- **Window-scoped field naming:** This spec's `DataQuality` uses the `window_` prefix for all metrics that have all-time counterparts in spec 015's `StatsData`: `window_unclassified_pct` vs `unclassified_pct`, `window_top_source_name` vs `top_source_name`, `window_top_source_pct` vs `top_source_pct`. The naming convention is consistent across all three field pairs so consumers cannot accidentally conflate window-scoped and all-time values. The scoping difference is intentional: forecast quality reflects the analysis window, system health reflects all-time data.

### Implementation ordering

Specs 014 and 015 can be implemented independently and in parallel. This spec computes its own topic counts (§A Step 3) and data quality metrics (§D) from the events database directly — it does not depend on spec 015's stats health metrics being in place. Spec 015's RSS backfill cap and health warnings improve upstream data quality, which reduces how often this spec's confidence gates fire, but the gates function correctly regardless of whether 015 has landed.

The only shared artifact is `queries/shared.ts` for `computeDataSpan` and `computeTopicCounts`. **This spec (014) owns creation of `queries/shared.ts`** — it introduces both functions as part of §A. Spec 015 is a consumer of the shared functions. **Recommended approach:** Land `queries/shared.ts` as a small prerequisite PR before either spec's main implementation, so both can import from it without coordination. If that's impractical: this spec (014) creates the file, and if 015 lands first, it should create `queries/shared.ts` with the same signatures so 014 can consume them without extraction. If both are implemented in parallel on separate branches, expect a trivial merge conflict on `queries/shared.ts` — the function signatures are identical, so resolution is straightforward.

If both specs land in the same release, bump `schema_version` once (to `"v2"`) to cover both sets of response shape changes.

### Schema version

Bump `IntelResponse.schema_version` from `"v1"` to `"v2"` when this spec ships. The version bump covers all new required fields across both spec 014 and spec 015 (if co-released). Consumers should key on `schema_version` to detect the new response shape. There are no external consumers of the forecast API today — the only consumer is the `intel` CLI itself — so no deprecation period or v1 compatibility shim is needed. If external consumers are added before this ships, revisit.
