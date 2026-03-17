---
name: forecast
description: "Predict likely next developments from internal development patterns (git history, archobs clusters) and external signals (intel feeds). Use when you need forward-looking intelligence — what's GOING to happen, not what already happened. NOT for gathering raw signals (use intel); NOT for architecture analysis (use archobs); NOT for implementation planning (use plan)."
metadata: {"stage":"Define","tags":["forecast","prediction","scenarios","chains","lifecycle","convergence","trends","intelligence","bayesian","entropy","cusum","hmm","decay","trajectory","momentum","velocity","feature-prediction","git-history","development-patterns","change-analysis","adjacency"],"aliases":["forecast","predict","scenarios","what-next","forward-looking","trajectory","momentum","velocity","feature-prediction"]}
---

# Forecast (Predictive Intelligence)

## Overview

Predict likely next developments using two engines:

- **Internal engine** (trajectory): analyzes git history and archobs cluster context to predict what the team is likely to build next — where momentum is concentrated, what kinds of changes are happening, and what areas are growing.
- **External engine**: uses Bayesian scenario projection, exponential decay weighting, entropy-based surprise scoring, CUSUM change-point detection, and HMM lifecycle classification from collected intelligence feeds to predict external shifts.

While `intel` tells you what happened, `forecast` tells you what's likely to happen next — internally from development patterns and externally from ecosystem signals.

Success looks like: forward-looking intelligence with ranked scenarios, development momentum analysis, and actionable recommendations that a team can act on before events materialize.

## Chooser (When to Use)

| Situation | Mode |
|---|---|
| "What are we likely to build next?" | **Internal** |
| "Where is development concentrated?" | **Internal** |
| "What external shifts should we prepare for?" | **External** |
| "What's going to happen next?" (general) | **Combined** — cross-references internal velocity with external ecosystem signals |
| "What's the full picture?" | **Combined** — produces compound insights (e.g., "heavy investment in a sinking dependency") |
| "What's the market doing?" / "Technology landscape" | **External** |
| "What happened recently?" | `intel` |
| "How is our codebase structured?" | `archobs` |
| "Plan the implementation" | `plan` |

**Default to Combined mode** unless the user explicitly scopes to internal-only or external-only. Cross-referencing internal development velocity against external ecosystem signals produces compound insights that neither engine generates alone.

## Prerequisites

### Internal engine
1. **archobs data**: Run `archobs report` first to get cluster assignments, file risks, drift data, and commit history
2. **archobs CLI**: `pip install -e 'tools/archobs[full]'`

### External engine
1. **Build the tool**:
   ```bash
   cd tools/intelligence && npm install && npm run build
   ```
2. **Make `intel` available on PATH**:
   ```bash
   npm link          # from tools/intelligence/
   ```
3. **Create a config file**:
   ```bash
   mkdir -p ~/.config/intel ~/.local/share/intel
   cp config/feeds.example.yaml ~/.config/intel/config.yaml
   ```
4. **Seed the database** (first run):
   ```bash
   intel collect --once
   ```
5. **Install the collector as a background service** so data stays fresh:
   ```bash
   ./service/install.sh        # macOS (launchd) / Linux (systemd)
   ```
6. **Run the published_at migration** (if upgrading from an older database):
   ```bash
   sqlite3 ~/.local/share/intel/intel.db < tools/intelligence/migrations/003-published-at-analysis.sql
   ```
7. **Verify**: `intel stats` — check `events_total > 0` and `newest_event` is recent.

---

## Workflow

Choose the mode (internal, external, or combined) based on the chooser table above, then follow the corresponding engine workflow below.

### Internal Engine (Trajectory)

Predict likely next features from recent development patterns. Archobs exposes per-cluster velocity, edge relationships, and commit activity natively — use these as the primary data source.

The data is deterministic and structured. Feature adjacency reasoning ("export features suggest reports are coming next") is your job as the LLM — the tools give you the evidence.

#### Same-session fast path

When running in the same session as archobs (data already loaded):

