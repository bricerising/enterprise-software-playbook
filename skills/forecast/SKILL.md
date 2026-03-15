---
name: forecast
description: "Predict likely next developments from topic co-movement patterns, lifecycle positioning, and multi-scale convergence analysis. Use when you need forward-looking intelligence — what's GOING to happen, not what already happened. NOT for gathering raw signals (use intel); NOT for shaping signals into briefs (use brief); NOT for architecture analysis (use archobs)."
metadata: {"stage":"Define","tags":["forecast","prediction","scenarios","chains","lifecycle","convergence","trends","intelligence"],"aliases":["forecast","predict","scenarios","what-next","forward-looking"]}
---

# Forecast (Predictive Intelligence)

## Overview

Predict likely next developments by analyzing topic co-movement patterns, lifecycle positioning, and multi-scale signal convergence from collected intelligence feeds.

While `intel` tells you what happened and `brief` shapes it for an audience, `forecast` tells you what's likely to happen next — which topics are about to spike, which are peaking, and which historical patterns suggest causal chains.

Success looks like: a set of ranked scenarios with probability estimates, timeframes, trigger signals, and supporting evidence that a trader or decision-maker can act on before events materialize.

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

6. **Verify**: `intel stats` — check `events_total > 0` and `newest_event` is recent. Forecast needs at least a few days of data to detect meaningful chains; 2+ weeks is ideal.

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
   Optional tuning:
   ```bash
   intel forecast --lag-window 5 --min-support 2 --top-scenarios 15
   ```

3. **Deepen on high-probability scenarios** — for the top scenarios, fetch supporting events:
   ```bash
   intel search "<target_topic>" --since 7d --limit 10
   intel events --id <event_id>
   ```

4. **Cross-reference with current trends** for context:
   ```bash
   intel trends --since 24h
   ```

5. **Synthesize** using the output template below. Focus on:
   - Which scenarios have the highest probability and shortest timeframes
   - What's currently triggering (active chains)
   - Multi-scale alignment as a confidence signal
   - What the user should watch for or act on now

## Guardrails

- **Probabilities are not certainties** — always present forecasts as probabilistic scenarios, not predictions of fact. Use language like "likely", "historically correlated", "pattern suggests".
- **Freshness check required** — stale data produces stale forecasts. Always verify data recency before synthesizing.
- **Spurious correlations exist** — low-support chains (support < 3) or low source-diversity chains should be flagged as lower confidence.
- **30-day retention limits** — the system only sees patterns within its retention window. Long-cycle patterns (quarterly, annual) are invisible.
- **Do not fabricate** — only use data returned by `intel forecast`. Never invent scenarios or probabilities.
- **Do not dump raw JSON** — always synthesize through the output template.

## Output Template

When delivering a forecast:

- **Analysis window**: date range, events analyzed, source count
- **Active triggers**: topics currently spiking that have historical chain patterns
- **Top scenarios** (3-5):
  - **Topic**: the predicted target topic
  - **Probability**: 0-1 score (explain as high/medium/low)
  - **Timeframe**: expected window in days
  - **Triggers**: which active topics are driving this prediction
  - **Evidence**: top supporting article titles
- **Lifecycle context**: notable phase transitions (emerging, peaking, decaying topics)
- **Multi-scale alignment**: topics where all timeframes agree on direction (strongest conviction signals)
- **Confidence notes**: data depth, source diversity, chain support levels — anything that affects forecast reliability
- **So what**: 1-2 sentence synthesis of the most actionable insight
- **Recommended action**: what to watch, prepare for, or investigate further

## References

- Raw signal gathering: [`intel`](../intel/SKILL.md)
- Audience-aware synthesis: [`brief`](../brief/SKILL.md)
- Implementation planning: [`plan`](../plan/SKILL.md)
- Architecture decisions: [`architecture`](../architecture/SKILL.md)
