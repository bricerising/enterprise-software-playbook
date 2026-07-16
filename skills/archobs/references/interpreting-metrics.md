# Interpreting Archobs Metrics

## Pipeline Overview

Archobs builds a multi-signal graph from three sources and fuses them into a unified view:

| Signal | Source | Weight (default) |
|--------|--------|-------------------|
| Semantic similarity | File content embeddings via KNN | `alpha = 0.45` |
| Co-change | Git commit history (files changed together) | `beta = 0.35` |
| Dependency | Import/require statements resolved to file paths | `gamma = 0.20` |

The fused graph is partitioned into clusters (subsystems) using community detection, then scored.

Only consume these artifacts when `.archobs/run_manifest.json` has `status: "complete"`. `archobs show` rejects a present non-complete manifest; any direct Parquet reader must check the same manifest first so a targeted stage cannot be mistaken for a complete analysis.

## File-Level Metrics

Query with `archobs show risks --format json` (or read `.archobs/file_metrics.parquet` directly only after the complete-manifest guard).

### `risk` (0.0 - 1.0)

Combined score of hubness, volatility, and boundary leakage. Higher means the file is more likely to cause problems during refactoring.

- **> 0.5**: Prioritize for refactoring — this file concentrates structural risk.
- **> 0.3**: Monitor — file is above average risk.
- **< 0.2**: Low risk — stable and well-bounded.

### `xnbr` — Cross-Boundary Neighbor Ratio (0.0 - 1.0)

Fraction of a file's graph neighbors that belong to a different cluster. Measures how much a file bridges multiple concerns.

- **> 0.50**: File is semantically split across subsystems — strong candidate for decomposition.
- **> 0.35**: File has mixed responsibilities — consider extracting shared logic.
- **< 0.15**: File is well-contained within its cluster.

**Pattern mapping**: High xnbr often points to missing Facade, Mediator, or Strategy patterns.

### `hubness` (0.0 - 1.0)

Normalized measure of how many other files depend on or co-change with this file. High hubness means high blast radius.

- **> 0.45**: Changes to this file ripple widely — reduce fan-in by extracting leaf helpers or narrowing the public surface.
- **> 0.25**: Moderate hub — acceptable if the file has a stable, narrow interface.

### `volatility` (relative)

How frequently this file changes relative to its peers (derived from commit count and recency).

High volatility + high hubness = urgent risk: a frequently changing file with wide blast radius.

### `betweenness` (0.0 - 1.0)

Graph centrality: how often this file appears on shortest paths between other files. Files with high betweenness are structural bottlenecks.

## Cluster-Level Metrics

Query with `archobs show clusters --format json` (or read `.archobs/cluster_metrics.parquet` directly only after the complete-manifest guard).

### `leakage` (0.0 - 1.0)

Fraction of a cluster's weighted edges that cross its boundary. Measures how porous the subsystem boundary is.

- **> 0.40**: Severely leaky — the boundary is not meaningful. Consider merging with neighbor or introducing an explicit interface.
- **> 0.20**: Moderately leaky — responsibilities are bleeding. Route cross-cluster calls through a Facade or contract.
- **< 0.10**: Clean boundary — healthy subsystem isolation.

### `cohesion` (0.0 - 1.0)

Strength of internal connectivity within the cluster. Higher means files within the cluster are strongly related.

- **< 0.30**: Weak cohesion — the cluster may be grouping unrelated files. Check if the clustering resolution is too low.
- **> 0.60**: Strong cohesion — files belong together.

### `conductance` (0.0 - 1.0)

Ratio of cross-boundary edges to total edges touching the cluster. Related to leakage but weighted differently.

Lower conductance = healthier boundary.

### `recent_file_changes_30d` / `recent_file_changes_90d`

Count of file-change events (rows in `commits.parquet`) within the 30-day or 90-day window, grouped by cluster. These count **file-change events**, not distinct commits — a single commit touching 5 files in a cluster adds 5 to the count. For distinct commit counts per cluster, use `archobs show velocity` which reports `distinct_commits` via `.nunique()` on `commit_sha`.

### `external_inbound_rank` (0.0 - 1.0)

Percentile rank of `external_inbound_weight` across all clusters. A rank of 0.95 means this cluster has higher inbound coupling than 95% of other clusters — it is a gravitational center.

- **> 0.90**: Strong gravitational center — other clusters are pulled toward this one. Consider decomposition.
- **> 0.75**: Moderate hub — acceptable if the cluster has clear ownership and a stable interface.
- **< 0.50**: Normal coupling — not a structural attractor.

