# External Engine

Predict likely next developments from collected intelligence feeds using statistical analysis.

## Analysis engines

The external engine combines seven analysis engines:

1. **Lifecycle positioning** — rule-based + HMM probabilistic phase classification across 4 time windows (1d/7d/14d/30d). Five phases: emerging, accelerating, peaking, decaying, stable. HMM uses Gaussian emission models with log-sum-exp posterior normalization; overrides rule-based when confidence is substantially higher (+0.15).
2. **Chain detection** — discovers topic co-movement patterns (A spikes -> B spikes within N days) with lift, confidence, directionality, and lag stddev. Uses `COALESCE(published_at, fetched_at)` for temporal analysis.
3. **Transitive chains** — extends direct chains to A->B->C paths with combined lift and cross-domain detection. Capped at 100 results.
4. **Exponential decay weighting** — weights chain support by recency (14-day half-life).
5. **Entropy-based surprise scoring** — Shannon entropy + normalized entropy per topic.
6. **CUSUM change-point detection** — detects structural breaks in topic volume timelines.
7. **Bayesian scenario projection** — filters active chains to those with above-chance lift (>= 1.5), then computes posterior probabilities from base rates x chain lifts x decay factors x CUSUM discounts.

## Activation model

Chain activation uses tiered fallback:
- **Primary**: topics with volume >= 3 in the last 24h
- **Secondary**: topics with 7d acceleration > 1.0 (handles sparse-day data)

## Deduplication

All volume counts use `COALESCE(canonical_url, event_id)` by default (`--dedup canonical`). Pass `--dedup none` to count raw events.

## Workflow

