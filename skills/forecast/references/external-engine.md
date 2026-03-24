# External Engine

Predict likely next developments from collected intelligence feeds using statistical analysis.

## Analysis engines

The external engine combines seven analysis engines:

1. **Lifecycle positioning** — rule-based + HMM probabilistic phase classification across 5 time windows (1d/7d/14d/30d/90d). Five phases: emerging, accelerating, peaking, decaying, stable. HMM uses Gaussian emission models with log-sum-exp posterior normalization; overrides rule-based when confidence is substantially higher (+0.15).
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
   intel trends --since 7d          # sustained momentum (add for medium/long-term questions)
   ```
   Verify `total_events` is substantial (100+) and data spans multiple days.

   **Match trends window to the question's time horizon.** The 24h trends identify which chain triggers are currently active (the activation model fires on 24h volume >= 3). But for medium-to-long-term questions ("what's next in the market?", "what should we prepare for?"), 24h trends alone over-weight daily noise and miss sustained signals. Add a 7d trends query to distinguish genuine momentum from single-day spikes. For short-term questions ("what's happening right now?"), 24h alone is sufficient.

2. **Run forecast**:
   ```bash
   intel forecast --summary
   ```
   Use `--summary` for agent consumption — returns only top-3 scenarios, top-5 ranked chains, top-3 dynamics, and change points. Omits empty sections entirely for minimal token usage. **Adaptive behavior**: when scenario yield is thin (< 3), summary mode automatically upgrades ranked chains, dynamics, and lifecycles to compact limits — no need to manually retry with `--compact`.

   Use `--compact` when you need more detail (top-N per section) but still want reduced output.

   Use `--with-context` to inline top event titles per change point topic and top ranked chain topic. This saves a full round-trip of `intel search` deepening calls by embedding narrative context directly in the forecast response.

   CLI defaults: `--lag-window 7 --min-support 2 --top-scenarios 10 --dedup canonical --window 120`

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
   | `scenarios` | Ranked scenario scores (relative, not calibrated probabilities), entropy-widened timeframes, trigger chains, evidence with relevance hints |
   | `multiscale` | Per-topic alignment across 1d/7d/30d/90d (aligned_up, aligned_down, diverging, transitioning) |
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

   **Temporal artifact detection**: chains include an optional `temporal_pattern` field and a `weekday_ratio` field (always present). When `temporal_pattern` = `weekday_correlated`, both the trigger and target topics spike predominantly on weekdays (Mon-Fri, >75% of co-occurrence days). This usually indicates a calendar cadence (e.g., business-hours publishing, earnings cycles, weekday SRE content) rather than a causal relationship. The `weekday_ratio` field (0-1, average of trigger and target weekday fractions) is always present so you can assess calendar artifact risk programmatically even below the binary threshold. Chains with `weekday_ratio` > 0.7 warrant extra scrutiny.

   **Evidence relevance**: Each scenario includes `evidence_relevance` parallel to `evidence_titles`. Values are 'high' (1-2 topics), 'medium' (3-4 topics), or 'low' (5 topics). Low-relevance evidence may be a classifier false positive — flag it and weight the scenario lower.

   **Classifier precision caveat**: The topic classifier over-tags high-volume topics (e.g., `lang.typescript`, `infra.gpu`). Events about tangentially related subjects get these tags, which inflates both volume numbers and evidence relevance. When evidence titles for a scenario look topically unrelated (e.g., "Home Assistant waters my plants" as evidence for a TypeScript scenario), the classifier misfired — discount that evidence and note the scenario may have inflated support. This primarily affects topics that match on broad keyword patterns.

   **Low scenario yield**: If `--summary` returns fewer than 3 actionable scenarios (e.g., two at P < 0.05), the most useful intelligence is likely in the change points, ranked chains, and system dynamics sections — not the Bayesian scenarios. Summary mode now handles this automatically: when scenario yield is thin (< 3), it upgrades ranked chains, dynamics, and lifecycles to compact limits. Use `--with-context` to add narrative context without extra round-trips. The scenario engine's lift threshold (≥ 1.5) and support minimum filter out weak signals, which is correct behavior — low yield means the data genuinely doesn't support strong scenario-level predictions for this window.

   **Systems dynamics interpretation**:

   | Dynamics type | Forecast signals used | What to look for |
   |---|---|---|
   | `reinforcing_loop` | Bidirectional chains (directionality 0.3-0.7, mutual lift > 1) | Topics that amplify each other. Ask: what breaks this cycle? |
   | `delay` | Active chains with avg_lag_days and lag_stddev | Gap between cause and effect. Long delays with high stddev are harder to predict. |
   | `accumulation` | aligned_up + emerging/accelerating + rising entropy + freshness gate | Pressure building without release. Requires recent published_at events (not backfill). Ask: what is the threshold event? |
   | `dampening` | Decaying phase + recent CUSUM change point | Something arrested growth. Ask: natural limit, policy change, or competing signal? |

4. **Assess structural limitations before synthesis**:

   The external engine is a **technology momentum detector** — it identifies where engineering attention is concentrating before it becomes consensus. Understand what it can and cannot tell you:

   | What it measures | What it doesn't measure |
   |---|---|
   | Coverage volume and acceleration | Revenue, margins, or enterprise adoption |
   | Topic co-movement timing | Causal mechanisms (why A predicts B) |
   | Lifecycle phase (attention curve position) | Product-market fit or technical maturity |
   | Cross-domain signal propagation | Signals behind paywalls (Gartner, Forrester) |
   | Developer community attention (HN, RSS, blogs) | Enterprise procurement decisions |
   | English-language technology discourse | Non-English markets and communities |

   **Compensating for blind spots**: When the forecast surfaces a high-scoring scenario or structural break, ask "what signals would I need from outside this system to validate this?" For enterprise-relevant decisions, supplement with analyst reports, job posting trends, and financial data. The system's 120-day retention window with 90d lifecycle timescale enables quarterly trend detection, but cannot detect year-over-year patterns or multi-year trends.

5. **Ground each structural break in specific events** (do NOT skip even if `--with-context` was used):

   For every topic with a CUSUM change point, calculate the search window from the break's `days_ago` value — **not** a flat `--since 7d`. The rule: `--since {days_ago + 4}d` to capture events that preceded the structural shift.

   **Two query batches are required** — run them in parallel:

   **Batch A — Topic event queries** (one per break topic):
   ```bash
   # Example: macro.commodities broke 6 days ago → --since 10d
   intel events --topic macro.commodities --since 10d --limit 10
   # Example: compute.semiconductor broke 6 days ago → --since 10d
   intel events --topic compute.semiconductor --since 10d --limit 10
   # Example: ai.agents broke 2 days ago → --since 6d
   intel events --topic ai.agents --since 6d --limit 10
   ```

   **Batch B — Alternative-mechanism searches** (MANDATORY, run in the SAME parallel call as Batch A):
   For every break cluster, identify the "obvious" narrative you'd construct from `--with-context` titles or general knowledge, then search for at least 2 alternative mechanisms. These are free-text searches, not topic-filtered — they catch cross-topic mechanisms that topic queries miss.
   ```bash
   # If the obvious narrative for a commodities/energy break is "oil prices":
   intel search "helium" --since 10d --limit 5
   intel search "lithium" --since 10d --limit 5
   intel search "neon" --since 10d --limit 5
   # If the obvious narrative for a semiconductor break is "demand surge":
   intel search "fab shutdown" --since 10d --limit 5
   intel search "supply shortage" --since 10d --limit 5
   ```
   **Why Batch B cannot be deferred**: Today's event titles are dominated by *consequences* of the break (oil price articles, stock moves), not the *cause* (e.g., helium supply disruption to EUV lithography). If you read Batch A results first, you will anchor on the consequence narrative and Batch B becomes a confirmation exercise rather than a genuine search. Running both batches in the same parallel call prevents this anchoring.

   **Cluster rule**: When multiple breaks share a similar date (within 2 days of each other), they likely share a root cause. Use the *oldest* break date in each cluster to set the window for all topics in that cluster.

   **Why break-relative windows**: A flat `--since 7d` misses the mechanism when the break is older than 3 days. Today's highest-scoring events are about the *consequences* of the break (e.g., oil price articles citing the Iran war), not the *cause* (e.g., helium supply disruption from drone attacks on Qatar). The break-relative window ensures you see the events that were publishing *when* the structural shift actually happened.

   If `--with-context` was used, the response includes `break_titles` for change-point topics where `days_ago > 3` — these are event titles from ±2 days around the break date. Use them as a starting point, but still run the full `intel events` query if the break_titles suggest a mechanism you didn't expect.

   **Anti-pattern to avoid**: Do not search only for catalysts you already expect to find. Searching for "Iran energy" when commodities broke will confirm an energy thesis while missing that the actual mechanism is helium supply disruption to EUV lithography. Let the events within each topic tell you what happened — then construct the narrative.

5b. **Name the specific mechanism for each break** (mandatory — do NOT proceed to step 6 or synthesis without completing this):

   For each structural break, write one sentence naming the specific mechanism. **You must cite which search results (from both Batch A and Batch B) informed your mechanism.** If your mechanism is informed only by Batch A results, you have not done Batch B properly — go back and run it.

   | Break topic | Mechanism (one sentence) | Source |
   |---|---|---|
   | `macro.commodities` | *e.g., "Drone attacks shut down Qatar's helium hub (33% of global supply), threatening EUV lithography gas supply"* | *Batch B: `intel search "helium"` returned "Qatar helium shutdown puts chip supply chain on a two-week clock"* |
   | `compute.semiconductor` | *e.g., "Helium shortage from Qatar disruption directly threatens EUV chip fabrication"* | *Batch A: `intel events --topic compute.semiconductor` + Batch B: helium search* |

   **Default-association check**: If your named mechanism matches the "obvious" association for the topic (e.g., Iran conflict → oil prices for a commodities break), your Batch B searches should have already surfaced alternatives. Review them now. If Batch B returned a more specific upstream mechanism (e.g., helium, neon, rare earth disruption) that explains both the topic break AND co-occurring breaks in other topics, prefer it over the default.

   **Cross-check**: Do the Batch A event titles support your named mechanism, or are they about something else? If Batch B says "helium" but Batch A titles say "oil," the Batch A titles are likely about consequences. Check the older titles in the break-relative window — they should confirm the upstream mechanism.

6. **Deepen on high-scoring scenarios** (skip if `--with-context` was used AND step 5 already covered the relevant topics):
   ```bash
   # Free-text search (FTS5 syntax) — use natural language, not topic IDs
   intel search "AI agents" --since 7d --limit 10
   # Or filter by exact topic ID using --topic flag
   intel events --topic ai.agents --since 7d --limit 10
   intel events --id <event_id>
   ```

7. **Deepen on accumulation signals**: When the dynamics section shows `accumulation` entries (pressure building without release), these need context to be actionable. The key question is: "what is the threshold event?" Search for recent content on the accumulating topic to identify what could trigger a release:
   ```bash
   # For each accumulation topic, search for recent context
   intel search "kubernetes security" --since 7d --limit 10
   intel events --topic security.appsec --since 14d --limit 10
   ```
   Look for: policy announcements, vulnerability disclosures, conference deadlines, or competitive moves that could serve as the threshold event. Accumulations without an identifiable trigger are noted but lower-priority.

8. **Cross-reference with current trends** (skip if already run in step 1):
   ```bash
   intel trends --since 24h
   intel trends --since 7d          # if medium/long-term question
   ```

9. **Synthesize** using the output template in the main skill document.

**Parallelism note**: `intel stats`, `intel trends`, and `intel forecast` are independent queries with no data dependency. Run them in parallel when possible to minimize latency (e.g., stats + trends in step 1, or trends + forecast if data freshness is already confirmed).
