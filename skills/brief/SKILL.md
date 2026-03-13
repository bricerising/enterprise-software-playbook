---
name: brief
description: "Shape intel signals into audience-aware briefs (executive, engineering, decision, daily digest). Use when you have intel data and need a reader-ready summary tailored to a specific audience or decision context. NOT for gathering raw signals (use intel); NOT for writing specs (use spec); NOT for implementation planning (use plan)."
metadata: {"stage":"Define","tags":["brief","audience","executive","engineering","decision","digest","synthesis","presentation","stakeholder"],"aliases":["brief","briefing","executive-brief","daily-digest","decision-brief"]}
---

# Brief (Audience-Aware Intelligence Briefs)

## Overview

Shape raw intel signals into focused, reader-ready briefs tailored for a specific audience. Same data, different lens depending on who's reading and why.

The `intel` skill gathers signals. This skill formalizes the presentation layer: filtering, ranking, and synthesizing those signals through audience-appropriate templates. An executive gets plain-language bullets with recommended actions; an engineer gets stack-relevant signals grouped by topic; a decision-maker gets evidence mapped to options.

Success looks like: a brief that the target audience can read in under 2 minutes and act on without needing to parse raw data.

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

| Type | Audience | Shape | When to use |
|---|---|---|---|
| **Executive** | Leadership, stakeholders | 3-5 bullet TL;DR, "so what", recommended action, risk flags | Status updates, steering meetings, decision escalation |
| **Engineering** | Dev team, architects | Signals mapped to our stack, migration/deprecation implications, links to relevant specs | Sprint planning, tech radar updates, dependency decisions |
| **Decision** | Anyone facing a specific choice | Framed around a binary/multi-option decision, evidence for/against each option, recommendation | Buy-vs-build, adopt-vs-wait, vendor selection |
| **Daily digest** | General team awareness | Curated top-5 signals with one-line commentary, quick-scan format | Morning standup context, async team channel |

## Clarifying Questions

- Who is the audience for this brief?
- What time horizon matters? (last few hours, last day, last week)
- Is there a specific topic or decision this brief should focus on?
- Which brief type fits? (executive, engineering, decision, daily digest)

## Workflow

1. **Determine brief type and audience** — ask or infer from context. If unclear, default to daily digest.

2. **Check intel freshness**:
   ```bash
   intel stats
   ```
   Check `total_events` and `newest_event`. If the database is empty or stale (oldest data beyond the brief's time horizon), refresh:
   ```bash
   intel collect --once
   ```

3. **Gather raw signals** — delegate to intel commands based on brief type:

   **Executive / Daily digest**:
   ```bash
   intel pack --since 24h --top 10 --max-events 5
   ```

   **Engineering** — run in parallel:
   ```bash
   intel pack
   intel search "<stack-relevant terms>"
   intel topics --active
   ```

   **Decision** — run in parallel:
   ```bash
   intel search "<decision topic>"
   intel trends
   ```
   Then deepen on the most relevant hits:
   ```bash
   intel events --id <event_id>
   ```

4. **Filter and rank** — select the top signals by relevance to the audience. Drop noise:
   - Executive: prioritize business impact, risk, competitive signals
   - Engineering: prioritize stack relevance, deprecations, security advisories
   - Decision: prioritize evidence that differentiates the options
   - Daily digest: prioritize breadth and recency

5. **Synthesize** — apply the output template for the chosen brief type (see below). Do not mix templates.

6. **Flag gaps** — note stale sources, missing coverage, low-confidence signals. Be explicit about what the brief does *not* cover.

## Guardrails

- Do not present intel signals as authoritative fact — these are signals from configured feeds, not exhaustive research.
- Do not dump raw JSON — always synthesize through the output template.
- Do not mix brief types — pick one and commit.
- Do not skip the freshness check — stale data produces misleading briefs.
- Do not fabricate signals — only use data returned by `intel` commands.
- Executive briefs must be readable by non-technical stakeholders — no jargon, no acronyms without expansion.

## Output Template

### Executive

- **Headline**: 1 sentence — what's the most important thing to know
- **Top signals** (3-5 bullets): plain language, no jargon, each with why it matters
- **So what**: 1-2 sentences — implication for us specifically
- **Recommended action / next step**: what to do with this information
- **Risk flags** (if any): things that could go wrong if we ignore this

### Engineering

- **Data window**: time range covered, event count, source count
- **Signals by relevance to our stack**: grouped by topic (e.g., runtime, framework, infra, tooling)
- **Migration / deprecation watch**: things to track that may force future work
- **New tools / releases worth evaluating**: notable releases relevant to our stack
- **Security advisories** (if any): CVEs, supply-chain risks, dependency alerts
- **Links to deeper reads**: URLs from source events for follow-up

### Decision

- **Decision statement**: what we're choosing between (frame as a clear question)
- **Evidence for each option**: sourced from signals, with citations
- **Gaps in evidence**: what we don't know and how it affects confidence
- **Recommendation**: selected option with confidence level (high / medium / low)
- **Next skill**: `plan` or `spec` to act on the decision

### Daily Digest

- **Date + data window**: date, time range, source count
- **Top 5 signals**: title + one-line take for each
- **One thing to watch**: emerging trend that hasn't peaked yet
- **Source health note** (if degraded): flag stale or unreachable sources

## References

- Raw signal gathering: [`intel`](../intel/SKILL.md)
- Implementation planning: [`plan`](../plan/SKILL.md)
- Spec-driven development: [`spec`](../spec/SKILL.md)
- Architecture decisions: [`architecture`](../architecture/SKILL.md)
