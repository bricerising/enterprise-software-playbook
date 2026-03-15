# Spec 007: Intelligence Forecast Module

## Problem

The intelligence tool collects signals and computes trends, but trends are backward-looking — they answer "what happened" not "what's likely next." Operators need forward-looking intelligence: which topics are about to spike, what chains of co-movement exist between topics, and where multi-timescale signals converge or diverge. Without a forecast module, agents must treat every signal as equally likely to matter, with no way to prioritize attention or anticipate downstream effects.

## Goal

Add a `computeForecast` query module (`tools/intelligence/src/queries/forecast.ts`) that synthesizes forward-looking intelligence from the existing event database. The module computes five complementary views from a single 30-day analysis window:

1. **Lifecycle positioning** — classify each topic's trajectory phase (emerging, accelerating, peaking, decaying, stable)
2. **Chain detection** — find statistically significant temporal co-movement patterns between topics with causal directionality
3. **Transitive chains** — discover multi-hop propagation paths (A triggers B triggers C)
4. **Scenario projection** — predict which topics are likely to spike next, with probability and timeframe estimates
5. **Multiscale convergence** — flag topics where short-term and long-term momentum agree or conflict

## Non-Goals

- Quantitative price/volume forecasting (this is topic-level signal analysis, not financial modeling)
- Machine learning or LLM-based prediction (pure statistical/algorithmic approach)
- Real-time streaming computation (runs on-demand against the SQLite database)
- Backtesting framework (forecasts are forward-looking snapshots, not evaluated against outcomes)

## Scope

