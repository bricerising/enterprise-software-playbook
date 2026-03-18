# Spec 007: Intelligence Forecast Module

## Problem

The intelligence tool collects signals and computes trends, but trends are backward-looking — they answer "what happened" not "what's likely next." Operators need forward-looking intelligence: which topics are about to spike, what chains of co-movement exist between topics, and where multi-timescale signals converge or diverge. Without a forecast module, agents must treat every signal as equally likely to matter, with no way to prioritize attention or anticipate downstream effects.

## Goal

Add a `computeForecast` query module (`tools/intelligence/src/queries/forecast.ts`) that synthesizes forward-looking intelligence from the existing event database. The module computes ten complementary views from a configurable analysis window (default: 120 days):

1. **Lifecycle positioning** — rule-based + HMM probabilistic phase classification (emerging, accelerating, peaking, decaying, stable)
2. **Chain detection** — statistically significant temporal co-movement patterns with causal directionality and exponential decay weighting
3. **Transitive chains** — multi-hop propagation paths (A triggers B triggers C)
4. **Scenario projection** — Bayesian posterior probability predictions with entropy-widened timeframes
5. **Multiscale convergence** — flag topics where short-term and long-term momentum agree or conflict
6. **Ranked chains** — prioritized active chains scored by composite metric, cross-domain chains first
7. **Exponential decay weighting** — 14-day half-life weighting reveals whether co-movement patterns are still active or stale
8. **Entropy-based surprise scoring** — Shannon entropy per topic measuring predictability vs burstiness
9. **CUSUM change-point detection** — structural breaks in topic volume that discount chain reliability
10. **Systems dynamics detection** — translates statistical output into systems thinking concepts (reinforcing loops, delays, accumulations, dampening)

## Non-Goals

- Quantitative price/volume forecasting (this is topic-level signal analysis, not financial modeling)
- Machine learning or LLM-based prediction (HMM classification is the only probabilistic model; everything else is statistical/algorithmic)
- Real-time streaming computation (runs on-demand against the SQLite database)
- Full backtesting framework (the snapshot evaluation mechanism enables forward-looking outcome tracking but does not support retroactive backtesting against historical data)

## Scope

| In scope | Out of scope |
|----------|-------------|
| Lifecycle classification from multi-window acceleration (rule-based + HMM hybrid) | Custom lifecycle phase definitions |
| Chain detection with statistical rigor (lift, confidence, directionality, decay weighting) | User-defined chain rules or overrides |
| Transitive chain inference from direct chains | Chains longer than 2 hops (A→B→C) |
| Bayesian scenario projection with entropy-widened timeframes and CUSUM discounts | Full retroactive backtesting against historical data |
| Multiscale convergence from acceleration vectors | Custom window definitions beyond 1d/7d/14d/30d/90d |
| Entropy-based surprise scoring per topic | Custom entropy thresholds |
| CUSUM change-point detection for structural breaks | Real-time streaming CUSUM |
| Systems dynamics detection (reinforcing loops, delays, accumulations, dampening) | Full causal modeling or simulation |
| Confidence-weighted topic classification with learned weights | Negative example training or embedding-based classification |
| Forecast snapshot → evaluate → weight update learning loop | Scheduled via launchd/systemd (weekly snapshot, daily evaluate); see spec 006 Service Management |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  computeForecast(db, opts)                                           │
│                                                                      │
│  ┌──────────────────────┐                                            │
│  │ A. computeLifecycles │──┐  (rule-based + HMM hybrid)              │
│  │    + CUSUM per topic  │  │                                        │
│  └──────────────────────┘  │                                         │
│                            │                                         │
│  ┌─────────────────────┐   │  ┌───────────────────────────┐          │
│  │ B. detectChains     │───┼─▶│ B2. detectTransitiveChains│          │
│  │  + decay weighting  │   │  └───────────────────────────┘          │
│  └─────────────────────┘   │                                         │
│           │                │                                         │
│           │  ┌─────────────────────────┐                             │
│           ├─▶│ C. projectScenarios     │  (Bayesian posterior +      │
│           │  │  + entropy widening     │   CUSUM discounts)          │
│           │  │  + CUSUM discounts      │                             │
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
│  ┌───────────────────────┐                                           │
│  │ F. computeEntropy     │  (Shannon entropy per topic)              │
│  └───────────────────────┘                                           │
│                                                                      │
│  ┌───────────────────────┐                                           │
│  │ F2. detectDynamics    │  (systems thinking interpretation)        │
│  └───────────────────────┘                                           │
│                                                                      │
│  ──▶ ForecastData (9 sections)                                       │
└──────────────────────────────────────────────────────────────────────┘
```

Core forecast computation is read-only against the `events` and `event_topics` tables. The learning loop adds three new tables (`forecast_snapshots`, `forecast_outcomes`, `topic_weights`) and a `confidence` column on `event_topics` (migration 004). The main entry point is `computeForecast()` which returns the standard `IntelResponse<ForecastData>` envelope. `saveSnapshot()` and `evaluateForecasts()` handle the write-path learning loop. Temporal queries use `COALESCE(published_at, fetched_at)` so bulk ingests don't compress real-world timelines.

### Execution Flow

1. Count events in the analysis window (default: 120 days)
2. **Lifecycles**: compute volume and acceleration at 5 windows (1d, 7d, 14d, 30d, 90d) for every topic; classify phase via rule-based + HMM hybrid; detect CUSUM change points per topic
3. **Chains**: detect temporal co-movement patterns via SQL; compute statistical metrics; determine directionality; apply exponential decay weighting (14-day half-life)
4. **Transitive chains**: join direct chains A→B and B→C to find 2-hop propagation paths
5. **Scenarios**: filter active chains with lift ≥ 1.5; compute Bayesian posterior probabilities from base rates × chain lifts × decay factors × CUSUM discounts; widen timeframes by entropy factor
6. **Multiscale**: compare short-term vs long-term acceleration for convergence/divergence signals
7. **Ranked chains**: score active chains for prioritized display
8. **Entropy**: compute Shannon entropy and normalized entropy per topic
9. **Dynamics**: detect systems thinking patterns (reinforcing loops, delays, accumulations, dampening) from statistical output

---

## Interface

### CLI

```
intel forecast                                    # defaults: 7d lag, min_support=2, top 10 scenarios, 120d window
intel forecast --lag-window 14                    # 14-day lag window for chain detection
intel forecast --min-support 2                    # lower threshold for sparse data
intel forecast --top-scenarios 5                  # limit scenario output
intel forecast --dedup none                       # skip canonical_url dedup (count all events)
intel forecast --window 7                         # 7-day analysis window (short-term forecasting)
intel forecast --compact                          # compact output: top-N per section
intel forecast --compact --window 7               # short-term compact forecast
intel forecast --summary                          # minimal output: top-3 scenarios, top-5 chains, change points
intel forecast --summary --window 7               # short-term summary forecast
intel forecast --topics ai.openai,hw.gpu          # filter output to specific topics
intel forecast --section lifecycles,entropy        # include only specific sections
intel forecast --topics ai.openai --section lifecycles,entropy --compact  # combined filtering
intel forecast --snapshot                    # save snapshot for later evaluation
intel forecast evaluate                      # evaluate pending outcomes and update topic weights
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
      "min_support": { "type": "number", "description": "Min co-occurrences for valid chain (default: 2)" },
      "top_scenarios": { "type": "number", "description": "Max scenarios to return (default: 10)" },
      "dedup": { "type": "string", "enum": ["canonical", "none"], "default": "canonical" },
      "window_days": { "type": "number", "description": "Analysis window in days: 7, 14, 30, 60, 90, or 120 (default: 120)" },
      "compact": { "type": "boolean", "description": "Return compact summary with top-N per section (default: false)" },
      "summary": { "type": "boolean", "description": "Return minimal summary: top-3 scenarios, top-5 chains, change points (default: false)" },
      "topics": { "type": "array", "items": { "type": "string" }, "description": "Filter output to specific topic IDs" },
      "sections": { "type": "array", "items": { "type": "string" }, "description": "Include only these sections in the response" }
    }
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `lag_window_days` | number | 7 | Maximum days between spike days A and B for chain detection |
| `min_support` | number | 2 | Minimum co-occurrence count for a chain to be emitted |
| `top_scenarios` | number | 10 | Cap on scenario results returned |
| `dedup` | string | `'canonical'` | `'canonical'` deduplicates by `canonical_url`; `'none'` counts all events |
| `window_days` | number | 120 | Overall analysis window in days (7, 14, 30, 60, 90, or 120) |
| `compact` | boolean | false | When true, return top-N per section for reduced output size |
| `summary` | boolean | false | When true, return minimal output (top-3 scenarios, top-5 chains, change points). Implies compact. Zero-limited sections are omitted entirely from the response (not included as empty arrays). **Adaptive**: when scenario yield < 3, auto-upgrades ranked_chains (→10), dynamics (→5/type), and lifecycles (→15) to compact limits. |
| `topics` | string[] | — | Filter output to specific topic IDs. Full pipeline runs but output is post-filtered. Eliminates the need to run the full forecast twice to extract lifecycle/entropy for specific topics. |
| `sections` | string[] | — | Include only named sections in the response. Valid values: lifecycles, chains, ranked_chains, scenarios, multiscale, transitive_chains, entropy, dynamics, change_points_summary, context. |

