# Spec 009: Archobs Agent Ergonomics

## Problem

After running archobs on a real 1,251-file TypeScript monolith and performing trajectory analysis, several ergonomic gaps emerged that force agents to drop into ad-hoc Python to understand the architecture. The CLI outputs are optimized for human-readable summaries but lack the completeness needed for agent-driven workflows — particularly trajectory analysis, which needs full file-to-cluster mappings and cluster membership inspection.

## Goal

Improve the archobs CLI to serve agent workflows as a first-class use case, eliminating the need for ad-hoc Parquet reading during trajectory and planning analysis.

## Non-Goals

- Changing the underlying analysis pipeline or clustering algorithms
- Adding new metrics or scores (existing metrics are sufficient)
- Replacing the human-readable table output (agents use `--format json`)

## Anti-Goals

- Over-indexing on JSON output size (reasonable defaults, not unlimited dumps)
- Auto-generating cluster labels that mislead (path prefixes are heuristic, not definitive)

---

## Changes

### A. Cluster file membership inspection (High — Finding #4)

**Problem**: `archobs show clusters` returns metrics (leakage, cohesion, etc.) but not which files belong to each cluster. Cluster IDs are meaningless without knowing what's in them.

**Solution**: Add a `show cluster-files` subcommand and an `--include-paths` flag.

```bash
# Show files in a specific cluster
archobs show cluster-files <cluster_id> [--top-paths 20] [--format json]

# Include top paths in cluster listing
archobs show clusters --include-paths [--top-paths 10] [--format json]
```

**Implementation**: Read `file_metrics.parquet`, filter by `cluster_id`, sort by risk descending, limit to `--top-paths` (default 20).

**Files affected**:
- `tools/archobs/src/archobs/display.py` — add `format_cluster_files()` function
- `tools/archobs/src/archobs/cli.py` — register `show cluster-files` subcommand, add `--include-paths` flag to `show clusters`

### B. Full file-to-cluster JSON output (High — Findings #5, #8)

**Problem**: `archobs show all --format json` returns only the top 10 risk files and top 10 clusters. For a repo with 66 clusters and 1,251 files, the other 56 clusters and 1,241 files are invisible. The trajectory tool's `assignCommitsToClusters` uses `file_risks` to build its path-to-cluster map — when only 10 files are returned, most commits get assigned to cluster -1 (unassigned).

**Solution**: Two changes:

1. **Add `show files` subcommand** — dumps the full `file_metrics.parquet` with cluster assignments:
   ```bash
   archobs show files [--top 0] [--min-risk 0] [--format json]
   ```
   Default: all files. `--top N` limits to top N by risk. `--min-risk` filters by threshold.

2. **Support `--top 0` in `show all`** — currently `format_all` hardcodes `top=10` for both risks and clusters. Allow `--top 0` to mean "all records" (consistent with `show risks` where `top=0` already works for risks, but `format_all` doesn't pass it through).

**Implementation**:
- `display.py`: Add `format_files()` that reads `file_metrics.parquet` and returns all rows (path, risk, xnbr, hubness, volatility, cluster_id)
- `display.py`: Update `format_all()` to accept and pass through `--top` parameter instead of hardcoding 10
- `cli.py`: Register `show files` subcommand

**Impact on trajectory**: With `show files --format json`, the trajectory skill can get a complete path-to-cluster mapping without ad-hoc Python. The skill workflow simplifies from:
```
archobs show all --format json > /tmp/archobs.json  # incomplete
python3 -c "import pandas..." > /tmp/files.json      # ad-hoc workaround
```
to:
```
archobs show all --top 0 --format json > /tmp/archobs.json  # complete
```

### C. Auto-generated cluster labels (High — Finding #6)

**Problem**: Clusters are numbered 0-66 with no human-readable names. The suggestions engine generates readable names from path analysis, but these aren't exposed in `show clusters`.

**Solution**: Auto-generate labels from the dominant path prefix of files in each cluster.

**Algorithm**:
1. For each cluster, collect all file paths
2. Extract the first 2-3 path segments after the common repo prefix (e.g., `src/`)
3. Count occurrences of each prefix
4. Use the top 1-2 prefixes as the label (e.g., "pos/orders + pos/payments")
5. Truncate to 50 characters

**Implementation**:
- `display.py`: Add `_generate_cluster_label(paths: list[str]) -> str`
- `display.py`: Include `label` field in `format_clusters()` JSON output
- `display.py`: Show label column in table output

**Caveat**: Labels are heuristic — they reflect path distribution, not semantic meaning. The label should be presented as a hint, not a name.

### D. Momentum-aware suggestion prioritization (Low — Finding #10)

**Problem**: The suggestions engine knows about risk and leakage but not development momentum. A cluster that's leaky AND accelerating is more urgent to refactor than one that's leaky but dormant.

**Solution**: Cross-reference `git_stats.parquet` volatility data in suggestion prioritization.

**Algorithm**:
1. When generating suggestions, load `git_stats.parquet` and compute per-cluster average volatility
2. For leakage/risk suggestions, multiply priority score by a momentum factor:
   - High volatility (top quartile): 1.3x priority boost
   - Low volatility (bottom quartile): 0.8x priority reduction
3. Re-sort suggestions after applying momentum factor

**Implementation**:
- `tools/archobs/src/archobs/suggestions.py` — modify `RuleSuggestionEngine` to accept and use `git_stats` data

### E. Path truncation improvement (Low — Finding #11)

**Problem**: `_truncate_path` in display.py truncates to 4 segments, which sometimes removes domain context for deep paths. Test factories and other deeply nested paths lose meaning.

**Solution**: Truncate by removing the common repository prefix instead of limiting segments.

**Algorithm**:
1. Compute the longest common prefix across all displayed paths
2. Remove that prefix (e.g., strip `src/` if all paths start with `src/`)
3. If the remaining path exceeds the column width, truncate from the left with `...`

**Implementation**:
- `display.py`: Update `_truncate_path()` to use common-prefix stripping

---

## Priority and Sequencing

| Priority | Change | Rationale |
|----------|--------|-----------|
| **1 (highest)** | B: Full file-to-cluster JSON | Unblocks trajectory tool from getting complete cluster mappings — highest-impact single change |
| **2** | A: Cluster file inspection | Unblocks agents from understanding cluster composition — meaningless IDs become interpretable |
| **3** | C: Cluster labels | Reduces cognitive load — works well with A but independent |
| **4** | D: Momentum-aware suggestions | Improves prioritization quality but existing suggestions still work |
| **5** | E: Path truncation | Cosmetic improvement for table output |

Changes A-C can be implemented together. D and E are independent.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Large JSON output for big repos | `--top` parameter limits output; default `show files` returns all but each record is small (~100 bytes) |
| Cluster labels may be misleading | Present as heuristic hint; use "label" not "name" in output |
| Momentum factor may over-weight volatile clusters | Use conservative multipliers (0.8-1.3); flag in suggestion output when momentum was a factor |

---

## Verification

```bash
# A: Cluster files
archobs show cluster-files 0 --format json | jq length  # should return file count
archobs show clusters --include-paths --format json | jq '.[0].top_paths | length'

# B: Full file output
archobs show files --format json | jq length   # should equal total tracked files
archobs show all --top 0 --format json | jq '.risks | length'  # should be >> 10

# C: Labels
archobs show clusters --format json | jq '.[0].label'  # should be human-readable

# D: Momentum-aware suggestions
archobs prompts --out .archobs  # verify high-volatility clusters rank higher

# E: Path truncation
archobs show risks --format table  # verify deep paths retain domain context
```
