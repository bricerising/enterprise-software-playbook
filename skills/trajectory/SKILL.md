---
name: trajectory
description: "Predict likely next features from recent development patterns by analyzing git history through archobs cluster context. Surfaces where development momentum is concentrated, what kinds of changes are happening, and what areas are growing — structured evidence for the LLM to reason about feature adjacency. NOT for external technology signals (use forecast); NOT for compound risk analysis (use forecast + risk-overlay); NOT for architecture metrics without trajectory (use archobs)."
metadata: {"stage":"Define","tags":["trajectory","momentum","velocity","feature-prediction","git-history","development-patterns","change-analysis","adjacency"],"aliases":["trajectory","change-trajectory","what-next","feature-prediction","momentum","velocity"]}
---

# Trajectory (Change Trajectory Analysis)

## Overview

Predict likely next features from recent development patterns. The `intel_change_trajectory` tool analyzes git history through archobs cluster assignments to surface where development momentum is concentrated, what kinds of changes are happening (additions vs modifications vs deletions), and which areas are accelerating.

The tool produces deterministic, structured data. Feature adjacency reasoning ("export features suggest reports are coming next") is your job as the LLM — the tool gives you the evidence.

### Signal sources compared

| Tool | Signal source | What it predicts |
|------|--------------|-----------------|
| `forecast` | External feeds (RSS, HN) | External technology shifts |
| `trajectory` | Git history + archobs clusters | Internal development direction |
| `risk-overlay` | archobs + forecast | Compound architectural risk |

## Prerequisites

1. **archobs data**: Run `archobs` first to get cluster assignments, file risks, and drift data
2. **Commit data**: Extract from `.archobs/commits.parquet` or `git log`
3. **Build the tool**: `cd tools/intelligence && npm install && npm run build`

### Extracting commit data

**From archobs Parquet** (preferred, if Python/pandas available):
```bash
python3 -c "
import pandas as pd, json, sys
df = pd.read_parquet('.archobs/commits.parquet')
records = df[['commit_sha','commit_ts','status','path']].to_dict('records')
json.dump(records, sys.stdout)
" > /tmp/commits.json
```

**From git log** (fallback):
```bash
git log --date-order --reverse --pretty=format:'--COMMIT--%n%H%n%ct' --name-status --no-renames \
  | python3 -c "
import sys, json
commits = []
sha = ts = None
for line in sys.stdin:
    line = line.strip()
    if line == '--COMMIT--':
        sha = next(sys.stdin).strip()
        ts = int(next(sys.stdin).strip())
    elif line and sha and '\t' in line:
        status, path = line.split('\t', 1)
        if status in ('A','M','D'):
            commits.append({'commit_sha': sha, 'commit_ts': ts, 'status': status, 'path': path})
json.dump(commits, sys.stdout)
" > /tmp/commits.json
```

**Extracting commit messages** (optional):
```bash
git log --format='%H%x00%s' | python3 -c "
import sys, json
msgs = []
for line in sys.stdin:
    sha, subject = line.strip().split('\x00', 1)
    msgs.append({'commit_sha': sha, 'subject': subject})
json.dump(msgs, sys.stdout)
" > /tmp/commit-messages.json
```

## Chooser (When to Use)

| Situation | Use |
|---|---|
| "What features are we likely to build next?" | **trajectory** |
| "Where is development concentrated?" | **trajectory** |
| "What external tech shifts affect us?" | `forecast` |
| "Where are compound architectural risks?" | `risk-overlay` |
| "How is our codebase structured?" | `archobs` |

## Workflow

1. **Run archobs** to get cluster assignments. Use `--top 0` to get complete file-to-cluster mappings (default `--top 10` only returns 10 risk files, causing most commits to map to cluster -1 as unassigned):
   ```bash
   archobs show all --top 0 --format json > /tmp/archobs.json
   ```

   If `--top 0` is not supported in your version, extract separately to get complete data:
   ```bash
   archobs show risks --top 0 --format json > /tmp/risks.json
   archobs show clusters --format json > /tmp/clusters.json
   archobs show drift --format json > /tmp/drift.json
   ```

2. **Extract commit data** using one of the methods above