---

## Response Shape

```typescript
interface ForecastData {
  window: { start: string; end: string; events_analyzed: number };
  lifecycles?: LifecycleItem[];          // omitted in summary mode (limit 0)
  chains?: ChainItem[];                  // omitted in summary mode (limit 0)
  ranked_chains: RankedChainItem[];
  scenarios: ScenarioItem[];
  multiscale?: MultiscaleItem[];         // omitted in summary mode (limit 0)
  transitive_chains?: TransitiveChainItem[];  // omitted in summary mode (limit 0)
  entropy?: EntropyItem[];               // omitted in summary mode (limit 0)
  dynamics: DynamicItem[];
  change_points_summary: ChangePointSummary[];  // topics with CUSUM structural breaks, sorted by recency
}

interface ChangePointSummary {
  topic: string;
  days_ago: number;
}
```

All responses are wrapped in the standard `IntelResponse<ForecastData>` envelope (`tool`, `schema_version`, `status`, `data`, `warnings`, `next_cursor`).

---

## A. Lifecycle Positioning

### Purpose

Classify each topic's current trajectory so agents can distinguish "newly appearing" from "winding down" from "steady state." Lifecycle phase is an input to scenario projection (acceleration modulates chain scores).

### Algorithm

For each of the 5 time windows (1d, 7d, 14d, 30d, 90d):

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

**Confidence** is the fraction of windows (d1, d7, d30, d90) that agree directionally. Each window is classified as up (> 0.2), down (< -0.2), or neutral. Confidence = max(count_up, count_down, count_neutral) / 4.

### Output

```typescript
interface LifecycleItem {
  topic: string;
  phase: 'emerging' | 'accelerating' | 'peaking' | 'decaying' | 'stable';
  phase_confidence: number;          // 0.33 - 1.0
  phase_probabilities?: Record<string, number>; // HMM posterior per phase; only present when HMM was used
  volumes: Record<string, number>;   // { '1d': N, '7d': N, '14d': N, '30d': N, '90d': N }
  accelerations: Record<string, number>; // { '1d': N, '7d': N, '14d': N, '30d': N, '90d': N }
  change_points: number[];           // days ago when CUSUM detected structural breaks
}
```

**HMM hybrid classification**: The rule-based classifier (described below) is supplemented by an HMM probabilistic classifier using Gaussian emission models with log-sum-exp posterior normalization. The HMM overrides the rule-based phase when its confidence is substantially higher (+0.15). `phase_probabilities` is only present when the HMM classifier was actually used, so consumers never see probabilities that disagree with the assigned phase.

