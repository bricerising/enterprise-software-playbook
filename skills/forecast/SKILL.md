---
name: forecast
description: "Predict likely next developments using Bayesian scenario projection, exponential decay weighting, entropy scoring, CUSUM change-point detection, and HMM lifecycle classification. Use when you need forward-looking intelligence — what's GOING to happen, not what already happened. NOT for gathering raw signals (use intel); NOT for shaping signals into briefs (use brief); NOT for architecture analysis (use archobs)."
metadata: {"stage":"Define","tags":["forecast","prediction","scenarios","chains","lifecycle","convergence","trends","intelligence","bayesian","entropy","cusum","hmm","decay"],"aliases":["forecast","predict","scenarios","what-next","forward-looking"]}
---

# Forecast (Predictive Intelligence)

## Overview

Predict likely next developments using Bayesian scenario projection, exponential decay weighting, entropy-based surprise scoring, CUSUM change-point detection, and HMM lifecycle classification from collected intelligence feeds.

While `intel` tells you what happened and `brief` shapes it for an audience, `forecast` tells you what's likely to happen next — which topics are about to spike, which are peaking, and which historical patterns suggest causal chains.

Success looks like: a set of ranked scenarios with probability estimates, timeframes, trigger signals, and supporting evidence that a trader or decision-maker can act on before events materialize.

### Analysis engines

The forecast module combines seven analysis engines:

1. **Lifecycle positioning** — rule-based + HMM probabilistic phase classification across 4 time windows (1d/7d/14d/30d). Five phases: emerging, accelerating, peaking, decaying, stable. HMM uses Gaussian emission models with log-sum-exp posterior normalization; overrides rule-based when confidence is substantially higher (+0.15).
2. **Chain detection** — discovers topic co-movement patterns (A spikes → B spikes within N days) with lift, confidence, directionality, and lag stddev. Uses `COALESCE(published_at, fetched_at)` for temporal analysis so bulk ingests don't compress real-world timelines.
3. **Transitive chains** — extends direct chains to A→B→C paths with combined lift and cross-domain detection. Capped at 100 results.
4. **Exponential decay weighting** — weights chain support by recency (14-day half-life). `decay_weighted_support` vs raw `support` reveals whether a pattern is still active or stale.
5. **Entropy-based surprise scoring** — Shannon entropy + normalized entropy per topic. Low entropy = regular cadence (predictable); high entropy = bursty (wider prediction windows).
6. **CUSUM change-point detection** — detects structural breaks in topic volume timelines. Recent change points (within 7 days) discount chain reliability because historical co-movement may no longer hold.
7. **Bayesian scenario projection** — filters active chains to those with above-chance lift (≥ 1.5), then computes posterior probabilities from base rates × chain lifts × decay factors × CUSUM discounts. Entropy widens timeframes for bursty targets.

### Activation model

Chain activation uses tiered fallback:
- **Primary**: topics with volume ≥ 3 in the last 24h
- **Secondary**: topics with 7d acceleration > 1.0 (handles sparse-day data where 24h is empty)

### Deduplication

All volume counts use `COALESCE(canonical_url, event_id)` by default (`--dedup canonical`), collapsing duplicate articles syndicated across multiple feeds. Pass `--dedup none` to count raw events.

