---
name: intel
description: "Produce tailored intelligence briefs on topics using the intel CLI — trending signals, search results, and evidence packs from collected feeds. Use when you need current context on a technology, industry trend, or domain before making decisions. NOT for architecture analysis (use archobs); NOT for writing specs (use spec)."
metadata: {"stage":"Define","tags":["intelligence","trends","signals","research","briefing","news","feeds","evidence"],"aliases":["intel","intelligence","brief","briefing","signals"]}
---

# Intel (Intelligence Briefs)

## Overview

Produce focused intelligence briefs on a topic by querying the `intel` CLI against locally collected feeds (RSS, HackerNews, Lobsters, EDGAR). Briefs combine trending signals, full-text search hits, and topic breakdowns into a concise, evidence-backed summary an agent or human can act on.

Use this skill when you need current signal on a technology, vendor, standard, or industry trend before planning, spec writing, or architecture decisions.

Success looks like: a brief with ranked signals, source citations, and a clear "so what" for the user's context.

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

6. **Verify**: `intel stats` — check `events_total > 0` and `newest_event` is recent.

## Chooser (Brief Type)

- **Topic brief** (default): Search + trends + topic activity for a specific subject. Use for "what's happening with X?"
- **Trend scan**: Top trending signals across all topics. Use for a general landscape check.
- **Evidence pack**: Bounded bundle of trends + supporting events. Use when feeding context into another skill (plan, spec, architecture).
- **Source check**: Health and freshness of configured feeds. Use to verify data quality before a brief.

## Workflow

1. **Verify data freshness**:
   ```bash
   intel stats
   ```
   Check `total_events` and `newest_event` — if the database is empty or stale, run `intel collect --once` first.

2. **Gather signals** (choose based on brief type):

   **Topic brief** — run in parallel:
   ```bash
   intel search "<topic>" --since 7d --limit 20
   intel trends --window 60m --top 10
   intel topics --active
   ```

   **Trend scan**:
   ```bash
   intel trends --window 60m --top 15
   ```

   **Evidence pack**:
   ```bash
   intel pack --since 6h --top 10 --max-events 5
   ```

   **Source check**:
   ```bash
   intel sources
   ```

3. **Deepen on high-signal hits** — for the most relevant results, fetch full event detail:
   ```bash
   intel events --id <event_id>
   ```

4. **Synthesize the brief** using the output template below. Focus on:
   - What signals are strongest and why they matter to the user's context
   - What's missing or uncertain (data gaps, stale sources)
   - Actionable next steps or skill hand-offs

## Clarifying Questions

- What topic or domain do you want a brief on?
- What time horizon matters? (last few hours, last week, last month)
- Is this for general awareness or feeding into a specific decision?
- Any particular sources or subtopics to prioritize?

## Guardrails

- Do not present intel output as authoritative fact — these are signals from configured feeds, not exhaustive research.
- Do not skip the freshness check — stale data produces misleading briefs.
- Do not dump raw JSON to the user — always synthesize into the output template.
- Do not run `intel collect` in long-running daemon mode during a brief — use `--once` if a refresh is needed.

## Output Template

When delivering a brief:

- **Topic**: the subject of the brief
- **Data window**: time range covered, event count, source count
- **Top signals** (3-5): title, source, timestamp, why it matters
- **Trend context**: what's rising/falling, velocity of change
- **Gaps**: stale sources, missing coverage areas, low-confidence signals
- **So what**: 1-2 sentence synthesis of what this means for the user's context
- **Next skill**: where to go from here (plan, spec, architecture, etc.)