**CUSUM change-point detection**: For each topic, a CUSUM algorithm (sensitivity k=0.5σ, threshold h=4.0σ) detects structural breaks in daily volume. Change points within the last 7 days discount chain reliability in scenario projection (50-100% of original lift depending on recency).

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
  decay_weighted_support: number; // support × exponential decay factor (14-day half-life)
  trigger_base_rate: number;     // fraction of window days the trigger topic spikes (0-1); >0.5 = omnipresent
  temporal_pattern?: 'weekday_correlated'; // calendar artifact flag (>75% weekday co-occurrences)
  weekday_ratio: number;         // avg weekday fraction of trigger+target co-occurrence days (0-1); >0.7 = calendar artifact risk
}
```

**Trigger base rate**: Each chain exposes how frequently the trigger topic spikes relative to the analysis window. High base rates (> 0.5) indicate omnipresent topics whose chains are less informative — the correlation may simply reflect background noise rather than meaningful co-movement. Consumers should prefer chains with lower trigger base rates.

**Chain sort order**: Chains are sorted by `lift DESC, support DESC` (not raw support). This surfaces rare-but-informative chains above common-but-boring ones.

**Exponential decay weighting**: Each chain's support is weighted by recency using a 14-day half-life (`λ = ln(2) / 14`). The `decay_weighted_support` vs raw `support` gap reveals pattern staleness — a large gap means the co-movement hasn't recurred recently. The decay factor is computed from the most recent co-occurrence: `exp(-λ × daysSinceRecent)`.

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
5. Sort by `combined_lift` descending
6. Per-prefix diversity cap: keep at most `MAX_TRANSITIVE_PER_PREFIX` (3) chains per A→B prefix — prevents a single high-lift prefix from dominating all top results (e.g., 5 variations of `aws.bedrock→hw.chip→*`)
7. Cap at 100 results total

### Output

```typescript
interface TransitiveChainItem {
  path: string[];          // [A, B, C] — always length 3
  total_lag_days: number;
  min_support: number;
  combined_lift: number;
  cross_domain: boolean;
  normalized_confidence: number; // geometric mean of leg confidences — calibrated [0,1]
}
```

---

## C. Scenario Projection

### Purpose

Answer "what's likely to happen next" by combining active chains with statistical significance filtering. Produces ranked predictions with probability estimates and timeframes.

### Algorithm

**Step 1: Filter chains**

Only chains that are both `active` (trigger topic is currently spiking) and have `lift >= 1.5` (above-chance co-occurrence — filters spurious correlations). If no chains pass, scenarios is empty.

**Step 2: Compute Bayesian posteriors with signal enrichment**

For each qualifying chain, compute an effective signal that incorporates multiple quality dimensions:

```
base_rate = (target_spike_days / total_days)   // prior probability
effective_lift = chain_lift × decay_ratio × cusum_discount
confidence_factor = √(chain_confidence)        // dampened confidence contribution
diversity_factor = √(chain_source_diversity)   // dampened diversity contribution
fanout_penalty = 1 / log₂(1 + trigger_fanout) // penalize omnipresent triggers
effective_signal = effective_lift × confidence_factor × diversity_factor × fanout_penalty

log_posterior = log(base_rate) + Σ log(max(effective_signal_i, 1.01))
```

**Trigger fanout penalty**: A trigger that chains to N distinct targets contributes less signal than one that chains to only a few. This prevents high-base-rate topics (e.g., `lang.typescript`) from dominating all scenarios with equal weight. The penalty uses `1/log₂(1+N)` for smooth decay: fanout 1 → penalty 1.0; fanout 5 → penalty 0.39; fanout 30 → penalty 0.20.

**Signal enrichment**: Chain confidence and source diversity are factored into the posterior (as sqrt to dampen their effect). This creates differentiation: a high-lift, high-confidence, multi-source chain produces a stronger posterior than a high-lift but low-confidence, single-source chain.

**Step 3: Aggregate by target topic with temperature-scaled softmax**

Multiple chains may predict the same target. Aggregate:
- `probability` = temperature-scaled softmax: `exp((logPost - max) / T) / Σ exp((logPost_i - max) / T)` where T = 0.5
- `triggerTopics` = sorted by per-target contribution strength (strongest first)
- `chainCount` = number of supporting chains (capped at MAX_CHAINS_PER_TARGET = 5)
- `timeframe` = entropy-widened window (see Step 4)

**Temperature-scaled softmax** (T = 0.5): Standard softmax (T = 1.0) produces nearly uniform probabilities when log-posteriors are close. Temperature < 1.0 sharpens the distribution by effectively doubling the gap between log-posteriors. This ensures scenarios with better-supported, more-specific chains receive meaningfully higher probabilities.

**Trigger topic ordering**: Rather than reporting an unsorted set of all trigger topics, each scenario's trigger list is sorted by the trigger's effective signal contribution to that specific target. This creates per-scenario differentiation even when the same triggers appear across multiple scenarios.

**Step 4: Entropy-widened timeframes**

Compute the base timeframe from chain lag statistics, then widen by the target topic's entropy:

```
entropyFactor = 1 + normalized_entropy   // ranges 1.0 (predictable) to 2.0 (bursty)
center = (avgLagMin + avgLagMax) / 2
halfWidth = (avgLagMax - avgLagMin) / 2
timeframe = [center - halfWidth × entropyFactor, center + halfWidth × entropyFactor]
```

Bursty topics (high entropy > 0.8) get wider prediction windows, reflecting less predictable timing.

**Step 5: Evidence titles**

For each target topic, fetch up to 3 recent high-scoring event titles (sanitized, capped at 200 chars) from the analysis window.

**Step 6: Sort and cap**

Sort by probability descending, return top N (default 10).

### Output

```typescript
interface ScenarioItem {
  target_topic: string;
  probability: number;              // 0.0 - 1.0 (relative Bayesian posterior)
  timeframe_days: [number, number]; // [min_days, max_days] — entropy-widened window
  trigger_topics: string[];
  supporting_chains: number;
  evidence_titles: string[];        // up to 3, sanitized
  evidence_relevance: Array<'high' | 'medium' | 'low'>; // parallel to evidence_titles; based on topic_count heuristic
  target_entropy: number;           // target topic's normalized entropy (0-1); >0.8 = bursty
  target_base_rate: number;         // fraction of window days target spikes (0-1); >0.8 = omnipresent
}
```

**Evidence relevance**: Each evidence title is scored based on how many topics the source event was assigned to by the classifier. Events assigned to fewer topics are more specifically classified, so their titles are more likely genuinely relevant:
- `'high'` — event assigned to 1-2 topics (specific classification)
- `'medium'` — event assigned to 3-4 topics
- `'low'` — event assigned to 5 topics (broad classification, higher false-positive risk)

**Evidence pre-filter**: Two pre-filter gates run before ranking:
1. Scenarios where ALL evidence titles have `'low'` relevance are dropped. This catches cases where the classifier misfired on every supporting event (e.g., "Home Assistant waters my plants" as evidence for a TypeScript scenario).
2. Scenarios where `target_base_rate` > 0.8 AND no evidence has `'high'` relevance are dropped. Predicting that an omnipresent topic will spike is trivially true and not actionable — only strong, specific evidence justifies keeping such scenarios.

---

## D. Multiscale Convergence

### Purpose

Flag topics where short-term and long-term momentum signals agree or conflict. Convergence (all timescales pointing the same direction) is a stronger signal than any single timescale alone. Divergence (short-term up, long-term down) may indicate a reversal.

### Algorithm

For each topic from lifecycles:

1. Extract d1, d7, d30, d90 acceleration values
2. Compute `short` = d1 if |d1| >= 0.1, else d7 (sparse-day proxy)
3. Compute `long` = d90 if |d90| >= 0.05, else d30 (falls back to d30 when d90 is near-zero)
4. Classify alignment:

| Condition | Alignment |
|-----------|-----------|
| short > 0 AND d7 > 0 AND long > 0 | `aligned_up` |
| short < 0 AND d7 < 0 AND long < 0 | `aligned_down` |
| (short > 0 AND long < 0) OR (short < 0 AND long > 0) | `diverging` |
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
  d90_accel: number;
}
```