## Prerequisites

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
   # Edit ~/.config/intel/config.yaml to customize feeds
   ```

4. **Seed the database** (first run):
   ```bash
   intel collect --once
   ```

5. **Install the collector as a background service** so data stays fresh:
   ```bash
   ./service/install.sh        # macOS (launchd) / Linux (systemd)
   ```
   This installs a LaunchAgent (macOS) or systemd user unit (Linux) that starts on login and restarts on crash. Verify it's running:
   ```bash
   # macOS
   launchctl print gui/$(id -u)/com.intel.collector
   tail -f ~/Library/Logs/intel-collector.log

   # Linux
   systemctl --user status intel-collector
   journalctl --user -u intel-collector -f
   ```
   To uninstall: `./service/install.sh uninstall`

6. **Run the published_at migration** (if upgrading from an older database):
   ```bash
   sqlite3 ~/.local/share/intel/intel.db < tools/intelligence/migrations/003-published-at-analysis.sql
   ```
   This adds an expression index on `COALESCE(published_at, fetched_at)` for faster temporal queries. Without it, forecast still works but chain-detection queries are slower.

7. **Verify**: `intel stats` — check `events_total > 0` and `newest_event` is recent. Forecast needs at least a few days of data to detect meaningful chains; 2+ weeks is ideal.

## Chooser (When to Use)

| Situation | Use |
|---|---|
| "What's going to happen next?" | **forecast** |
| "What happened recently?" | `intel` |
| "Summarize this for leadership" | `brief` |
| "How is our codebase structured?" | `archobs` |
| "Plan the implementation" | `plan` |

Use `forecast` when the user wants forward-looking intelligence, scenario planning, or wants to know which current signals predict future developments.

## Workflow

1. **Check data freshness and depth**:
   ```bash
   intel stats
   ```
   Verify `total_events` is substantial (100+) and data spans multiple days. Forecast quality scales with data depth — warn the user if the database has fewer than 7 days of data.

2. **Run forecast**:
   ```bash
   intel forecast
   ```
   CLI defaults: `--lag-window 7 --min-support 3 --top-scenarios 10 --dedup canonical`
   MCP defaults: `lag_window_days=7 min_support=2 top_scenarios=10 dedup=canonical` (lower min_support while data depth matures)

   Optional tuning:
   ```bash
   intel forecast --lag-window 5 --min-support 2 --top-scenarios 15
   intel forecast --dedup none    # count raw events instead of deduped
   ```

   The forecast is also available as the `intel_forecast` MCP tool with the same parameters (`lag_window_days`, `min_support`, `top_scenarios`, `dedup`).

3. **Interpret the response sections**:

   | Section | Fields | What it tells you |
   |---|---|---|
   | `window` | `start`, `end`, `events_analyzed` | Analysis date range and event count |
   | `lifecycles` | `topic`, `phase`, `phase_confidence`, `phase_probabilities`, `volumes`, `accelerations`, `change_points` | Phase (emerging/accelerating/peaking/decaying/stable), HMM posterior probabilities per phase, volume and acceleration across 4 windows (1d/7d/14d/30d), CUSUM change points (days ago) |
   | `chains` | `from_topic`, `to_topic`, `support`, `avg_lag_days`, `source_diversity`, `active`, `lift`, `confidence`, `directionality`, `lag_stddev`, `decay_weighted_support` | Direct A→B co-movement patterns. `active` = trigger topic is currently spiking. `directionality` near 1.0 = A consistently leads B. `decay_weighted_support` vs `support` reveals staleness. |
   | `ranked_chains` | _extends chains_ + `score`, `cross_domain` | Active chains scored (`support × source_diversity × lift × confidence × (1 + acceleration)`) and sorted (cross-domain first, then by composite score), capped at 50 |
   | `transitive_chains` | `path[]`, `total_lag_days`, `min_support`, `combined_lift`, `cross_domain` | A→B→C paths with combined lift (product) and weakest-link support. `cross_domain` = first domain != last domain. |
   | `scenarios` | `target_topic`, `probability`, `timeframe_days[min,max]`, `trigger_topics[]`, `supporting_chains`, `evidence_titles[]`, `target_entropy` | Bayesian posterior probabilities (highest normalizes to 1.0), entropy-widened timeframe windows, trigger chains, and supporting evidence. `target_entropy` > 0.8 = bursty/less predictable. |
   | `multiscale` | `topic`, `alignment`, `d1_accel`, `d7_accel`, `d30_accel` | Per-topic alignment across 1d/7d/30d (aligned_up, aligned_down, diverging, transitioning). Uses d7 as short-term proxy when d1 is near zero. |
   | `entropy` | `topic`, `entropy`, `normalized_entropy`, `active_days` | Shannon entropy and normalized entropy (0-1) per topic. Low (< 0.3) = regular cadence; high (> 0.8) = bursty. |
   | `dynamics` | `type`, `topics[]`, `metric`, `interpretation` | Systems dynamics detected from statistical output: reinforcing loops, delays, accumulations, dampening signals. Each item includes a pre-computed interpretation. |

   **Systems dynamics interpretation**

   The `dynamics` section translates statistical forecast output into systems thinking concepts:

   | Dynamics type | Forecast signals used | Systems thinking analog | What to look for |
   |---|---|---|---|
   | `reinforcing_loop` | Bidirectional chains (directionality 0.3–0.7, mutual lift > 1) | Reinforcing feedback loop | Topics that amplify each other. Ask: what breaks this cycle? |
   | `delay` | Active chains with avg_lag_days and lag_stddev | System delay | Gap between cause and effect. Long delays with high stddev are harder to predict. |
   | `accumulation` | aligned_up + emerging/accelerating + rising entropy | Stock accumulation | Pressure building without release. Ask: what is the threshold event? |
   | `dampening` | Decaying phase + recent CUSUM change point | Balancing feedback loop | Something arrested growth. Ask: natural limit, policy change, or competing signal? |

   **Vocabulary mapping** (forecast concept → systems thinking concept):

   | Forecast concept | Systems thinking concept |
   |---|---|
   | Chain co-movement (A→B) | Causal link |
   | Transitive chain (A→B→C) | Indirect effect / second-order effect |
   | Bidirectional chain | Feedback loop |
   | Lifecycle phase transition | Regime change |
   | CUSUM change point | Structural break |
   | High entropy | Unpredictability / burstiness |
   | Multiscale divergence | Leading indicator of trend reversal |
   | Decay-weighted support gap | Pattern staleness |

4. **Deepen on high-probability scenarios** — for the top scenarios, fetch supporting events:
   ```bash
   intel search "<target_topic>" --since 7d --limit 10
   intel events --id <event_id>
   ```

5. **Cross-reference with current trends** for context:
   ```bash
   intel trends --since 24h
   ```

6. **Synthesize** using the output template below. Focus on:
   - Which scenarios have the highest probability and shortest timeframes
   - What's currently triggering (active chains)
   - Multi-scale alignment as a confidence signal
   - Transitive chains for longer causal reasoning (A→B→C)
   - Entropy landscape for prediction reliability
   - CUSUM change points for structural breaks that invalidate historical patterns
   - What the user should watch for or act on now

## Guardrails

- **Probabilities are not certainties** — always present forecasts as probabilistic scenarios, not predictions of fact. Use language like "likely", "historically correlated", "pattern suggests".
- **Freshness check required** — stale data produces stale forecasts. Always verify data recency before synthesizing.
- **Spurious correlations exist** — low-support chains (support < 3) or low source-diversity chains should be flagged as lower confidence.
- **Decay reveals staleness** — compare `decay_weighted_support` to raw `support`. A large gap means the co-movement pattern hasn't recurred recently and may be stale. Half-life is 14 days.
- **Entropy signals predictability** — high normalized entropy (> 0.8) means the target is bursty and less predictable. Timeframe windows are automatically widened by the entropy factor (1 + normalized_entropy), but flag these scenarios as wider confidence to the reader.
- **CUSUM change points invalidate history** — if a trigger or target topic has a change point within the last 7 days, the scenario's effective lift is discounted (50-100% of original depending on recency). Mention this to the reader as reduced confidence.
- **HMM vs rule-based phase** — the HMM classifier overrides the rule-based one when its confidence is 0.15+ higher. When `phase_probabilities` show two phases within 0.15 of each other, present both possibilities.
- **Transitive chains compound uncertainty** — A→B→C has `min_support` (weakest link) and `combined_lift` (product), but uncertainty compounds. Treat these as weaker signals than direct chains.
- **30-day retention limits** — the system only sees patterns within its retention window. Long-cycle patterns (quarterly, annual) are invisible.
- **Tiered activation may surface weaker signals** — when 24h volume is zero, the system activates chains from topics with strong 7d acceleration. These are softer signals than current-day spikes.
- **Do not fabricate** — only use data returned by `intel forecast`. Never invent scenarios or probabilities.
- **Do not dump raw JSON** — always synthesize through the output template.

## Output Template

When delivering a forecast:

- **Analysis window**: date range, events analyzed, source count
- **Active triggers**: topics currently spiking (or 7d-accelerating) that have historical chain patterns. Note `decay_weighted_support` vs raw `support` — a large gap means the pattern hasn't repeated recently.
- **Top scenarios** (3-5):
  - **Topic**: the predicted target topic
  - **Probability**: Bayesian posterior (0-1), explain as high/medium/low. The highest-probability scenario normalizes to 1.0; interpret relative to others. Scenarios with multiple converging trigger chains are stronger (multiplicative lift).
  - **Timeframe**: expected window in days (entropy-widened confidence interval). Wider windows indicate burstier targets.
  - **Triggers**: which active topics are driving this prediction
  - **Evidence**: top supporting article titles (up to 3)
  - **Predictability**: if `target_entropy` is high (> 0.8), note the target is historically bursty and the timeframe window is less reliable
  - **CUSUM discount**: if trigger or target has a recent change point, note reduced confidence in this scenario
- **Transitive chains** (if noteworthy): A→B→C paths with high combined lift, especially cross-domain ones (first domain != last domain). These suggest longer causal reasoning but compound uncertainty.
- **Lifecycle context**: notable phase transitions (emerging, accelerating, peaking, decaying, stable topics). Use `phase_probabilities` to flag ambiguous classifications — if the top two phases are close (< 0.15 gap), present both possibilities. Surface `change_points` to highlight recent structural breaks ("volume regime changed N days ago").
- **Entropy landscape**: flag topics with extreme entropy values — low normalized entropy (< 0.3) = regular cadence (predictable), high (> 0.8) = bursty/surprising
- **Multi-scale alignment**: topics where all timeframes agree on direction (strongest conviction signals). Note `diverging` and `transitioning` topics as potential trend reversals.
- **System dynamics** (from `dynamics` section, if any detected):
  - Reinforcing loops: which topics amplify each other, and what could break the cycle
  - Delays: where the gap between signal and response creates planning risk
  - Accumulations: where pressure is building without release
  - Dampening: where a balancing force or correction has appeared
- **Ranked chains**: top active chains sorted by composite score (support × source_diversity × lift × confidence × (1 + acceleration)). Cross-domain chains are prioritized — they often signal broader market shifts.
- **Confidence notes**: data depth, source diversity, chain support levels, decay-weighted support, CUSUM discounts, and entropy factors — anything that affects forecast reliability. Chains where `decay_weighted_support` is much lower than `support` are stale patterns.
- **So what**: 1-2 sentence synthesis of the most actionable insight
- **Recommended action**: what to watch, prepare for, or investigate further

## References

- Raw signal gathering: [`intel`](../intel/SKILL.md)
- Audience-aware synthesis: [`brief`](../brief/SKILL.md)
- Implementation planning: [`plan`](../plan/SKILL.md)
- Architecture decisions: [`architecture`](../architecture/SKILL.md)