| In scope | Out of scope |
|----------|-------------|
| Lifecycle classification from multi-window acceleration | Custom lifecycle phase definitions |
| Chain detection with statistical rigor (lift, confidence, directionality) | User-defined chain rules or overrides |
| Transitive chain inference from direct chains | Chains longer than 2 hops (A→B→C) |
| Scenario projection from active chains | Scenario evaluation or accuracy tracking |
| Multiscale convergence from acceleration vectors | Custom window definitions beyond 1d/7d/14d/30d |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  computeForecast(db, opts)                                           │
│                                                                      │
│  ┌──────────────────────┐                                            │
│  │ A. computeLifecycles │──┐                                         │
│  └──────────────────────┘  │                                         │
│                            │                                         │
│  ┌─────────────────────┐   │  ┌───────────────────────────┐          │
│  │ B. detectChains     │───┼─▶│ B2. detectTransitiveChains│          │
│  └─────────────────────┘   │  └───────────────────────────┘          │
│           │                │                                         │
│           │  ┌─────────────────────────┐                             │
│           ├─▶│ C. projectScenarios     │                             │
│           │  └─────────────────────────┘                             │
│           │                │                                         │
│           │  ┌─────────────────────────┐                             │
│           └─▶│ E. computeRankedChains  │                             │
│              └─────────────────────────┘                             │
│                            │                                         │
│  ┌───────────────────────┐ │                                         │
│  │ D. buildMultiscaleView│◀┘                                         │
│  └───────────────────────┘                                           │
│                                                                      │
│  ──▶ ForecastData (7 sections)                                       │
└──────────────────────────────────────────────────────────────────────┘
```

All computation is read-only against the existing `events` and `event_topics` tables. No new tables or schema changes. The module is a single function (`computeForecast`) that returns the standard `IntelResponse<ForecastData>` envelope.

### Execution Flow

1. Count events in the 30-day analysis window
2. **Lifecycles**: compute volume and acceleration at 4 windows (1d, 7d, 14d, 30d) for every topic; classify phase
3. **Chains**: detect temporal co-movement patterns via SQL; compute statistical metrics; determine directionality
4. **Transitive chains**: join direct chains A→B and B→C to find 2-hop propagation paths
5. **Scenarios**: filter chains by activation and statistical significance; score, aggregate by target, normalize
6. **Multiscale**: compare short-term vs long-term acceleration for convergence/divergence signals
7. **Ranked chains**: score active chains for prioritized display

---

## Interface

### CLI

```
intel forecast                                    # defaults: 7d lag, min_support=3, top 10 scenarios
intel forecast --lag-window 14                    # 14-day lag window for chain detection
intel forecast --min-support 2                    # lower threshold for sparse data
intel forecast --top-scenarios 5                  # limit scenario output
intel forecast --dedup none                       # skip canonical_url dedup (count all events)
```

### MCP Tool

```json
{
  "name": "intel_forecast",
  "description": "Predict likely next developments from topic co-movement patterns and lifecycle analysis",
  "inputSchema": {
    "type": "object",
    "properties": {
      "lag_window_days": { "type": "number", "description": "Max days between chain links (default: 7)" },
      "min_support": { "type": "number", "description": "Min co-occurrences for valid chain (default: 3)" },
      "top_scenarios": { "type": "number", "description": "Max scenarios to return (default: 10)" },
      "dedup": { "type": "string", "enum": ["canonical", "none"], "default": "canonical" }
    }
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `lag_window_days` | number | 7 | Maximum days between spike days A and B for chain detection |
| `min_support` | number | 3 | Minimum co-occurrence count for a chain to be emitted |
| `top_scenarios` | number | 10 | Cap on scenario results returned |
| `dedup` | string | `'canonical'` | `'canonical'` deduplicates by `canonical_url`; `'none'` counts all events |

---

## Response Shape

```typescript
interface ForecastData {
  window: { start: string; end: string; events_analyzed: number };
  lifecycles: LifecycleItem[];
  chains: ChainItem[];
  ranked_chains: RankedChainItem[];
  scenarios: ScenarioItem[];
  multiscale: MultiscaleItem[];
  transitive_chains: TransitiveChainItem[];
}
```

All responses are wrapped in the standard `IntelResponse<ForecastData>` envelope (`tool`, `schema_version`, `status`, `data`, `warnings`, `next_cursor`).

---

## A. Lifecycle Positioning

### Purpose

Classify each topic's current trajectory so agents can distinguish "newly appearing" from "winding down" from "steady state." Lifecycle phase is an input to scenario projection (acceleration modulates chain scores).

### Algorithm

For each of the 4 time windows (1d, 7d, 14d, 30d):

1. Compute **current volume** — event count in the window (with optional canonical_url dedup)
2. Compute **previous volume** — event count in the preceding window of equal length
3. Compute **acceleration** — `(current - previous) / previous` (1.0 if no previous, 0.0 if no current)

Then classify phase using a priority-ordered rule set:

| Priority | Rule | Phase |
|----------|------|-------|
| 1 | d1 > 0.5 AND d7 > 0 AND v30 < median | `emerging` |
| 2 | d1 > 0 AND d7 > 0 AND d30 > 0 | `accelerating` |
| 3 | d1 < 0 AND d7 > 0 | `peaking` |
| 4 | d1 < 0 AND d7 < 0 | `decaying` |
| 5 | \|d1\| < 0.2 AND \|d7\| < 0.2 AND \|d30\| < 0.2 | `stable` |
| 6+ | Secondary d7/d30 fallback when \|d1\| < 0.1 | (see below) |
| default | No rule matches | `stable` |

**Sparse-day fallbacks** (when d1 ~ 0 due to no events in last 24h):

| Rule | Phase |
|------|-------|
| d7 > 1.0 AND d30 > 0 AND v30 < median | `emerging` |
| d7 > 0.2 AND d30 > 0 | `accelerating` |
| d7 < -0.1 AND d30 > 0.2 | `peaking` |
| d7 < -0.1 AND d30 < -0.1 | `decaying` |

**Confidence** is the fraction of windows (d1, d7, d30) that agree directionally. Each window is classified as up (> 0.2), down (< -0.2), or neutral. Confidence = max(count_up, count_down, count_neutral) / 3.

### Output

```typescript
interface LifecycleItem {
  topic: string;
  phase: 'emerging' | 'accelerating' | 'peaking' | 'decaying' | 'stable';
  phase_confidence: number;          // 0.33 - 1.0
  volumes: Record<string, number>;   // { '1d': N, '7d': N, '14d': N, '30d': N }
  accelerations: Record<string, number>; // { '1d': N, '7d': N, '14d': N, '30d': N }
}
```

---

## B. Chain Detection

### Purpose

Detect temporal co-movement patterns: "when topic A spikes, topic B tends to spike N days later." Chains are the core predictive primitive — they connect current activity to future likely activity.

### Algorithm

**Step 1: Daily volumes CTE**

Aggregate events into topic-day pairs, keeping only "spike days" (volume >= 3). Record the count of distinct sources per topic-day.

```sql
daily_volumes AS (
  SELECT et.topic, DATE(e.fetched_at) AS day,
         COUNT(DISTINCT COALESCE(e.canonical_url, e.event_id)) AS volume,
         COUNT(DISTINCT e.source) AS sources
  FROM event_topics et JOIN events e ON e.event_id = et.event_id
  WHERE e.fetched_at >= :window_start
  GROUP BY et.topic, DATE(e.fetched_at)
  HAVING volume >= 3
)
```

**Step 2: Supporting CTEs for statistical metrics**

```sql
topic_spike_days AS (
  SELECT topic, COUNT(DISTINCT day) AS spike_days
  FROM daily_volumes GROUP BY topic
),
total_window AS (
  SELECT COUNT(DISTINCT day) AS total_days FROM daily_volumes
)
```

**Step 3: Self-join for co-occurrence**

Join `daily_volumes a` to `daily_volumes b` where B follows A within the lag window and topics differ. Join to `topic_spike_days` and `total_window` for metric computation.

**Step 4: Computed metrics**

| Metric | Formula | Meaning |
|--------|---------|---------|
| `support` | `COUNT(*)` | Number of (day_A, day_B) co-occurrence pairs |
| `avg_lag_days` | `AVG(JULIANDAY(b.day) - JULIANDAY(a.day))` | Average temporal gap |
| `source_diversity` | `AVG(MIN(a.sources, b.sources))` normalized to 0–1 | Whether co-occurrences span multiple sources |
| `lift` | `(support × total_days) / (spike_days_A × spike_days_B)` | Above-chance co-occurrence ratio (>1 = more than random) |
| `confidence` | `support / spike_days_A` | P(B follows \| A spikes), capped at 1.0 |
| `lag_stddev` | `SQRT(MAX(0, AVG(lag²) - AVG(lag)²))` | Timing consistency (lower = more predictable) |

`source_diversity` is the average min source count across co-occurrence pairs, normalized by dividing by the maximum across all chains. This measures whether the co-movement pattern is observed across multiple independent sources (RSS, Hacker News, etc.) rather than being an artifact of a single feed.

**Step 5: Activation**

A chain is marked `active` if its `from_topic` is currently spiking. Spiking is determined by tiered activation:
- **Tier 1**: Topic has volume >= 3 in the last 24 hours
- **Tier 2**: Topic has 7-day acceleration > 1.0 (handles sparse-day scenarios where events cluster 2-7 days ago with no activity in the last 24h)

**Step 6: Directionality (post-processing)**

For each chain A→B, compute:

```
directionality = support(A→B) / (support(A→B) + support(B→A))
```

- 1.0 = perfectly unidirectional (no reverse chain exists, or reverse has zero support)
- 0.5 = perfectly symmetric (mutual co-occurrence, no causal direction)

**Invariant**: For any pair where both A→B and B→A exist, their directionalities sum to 1.0.

### Output

```typescript
interface ChainItem {
  from_topic: string;
  to_topic: string;
  support: number;
  avg_lag_days: number;       // rounded to 0.1
  source_diversity: number;   // 0.0 - 1.0
  active: boolean;
  lift: number;               // > 0; typically 1.0-10.0 for real signal
  confidence: number;         // 0.0 - 1.0
  directionality: number;     // 0.0 - 1.0 (0.5 = symmetric, 1.0 = unidirectional)
  lag_stddev: number;         // >= 0; days of timing spread
}
```

---

## B2. Transitive Chain Detection

### Purpose

Discover multi-hop propagation paths. If A→B and B→C both exist as direct chains, then A may predict C with a longer lag. This is useful for early-warning: A is a leading indicator for C even though they don't directly co-occur.

### Algorithm

1. Build an adjacency map: `from_topic → [ChainItem, ...]`
2. For each direct chain A→B, look up all chains B→C
3. Skip loops where C = A (no A→B→A paths)
4. Emit transitive chain with:
   - `total_lag_days` = A→B lag + B→C lag
   - `min_support` = min(support_AB, support_BC) — weakest link
   - `combined_lift` = lift_AB × lift_BC — multiplicative above-chance ratio
   - `cross_domain` = true if A and C have different top-level domains (e.g., `ai.llm` → `aws.lambda`)
5. Sort by `combined_lift` descending, cap at 100 results

### Output

```typescript
interface TransitiveChainItem {
  path: string[];          // [A, B, C] — always length 3
  total_lag_days: number;
  min_support: number;
  combined_lift: number;
  cross_domain: boolean;
}
```

---

## C. Scenario Projection

### Purpose

Answer "what's likely to happen next" by combining active chains with statistical significance filtering. Produces ranked predictions with probability estimates and timeframes.

### Algorithm

**Step 1: Filter chains**

Only chains that are both `active` (trigger topic is currently spiking) and have `lift >= 1.5` (above-chance co-occurrence — filters spurious correlations). If no chains pass, scenarios is empty.

**Step 2: Score**

For each qualifying chain:

```
rawScore = confidence × lift × source_diversity × (1 + max(0, acceleration))
```

Where `acceleration` is the trigger topic's acceleration (prefer d1 if |d1| >= 0.1, else d7 fallback).

**Step 3: Aggregate by target topic**

Multiple chains may predict the same target. Aggregate:
- `totalScore` = sum of rawScores from all chains pointing to this target
- `triggerTopics` = union of all trigger topics
- `chainCount` = number of supporting chains
- `timeframe` = [min(avg_lag - 2×stddev), max(avg_lag + 2×stddev)] across all chains to this target

The stddev-based timeframe replaces an earlier arbitrary ×0.5/×1.5 multiplier, giving statistically grounded prediction windows.

**Step 4: Normalize probability**

```
probability = totalScore / max(totalScore across all targets)
```

Scaled to 0–1. The highest-scoring target gets probability 1.0; others are relative.

**Step 5: Evidence titles**

For each target topic, fetch up to 3 recent high-scoring event titles (sanitized, capped at 200 chars) from the analysis window.

**Step 6: Sort and cap**

Sort by probability descending, return top N (default 10).

### Output

```typescript
interface ScenarioItem {
  target_topic: string;
  probability: number;              // 0.0 - 1.0 (relative, not absolute)
  timeframe_days: [number, number]; // [min_days, max_days] — stddev-based window
  trigger_topics: string[];
  supporting_chains: number;
  evidence_titles: string[];        // up to 3, sanitized
}
```

---

## D. Multiscale Convergence

### Purpose

Flag topics where short-term and long-term momentum signals agree or conflict. Convergence (all timescales pointing the same direction) is a stronger signal than any single timescale alone. Divergence (short-term up, long-term down) may indicate a reversal.

### Algorithm

For each topic from lifecycles:

1. Extract d1, d7, d30 acceleration values
2. Compute `short` = d1 if |d1| >= 0.1, else d7 (sparse-day proxy)
3. Classify alignment:

| Condition | Alignment |
|-----------|-----------|
| short > 0 AND d7 > 0 AND d30 > 0 | `aligned_up` |
| short < 0 AND d7 < 0 AND d30 < 0 | `aligned_down` |
| (short > 0 AND d30 < 0) OR (short < 0 AND d30 > 0) | `diverging` |
| (short > 0 AND d7 < 0) OR (short < 0 AND d7 > 0) | `transitioning` |
| default (all near zero) | `aligned_up` (neutral-up) |

### Output

```typescript
interface MultiscaleItem {
  topic: string;
  alignment: 'aligned_up' | 'aligned_down' | 'diverging' | 'transitioning';
  d1_accel: number;
  d7_accel: number;
  d30_accel: number;
}
```

---

## E. Ranked Chains

### Purpose

Provide a prioritized view of the most actionable active chains, with cross-domain chains surfaced first (they tend to carry more novel signal).

### Algorithm

1. Filter to active chains only
2. Score: `support × source_diversity × lift × confidence × (1 + max(0, acceleration))`
3. Mark `cross_domain`: true if `from_topic` and `to_topic` have different top-level domains (first segment before `.`)
4. Sort: cross-domain chains first, then by score descending
5. Cap at 50 results

### Output

```typescript
interface RankedChainItem extends ChainItem {
  score: number;
  cross_domain: boolean;
}
```

---

## Implementation

### File Structure

```
tools/intelligence/src/queries/forecast.ts    — all algorithm code (~630 lines)
tools/intelligence/tests/forecast.test.ts     — 20 tests across 4 describe blocks
```

### Internal Functions

| Function | Section | Lines | Description |
|----------|---------|-------|-------------|
| `computeForecast` | Main | 90–125 | Orchestrator; wires all sections together |
| `computeLifecycles` | A | 129–220 | Multi-window volume/acceleration + phase classification |
| `classifyPhase` | A | 222–274 | Rule-based phase assignment with sparse-day fallbacks |
| `detectChains` | B | 278–399 | SQL-based chain detection + directionality post-processing |
| `detectTransitiveChains` | B2 | 403–434 | Adjacency-based 2-hop chain inference |
| `projectScenarios` | C | 438–555 | Chain scoring, target aggregation, probability normalization |
| `buildMultiscaleView` | D | 559–590 | Acceleration vector alignment classification |
| `computeRankedChains` | E | 594–625 | Active chain scoring and sorting |

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `WINDOWS` | 1d, 7d, 14d, 30d | Analysis timescales for lifecycle computation |
| `MAX_TITLES_PER_SCENARIO` | 3 | Evidence title cap per scenario |
| Spike day threshold | volume >= 3 | Minimum daily events to count as a "spike day" in chain detection |
| Tiered activation threshold | 7d acceleration > 1.0 | Sparse-day fallback for chain activation |
| Lift filter | >= 1.5 | Minimum lift for scenario projection (below-chance chains excluded) |
| Transitive chain cap | 100 | Maximum transitive chains returned |
| Ranked chain cap | 50 | Maximum ranked chains returned |

### Dependencies

- `better-sqlite3` — database access (read-only)
- `../types.js` — `IntelResponse` envelope type
- `../util/envelope.js` — `ok()` response wrapper
- `../util/text.js` — `sanitizeSnippet()` for evidence titles
- `../util/time.js` — `sinceISO()`, `formatISO()` for window computation

No external dependencies beyond what the intelligence tool already uses.

---

## Tests

**File**: `tools/intelligence/tests/forecast.test.ts`

### Test Fixtures

Two fixture sets seed synthetic data for deterministic testing:

**Standard fixtures** (`seedChainFixtures`):
- Pattern A: `ai.llm` → `ai.agents` — 3 occurrences, ~2-day lag, single source
- Pattern B: `aws.bedrock` → `aws.lambda` — 4 occurrences, ~1-day lag, cross-source (rss + hackernews)
- Current spike: `ai.llm` active now (5 events in last few hours) — triggers scenario prediction

**Sparse fixtures** (`seedSparseFixtures`):
- `ml.transformers` → `ml.training` — events cluster 2–7 days ago, zero events in last 24h
- `ml.transformers` → `infra.gpu` — cross-domain chain
- Previous window (8–12 days ago) has low volume, creating high 7d acceleration
- Tests the sparse-day fallback paths (d7 proxy, tiered activation)

### Test Cases (20 tests, 4 describe blocks)

**`computeForecast` (8 tests)**:
- Response envelope shape includes all 7 sections (including `transitive_chains`)
- Chain support counts >= min_support, avg_lag_days > 0, source_diversity in [0, 1]
- Chain fields include `lift`, `confidence`, `directionality`, `lag_stddev`
- Active chains when trigger topic is spiking
- Scenarios: probability in [0, 1], timeframe[0] <= timeframe[1], trigger_topics non-empty
- Lifecycle phases valid, phase_confidence in [0, 1]
- Multiscale alignments valid
- min_support threshold respected
- top_scenarios limit respected
- Empty database returns all empty arrays
- Evidence titles present and capped at 3

**`sparse-day fallbacks` (5 tests)**:
- Scenarios generated via 7d fallback when 24h is empty
- High-7d-accel topics not classified as stable
- Multiscale uses d7 proxy when d1 is zero
- Ranked chains scored, sorted (cross-domain first), capped at 50
- Cross-domain marking uses top-level domain comparison

**`chain statistical fields` (2 tests)**:
- Lift and confidence are finite and in expected ranges (lift > 0, confidence in [0, 1], lag_stddev >= 0)
- Directionality symmetry: for any pair A→B and B→A, directionalities sum to 1.0; absent reverse chain = 1.0

**`transitive chains` (3 tests)**:
- Valid structure: path length 3, no A→B→A loops, finite numeric fields, min_support >= threshold
- Cross-domain correctness: first and last path elements compared
- Capped at 100 results

---

## Risks

| Risk | Mitigation |
|------|-----------|
| `SQRT` returns NULL on floating-point negative variance | `MAX(0, ...)` inside SQRT; `?? 0` guard in TypeScript |
| `lift >= 1.5` filter removes too many chains in sparse datasets | Existing fixtures produce lift ~2.5; real data expected higher; lower `min_support` widens chain pool |
| SQL performance with added CTEs + JOINs | CTEs scan `daily_volumes` output (hundreds of rows, not base tables); no performance impact observed |
| Transitive chain explosion with many direct chains | Capped at 100 results after sorting by combined_lift |
| Division by zero in lift/confidence | Denominator is `spike_days_A × spike_days_B`; both guaranteed >= 1 by HAVING volume >= 3 |
| Directionality of 0.0 (degenerate) | Not possible: forward support is always >= min_support > 0, so ratio is always > 0 |

---

## Decision Summary

| Decision | Selected | Rationale |
|----------|----------|-----------|
| Fixed 30-day analysis window | 30 days | Matches existing data retention default; covers multiple weekly cycles |
| 4-window lifecycle (1d/7d/14d/30d) | 4 windows | Balances granularity with computation cost; 14d adds mid-term signal |
| Spike day threshold = 3 events | 3 | Filters noise from single stray events; tunable via data density |
| Lift >= 1.5 for scenarios | 1.5 | Excludes below-chance and borderline chains; conservative filter |
| Stddev-based timeframes | avg_lag +/- 2*stddev | Statistically grounded ~95% CI vs arbitrary multipliers |
| Directionality via support ratio | support(A→B) / (A→B + B→A) | Simple, interpretable, computable from existing data |
| Transitive chains 2-hop only | A→B→C | 3+ hops would multiply noise; 2 hops catches key propagation |
| Cross-domain priority in ranking | Sort cross-domain first | Novel cross-domain signals (e.g., ai→aws) are more actionable |

---

## Verification

```bash
# 1. All tests pass (20 tests)
cd tools/intelligence && npx vitest run tests/forecast.test.ts

# 2. Type-checks cleanly
npx tsc --noEmit

# 3. CLI output shows all sections populated
intel forecast --min-support 2

# 4. Verify new fields present in chain output
intel forecast --min-support 2 | jq '.data.chains[0] | keys'
# Expected: active, avg_lag_days, confidence, directionality, from_topic, lag_stddev, lift, source_diversity, support, to_topic

# 5. Verify transitive chains populated
intel forecast --min-support 2 | jq '.data.transitive_chains | length'

# 6. Verify scenarios use stddev-based timeframes
intel forecast --min-support 2 | jq '.data.scenarios[0].timeframe_days'
```