1. `archobs show velocity --window 30 --compare --format json` — includes `added_paths`, `external_inbound_weight`, `recent_file_changes_30d`, `recent_file_changes_90d`, and `is_emerging` (when `--compare` is used).
2. `archobs show edges --top-active 3 --max-neighbors 10 --format json` — auto-selects top-3 clusters by file_change_count.
3. `git branch -r --sort=-committerdate | head -20`
4. `git log --since="30 days ago" --format="%s" --no-merges | head -40`
5. Theme extraction + feature adjacency reasoning (see below)

Run commands 1-2 in parallel (independent artifacts). Then 3-4 in parallel (independent git queries).

#### Primary path: archobs-native queries

1. **Get velocity data** — per-cluster commit activity with growth/churn ratios:
   ```bash
   archobs show velocity --window 30 --compare --format json
   ```
   Recently added file paths (`added_paths`) are included by default in JSON output — they are the highest-signal data for feature prediction. Use `--compare` to get acceleration relative to the prior window.

2. **Inspect cluster relationships** — which clusters are connected and how strongly:
   ```bash
   archobs show edges <cluster_id> --format json
   ```

3. **Get full context** — run individual queries in parallel:
   ```bash
   archobs show files --format json
   archobs show clusters --format json
   archobs show drift --format json
   archobs show risks --top 10 --format json
   ```

4. **Collect branch signals** — active branches are the highest-confidence trajectory signal:
   ```bash
   git branch -r --sort=-committerdate | head -20
   ```
   Branch names are direct feature declarations. Extract ticket ID prefixes (e.g. `OIQ-516`, `CR-02`) and cross-reference with commit message prefixes to group related branches into feature initiatives.

   **Ticket series grouping**: When 3+ branches share a numeric prefix series or a domain keyword appears in both branch names and commit messages, group them as a single initiative. Report the initiative name, branch count, and combined cluster footprint.

4b. **Collect commit message themes**:
   ```bash
   git log --since="30 days ago" --format="%s" --no-merges | head -40
   ```
   Parse conventional commit prefixes to identify which domains are receiving feature work vs maintenance.

5. **Interpret velocity signals**:

   | Signal | Suggests |
   |--------|----------|
   | High `growth_ratio` | New capability being built |
   | High `churn_ratio` | Feature refinement/iteration |
   | High `acceleration` (with --compare) | Active development push |
   | Low `acceleration` | Work winding down |
   | High `recent_file_changes_30d` in cluster | Focused sprint in one area |
   | Cross-cluster edges (show edges) | Feature adjacency — what depends on what |
   | High `external_inbound_weight` | Gravitational center — other clusters pull toward this one |

   For detailed interpretation rules (compound velocity matrix, per-file intensity, convergent hub pattern, `is_emerging`, test-only clusters, cross-cluster initiative detection), see [`references/velocity-interpretation.md`](references/velocity-interpretation.md).

6. **Reason about feature adjacency** using the patterns in [`references/feature-adjacency.md`](references/feature-adjacency.md) and your domain knowledge.

**Manual fallback**: When archobs artifacts are not available, see [`references/manual-fallback.md`](references/manual-fallback.md) for git-only trajectory extraction.

#### Combined archobs + trajectory workflow

When running both archobs and trajectory in the same session (the most common case):

1. **`archobs report`** (blocking — wait for completion)
2. **Parallel**: all archobs `show` commands + trajectory git commands:
   ```bash
   # Archobs queries (parallel):
   archobs show risks --top 10 --format json
   archobs show clusters --sort leakage --format json
   archobs show drift --format json
   archobs show summary --format json
   archobs show velocity --window 30 --compare --format json
   archobs show edges --top-active 3 --max-neighbors 10 --format json
   archobs show suggestions --format json
   # Git queries (parallel with above):
   git branch -r --sort=-committerdate | head -20
   git log --since="30 days ago" --format="%s" --no-merges | head -40
   ```
3. **Synthesize** into a combined report.

---

### External Engine

Predict likely next developments from collected intelligence feeds using statistical analysis.

#### Analysis engines

The external engine combines seven analysis engines:

