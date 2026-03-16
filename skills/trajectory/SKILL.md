---
name: trajectory
description: "Predict likely next features from recent development patterns by analyzing git history through archobs cluster context. Surfaces where development momentum is concentrated, what kinds of changes are happening, and what areas are growing — structured evidence for the LLM to reason about feature adjacency. NOT for external technology signals (use forecast); NOT for compound risk analysis (use forecast + risk-overlay); NOT for architecture metrics without trajectory (use archobs)."
metadata: {"stage":"Define","tags":["trajectory","momentum","velocity","feature-prediction","git-history","development-patterns","change-analysis","adjacency"],"aliases":["trajectory","change-trajectory","what-next","feature-prediction","momentum","velocity"]}
---

# Trajectory (Change Trajectory Analysis)

## Overview

Predict likely next features from recent development patterns. Archobs exposes per-cluster velocity, edge relationships, and commit activity natively — use these as the primary data source. The `intel change-trajectory` tool provides additional enrichment (commit message themes, concentration index) when available.

The data is deterministic and structured. Feature adjacency reasoning ("export features suggest reports are coming next") is your job as the LLM — the tools give you the evidence.

### Signal sources compared

| Tool | Signal source | What it predicts |
|------|--------------|-----------------|
| `forecast` | External feeds (RSS, HN) | External technology shifts |
| `trajectory` | Git history + archobs clusters | Internal development direction |
| `risk-overlay` | archobs + forecast | Compound architectural risk |

## Prerequisites

1. **archobs data**: Run `archobs report` first to get cluster assignments, file risks, drift data, and commit history
2. **archobs CLI**: `pip install -e 'tools/archobs[full]'`

## Workflow

### Primary path: archobs-native queries

1. **Get velocity data** — per-cluster commit activity with growth/churn ratios:
   ```bash
   archobs show velocity --window 30 --format json
   ```
   With acceleration comparison to the prior 30-day window:
   ```bash
   archobs show velocity --window 30 --compare --format json
   ```

2. **Inspect cluster relationships** — which clusters are connected and how strongly:
   ```bash
   archobs show edges <cluster_id> --format json
   ```

3. **Get full context** — complete file-to-cluster mappings, risk, drift:
   ```bash
   archobs show all --top 0 --format json
   archobs show files --format json           # complete file-to-cluster map
   archobs show clusters --format json        # cluster metrics with recent_commits
   archobs show drift --format json           # temporal stability
   ```

4. **Collect branch signals** — active branches are the highest-confidence trajectory signal:
   ```bash
   git branch -r --sort=-committerdate | head -20
   ```
   Branch names are direct feature declarations — they tell you what the team is building, not what you infer from file changes. Include these in your analysis with the highest confidence level.

5. **Interpret the velocity signals**:

   | Signal | Suggests |
   |--------|----------|
   | High `growth_ratio` | New capability being built |
   | High `churn_ratio` | Feature refinement/iteration |
   | High `acceleration` (with --compare) | Active development push |
   | Low `acceleration` | Work winding down |
   | High `recent_commits_30d` in cluster | Focused sprint in one area |
   | Cross-cluster edges (show edges) | Feature adjacency — what depends on what |

6. **Reason about feature adjacency** using the patterns below and your domain knowledge:

   | Observed pattern | Likely next |
   |-----------------|-------------|
   | Active feature branches not yet merged | Direct feature signal — the roadmap in code (highest confidence) |
   | New database migrations creating tables | CRUD endpoints, API, then UI for the new entities |
   | Schema field additions to existing entities | Feature enrichment using those fields in the UI |
   | Test factory additions for new entities | Team is committed to shipping the feature (high confidence) |
   | Export features (CSV, PDF, data transforms) | Reporting features (aggregates, charts, dashboards) |
   | CRUD operations for new entities | Search, filter, and sort capabilities |
   | Data model additions | API endpoints exposing the data |
   | Authentication/authorization scaffolding | User management, roles, permissions UI |
   | Test file additions in a cluster | Committed feature work (the team is investing) |
   | Configuration/settings additions | Feature flags, admin controls |
   | Event/webhook infrastructure | Notification and integration features |

### Enhancement: `intel change-trajectory`

When you need richer analysis (commit message themes, concentration index, recently added/modified/deleted path lists), use the intel CLI:

1. **Build the tool**: `cd tools/intelligence && npm install && npm run build`

