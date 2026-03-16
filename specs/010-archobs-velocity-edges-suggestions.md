# Spec 010: Archobs Velocity, Edges, and Suggestion Improvements

## Problem

After running archobs + trajectory analysis on a real codebase (sauceiq-node), 10 friction points were identified. The core theme: archobs has all the data needed for trajectory analysis but doesn't expose it through its query layer. Velocity data requires ad-hoc Parquet reading, edge relationships are only available in HTML reports, and suggestions reference static strings instead of actual file paths.

## Goal

Expose velocity, edge, and boundary data through the archobs CLI query layer so agents can reason about development momentum, cluster relationships, and migration patterns without dropping into ad-hoc Python.

## Non-Goals

- Changing the underlying analysis pipeline or clustering algorithms
- Adding new graph signals or edge types
- Replacing the HTML report (CLI queries complement it)

## Anti-Goals

- Over-engineering cluster labels (domain keyword heuristic is a hint, not a name)
- Exposing internal drift window assignments (use xnbr proxy instead)

---

## Changes

### 1. `archobs show velocity` (P0)

**Problem**: Velocity data (commit counts, growth/churn ratios per cluster) requires ad-hoc Parquet reading.

**Solution**: Add `format_velocity()` in display.py and `show velocity` in cli.py.

```bash
archobs show velocity [--window 30] [--compare] [--format json] [--out-file path]
```

**Implementation**:
- Read `commits.parquet` + `cluster_metrics.parquet` + `file_metrics.parquet`
- Join commits to file_metrics on `path` to get `cluster_id` per commit-file row
- Group by `cluster_id`, compute: `commit_count`, `added_count`, `modified_count`, `deleted_count`, `growth_ratio`, `churn_ratio`
- Filter by `--window <days>` (default 30) using `commit_ts` column
- `--compare`: compute same metrics for prior window, add `acceleration` column
- Sort by `commit_count` descending

### 2. Add `recent_commits` to cluster metrics (P1)

**Problem**: Cluster metrics lack commit activity data, forcing separate extraction.

**Solution**: In `pipeline.py:report()`, join commit data to cluster assignments and compute `recent_commits_30d` and `recent_commits_90d` per cluster. Add to `_CLUSTER_TABLE_COLS` and `_CLUSTER_JSON_COLS` in display.py.

### 3. `archobs show edges <cluster_id>` (P1)

**Problem**: Boundary profiles (which clusters connect and how) are computed during report but only stored in the HTML rendering snapshot. Not queryable.

**Solution**: Persist `graph_edges.parquet` with cluster annotations during `report()`, then add `format_edges()` and `show edges` CLI command.

```bash
archobs show edges <cluster_id> [--format json] [--out-file path]
```

**Implementation**:
- Persist cluster-annotated edges (with `cluster_a`/`cluster_b` columns) during report
- Read `graph_edges.parquet` + `cluster_metrics.parquet` + `file_metrics.parquet`
- Filter edges where either `cluster_a` or `cluster_b` matches the given cluster_id
- Group by neighbor cluster, compute: aggregate weight, top connecting file pairs
- Include neighbor cluster label

### 4. Drift suggestion scope — reference actual files (P2)

**Problem**: Drift suggestion scope is hard-coded to `"the lowest-stability cluster window in the drift table"`.

**Solution**: Replace static string with top high-xnbr file paths from the clusters involved in the lowest-stability window. Uses xnbr as a proxy for "migrating" files.

### 5. xnbr suggestion identifies specific concerns (P2)

**Problem**: xnbr suggestion change text is generic: "Separate orchestration and shared boundary logic from the domain logic".

**Solution**: Use boundary_profiles to look up which clusters the high-xnbr file bridges. Name specific concerns in the change text.

### 6. Improve cluster label generation with domain keywords (P2)

**Problem**: `_generate_cluster_label` uses purely structural path prefixes.

**Solution**: Add domain keyword extraction — extract common non-generic filename stems (e.g., "orders", "payments") and prepend when a single dominant stem appears in >40% of files.

### 7. Restructure trajectory SKILL.md (P3)

Lead with archobs-native queries (`show velocity`, `show edges`) as primary path. Move `intel change-trajectory` to enhancement section.

### 8. Split `show all --top` into `--top-risks` / `--top-clusters` (P3)

Add separate `--top-risks` and `--top-clusters` parameters. Keep `--top` as shorthand that sets both (backwards compatible). Default to `--top 0`.

### 9. Clarify init vs report in archobs SKILL.md (P3)

Add note that `report` auto-initializes; only run `init` separately to edit config first.

### 10. Include velocity in `show clusters` JSON (P3)

After `recent_commits` fields are added to cluster_metrics (change #2), they appear automatically in `show clusters --format json` via the column lists.

---

## File Summary

| File | Changes |
|------|---------|
| `tools/archobs/src/archobs/display.py` | `format_velocity()`, `format_edges()`, `read_commits()`, `read_graph_edges()`; enhanced `_generate_cluster_label()`; updated cluster column lists; updated `format_all()` |
| `tools/archobs/src/archobs/cli.py` | `show velocity`, `show edges` subcommands; split `--top` in `show all` |
| `tools/archobs/src/archobs/suggestions.py` | Fix drift scope; enhance xnbr suggestion |
| `tools/archobs/src/archobs/pipeline.py` | `recent_commits_30d`/`recent_commits_90d` in cluster metrics; persist annotated graph_edges |
| `tools/archobs/tests/test_show.py` | Tests for velocity, edges, cluster labels, split --top |
| `tools/archobs/tests/test_core.py` | Tests for suggestion improvements |
| `skills/archobs/SKILL.md` | Velocity/edges commands; init vs report clarification |
| `skills/trajectory/SKILL.md` | Restructured to lead with archobs-native queries |

---

## Verification

```bash
cd tools/archobs && python -m pytest tests/ -v
python -m pytest tests/test_show.py -v -k "velocity or edges"
```
