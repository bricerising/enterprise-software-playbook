---
name: trajectory
description: "Predict likely next features from recent development patterns by analyzing git history through archobs cluster context. Surfaces where development momentum is concentrated, what kinds of changes are happening, and what areas are growing — structured evidence for the LLM to reason about feature adjacency. NOT for external technology signals (use forecast); NOT for architecture metrics without trajectory (use archobs)."
metadata: {"stage":"Define","tags":["trajectory","momentum","velocity","feature-prediction","git-history","development-patterns","change-analysis","adjacency"],"aliases":["trajectory","what-next","feature-prediction","momentum","velocity"]}
---

# Trajectory (Change Trajectory Analysis)

## Overview

Predict likely next features from recent development patterns. Archobs exposes per-cluster velocity, edge relationships, and commit activity natively — use these as the primary data source.

The data is deterministic and structured. Feature adjacency reasoning ("export features suggest reports are coming next") is your job as the LLM — the tools give you the evidence.

### Signal sources compared

| Tool | Signal source | What it predicts |
|------|--------------|-----------------|
| `forecast` | External feeds (RSS, HN) | External technology shifts |
| `trajectory` | Git history + archobs clusters | Internal development direction |

## Prerequisites

1. **archobs data**: Run `archobs report` first to get cluster assignments, file risks, drift data, and commit history
2. **archobs CLI**: `pip install -e 'tools/archobs[full]'`

## Workflow

### Same-session fast path

When running in the same session as archobs (data already loaded), use this checklist instead of the full workflow below:

1. `archobs show velocity --window 30 --compare --format json` — `added_paths` are included by default in JSON output. Also includes `external_inbound_weight`, `recent_file_changes_30d`, `recent_file_changes_90d`, and `is_emerging` (when `--compare` is used). Use `--no-added-paths` to exclude them.
2. `archobs show edges --top-active 3 --max-neighbors 10 --format json` — auto-selects top-3 clusters by file_change_count, no need to extract cluster IDs first. `--max-neighbors 10` prevents output explosion for large hub clusters.
3. `git branch -r --sort=-committerdate | head -20`
4. `git log --since="30 days ago" --format="%s" --no-merges | head -40`
5. Theme extraction + feature adjacency reasoning (step 5 and 6 below)

Run commands 1-2 in parallel (they read independent artifacts). Then 3-4 in parallel (independent git queries). The `--top-active` flag on edges eliminates the previous sequential dependency on velocity results.

### Primary path: archobs-native queries

1. **Get velocity data** — per-cluster commit activity with growth/churn ratios:
   ```bash
   archobs show velocity --window 30 --compare --format json
   ```
   Recently added file paths (`added_paths`) are included by default in JSON output — they are the highest-signal data for feature prediction. Use `--compare` to get acceleration relative to the prior window. Use `--no-added-paths` to exclude them if output size is a concern.

   Simpler variants (when you only need a quick check, not full trajectory):
   ```bash
   archobs show velocity --window 30 --format json                  # basic velocity only
   archobs show velocity --window 30 --compare --format json        # with acceleration, no paths
   ```

2. **Inspect cluster relationships** — which clusters are connected and how strongly:
   ```bash
   archobs show edges <cluster_id> --format json
   ```

3. **Get full context** — run individual queries in parallel (preferred for large repos to avoid output truncation):
   ```bash
   # Run these in parallel:
   archobs show files --format json           # complete file-to-cluster map
   archobs show clusters --format json        # cluster metrics with recent_file_changes
   archobs show drift --format json           # temporal stability
   archobs show risks --top 10 --format json  # top risk files
   ```
   Or use the compact all-in-one for smaller repos:
   ```bash
   archobs show all --compact --format json
   ```
   All `show` subcommands read from Parquet artifacts independently — **run them in parallel** for speed.