1. **Lifecycle positioning** — rule-based + HMM probabilistic phase classification across 4 time windows (1d/7d/14d/30d). Five phases: emerging, accelerating, peaking, decaying, stable. HMM uses Gaussian emission models with log-sum-exp posterior normalization; overrides rule-based when confidence is substantially higher (+0.15).
2. **Chain detection** — discovers topic co-movement patterns (A spikes → B spikes within N days) with lift, confidence, directionality, and lag stddev. Uses `COALESCE(published_at, fetched_at)` for temporal analysis.
3. **Transitive chains** — extends direct chains to A→B→C paths with combined lift and cross-domain detection. Capped at 100 results.
4. **Exponential decay weighting** — weights chain support by recency (14-day half-life).
5. **Entropy-based surprise scoring** — Shannon entropy + normalized entropy per topic.
6. **CUSUM change-point detection** — detects structural breaks in topic volume timelines.
7. **Bayesian scenario projection** — filters active chains to those with above-chance lift (≥ 1.5), then computes posterior probabilities from base rates × chain lifts × decay factors × CUSUM discounts.

#### Activation model

Chain activation uses tiered fallback:
- **Primary**: topics with volume ≥ 3 in the last 24h
- **Secondary**: topics with 7d acceleration > 1.0 (handles sparse-day data)

#### Deduplication

All volume counts use `COALESCE(canonical_url, event_id)` by default (`--dedup canonical`). Pass `--dedup none` to count raw events.

#### Workflow

1. **Check data freshness and depth**:
   ```bash
   intel stats
   ```
   Verify `total_events` is substantial (100+) and data spans multiple days.

2. **Run forecast**:
   ```bash
   intel forecast --summary
   ```
   Use `--summary` for agent consumption — returns only top-3 scenarios, top-5 ranked chains, top-3 dynamics, and change points. This is the preferred mode for agent workflows.

   Use `--compact` when you need more detail (top-N per section) but still want reduced output.

   CLI defaults: `--lag-window 7 --min-support 2 --top-scenarios 10 --dedup canonical --window 30`

   Optional tuning:
   ```bash
   intel forecast --summary --window 7               # short-term summary forecast
   intel forecast --compact                           # more detail, still bounded
   intel forecast --lag-window 5 --min-support 2 --top-scenarios 15
   intel forecast --window 14                         # 14-day analysis window
   intel forecast --dedup none                        # count raw events
   ```

3. **Interpret the response sections**:

   | Section | What it tells you |
   |---|---|
   | `lifecycles` | Phase (emerging/accelerating/peaking/decaying/stable), HMM posteriors, volumes, accelerations, change points |
   | `chains` | Direct A→B co-movement patterns with lift, confidence, directionality, decay-weighted support |
   | `ranked_chains` | Active chains scored and sorted (cross-domain first, then composite score), capped at 50 |
   | `transitive_chains` | A→B→C paths with combined lift and weakest-link support |
   | `scenarios` | Bayesian posterior probabilities, entropy-widened timeframes, trigger chains, evidence |
   | `multiscale` | Per-topic alignment across 1d/7d/30d (aligned_up, aligned_down, diverging, transitioning) |
   | `entropy` | Shannon entropy per topic — low (< 0.3) = predictable; high (> 0.8) = bursty |
   | `dynamics` | Systems dynamics: reinforcing loops, delays, accumulations, dampening signals |
   | `change_points_summary` | **HIGH PRIORITY** — topics with CUSUM structural breaks, sorted by recency. Always call these out. |

   **CUSUM change points** are the highest-priority signal in the forecast output. A change point means a topic's volume trajectory shifted structurally — the historical pattern broke. When `change_points_summary` is non-empty:
   - Always call out which topics had structural breaks and how recently
   - A change point 0-3 days ago = very recent shift, likely still unfolding
   - A change point with `days_ago: 1` on a topic like `ai.openai` means "OpenAI's trajectory shifted yesterday" — this is actionable intelligence
   - Cross-reference with lifecycle phase: a change point + `decaying` phase = growth was arrested; a change point + `emerging` phase = new breakout

   **Chains are sorted by lift** (above-chance co-occurrence ratio), not by raw support. High-lift chains are informative regardless of volume. Chains also include `trigger_base_rate` — values > 0.5 indicate omnipresent triggers whose chains are less informative.

   **Systems dynamics interpretation**:

   | Dynamics type | Forecast signals used | What to look for |
   |---|---|---|
   | `reinforcing_loop` | Bidirectional chains (directionality 0.3–0.7, mutual lift > 1) | Topics that amplify each other. Ask: what breaks this cycle? |
   | `delay` | Active chains with avg_lag_days and lag_stddev | Gap between cause and effect. Long delays with high stddev are harder to predict. |
   | `accumulation` | aligned_up + emerging/accelerating + rising entropy | Pressure building without release. Ask: what is the threshold event? |
   | `dampening` | Decaying phase + recent CUSUM change point | Something arrested growth. Ask: natural limit, policy change, or competing signal? |

