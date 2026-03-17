# Internal Engine (Trajectory)

Predict likely next features from recent development patterns. Archobs exposes per-cluster velocity, edge relationships, and commit activity natively — use these as the primary data source.

The data is deterministic and structured. Feature adjacency reasoning ("export features suggest reports are coming next") is your job as the LLM — the tools give you the evidence.

## Same-session fast path

When running in the same session as archobs (data already loaded):

1. `archobs show velocity --window 30 --compare --format json` — includes `added_paths`, `external_inbound_weight`, `recent_file_changes_30d`, `recent_file_changes_90d`, and `is_emerging` (when `--compare` is used).
2. `archobs show edges --top-active 3 --max-neighbors 10 --format json` — auto-selects top-3 clusters by file_change_count.
3. `git branch -r --sort=-committerdate | head -20`
4. `git log --since="30 days ago" --format="%s" --no-merges | head -40`
5. Theme extraction + feature adjacency reasoning (see below)

Run commands 1-2 in parallel (independent artifacts). Then 3-4 in parallel (independent git queries).

## Primary path: archobs-native queries

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

   For detailed interpretation rules (compound velocity matrix, per-file intensity, convergent hub pattern, `is_emerging`, test-only clusters, cross-cluster initiative detection), see [`velocity-interpretation.md`](velocity-interpretation.md).

6. **Reason about feature adjacency** using the patterns in [`feature-adjacency.md`](feature-adjacency.md) and your domain knowledge.

**Manual fallback**: When archobs artifacts are not available, see [`manual-fallback.md`](manual-fallback.md) for git-only trajectory extraction.

## Combined archobs + trajectory workflow

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