---

## E. Ranked Chains

### Purpose

Provide a prioritized view of the most actionable active chains, with cross-domain chains surfaced first (they tend to carry more novel signal).

### Algorithm

1. Filter to active chains only
2. Score: `support × source_diversity × lift × confidence × (1 + max(0, acceleration)) × baseRateDiscount`
   - `baseRateDiscount = 1 / (1 + max(0, trigger_base_rate - 0.5) × 3)` — penalizes omnipresent triggers (base_rate > 0.5)
3. Mark `cross_domain`: true if `from_topic` and `to_topic` have different top-level domains (first segment before `.`)
4. Sort: cross-domain chains first, then by score descending
5. Per-trigger cap: keep at most `MAX_RANKED_PER_TRIGGER` (3) chains per trigger topic — ensures diverse trigger representation
6. Cap at 50 results total

### Output

```typescript
interface RankedChainItem extends ChainItem {
  score: number;
  cross_domain: boolean;
}
```

---

## F. Entropy-Based Surprise Scoring

### Purpose

Measure how predictable or bursty each topic's event cadence is. Low-entropy topics have regular, predictable patterns; high-entropy topics are bursty and less predictable. Entropy is used to widen scenario timeframes for bursty targets.

### Algorithm

For each topic, compute daily event counts over the 30-day window:

1. Normalize daily counts into a probability distribution: `p_i = count_i / total`
2. Compute Shannon entropy: `H = -Σ p_i × log₂(p_i)`
3. Normalize: `normalized_entropy = H / log₂(active_days)` (0-1 scale)

### Output

```typescript
interface EntropyItem {
  topic: string;
  entropy: number;              // raw Shannon entropy (bits)
  normalized_entropy: number;   // 0.0 - 1.0 (0 = perfectly regular, 1 = maximally bursty)
  active_days: number;          // days with at least 1 event
}
```

Interpretation: normalized entropy < 0.3 = regular cadence (predictable); > 0.8 = bursty (wider prediction windows).

---

## F2. Systems Dynamics Detection

### Purpose

Translate statistical forecast output into systems thinking concepts. This helps agents and humans reason about feedback loops, delays, and accumulation patterns rather than raw statistical metrics.

### Algorithm

Scans the computed lifecycles, chains, multiscale, and entropy data to detect four dynamics patterns:

| Dynamics type | Detection rule | Systems thinking analog |
|---|---|---|
| `reinforcing_loop` | Bidirectional chains with directionality 0.3-0.7 and mutual lift > 1 | Reinforcing feedback loop — topics amplify each other |
| `delay` | Active chains with avg_lag_days and lag_stddev | System delay — gap between cause and effect |
| `accumulation` | aligned_up + emerging/accelerating + rising entropy + freshness gate | Stock accumulation — pressure building without release. Requires `published_at` events in the analysis window (backfill-only topics excluded). |
| `dampening` | Decaying phase + recent CUSUM change point | Balancing feedback loop — something arrested growth |

### Output

```typescript
interface DynamicItem {
  type: 'reinforcing_loop' | 'delay' | 'accumulation' | 'dampening';
  topics: string[];
  metric: { name: string; value: number; secondary_value?: number }; // structured statistical evidence
  interpretation: string;     // pre-computed human-readable interpretation
}
```

---

## G. CUSUM Change-Point Detection

### Purpose

Detect structural breaks in topic volume timelines. A recent change point (within 7 days) means historical co-movement patterns may no longer hold, so chain reliability should be discounted in scenario projection.

### Algorithm

For each topic with sufficient data:

1. Compute daily volumes and running mean
2. Apply one-sided CUSUM with sensitivity k = 0.5σ and threshold h = 4.0σ
3. Detect both upward and downward breaks
4. Report change points as "days ago" in the lifecycle output

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `CUSUM_K_SIGMA` | 0.5 | Sensitivity parameter — lower detects smaller shifts |
| `CUSUM_H_SIGMA` | 4.0 | Threshold — higher requires more evidence before declaring a break |
| `CUSUM_DISCOUNT_HORIZON_DAYS` | 7 | Change points within this window discount scenario chain reliability |