4. **Deepen on high-probability scenarios**:
   ```bash
   # Free-text search (FTS5 syntax) — use natural language, not topic IDs
   intel search "AI agents" --since 7d --limit 10
   # Or filter by exact topic ID using --topic flag
   intel events --topic ai.agents --since 7d --limit 10
   intel events --id <event_id>
   ```

5. **Cross-reference with current trends**:
   ```bash
   intel trends --since 24h
   ```

6. **Synthesize** using the output template below.

---

### Combined Mode

When the user asks "what's going to happen next?" or wants the full picture, run both engines and cross-reference.

#### Workflow

1. Run internal and external engines in parallel (they have independent data sources)
2. **Cross-reference**: cluster velocity × lifecycle phase of ecosystem dependencies
   - Which archobs clusters map to technologies that forecast tracks?
   - Is the team investing heavily in an area where the ecosystem is decaying?
   - Is there an emerging ecosystem opportunity where the team has no current investment?
3. **Surface compound signals**: "cluster X has high acceleration AND its primary ecosystem dependency shows a reinforcing loop"

#### Cross-reference patterns

| Internal signal | External signal | Synthesis |
|---|---|---|
| High velocity cluster wrapping external dep | Decaying lifecycle for that dep | Urgent: heavy investment in a sinking dependency |
| Emerging cluster using new technology | Accelerating lifecycle for that tech | Aligned: team is riding a growth wave |
| No cluster activity for a technology | Reinforcing loop detected for that tech | Gap: ecosystem is moving and we're not |
| High velocity in an area | Stable lifecycle for related tech | Normal: team building on solid ground |

---

## Guardrails

- **Probabilities are not certainties** — always present forecasts as probabilistic scenarios, not predictions of fact.
- **Trajectory is evidence, not prediction** — present trajectory data as "evidence suggests" or "development patterns indicate."
- **Feature adjacency is heuristic** — the adjacency table reflects common patterns, not rules. Domain context matters.
- **Freshness check required** — stale data produces stale forecasts. Always verify data recency before synthesizing.
- **Spurious correlations exist** — low-support chains (support < 3) or low source-diversity chains should be flagged as lower confidence.
- **Decay reveals staleness** — compare `decay_weighted_support` to raw `support`. A large gap means the co-movement pattern hasn't recurred recently. Half-life is 14 days.
- **Entropy signals predictability** — high normalized entropy (> 0.8) means the target is bursty and less predictable.
- **CUSUM change points invalidate history** — if a trigger or target topic has a change point within the last 7 days, the scenario's effective lift is discounted. **Always surface change points prominently** — they represent structural shifts that are easy to miss but highly actionable.
- **Scenario probabilities reflect signal quality** — scenarios are differentiated by chain confidence, source diversity, and trigger specificity (not just lift). A scenario driven by a trigger that chains to only 3 targets ranks higher than one driven by a trigger that chains to 30 targets, because the signal is more specific.
- **Trigger base rate reveals noise** — chains with `trigger_base_rate` > 0.5 originate from topics that spike on most days. These correlations are less informative than chains from targeted triggers. Prefer interpreting chains with lower trigger base rates.
- **Evidence quality varies** — the topic classifier occasionally produces false positives (e.g., unrelated content tagged under a topic). When evidence titles seem off-topic, note this and weight the scenario lower.
- **HMM vs rule-based phase** — the HMM classifier overrides the rule-based one when its confidence is 0.15+ higher. `phase_probabilities` is only present when the HMM was used, so the probabilities always agree with the assigned phase.
- **Transitive chains compound uncertainty** — A→B→C has `min_support` (weakest link) and `combined_lift` (product), but uncertainty compounds.
- **Cluster assignments may be stale** — if `drift.ari_prev` is low, cluster boundaries are shifting. Path-based analysis is still valid.
- **30-day retention limits** — the system only sees patterns within its retention window.
- **Do not fabricate** — only use data returned by the tools. Never invent scenarios or probabilities.
- **Do not dump raw JSON** — always synthesize through the output template.