### `risk_mean` / `risk_max`

Average and maximum file-level risk within the cluster. Clusters with high `risk_max` contain at least one problematic file.

## Drift Metrics

Query with `archobs show drift --format json` (or read `.archobs/drift.parquet` directly only after the complete-manifest guard).

### `ari_prev` — Adjusted Rand Index (−1.0 to 1.0)

Measures how much the cluster assignments changed between adjacent time windows. Compares consecutive snapshots of the subsystem map.

**Point-in-time thresholds:**
- **> 0.80**: Stable — architecture is not reshuffling.
- **0.50 - 0.80**: Moderate drift — some subsystem boundaries are shifting.
- **< 0.50**: Unstable — the subsystem map is changing significantly. Avoid broad moves until boundaries stabilize.

**Multi-window trend patterns** (when 3+ drift windows are available, the trajectory of ARI is more informative than any single value):

| Pattern | Example | Interpretation |
|---------|---------|---------------|
| Rising (low → high) | 0.38 → 0.58 → 0.77 | **Stabilizing after restructuring** — boundaries are converging. Safe to plan architectural moves. |
| Falling (high → low) | 0.82 → 0.60 → 0.42 | **Actively destabilizing** — boundaries are dissolving. Investigate what's driving structural change before refactoring. |
| Oscillating | 0.50 → 0.72 → 0.48 | **Unstable equilibrium** — architecture hasn't settled. Cluster assignments are unreliable for planning. |
| Plateau (high) | 0.85 → 0.83 → 0.81 | **Stable architecture** — safe to use cluster assignments for trajectory analysis and planning. |
| Plateau (low) | 0.35 → 0.38 → 0.33 | **Persistently unstable** — the codebase may lack natural boundaries. Consider whether the clustering resolution is appropriate. |

### `modularity` (0.0 - 1.0)

Global graph modularity for the time-windowed snapshot. Declining modularity over time means boundaries are weakening.

### `cluster_count`

Number of detected clusters per time window. Significant fluctuation suggests the architecture is not converging on stable subsystems.

**Declining cluster_count in young repos**: For repos with less than ~12 months of history, cluster_count often drops dramatically across drift windows (e.g. 593 → 384 → 148 → 66). This is **not** architectural consolidation — it is an artifact of increasing co-change signal density. Early windows have sparse commit history, producing weak co-change edges where Leiden creates many tiny clusters. As more history accumulates, edges strengthen and clusters consolidate naturally. In these cases, the ARI trend is the reliable structural signal; cluster_count in early windows is noise.

## Artifacts Reference

| Artifact | Format | Contents |
|----------|--------|----------|
| `files.parquet` | Parquet | File inventory: path, language, loc, size |
| `commits.parquet` | Parquet | Git commit-file edges with timestamps and message (first 80 chars of subject line) |
| `git_stats.parquet` | Parquet | Per-file: commit count, last commit timestamp |
| `imports.parquet` | Parquet | Resolved dependency edges: source, target |
| `co_edges.parquet` | Parquet | Co-change edges with decay-weighted strength |
| `dep_edges.parquet` | Parquet | Dependency edges from import resolution |
| `graph_edges.parquet` | Parquet | Fused graph: path_a, path_b, weight, w_sem, w_co, w_dep |
| `clusters.parquet` | Parquet | Cluster assignments: path, cluster_id |
| `file_metrics.parquet` | Parquet | Per-file risk scores and signals |
| `cluster_metrics.parquet` | Parquet | Per-cluster health metrics |
| `drift.parquet` | Parquet | Temporal clustering stability |
| `suggestions.json` | JSON | Prioritized change suggestions with scope |
| `report/index.html` | HTML | Interactive report with visualizations |
| `report/graph.html` | HTML | Interactive graph visualization |

## Configuration Knobs

Key settings in `.archobs/config.json` that affect metric quality:

| Setting | Default | Effect |
|---------|---------|--------|
| `graph.alpha` | 0.45 | Semantic edge weight in fusion |
| `graph.beta` | 0.35 | Co-change edge weight in fusion |
| `graph.gamma` | 0.20 | Dependency edge weight in fusion |
| `graph.tau_sem` | 0.35 | Semantic similarity threshold (lower = more edges) |
| `graph.half_life_days` | 180 | Decay rate for old co-change signal |
| `clustering.resolution` | 1.0 | Higher = more, smaller clusters |
| `clustering.algorithm` | auto | `leiden` (preferred) or `greedy-modularity` (fallback) |