Change points integrate into scenario projection: if a trigger or target topic has a change point within 7 days, the scenario's effective lift is discounted (50-100% of original depending on recency).

---

## H. HMM Probabilistic Phase Classification

### Purpose

Supplement the rule-based lifecycle classifier with a probabilistic model. The HMM uses Gaussian emission models for each phase and computes posterior probabilities via log-sum-exp normalization.

### Algorithm

1. For each topic, collect acceleration values across the 5 time windows
2. Compute log-likelihoods for each phase using pre-defined Gaussian emission parameters (`PHASE_EMISSIONS`)
3. Normalize via log-sum-exp to get posterior probabilities
4. Return the MAP phase and full posterior distribution

The HMM overrides the rule-based classification when its confidence is substantially higher (+0.15 threshold). Otherwise, the deterministic rule-based phase is used for backward compatibility.

### Output

`phase_probabilities` in `LifecycleItem` — when present, a record mapping each phase to its posterior probability (sums to ~1.0). Only included when the HMM classifier was used (i.e., its confidence exceeded the rule-based classifier by >0.15).

---

## I. Confidence-Weighted Classification

### Purpose

The topic classifier performs binary keyword/regex matching — a topic either matches or it doesn't. A tangential mention of "bedrock" scores identically to a deep-dive article about Amazon Bedrock. Confidence-weighted classification adds a per-tag confidence score in [0, 1] so downstream consumers (evidence relevance, chain detection) can distinguish strong matches from weak ones.

### Algorithm

The confidence formula combines four signals already present in the match path:

```
base = 0.5 + min(keywordHits - 1, 3) × 0.1 + regexHits × 0.05    (capped at 0.8)
contextBoost = context_required && passed ? 1.25 : 1.0
priorityFactor = 0.6 + 0.4 × (priority / 100)
raw_confidence = min(1.0, base × contextBoost × priorityFactor)
final_confidence = min(1.0, raw_confidence × topic_weight)
```

- **base**: starts at 0.5 for a single keyword hit; each additional keyword hit adds 0.1 (up to +0.3); each regex hit adds 0.05. Capped at 0.8 to leave room for context and priority boosts.
- **contextBoost**: topics with `context_required: true` that pass context validation get a 25% boost (reward for passing the disambiguation gate).
- **priorityFactor**: maps topic priority (0-100) into a [0.6, 1.0] multiplier. High-priority topics get a confidence boost.
- **topic_weight**: learned weight from the feedback loop (default 1.0). Topics with poor forecast accuracy trend toward 0.5.

### Schema

```sql
ALTER TABLE event_topics ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
```

Backward-compatible: existing rows default to 1.0. New events receive computed confidence values.

### Interface Changes

- `classify()` returns `ClassifiedTopic[]` (array of `{ id: string; confidence: number }`) instead of `string[]`
- `classifyIds()` provides backward-compatible `string[]` return type
- `loadTopics()` accepts optional DB handle to load `topic_weights` into an in-memory Map

### Evidence Relevance Upgrade

Evidence relevance in scenario projection now uses a combined score:

```
combinedScore = topicConfidence × topicCountFactor
relevance = combinedScore >= 0.7 ? 'high' : combinedScore >= 0.4 ? 'medium' : 'low'
```

Where `topicCountFactor` is: 1.0 (1-2 topics), 0.7 (3-4 topics), 0.4 (5 topics). This replaces the previous topic-count-only heuristic with a score that accounts for both classifier confidence and tag specificity.

---

## J2. Forecast Learning Loop

### Purpose

Close the feedback loop: snapshot forecasts, evaluate outcomes, and adjust per-topic weights based on historical accuracy. Topics with accurate forecasts get higher classifier confidence; topics with many false positives get discounted.

### Scheduling

The learning loop is automated via OS-level scheduled jobs (see spec 006 Service Management, "Forecast Scheduled Jobs"):

| Job | Schedule | What it does |
|-----|----------|-------------|
| `intel forecast --snapshot` | Weekly (Sundays 03:00) | Captures current scenarios for later evaluation |
| `intel forecast evaluate` | Daily (04:00) | Evaluates pending outcomes, updates topic weights |

The daily evaluate cadence ensures outcomes are resolved promptly after their predicted timeframe elapses. The weekly snapshot cadence aligns with the 7-day default lag window — snapshotting more frequently would produce highly overlapping scenario sets with minimal additional signal.

Both jobs are installed and managed by `service/install.sh` alongside the collector daemon. They run as one-shot processes (not daemons) and share a log file (`~/Library/Logs/intel-forecast.log` on macOS; systemd journal on Linux).

### Snapshot Mechanism

`intel forecast --snapshot` saves the current forecast for later evaluation:

1. Insert all scenarios into `forecast_snapshots` (JSON blob) + one `forecast_outcomes` row per scenario (outcome = NULL = pending)
2. Auto-delete snapshots older than 90 days (retention cleanup)

### Evaluation

`intel forecast evaluate` evaluates pending outcomes:

1. For each pending outcome (outcome IS NULL):
   - Check if `target_topic` had a spike day (volume >= 3) within the predicted timeframe since snapshot creation
   - Set `outcome = 1` (observed) or `outcome = 0` (not observed, timeframe elapsed)
   - Skip if timeframe hasn't elapsed yet

### Weight Update

After evaluation, topic weights are updated using Laplace-smoothed precision:

```
precision = (TP + 1) / (TP + FP + 2)     // Laplace smoothing, default = 0.5
weight = 0.5 + 0.5 × precision            // Maps [0,1] → [0.5, 1.0]
```

- Topics with many accurate forecasts → weight trends toward 1.0
- Topics with many false positives → weight trends toward 0.5 (50% discount, never fully silenced)
- Topics with no data → default ~0.75 (neutral)
- Minimum 5 evaluated outcomes before updating weight (avoids swinging on sparse data)