---

## Output Template

### Internal mode (trajectory)

- **Analysis window**: date range, total commits, total file changes
- **Development focus**: which clusters are most active (momentum ranking)
- **Active areas** (top 2-3 clusters):
  - **Cluster**: ID, label, top paths, archobs metrics
  - **Change profile**: growth/churn ratios — what kind of work is happening
  - **Velocity**: accelerating/steady/decelerating (from --compare)
  - **Key paths**: recently added (what's new), most modified (what's being iterated)
  - **Edge relationships**: which other clusters this one connects to
- **Thematic patterns**: frequent tokens, recent subjects
- **Feature adjacency reasoning**: based on observed patterns, what features are logically next
- **Confidence notes**: window size, cluster stability (drift), concentration level
- **Recommended action**: what to investigate, plan for, or build next

### External mode (forecast)

- **Analysis window**: date range, events analyzed, source count
- **Structural breaks** (ALWAYS include if non-empty): topics with CUSUM change points from `change_points_summary`, sorted by recency. These are the highest-signal items — a recent structural break means a topic's trajectory changed and historical patterns may not hold.
- **Active triggers**: topics currently spiking that have historical chain patterns
- **Top scenarios** (3-5):
  - **Topic**: the predicted target topic
  - **Probability**: Bayesian posterior (0-1), explain as high/medium/low
  - **Timeframe**: expected window in days (entropy-widened)
  - **Triggers**: which active topics are driving this prediction (sorted by contribution strength — first trigger matters most for this specific target)
  - **Evidence**: top supporting article titles (up to 3). Flag any evidence that looks off-topic (topic classifier false positives)
  - **Predictability**: if `target_entropy` > 0.8, note the target is bursty
  - **CUSUM discount**: if trigger/target has a recent change point, note reduced confidence
- **Transitive chains**: noteworthy A→B→C paths, especially cross-domain
- **Lifecycle context**: notable phase transitions
- **Entropy landscape**: topics with extreme entropy values
- **Multi-scale alignment**: topics where all timeframes agree on direction
- **System dynamics**: reinforcing loops, delays, accumulations, dampening
- **Ranked chains**: top active chains by composite score. Note chains with high `trigger_base_rate` (> 0.5) as lower-confidence.
- **Confidence notes**: data depth, source diversity, chain support levels, decay-weighted support, CUSUM discounts
- **So what**: 1-2 sentence synthesis of the most actionable insight
- **Recommended action**: what to watch, prepare for, or investigate further

### Combined mode

- **Development momentum** (from internal engine): top active clusters, velocity, feature adjacency
- **Ecosystem signals** (from external engine): top scenarios, lifecycle phases, dynamics
- **Cross-domain synthesis**: where internal development patterns and external ecosystem signals align or conflict — compound signals, gaps, and urgent mismatches
- **Recommended action**: what to prioritize, investigate, or prepare for based on the full picture

## References

- Raw signal gathering: [`intel`](../intel/SKILL.md)
- Architecture observability: [`archobs`](../archobs/SKILL.md)
- Implementation planning: [`plan`](../plan/SKILL.md)
- Architecture decisions: [`architecture`](../architecture/SKILL.md)
- Velocity interpretation details: [`references/velocity-interpretation.md`](references/velocity-interpretation.md)
- Feature adjacency patterns: [`references/feature-adjacency.md`](references/feature-adjacency.md)
- Git-only fallback: [`references/manual-fallback.md`](references/manual-fallback.md)