1. **Check data freshness and current trends** (run in parallel — they're independent):
   ```bash
   intel stats
   intel trends --since 24h
   ```
   Verify `total_events` is substantial (100+) and data spans multiple days.

2. **Run forecast**:
   ```bash
   intel forecast --summary
   ```
   Use `--summary` for agent consumption — returns only top-3 scenarios, top-5 ranked chains, top-3 dynamics, and change points. Omits empty sections entirely for minimal token usage.

   Use `--compact` when you need more detail (top-N per section) but still want reduced output. **Prefer `--compact` over `--summary` when scenario yield from `--summary` is low** (< 3 actionable scenarios) — the extra ranked chains and lifecycle data often contain the most useful signals.

   Use `--with-context` to inline top event titles per change point topic and top ranked chain topic. This saves a full round-trip of `intel search` deepening calls by embedding narrative context directly in the forecast response.

   CLI defaults: `--lag-window 7 --min-support 2 --top-scenarios 10 --dedup canonical --window 30`

   Optional tuning:
   ```bash
   intel forecast --summary --with-context            # summary + inlined context (recommended)
   intel forecast --summary --window 7                # short-term summary forecast
   intel forecast --compact                           # more detail, still bounded
   intel forecast --compact --with-context             # detail + inlined context
   intel forecast --lag-window 5 --min-support 2 --top-scenarios 15
   intel forecast --window 14                         # 14-day analysis window
   intel forecast --dedup none                        # count raw events
   ```

   **Topic-level and section-level filtering** — query specific subsets without running the full pipeline twice:
   ```bash
   # Get lifecycle/entropy for specific topics (avoids re-running full forecast)
   intel forecast --topics ai.openai,ai.agents,hw.gpu --section lifecycles,entropy,multiscale
   # Get just scenarios and dynamics for specific topics
   intel forecast --compact --topics hw.gpu,aws.bedrock --section scenarios,dynamics
   # Full forecast filtered to a topic group
   intel forecast --topics ai.openai,ai.agents --with-context
   ```
   `--topics` post-filters all sections to only include data relating to specified topics. `--section` includes only named sections in the response. Both can be combined with `--compact`/`--summary`/`--with-context`.

3. **Interpret the response sections**:

   | Section | What it tells you |
   |---|---|
   | `lifecycles` | Phase (emerging/accelerating/peaking/decaying/stable), HMM posteriors, volumes, accelerations, change points |
   | `chains` | Direct A->B co-movement patterns with lift, confidence, directionality, decay-weighted support |
   | `ranked_chains` | Active chains scored and sorted (cross-domain first, then composite score with base-rate discount), capped at 50. Per-trigger cap of 3 ensures diverse trigger representation. |
   | `transitive_chains` | A->B->C paths with combined lift and weakest-link support |
   | `scenarios` | Bayesian posterior probabilities, entropy-widened timeframes, trigger chains, evidence with relevance hints |
   | `multiscale` | Per-topic alignment across 1d/7d/30d (aligned_up, aligned_down, diverging, transitioning) |
   | `entropy` | Shannon entropy per topic — low (< 0.3) = predictable; high (> 0.8) = bursty |
   | `dynamics` | Systems dynamics: reinforcing loops, delays, accumulations (with freshness gate), dampening signals |
   | `change_points_summary` | **HIGH PRIORITY** — topics with CUSUM structural breaks, sorted by recency. Always call these out. |
   | `context` | *(--with-context only)* Top event titles per change point topic and top chain topic. Use for narrative context without separate `intel search` calls. |

   **CUSUM change points** are the highest-priority signal in the forecast output. A change point means a topic's volume trajectory shifted structurally — the historical pattern broke. When `change_points_summary` is non-empty:
   - Always call out which topics had structural breaks and how recently
   - A change point 0-3 days ago = very recent shift, likely still unfolding
   - A change point with `days_ago: 1` on a topic like `ai.openai` means "OpenAI's trajectory shifted yesterday" — this is actionable intelligence
   - Cross-reference with lifecycle phase: a change point + `decaying` phase = growth was arrested; a change point + `emerging` phase = new breakout

   **Chains are sorted by lift** (above-chance co-occurrence ratio), not by raw support. High-lift chains are informative regardless of volume. Chains also include `trigger_base_rate` — values > 0.5 indicate omnipresent triggers whose chains are less informative.

   **Temporal artifact detection**: chains include an optional `temporal_pattern` field. When set to `weekday_correlated`, both the trigger and target topics spike predominantly on weekdays (Mon-Fri, >85% of co-occurrence days). This usually indicates a calendar cadence (e.g., business-hours publishing, earnings cycles, weekday SRE content) rather than a causal relationship. Discount these chains unless you can identify a plausible mechanism beyond shared weekday scheduling.

   **Evidence relevance**: Each scenario includes `evidence_relevance` parallel to `evidence_titles`. Values are 'high' (1-2 topics), 'medium' (3-4 topics), or 'low' (5 topics). Low-relevance evidence may be a classifier false positive — flag it and weight the scenario lower.

   **Classifier precision caveat**: The topic classifier over-tags high-volume topics (e.g., `lang.typescript`, `infra.gpu`). Events about tangentially related subjects get these tags, which inflates both volume numbers and evidence relevance. When evidence titles for a scenario look topically unrelated (e.g., "Home Assistant waters my plants" as evidence for a TypeScript scenario), the classifier misfired — discount that evidence and note the scenario may have inflated support. This primarily affects topics that match on broad keyword patterns.

   **Low scenario yield**: If `--summary` returns fewer than 3 actionable scenarios (e.g., two at P < 0.05), the most useful intelligence is likely in the change points, ranked chains, and system dynamics sections — not the Bayesian scenarios. In this case, try `--compact` for more ranked chain data, or use `--with-context` to get narrative context without extra round-trips. The scenario engine's lift threshold (≥ 1.5) and support minimum filter out weak signals, which is correct behavior — low yield means the data genuinely doesn't support strong scenario-level predictions for this window.

   **Systems dynamics interpretation**:

   | Dynamics type | Forecast signals used | What to look for |
   |---|---|---|
   | `reinforcing_loop` | Bidirectional chains (directionality 0.3-0.7, mutual lift > 1) | Topics that amplify each other. Ask: what breaks this cycle? |
   | `delay` | Active chains with avg_lag_days and lag_stddev | Gap between cause and effect. Long delays with high stddev are harder to predict. |
   | `accumulation` | aligned_up + emerging/accelerating + rising entropy + freshness gate | Pressure building without release. Requires recent published_at events (not backfill). Ask: what is the threshold event? |
   | `dampening` | Decaying phase + recent CUSUM change point | Something arrested growth. Ask: natural limit, policy change, or competing signal? |

4. **Deepen on high-probability scenarios** (skip if `--with-context` was used — context is already inlined):
   ```bash
   # Free-text search (FTS5 syntax) — use natural language, not topic IDs
   intel search "AI agents" --since 7d --limit 10
   # Or filter by exact topic ID using --topic flag
   intel events --topic ai.agents --since 7d --limit 10
   intel events --id <event_id>
   ```

5. **Cross-reference with current trends** (skip if already run in step 1):
   ```bash
   intel trends --since 24h
   ```

6. **Synthesize** using the output template in the main skill document.

**Parallelism note**: `intel stats`, `intel trends`, and `intel forecast` are independent queries with no data dependency. Run them in parallel when possible to minimize latency (e.g., stats + trends in step 1, or trends + forecast if data freshness is already confirmed).