3. **Run trajectory analysis**:
   ```bash
   intel change-trajectory --commits /tmp/commits.json --archobs /tmp/archobs.json
   ```

   With commit messages:
   ```bash
   intel change-trajectory --commits /tmp/commits.json --archobs /tmp/archobs.json \
     --commit-messages /tmp/commit-messages.json --window-days 30
   ```

   Or via MCP tool `intel_change_trajectory` with the same inputs.

4. **Interpret the trajectory signals**:

   | Signal | Suggests |
   |--------|----------|
   | High `growth_ratio` + many `recently_added_paths` | New capability being built |
   | High `churn_ratio` + many `most_modified_paths` | Feature refinement/iteration |
   | High `contraction_ratio` + `recently_deleted_paths` | Area being deprecated or replaced |
   | High `concentration_index` (near 1.0) | Focused sprint in one area |
   | Low `concentration_index` (near 1/N) | Scattered work across many areas |
   | `velocity_trend: accelerating` | Active development push |
   | `velocity_trend: decelerating` | Work winding down |
   | `velocity_trend: dormant` | Minimal recent activity |
   | `recently_added_paths` patterns | File naming reveals feature intent |
   | `subject_patterns.top_tokens` | Thematic focus of recent commits |

5. **Reason about feature adjacency** using the patterns below and your domain knowledge:

   | Observed pattern | Likely next |
   |-----------------|-------------|
   | Export features (CSV, PDF, data transforms) | Reporting features (aggregates, charts, dashboards) |
   | CRUD operations for new entities | Search, filter, and sort capabilities |
   | Data model additions | API endpoints exposing the data |
   | Authentication/authorization scaffolding | User management, roles, permissions UI |
   | Test file additions in a cluster | Committed feature work (the team is investing) |
   | Configuration/settings additions | Feature flags, admin controls |
   | Event/webhook infrastructure | Notification and integration features |
   | Schema migrations | Data import/migration tooling |

6. **Cross-reference with other tools** (optional):
   - Run `forecast` to check if external signals align with internal trajectory
   - Run `risk-overlay` to check if high-momentum clusters have compound risks
   - Read code in active clusters for deeper context

## Guardrails

- **Trajectory is evidence, not prediction** — always present trajectory data as "evidence suggests" or "development patterns indicate," not as certainty.
- **Feature adjacency is heuristic** — the adjacency table above reflects common patterns, not rules. Domain context matters.
- **Cluster assignments may be stale** — if `drift.ari_prev` is low, cluster boundaries are shifting. Path-based analysis (recently_added, most_modified) is still valid even when clusters are unstable.
- **Commit messages are noisy** — subject_patterns extracts tokens, but "wip" and "misc" are common. Path patterns are often more reliable.
- **Window size affects signal** — 30 days is the default, but a 7-day window for sprint planning or 90-day window for roadmap planning may be more appropriate.
- **Concentration is not quality** — high concentration means focused work, not necessarily good architecture. Cross-reference with archobs risk metrics.
- **Do not fabricate** — only reason from data returned by the trajectory tool. Do not invent development patterns.

## Output Template

When delivering trajectory analysis:

- **Analysis window**: date range, total commits, total file changes
- **Development focus**: which clusters are most active (momentum ranking), concentration index interpretation
- **Active areas** (top 2-3 clusters):
  - **Cluster**: ID, top paths, archobs metrics
  - **Change profile**: growth/churn/contraction ratios — what kind of work is happening
  - **Velocity**: accelerating/steady/decelerating/dormant
  - **Key paths**: recently added (what's new), most modified (what's being iterated)
- **Thematic patterns** (if commit messages available): frequent tokens, recent subjects
- **Feature adjacency reasoning**: based on observed patterns, what features are logically next
- **Confidence notes**: window size, cluster stability (drift), concentration level
- **Recommended action**: what to investigate, plan for, or build next

## References

- External signal forecasting: [`forecast`](../forecast/SKILL.md)
- Architecture observability: [`archobs`](../archobs/SKILL.md)
- Risk overlay composition: [`forecast`](../forecast/SKILL.md) (risk overlay section)
- Implementation planning: [`plan`](../plan/SKILL.md)