4. **Collect branch signals** — active branches are the highest-confidence trajectory signal:
   ```bash
   git branch -r --sort=-committerdate | head -20
   ```
   Branch names are direct feature declarations — they tell you what the team is building, not what you infer from file changes. Include these in your analysis with the highest confidence level.

   **Ticket ID extraction**: Extract ticket ID prefixes (e.g. `OIQ-516`, `CR-02`) from branch names and cross-reference with commit message prefixes (e.g. `feat(loyalty):`, `chore(db):`) to group related branches into feature initiatives. Multiple branches sharing the same prefix or ticket series (e.g. `OIQ-515`, `OIQ-516`, `OIQ-523`) likely represent coordinated work on one feature area.

   **Ticket series grouping heuristic**: When 3+ branches share a numeric prefix series (e.g., `OIQ-515`, `OIQ-516`, `OIQ-523`) **or** a domain keyword appears in both branch names and commit messages (e.g., "loyalty" in `OIQ-515-loyalty-points`, `OIQ-516-auto-earn-and-reversals`, and `feat(loyalty):` commits), group them as a single initiative. Report the initiative name (derived from the shared keyword), the branch count, and the combined cluster footprint. This is important because individual branches may each touch only a small area, but the combined initiative may span multiple clusters and warrant architectural attention as a coordinated effort.

4b. **Collect commit message themes** — what the team is describing:
   ```bash
   git log --since="30 days ago" --format="%s" --no-merges | head -40
   ```
   Commit message prefixes (e.g. `feat(loyalty):`, `chore(db):`, `fix(tests):`) are often the single highest-confidence signal for identifying active feature work. Parse conventional commit prefixes to identify which domains are receiving feature work vs maintenance.

   **Note**: `commits.parquet` now includes a `message` column (first 80 chars of the subject line), so `archobs show commits --since 30 --format json` can provide commit messages directly without a separate `git log` call. However, `git log` remains useful for accessing the full untruncated subject and for `--no-merges` filtering.