### Schema

```sql
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
```

---

## Implementation

### File Structure

```
tools/intelligence/src/queries/forecast.ts    — forecast computation + snapshot + evaluation
tools/intelligence/src/collector/topic-classifier.ts — confidence-weighted classification
tools/intelligence/migrations/004-confidence-learning.sql — schema migration
tools/intelligence/tests/forecast.test.ts     — tests
```

### Internal Functions

| Function | Section | Description |
|----------|---------|-------------|
| `computeForecast` | Main | Orchestrator; wires all sections together |
| `computeLifecycles` | A | Multi-window volume/acceleration + hybrid phase classification |
| `classifyPhase` | A | Rule-based phase assignment with sparse-day fallbacks |
| `classifyPhaseHMM` | H | HMM probabilistic phase classification with Gaussian emissions |
| `detectChains` | B | SQL-based chain detection + directionality + decay weighting |
| `detectTransitiveChains` | B2 | Adjacency-based 2-hop chain inference |
| `projectScenariosBayesian` | C | Bayesian posterior projection with signal enrichment, fanout penalty, temperature-scaled softmax, entropy widening, and CUSUM discounts |
| `buildMultiscaleView` | D | Acceleration vector alignment classification |
| `computeRankedChains` | E | Active chain scoring and sorting |
| `computeEntropy` | F | Shannon entropy per topic |
| `detectDynamics` | F2 | Systems thinking pattern detection |
| `detectChangePoints` | G | CUSUM change-point detection per topic |
| `saveSnapshot` | J2 | Persist forecast scenarios for later evaluation |
| `evaluateForecasts` | J2 | Evaluate pending outcomes and update topic weights |

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `WINDOWS` | 1d, 7d, 14d, 30d, 90d | Analysis timescales for lifecycle computation |
| `MAX_TITLES_PER_SCENARIO` | 3 | Evidence title cap per scenario |
| Spike day threshold | volume >= 3 | Minimum daily events to count as a "spike day" in chain detection |
| Tiered activation threshold | 7d acceleration > 1.0 | Sparse-day fallback for chain activation |
| Lift filter | >= 1.5 | Minimum lift for scenario projection (below-chance chains excluded) |
| Transitive chain cap | 100 | Maximum transitive chains returned |
| `MAX_TRANSITIVE_PER_PREFIX` | 3 | Maximum transitive chains per A→B prefix in top-100 output |
| Ranked chain cap | 50 | Maximum ranked chains returned |
| `DECAY_HALF_LIFE_DAYS` | 14 | Exponential decay half-life for chain recency weighting |
| `CUSUM_K_SIGMA` | 0.5 | CUSUM sensitivity parameter |
| `CUSUM_H_SIGMA` | 4.0 | CUSUM threshold parameter |
| `CUSUM_DISCOUNT_HORIZON_DAYS` | 7 | Window within which change points discount chain reliability |
| HMM override threshold | +0.15 | HMM must beat rule-based by this margin to override |
| `MAX_CHAINS_PER_TARGET` | 5 | Maximum trigger chains contributing to a single target's posterior |
| `MAX_DYNAMICS_PER_TYPE` | 10 | Maximum dynamics entries per type (reinforcing/delay/accumulation/dampening) |
| `MAX_RANKED_PER_TRIGGER` | 3 | Maximum ranked chains per trigger topic in top-50 output |
| `SOFTMAX_TEMPERATURE` | 0.5 | Temperature for scenario softmax; < 1.0 sharpens probability differentiation |

### Dependencies

- `better-sqlite3` — database access (read-only)
- `../types.js` — `IntelResponse` envelope type
- `../util/envelope.js` — `ok()` response wrapper
- `../util/text.js` — `sanitizeSnippet()` for evidence titles
- `../util/time.js` — `sinceISO()`, `formatISO()` for window computation

No external dependencies beyond what the intelligence tool already uses.

---

## Tests

**File**: `tools/intelligence/tests/forecast.test.ts` (68+ tests, 14+ describe blocks)

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

### Test Cases (61 tests, 14 describe blocks)

**`computeForecast` (8 tests)**:
- Response envelope shape includes all 9 sections (including `transitive_chains`, `entropy`, `dynamics`)
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

**`evidence relevance` (1 test)**:
- `evidence_relevance` parallel to `evidence_titles`, values are 'high'/'medium'/'low'