2. **Extract commit data** (from archobs Parquet, preferred):
   ```bash
   python3 -c "
   import pandas as pd, json, sys
   df = pd.read_parquet('.archobs/commits.parquet')
   records = df[['commit_sha','commit_ts','status','path']].to_dict('records')
   json.dump(records, sys.stdout)
   " > /tmp/commits.json
   ```

3. **Run trajectory analysis**:
   ```bash
   intel change-trajectory --commits /tmp/commits.json --archobs /tmp/archobs.json
   ```

   With commit messages:
   ```bash
   intel change-trajectory --commits /tmp/commits.json --archobs /tmp/archobs.json \
     --commit-messages /tmp/commit-messages.json --window-days 30
   ```

### Manual fallback (when neither archobs nor intel is available)

When archobs artifacts are not available, extract trajectory signals directly from git:

```bash
# 1. Active directories — where development is concentrated (last 90 days)
git log --since="90 days ago" --name-only --format="" | sort | sed '/^$/d' \
  | xargs -I{} dirname {} | sort | uniq -c | sort -rn | head -30

# 2. Acceleration — compare recent vs older activity
# Last 30 days:
git log --since="30 days ago" --name-only --format="" | sort | sed '/^$/d' \
  | xargs -I{} dirname {} | sort | uniq -c | sort -rn | head -20
# Previous 30–60 days:
git log --since="60 days ago" --until="30 days ago" --name-only --format="" | sort | sed '/^$/d' \
  | xargs -I{} dirname {} | sort | uniq -c | sort -rn | head -20

# 3. Commit message themes — what the team is talking about
git log --since="30 days ago" --format="%s" | tr '[:upper:]' '[:lower:]' \
  | tr -cs '[:alpha:]' '\n' | sort | uniq -c | sort -rn | head -20

# 4. Branch signals — direct feature declarations (highest confidence)
git branch -r --sort=-committerdate | head -20
```

Compare directory counts between the two 30-day windows to identify acceleration (growing) vs deceleration (shrinking).

## Chooser (When to Use)

| Situation | Use |
|---|---|
| "What features are we likely to build next?" | **trajectory** |
| "Where is development concentrated?" | **trajectory** |
| "What external tech shifts affect us?" | `forecast` |
| "Where are compound architectural risks?" | `risk-overlay` |
| "How is our codebase structured?" | `archobs` |

## Guardrails

- **Trajectory is evidence, not prediction** — always present trajectory data as "evidence suggests" or "development patterns indicate," not as certainty.
- **Feature adjacency is heuristic** — the adjacency table above reflects common patterns, not rules. Domain context matters.
- **Cluster assignments may be stale** — if `drift.ari_prev` is low, cluster boundaries are shifting. Path-based analysis is still valid even when clusters are unstable.
- **Commit messages are noisy** — subject_patterns extracts tokens, but "wip" and "misc" are common. Path patterns are often more reliable.
- **Window size affects signal** — 30 days is the default, but a 7-day window for sprint planning or 90-day window for roadmap planning may be more appropriate.
- **Concentration is not quality** — high concentration means focused work, not necessarily good architecture. Cross-reference with archobs risk metrics.
- **Do not fabricate** — only reason from data returned by the trajectory tool. Do not invent development patterns.

## Output Template

When delivering trajectory analysis:

- **Analysis window**: date range, total commits, total file changes
- **Development focus**: which clusters are most active (momentum ranking), concentration interpretation
- **Active areas** (top 2-3 clusters):
  - **Cluster**: ID, label, top paths, archobs metrics
  - **Change profile**: growth/churn ratios — what kind of work is happening
  - **Velocity**: accelerating/steady/decelerating (from --compare)
  - **Key paths**: recently added (what's new), most modified (what's being iterated)
  - **Edge relationships**: which other clusters this one connects to (from show edges)
- **Thematic patterns** (if commit messages available): frequent tokens, recent subjects
- **Feature adjacency reasoning**: based on observed patterns, what features are logically next
- **Confidence notes**: window size, cluster stability (drift), concentration level
- **Recommended action**: what to investigate, plan for, or build next

## References

- External signal forecasting: [`forecast`](../forecast/SKILL.md)
- Architecture observability: [`archobs`](../archobs/SKILL.md)
- Risk overlay composition: [`forecast`](../forecast/SKILL.md) (risk overlay section)
- Implementation planning: [`plan`](../plan/SKILL.md)