5. **Interpret the velocity signals**:

   | Signal | Suggests |
   |--------|----------|
   | High `growth_ratio` | New capability being built |
   | High `churn_ratio` | Feature refinement/iteration |
   | High `acceleration` (with --compare) | Active development push |
   | Low `acceleration` | Work winding down |
   | High `recent_file_changes_30d` in cluster | Focused sprint in one area |
   | Cross-cluster edges (show edges) | Feature adjacency — what depends on what |
   | High `external_inbound_weight` | Gravitational center — other clusters pull toward this one |

   **Compound velocity signal matrix** — the combination of acceleration and growth is what matters for interpretation:

   | Acceleration | Growth | Signal |
   |---|---|---|
   | High (>1.5x) | High (>30%) | Brand-new feature area expanding rapidly — needs architecture review |
   | High (>1.5x) | Zero (0%) | Batch ops work on existing code — needs capacity planning |
   | Moderate | High (>20%) | Steady buildout of new capability — define boundaries early |
   | Low (<0.5x) | High churn | Maintenance/refinement — safe window for refactoring |
   | Low (<0.5x) | Zero | Dormant — safe for structural cleanup if leaky |
   | Test-only cluster with high growth | — | Feature commitment signal — team is writing tests before/alongside production code. Look at the production cluster this maps to for architectural decisions. |

   **Interpret file_change_count relative to cluster size**: Absolute file_change_count is misleading without size context. A cluster with 202 changes and 203 files has ~1 change/file (broad shallow touch — migration or bulk rename), while one with 30 changes and 5 files has 6 changes/file (deep iteration on a focused area). The velocity JSON output includes a `size` field for this purpose. Use `file_change_count / size` as the per-file change intensity when comparing clusters of different sizes.

   **Cross-reference velocity with risk**: Files that appear in both `show risks` (risk > 0.5) AND belong to a high-velocity cluster are the highest-urgency items. These are files that are simultaneously architecturally risky and actively being changed — the most dangerous combination. Use `archobs show risks --min-risk 0.5 --min-volatility 0.5 --format json` to find them directly.

   **Convergent hub pattern**: When 3+ clusters leak primarily toward the same target (visible via `show edges` or the `external_inbound_weight` metric on `show clusters`), the finding is about the hub, not the individual boundaries. The actionable insight is "decompose the attractor" rather than "build N separate boundaries." This is the most common pattern in real monoliths.

   **`is_emerging` flag**: `is_emerging` is `true` when a cluster had zero commits in the prior window but has commits in the current window. This signals a brand-new area of development, not acceleration of existing work. Emerging clusters need early boundary definition; accelerating clusters need capacity planning.

   **Acceleration context for new clusters**: When `prior_commit_count` is 0 or very low, acceleration will be infinite or very high (e.g. 6.0x). This signals **emergence** (a brand-new area appearing), not **acceleration** (an existing area speeding up). Distinguish "brand new area" from "existing area speeding up" — they require different responses. New areas need architecture review; accelerating areas need capacity planning.

   **Test-only clusters**: A cluster containing predominantly test files (>80% test paths) with high acceleration is a different signal than a production cluster at the same metrics. It means the team is investing in test coverage for a feature — high confidence the feature is real and the team is committed, but boundary decisions live in the production code, not the test code. Identify the production cluster the tests correspond to and direct architectural recommendations there.

   **Cross-cluster initiative detection**: When multiple clusters share domain keywords in their `added_paths` or labels (e.g., "loyalty" appearing in both a production cluster and a test cluster), group them as a single feature initiative. This is especially common with test-only clusters — they indicate commitment to a feature whose boundary decisions live in the production cluster. More generally, any time 2+ clusters share a domain keyword (in labels, added paths, or branch names), treat them as one coordinated initiative for trajectory purposes rather than analyzing each cluster independently. The combined velocity and scope of the initiative is what matters for architectural decisions.

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
   | Migration file recreation/renumbering | Schema stabilization before ship — feature is close to merge |
   | Multiple "review cleaning" commits | Code review in progress — approaching merge |
   | Idempotency key additions | Offline mode or distributed operation hardening |
   | CORS configuration changes | Deployment environment changes (new domains, staging environments) |
   | Test coverage push (many test-only commits) | CI pipeline enforcement or pre-release quality gate |
   | Service decomposed into sub-modules (lock, utils, payloads) | Feature maturing toward production — expect monitoring/alerting additions next |
   | P0/security fix branches alongside feature branches | Hardening phase — team is stabilizing before or during feature rollout |
   | Hub/infrastructure changes (CORS, server.ts, env config) | Deployment environment shift (new domains, staging, or architecture change) |
   | Multiple clusters with same domain keyword in added_paths | Coordinated multi-sprint initiative — treat as single feature for trajectory |

### Manual fallback (when archobs is not available)

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

# 3. Commit message themes (also in primary workflow step 4b — repeat here for standalone use)
git log --since="30 days ago" --format="%s" | tr '[:upper:]' '[:lower:]' \
  | tr -cs '[:alpha:]' '\n' | sort | uniq -c | sort -rn | head -20

# 4. Branch signals — direct feature declarations (highest confidence)
git branch -r --sort=-committerdate | head -20
```

Compare directory counts between the two 30-day windows to identify acceleration (growing) vs deceleration (shrinking).

## Combined Archobs + Trajectory Workflow

When running both archobs and trajectory in the same session (the most common case), use this optimized combined sequence instead of the individual workflows:

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
3. **Synthesize** into a combined report using both output templates.

This eliminates the sequential fast-path steps and runs everything in one parallel batch after the report completes.

## Chooser (When to Use)

| Situation | Use |
|---|---|
| "What features are we likely to build next?" | **trajectory** |
| "Where is development concentrated?" | **trajectory** |
| "What external tech shifts affect us?" | `forecast` |
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
- Implementation planning: [`plan`](../plan/SKILL.md)