**`ranked chain diversity` (2 tests)**:
- No trigger appears more than 3 times in ranked chains (per-trigger cap)
- High base-rate triggers get valid scores (base-rate discount applied)

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
| Configurable analysis window | 7, 14, 30, 60, 90, or 120 days (default 120) | Different planning horizons need different windows; 120d enables seasonal and multi-quarter trend detection, 7d useful for short-term forecasting |
| 5-window lifecycle (1d/7d/14d/30d/90d) | 5 windows | Balances granularity with computation cost; 90d adds long-term signal for phase classification and multiscale alignment |
| Spike day threshold = 3 events | 3 | Filters noise from single stray events; tunable via data density |
| Lift >= 1.5 for scenarios | 1.5 | Excludes below-chance and borderline chains; conservative filter |
| Entropy-widened timeframes | avg_lag ± halfWidth × (1 + entropy) | Bayesian + entropy approach replaces earlier stddev-based windows |
| Bayesian scenario projection | log-posterior from base rates × lifts × decay × CUSUM | Principled probabilistic scoring replaces earlier heuristic scoring |
| HMM hybrid classification | override rule-based when +0.15 confidence | Supplements rule-based with probabilistic model; backward-compatible |
| Exponential decay (14-day half-life) | support × exp(-λ × days) | Reveals pattern staleness; stale patterns get lower effective lift |
| CUSUM change-point detection | k=0.5σ, h=4.0σ | Identifies structural breaks that invalidate historical patterns |
| Directionality via support ratio | support(A→B) / (A→B + B→A) | Simple, interpretable, computable from existing data |
| Transitive chains 2-hop only | A→B→C | 3+ hops would multiply noise; 2 hops catches key propagation |
| Cross-domain priority in ranking | Sort cross-domain first | Novel cross-domain signals (e.g., ai→aws) are more actionable |
| Softmax scenario normalization | Proper softmax over all targets | Prevents all-1.0 saturation when many triggers active; produces a probability distribution summing to 1.0 |
| Cap trigger chains per target | Max 5 chains per target | Prevents posterior accumulation from unbounded chain count; top-5 by effective lift keeps strongest signals |
| Compact output mode | `--compact` flag | Avoids 277KB+ JSON dumps; returns top-N per section for agent-friendly output |
| Summary output mode | `--summary` flag | Returns top-3 scenarios, top-5 ranked chains, top-3 dynamics, change points. Zero-limited sections omitted entirely (not empty arrays). Minimal output for fast agent synthesis. |
| Dynamics ranking and capping | Top 10 per type, ranked by signal strength | Raw dynamics output (60+ loops, 200+ delays) is too noisy; ranking by lift/stddev/entropy surfaces most important signals |
| Temperature-scaled softmax | T = 0.5 | Standard softmax (T=1.0) produces near-uniform probabilities when log-posteriors are similar. T=0.5 doubles differences, making top scenarios stand out. |
| Signal enrichment in posterior | √confidence × √diversity × fanout penalty | Chains vary widely in confidence and source diversity. Incorporating these creates scenario differentiation that pure lift-based posteriors miss. |
| Trigger fanout penalty | 1/log₂(1+N) | High-fanout triggers (chain to many targets) are less informative. Penalty suppresses omnipresent topics like lang.typescript. |
| Chain sort by lift | ORDER BY lift DESC, support DESC | Surfaces rare-but-informative chains over common-but-boring ones. Raw support still visible for filtering. |
| Trigger base rate field | spike_days/total_days per chain | Exposes how "omnipresent" a trigger is. Consumers can filter/deprioritize chains with trigger_base_rate > 0.5. |
| Ranked chain diversity | base-rate discount + per-trigger cap (3) | Prevents high-base-rate triggers from monopolizing ranked chain output. Discount formula: `1/(1 + max(0, base_rate - 0.5) * 3)`. |
| Evidence relevance hints | topic_count heuristic | Events assigned to fewer topics are more specifically classified. Parallel `evidence_relevance` array flags 'high'/'medium'/'low' per evidence title. |
| Accumulation freshness gate | published_at recency check | Topics whose events lack `published_at` in the analysis window (backfill-only) are excluded from accumulation detection to prevent false signals from bulk-ingested old content. |
| Top-level change_points_summary | Always populated, sorted by recency | CUSUM change points are easy to overlook when buried in per-topic lifecycle data. Top-level summary ensures they're always surfaced. |
| Topic-level output filtering | `--topics` post-filter | Full pipeline runs (chains/scenarios need cross-topic data) but output is post-filtered. Eliminates re-running the entire pipeline to extract lifecycle/entropy for specific topics. |
| Section-level output filtering | `--section` inclusion filter | Only named sections are included in the response. Reduces output to exactly the data needed. |
| Transitive chain diversity | per-prefix cap of 3 | Prevents a single A→B prefix from dominating all transitive chain results. Surfaces diverse cross-domain propagation paths. |
| Evidence pre-filter | Drop all-low-relevance scenarios; drop high-base-rate targets with weak evidence | Two gates: (1) all 'low' relevance = drop; (2) target_base_rate > 0.8 + no 'high' relevance = drop (trivially true, not actionable). |
| Target base rate field | spike_days/total_days per scenario target | Exposes how "omnipresent" the target topic is. Scenarios with target_base_rate > 0.8 are pre-filtered unless strong evidence justifies them. |
| Weekday ratio field | Avg weekday fraction always present on chains | `weekday_ratio` (0-1) enables programmatic calendar artifact assessment. Binary `temporal_pattern` flag threshold lowered from 0.85 to 0.75. |
| Normalized transitive confidence | Geometric mean of leg confidences | `normalized_confidence = sqrt(conf_AB * conf_BC)` — calibrated [0,1] metric for comparing transitive chain strength without raw combined_lift inflation. |
| Adaptive summary mode | Auto-upgrade thin sections when scenario yield < 3 | Summary mode upgrades ranked_chains, dynamics, lifecycles to compact limits when fewer than 3 scenarios qualify. Eliminates manual --compact retry round-trip. |
| Confidence-weighted tagging | Classifier emits confidence per tag | Replaces binary match with 4-signal confidence formula (keyword density, regex hits, context validation, priority). Stored in `event_topics.confidence`. |
| Forecast learning loop | Snapshot → evaluate → weight update | Laplace-smoothed precision per topic; weight floor at 0.5 (never fully silenced); min 5 outcomes before update. Scheduled via launchd/systemd: weekly snapshot (Sun 03:00), daily evaluate (04:00). 90-day retention. |
| Combined evidence relevance | topicConfidence × topicCountFactor | Replaces topic-count-only heuristic with combined score that accounts for classifier confidence and tag specificity. |

---

## Verification

```bash
# 1. All tests pass (58 tests)
cd tools/intelligence && npx vitest run tests/forecast.test.ts

# 2. Type-checks cleanly
npx tsc --noEmit

# 3. CLI output shows all sections populated
intel forecast --min-support 2

# 4. Verify new fields present in chain output
intel forecast --min-support 2 | jq '.data.chains[0] | keys'
# Expected: active, avg_lag_days, confidence, decay_weighted_support, directionality, from_topic, lag_stddev, lift, source_diversity, support, to_topic

# 5. Verify transitive chains populated
intel forecast --min-support 2 | jq '.data.transitive_chains | length'

# 6. Verify scenarios use entropy-widened timeframes and include target_entropy
intel forecast --min-support 2 | jq '.data.scenarios[0] | {timeframe_days, target_entropy}'

# 7. Verify entropy and dynamics sections populated
intel forecast --min-support 2 | jq '.data.entropy | length'
intel forecast --min-support 2 | jq '.data.dynamics | length'

# 8. Verify lifecycle items include change_points; phase_probabilities present only when HMM used
intel forecast --min-support 2 | jq '.data.lifecycles[0] | {phase, phase_confidence, phase_probabilities, change_points}'

# 9. Verify change_points_summary is populated and sorted by recency
intel forecast --min-support 2 | jq '.data.change_points_summary'

# 10. Verify chains include trigger_base_rate and are sorted by lift
intel forecast --min-support 2 | jq '.data.chains[:3] | .[] | {from_topic, to_topic, lift, trigger_base_rate}'

# 11. Verify scenario probabilities are differentiated (not all identical)
intel forecast --min-support 2 | jq '[.data.scenarios[].probability] | unique | length'

# 12. Verify summary mode omits empty sections entirely
intel forecast --summary | jq 'keys' | grep -v lifecycles
# Expected: lifecycles, chains, multiscale, transitive_chains, entropy should be ABSENT

# 13. Verify evidence_relevance parallel to evidence_titles
intel forecast --min-support 2 | jq '.data.scenarios[0] | {evidence_titles, evidence_relevance}'

# 14. Verify ranked chains have diverse triggers (max 3 per trigger)
intel forecast --min-support 2 | jq '[.data.ranked_chains[].from_topic] | group_by(.) | map(length) | max'
# Expected: <= 3
```

---

## Known Limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| **Classifier noise** | Topic classifier over-tags high-volume topics (e.g. `lang.typescript`, `infra.gpu`), inflating volume counts and producing misleading evidence (e.g., "Home Assistant waters my plants" tagged as TypeScript). | Confidence-weighted classification now scores each tag assignment 0-1 based on keyword density, regex hits, context validation, and priority. Evidence relevance uses the combined confidence × topic-count score. The forecast learning loop further adjusts weights based on historical accuracy. Evidence pre-filter drops all-low-relevance scenarios; `target_base_rate` filter catches omnipresent targets. |
| **120-day retention window** | Can detect quarterly trends and seasonal cycles within a single quarter, but cannot detect year-over-year patterns or multi-year trends. Effective horizon is "what's happening now, what's about to happen, and how does the current quarter compare to the last." | 90d lifecycle window leverages the extended retention for phase classification. For longer-horizon analysis, supplement with analyst reports and historical research. |
| **Co-movement ≠ causation** | Chains detect statistical co-occurrence patterns, not causal mechanisms. High lift means "more than random" but does not imply A causes B. | Weekday-ratio filter catches some calendar artifacts. Consumers must treat chains as correlation signals and seek explanatory mechanisms before acting. |
| **Source bias** | 128 sources skew toward developer communities (Hacker News), vendor announcements (AWS/Azure/GCP blogs), and financial news (Seeking Alpha, Yahoo Finance). Enterprise procurement signals, analyst reports behind paywalls (Gartner, Forrester, IDC), and non-English-language markets are underweighted. | Coverage gaps are blind spots, not absence of activity. Source diversity metric partially compensates by discounting single-source chains. |
| **Attention ≠ fundamentals** | "Accelerating" means more coverage and developer activity, not necessarily more revenue, better margins, or enterprise adoption. The `biz.earnings → hw.gpu` chain is suggestive but thin. | System is designed for technology momentum detection — where engineering investment is concentrating. Not a substitute for market research or financial analysis. |

---

## Future Work

### Narrative scenario layer

The current scenario engine models topic co-movement statistically (Bayesian posteriors from chain lift/decay/CUSUM), but the resulting scenarios represent "statistically interesting co-movement" rather than "coherent market narratives." The most actionable insights in practice come from the LLM's synthesis of trends + events + dynamics, not from the scenario probabilities directly.

A future enhancement could add a narrative clustering layer on top of the Bayesian chain model:

1. **Signal clustering**: Group related signals (chains, dynamics, lifecycle phases) by domain/theme into coherent narratives
2. **Narrative scoring**: Score narratives by coherence (how well signals reinforce each other) rather than just statistical co-movement
3. **Evidence alignment**: Match evidence titles to narrative themes rather than individual topics, reducing false-positive noise

This would bridge the gap between the statistical engine's output and the kind of forward-looking intelligence that's most actionable for decision-making. The current approach — having the LLM synthesize across sections — works but pushes narrative construction entirely to the consumer.

### Additional data sources

The current 128-source feed set is strong for developer community signals but has known blind spots. Recommended additions ranked by signal value:

1. **Job posting data** — Which roles companies are hiring for is a strong leading indicator of technology investment decisions. A spike in "Rust infrastructure engineer" postings across multiple companies predicts Rust ecosystem growth 3-6 months ahead of developer community discussion. Sources: LinkedIn API, Indeed, Greenhouse/Lever public postings.

2. **Analyst report feeds** (Gartner, Forrester, IDC) — Enterprise procurement signals that the current developer-community-skewed sources miss. A Gartner "Cool Vendor" designation or Magic Quadrant shift drives enterprise adoption patterns invisible to HN/RSS feeds.

3. **Extended retention window** *(partially addressed)* — Retention extended to 120 days with a 90d lifecycle window for phase classification and multiscale alignment. Seasonal decomposition and year-over-year comparison remain future work; further extension to 180-365 days with downsampled historical data would enable annual cycle detection.

4. **Financial data feed** — Correlation with actual capital flows (VC funding rounds, M&A activity, public company revenue by segment) would ground the attention-based signals in economic reality. The current `biz.earnings → hw.gpu` chain is suggestive; systematic financial data would make it rigorous. Sources: Crunchbase API, SEC EDGAR, Yahoo Finance API.

### Classifier precision improvements

Confidence-weighted tagging is now implemented (see section I). Remaining improvements:

1. **Negative examples** — Train the classifier with explicit "not this topic" examples for commonly over-tagged categories
2. **Title-topic coherence scoring** — Post-hoc validation that evidence titles are semantically related to the scenario's target topic, using embedding similarity
3. **Confidence-weighted chain volumes** — Use confidence scores in chain detection volume computation (opt-in; currently only affects evidence relevance)
