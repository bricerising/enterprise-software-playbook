"""Output formatting for ``archobs show`` subcommands."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

from archobs.storage import json_path, parquet_path, run_manifest_issue


# ---------------------------------------------------------------------------
# Artifact readers
# ---------------------------------------------------------------------------

_WARNED_MANIFEST_ROOTS: set[Path] = set()


def _warn_if_run_incomplete(base: Path) -> None:
    root = base.parent if base.name == "report" else base
    if root in _WARNED_MANIFEST_ROOTS:
        return
    issue = run_manifest_issue(base)
    if issue is None:
        return
    print(f"Warning: {issue}", file=sys.stderr)
    _WARNED_MANIFEST_ROOTS.add(root)


def _require_parquet(base: Path, name: str) -> pd.DataFrame:
    _warn_if_run_incomplete(base)
    path = parquet_path(base, name)
    if not path.exists():
        print(f"Error: {path} not found. Run `archobs report` first.", file=sys.stderr)
        raise SystemExit(1)
    return pd.read_parquet(path)


def _require_json(base: Path, name: str) -> Any:
    _warn_if_run_incomplete(base)
    path = json_path(base, name)
    if not path.exists():
        print(f"Error: {path} not found. Run `archobs report` first.", file=sys.stderr)
        raise SystemExit(1)
    return json.loads(path.read_text(encoding="utf-8"))


def read_file_metrics(out: Path) -> pd.DataFrame:
    return _require_parquet(out, "file_metrics")


def read_cluster_metrics(out: Path) -> pd.DataFrame:
    return _require_parquet(out, "cluster_metrics")


def read_drift(out: Path) -> pd.DataFrame:
    return _require_parquet(out, "drift")


def read_summary(out: Path) -> dict:
    return _require_json(out / "report", "summary")


def read_suggestions(out: Path) -> dict:
    return _require_json(out, "suggestions")


def read_commits(out: Path) -> pd.DataFrame:
    return _require_parquet(out, "commits")


def read_graph_edges(out: Path) -> pd.DataFrame:
    return _require_parquet(out, "graph_edges")


def read_author_stats(out: Path) -> pd.DataFrame:
    return _require_parquet(out, "author_stats")


def read_bus_factor(out: Path) -> pd.DataFrame:
    return _require_parquet(out, "bus_factor")


def read_concentration(out: Path) -> pd.DataFrame:
    return _require_parquet(out, "concentration")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_GENERIC_STEMS = {
    "src", "services", "controllers", "routes", "schemas", "packages",
    "lib", "test", "tests", "utils", "helpers", "common", "shared",
    "middleware", "config", "types", "interfaces", "models", "modules",
    "core", "app", "apps", "index", "main", "init", "__init__",
}


def _generate_cluster_label(
    paths: list[str],
    max_length: int = 50,
    weights: dict[str, float] | None = None,
    cluster_size: int | None = None,
) -> str:
    """Generate a heuristic label from the dominant path prefixes in a cluster.

    Extracts domain keywords from filenames (e.g. "orders", "payments") and
    prepends when dominant stems appear above a threshold. For large clusters
    (>30 files) the threshold is lowered from 40% to 25%, for very large
    clusters (>100 files) it drops to 15%. The top-2 stems are used when no
    single stem dominates.

    For clusters with >100 files, *max_length* is automatically raised to 70
    so the label can convey domain meaning before truncation.

    When *weights* is provided (mapping path -> significance score such as risk
    or degree), stems and prefixes are weighted by significance rather than
    counted by frequency. This prevents large clusters of small files from
    drowning out the domain-defining high-risk files.

    When *cluster_size* is provided, it is used for threshold calculations
    instead of ``len(paths)``.  This is important because the stored paths
    column may be capped (e.g. at 50 entries) while the actual cluster can
    be much larger.
    """
    if not paths:
        return ""
    from collections import Counter, defaultdict
    from pathlib import PurePosixPath

    effective_size = cluster_size if cluster_size is not None else len(paths)

    # Scale max_length for very large clusters so labels convey domain meaning
    if effective_size > 100:
        max_length = max(max_length, 70)

    prefix_weights: defaultdict[str, float] = defaultdict(float)
    stem_weights: defaultdict[str, float] = defaultdict(float)
    for p in paths:
        w = weights.get(p, 1.0) if weights else 1.0
        parts = p.split("/")
        # Skip common root segments like src/, packages/, apps/
        start = 0
        if parts and parts[0] in {"src", "packages", "apps", "lib"}:
            start = 1
        # Use deeper prefix (3 segments) when root is skipped for richer context
        depth = 3 if start > 0 else 2
        segments = parts[start:start + depth]
        if segments:
            prefix_weights["/".join(segments)] += w
        # Extract domain keyword from filename stem
        raw_stem = PurePosixPath(p).stem.split(".")[0]  # orders.service.ts -> orders
        raw_stem = raw_stem.replace("-", "_").split("_")[0]  # order-events -> order
        if raw_stem.lower() not in _GENERIC_STEMS and len(raw_stem) > 1:
            stem_weights[raw_stem.lower()] += w

    if not prefix_weights:
        return ""
    top = sorted(prefix_weights.items(), key=lambda x: -x[1])[:2]
    structural = " + ".join(prefix for prefix, _ in top)

    # Check for dominant domain keywords — adaptive threshold for large clusters
    total_weight = sum(weights.get(p, 1.0) for p in paths) if weights else float(len(paths))
    if effective_size > 100:
        threshold = 0.15
    elif effective_size > 30:
        threshold = 0.25
    else:
        threshold = 0.40

    # For large risk-concentrated clusters, force the top-risk file's stem into the
    # label when risk_max >> risk_mean.  The normal threshold math fails here because
    # a single 0.95-risk file is diluted by 200 files with risk 0.02.
    if weights and effective_size > 100 and stem_weights:
        weight_values = [weights.get(p, 1.0) for p in paths]
        w_max = max(weight_values)
        w_mean = total_weight / len(paths)
        if w_mean > 0 and w_max > 3 * w_mean:
            # Find the stem of the highest-weighted file and force it to dominate
            top_path = max(paths, key=lambda p: weights.get(p, 0.0))
            top_raw = PurePosixPath(top_path).stem.split(".")[0]
            top_raw = top_raw.replace("-", "_").split("_")[0]
            if top_raw.lower() not in _GENERIC_STEMS and len(top_raw) > 1:
                label = f"{top_raw.lower()} ({structural})"
                if len(label) > max_length:
                    label = label[:max_length - 3] + "..."
                return label

    if stem_weights:
        top_stems = sorted(stem_weights.items(), key=lambda x: -x[1])[:2]
        dominant_stem, dominant_weight = top_stems[0]
        dominant_ratio = dominant_weight / total_weight if total_weight > 0 else 0
        # For very large clusters (>100 files), prefer top-2 stems unless one
        # clearly dominates (>25%).  This prevents a single stem that barely
        # clears the 15% adaptive threshold from becoming the sole label while
        # equally important stems (12-14%) are hidden.
        if effective_size > 100 and len(top_stems) >= 2 and dominant_ratio < 0.25:
            s1, w1 = top_stems[0]
            s2, w2 = top_stems[1]
            combined_ratio = (w1 + w2) / total_weight if total_weight > 0 else 0
            if combined_ratio > threshold:
                label = f"{s1}/{s2} ({structural})"
            else:
                label = structural
        elif dominant_ratio > threshold:
            label = f"{dominant_stem} ({structural})"
        elif len(top_stems) >= 2:
            # Use top-2 stems when no single stem dominates
            s1, w1 = top_stems[0]
            s2, w2 = top_stems[1]
            combined_ratio = (w1 + w2) / total_weight if total_weight > 0 else 0
            if combined_ratio > threshold:
                label = f"{s1}/{s2} ({structural})"
            else:
                label = structural
        else:
            label = structural
    else:
        label = structural

    if len(label) > max_length:
        label = label[:max_length - 3] + "..."
    return label


def _build_risk_weights(file_metrics_df: pd.DataFrame) -> dict[str, float] | None:
    """Build a path->risk weight map from file_metrics for label generation."""
    if file_metrics_df.empty or "risk" not in file_metrics_df.columns:
        return None
    return dict(zip(file_metrics_df["path"], file_metrics_df["risk"]))


def _truncate_path(p: str, max_segments: int = 4) -> str:
    """Shorten long paths for table display by keeping last *max_segments* parts."""
    parts = p.split("/")
    if len(parts) <= max_segments:
        return p
    return ".../" + "/".join(parts[-max_segments:])


def _round_floats(df: pd.DataFrame, decimals: int = 3) -> pd.DataFrame:
    float_cols = df.select_dtypes(include="float").columns
    return df.copy().assign(**{c: df[c].round(decimals) for c in float_cols})


def _to_table(df: pd.DataFrame) -> str:
    return df.to_string(index=False)


def _to_csv(df: pd.DataFrame) -> str:
    return df.to_csv(index=False)


def _to_json_records(df: pd.DataFrame) -> str:
    return json.dumps(df.to_dict(orient="records"), indent=2)


def _ts_to_iso(ts: float | int) -> str:
    return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Format: risks
# ---------------------------------------------------------------------------

_RISK_COLS = ["path", "risk", "xnbr", "hubness", "volatility", "cluster_id",
              "degree", "weighted_degree", "betweenness"]
_RISK_TABLE_COLS = ["path", "risk", "xnbr", "hubness", "volatility", "cluster_id"]


def format_risks(
    df: pd.DataFrame,
    *,
    top: int = 15,
    fmt: str = "table",
    min_risk: float | None = None,
    min_xnbr: float | None = None,
    min_hubness: float | None = None,
    min_volatility: float | None = None,
) -> str:
    filtered = df.copy()
    if min_risk is not None:
        filtered = filtered[filtered["risk"] >= min_risk]
    if min_xnbr is not None:
        filtered = filtered[filtered["xnbr"] >= min_xnbr]
    if min_hubness is not None:
        filtered = filtered[filtered["hubness"] >= min_hubness]
    if min_volatility is not None and "volatility" in filtered.columns:
        filtered = filtered[filtered["volatility"] >= min_volatility]
    filtered = filtered.sort_values("risk", ascending=False)
    if top > 0:
        filtered = filtered.head(top)

    if fmt == "json":
        cols = [c for c in _RISK_COLS if c in filtered.columns]
        return _to_json_records(filtered[cols])
    if fmt == "csv":
        cols = [c for c in _RISK_COLS if c in filtered.columns]
        return _to_csv(_round_floats(filtered[cols]))

    # table
    cols = [c for c in _RISK_TABLE_COLS if c in filtered.columns]
    out = _round_floats(filtered[cols])
    out["path"] = out["path"].apply(_truncate_path)
    return _to_table(out)


# ---------------------------------------------------------------------------
# Format: velocity
# ---------------------------------------------------------------------------

_VELOCITY_TABLE_COLS = [
    "cluster_id", "label", "distinct_commits", "file_change_count", "added_count", "modified_count",
    "deleted_count", "growth_ratio", "churn_ratio",
]
_VELOCITY_JSON_COLS = _VELOCITY_TABLE_COLS + [
    "external_inbound_weight", "recent_file_changes_30d", "recent_file_changes_90d", "size",
]


def format_velocity(
    commits_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    cluster_metrics_df: pd.DataFrame,
    *,
    window: int = 30,
    compare: bool = False,
    include_added_paths: bool = False,
    fmt: str = "table",
    min_acceleration: float | None = None,
    min_growth_ratio: float | None = None,
    sort_by: str = "distinct_commits",
) -> str:
    """Compute per-cluster velocity metrics from commit history."""
    if commits_df.empty or file_metrics_df.empty:
        return "No commit data available for velocity analysis."

    # Map commits to clusters via file_metrics path -> cluster_id.
    # NOTE: inner join drops commits for files deleted during the analysis window
    # because deleted files have no cluster assignment.  This means deleted_count
    # in the output will be 0 for files no longer in the inventory.
    path_cluster = file_metrics_df[["path", "cluster_id"]].drop_duplicates("path")
    merged = commits_df.merge(path_cluster, on="path", how="inner")
    if merged.empty:
        return "No commits match tracked files."

    max_ts = int(merged["commit_ts"].max())
    cutoff = max_ts - (window * 86400)
    current = merged[merged["commit_ts"] >= cutoff]

    def _compute_velocity(df: pd.DataFrame) -> pd.DataFrame:
        if df.empty:
            return pd.DataFrame(columns=["cluster_id", "distinct_commits", "file_change_count",
                                          "added_count", "modified_count", "deleted_count",
                                          "growth_ratio", "churn_ratio"])
        grouped = df.groupby("cluster_id").agg(
            distinct_commits=("commit_sha", "nunique"),
            file_change_count=("commit_ts", "count"),
            added_count=("status", lambda s: (s == "A").sum()),
            modified_count=("status", lambda s: (s == "M").sum()),
            deleted_count=("status", lambda s: (s == "D").sum()),
        ).reset_index()
        total = grouped["added_count"] + grouped["modified_count"] + grouped["deleted_count"]
        total = total.replace(0, 1)  # avoid division by zero
        grouped["growth_ratio"] = grouped["added_count"] / total
        grouped["churn_ratio"] = grouped["modified_count"] / total
        return grouped

    velocity = _compute_velocity(current)
    _sort_col = sort_by if sort_by in velocity.columns else "distinct_commits"
    velocity = velocity.sort_values(_sort_col, ascending=False).reset_index(drop=True)

    # Use canonical labels from cluster_metrics when available; regenerate as fallback
    if "label" in cluster_metrics_df.columns and cluster_metrics_df["label"].notna().any():
        label_map = dict(zip(cluster_metrics_df["cluster_id"].astype(int), cluster_metrics_df["label"]))
        velocity["label"] = velocity["cluster_id"].map(label_map).fillna("")
    elif "paths" in cluster_metrics_df.columns:
        risk_weights = _build_risk_weights(file_metrics_df)
        label_map = {}
        for _, row in cluster_metrics_df.iterrows():
            all_paths = _extract_paths_list(row.get("paths", ""))
            csize = int(row["size"]) if "size" in row.index else None
            label_map[int(row["cluster_id"])] = _generate_cluster_label(all_paths, weights=risk_weights, cluster_size=csize)
        velocity["label"] = velocity["cluster_id"].map(label_map).fillna("")
    else:
        velocity["label"] = ""

    # Merge cluster-level context from cluster_metrics (eliminates extra show clusters query)
    _merge_cols = ["external_inbound_weight", "recent_file_changes_30d", "recent_file_changes_90d", "size"]
    _available = [c for c in _merge_cols if c in cluster_metrics_df.columns]
    if _available:
        _cm_subset = cluster_metrics_df[["cluster_id"] + _available].copy()
        _cm_subset["cluster_id"] = _cm_subset["cluster_id"].astype(int)
        velocity = velocity.merge(_cm_subset, on="cluster_id", how="left")

    if compare:
        prior_cutoff = cutoff - (window * 86400)
        prior = merged[(merged["commit_ts"] >= prior_cutoff) & (merged["commit_ts"] < cutoff)]
        prior_velocity = _compute_velocity(prior)
        prior_map = dict(zip(prior_velocity["cluster_id"], prior_velocity["distinct_commits"]))
        velocity["prior_commit_count"] = velocity["cluster_id"].map(prior_map).fillna(0).astype(int)
        velocity["acceleration"] = velocity.apply(
            lambda r: round(r["distinct_commits"] / max(r["prior_commit_count"], 1), 2),
            axis=1,
        )
        velocity["is_emerging"] = velocity["prior_commit_count"] == 0
        # Re-sort if the requested sort column was just created by --compare
        if sort_by in ("acceleration", "prior_commit_count") and sort_by in velocity.columns:
            velocity = velocity.sort_values(sort_by, ascending=False).reset_index(drop=True)

    # Apply velocity filters
    if min_growth_ratio is not None:
        velocity = velocity[velocity["growth_ratio"] >= min_growth_ratio]
    if min_acceleration is not None:
        if "acceleration" not in velocity.columns:
            return "Error: --min-acceleration requires --compare."
        velocity = velocity[velocity["acceleration"] >= min_acceleration]
    velocity = velocity.reset_index(drop=True)

    # Collect recently added file paths per cluster
    added_paths_map: dict[int, list[str]] = {}
    if include_added_paths and "status" in current.columns:
        added = current[current["status"] == "A"]
        for cid, grp in added.groupby("cluster_id"):
            added_paths_map[int(cid)] = grp["path"].unique().tolist()

    cols = [c for c in _VELOCITY_JSON_COLS if c in velocity.columns]
    if compare:
        for extra in ("prior_commit_count", "acceleration", "is_emerging"):
            if extra in velocity.columns and extra not in cols:
                cols = cols + [extra]

    if fmt == "json":
        records = _round_floats(velocity[cols]).to_dict(orient="records")
        if include_added_paths:
            for rec in records:
                rec["added_paths"] = added_paths_map.get(int(rec["cluster_id"]), [])
        return json.dumps(records, indent=2)
    if fmt == "csv":
        return _to_csv(_round_floats(velocity[cols]))
    return _to_table(_round_floats(velocity[cols]))


# ---------------------------------------------------------------------------
# Format: commits
# ---------------------------------------------------------------------------

_COMMIT_TABLE_COLS = ["commit_sha", "commit_ts", "message", "status", "path", "cluster_id"]
_COMMIT_JSON_COLS = _COMMIT_TABLE_COLS


def format_commits(
    commits_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    *,
    since: int | None = None,
    top: int = 0,
    fmt: str = "table",
) -> str:
    """Show commit-level data with cluster annotations (deduplicated)."""
    if commits_df.empty:
        return "No commit data available."

    # Annotate with cluster_id from file_metrics
    path_cluster = file_metrics_df[["path", "cluster_id"]].drop_duplicates("path")
    merged = commits_df.merge(path_cluster, on="path", how="left")
    merged["cluster_id"] = merged["cluster_id"].fillna(-1).astype(int)

    # Filter by recency
    if since is not None and "commit_ts" in merged.columns:
        max_ts = int(merged["commit_ts"].max())
        cutoff = max_ts - (since * 86400)
        merged = merged[merged["commit_ts"] >= cutoff]

    # Deduplicate: one row per (commit_sha, path) pair
    merged = merged.drop_duplicates(subset=["commit_sha", "path"])
    merged = merged.sort_values("commit_ts", ascending=False).reset_index(drop=True)

    if top > 0:
        merged = merged.head(top)

    cols = [c for c in _COMMIT_JSON_COLS if c in merged.columns]
    if fmt == "json":
        out = merged[cols].copy()
        if "commit_ts" in out.columns:
            out["commit_time"] = out["commit_ts"].apply(_ts_to_iso)
        return _to_json_records(out)
    if fmt == "csv":
        return _to_csv(merged[cols])
    out = merged[cols].copy()
    if "commit_sha" in out.columns:
        out["commit_sha"] = out["commit_sha"].str[:8]
    if "commit_ts" in out.columns:
        out["commit_ts"] = out["commit_ts"].apply(_ts_to_iso)
    if "path" in out.columns:
        out["path"] = out["path"].apply(_truncate_path)
    return _to_table(out)


# ---------------------------------------------------------------------------
# Format: edges
# ---------------------------------------------------------------------------


def format_edges(
    graph_edges_df: pd.DataFrame,
    cluster_metrics_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    cluster_id: int,
    *,
    max_neighbors: int = 0,
    fmt: str = "table",
) -> str:
    """Show cross-cluster edge relationships for a given cluster."""
    if graph_edges_df.empty:
        return "No graph edges available."
    if "cluster_a" not in graph_edges_df.columns or "cluster_b" not in graph_edges_df.columns:
        return "Graph edges missing cluster annotations. Re-run `archobs report`."

    # Filter edges touching the given cluster
    mask = (graph_edges_df["cluster_a"] == cluster_id) | (graph_edges_df["cluster_b"] == cluster_id)
    relevant = graph_edges_df[mask].copy()
    if relevant.empty:
        return f"No edges found for cluster {cluster_id}."

    # Only keep cross-cluster edges
    cross = relevant[relevant["cluster_a"] != relevant["cluster_b"]].copy()
    if cross.empty:
        return f"Cluster {cluster_id} has no cross-cluster edges."

    # Determine the neighbor cluster for each edge
    cross["neighbor_cluster"] = cross.apply(
        lambda r: int(r["cluster_b"]) if int(r["cluster_a"]) == cluster_id else int(r["cluster_a"]),
        axis=1,
    )

    # Use canonical labels from cluster_metrics when available; regenerate as fallback
    label_map: dict[int, str] = {}
    if "label" in cluster_metrics_df.columns and cluster_metrics_df["label"].notna().any():
        for _, row in cluster_metrics_df.iterrows():
            label_map[int(row["cluster_id"])] = str(row["label"]) if row["label"] else ""
    elif "paths" in cluster_metrics_df.columns:
        for _, row in cluster_metrics_df.iterrows():
            all_paths = _extract_paths_list(row.get("paths", ""))
            csize = int(row["size"]) if "size" in row.index else None
            label_map[int(row["cluster_id"])] = _generate_cluster_label(all_paths, cluster_size=csize)

    # Group by neighbor cluster
    grouped = cross.groupby("neighbor_cluster").agg(
        total_weight=("weight", "sum"),
        edge_count=("weight", "count"),
    ).reset_index()
    grouped = grouped.sort_values("total_weight", ascending=False).reset_index(drop=True)
    if max_neighbors > 0:
        grouped = grouped.head(max_neighbors).reset_index(drop=True)
    grouped["neighbor_label"] = grouped["neighbor_cluster"].map(label_map).fillna("")
    grouped["total_weight"] = grouped["total_weight"].round(3)

    # Compute leakage_share: what percentage of the queried cluster's external
    # weight flows to each neighbor.  Eliminates manual cross-referencing.
    parent_external_weight = 0.0
    if "external_weight" in cluster_metrics_df.columns:
        mask = cluster_metrics_df["cluster_id"].astype(int) == cluster_id
        vals = cluster_metrics_df.loc[mask, "external_weight"]
        if not vals.empty:
            parent_external_weight = float(vals.iloc[0])
    if parent_external_weight > 0:
        grouped["leakage_share"] = (grouped["total_weight"] / parent_external_weight).round(3)
    else:
        grouped["leakage_share"] = 0.0

    # Add top connecting file pairs per neighbor
    top_pairs: dict[int, list[dict[str, str]]] = {}
    for nbr_id, nbr_df in cross.groupby("neighbor_cluster"):
        sorted_edges = nbr_df.sort_values("weight", ascending=False).head(3)
        pairs = [
            {"path_a": str(r["path_a"]), "path_b": str(r["path_b"]), "weight": round(float(r["weight"]), 3)}
            for _, r in sorted_edges.iterrows()
        ]
        top_pairs[int(nbr_id)] = pairs

    cols = ["neighbor_cluster", "neighbor_label", "total_weight", "edge_count", "leakage_share"]
    if fmt == "json":
        records = grouped[cols].to_dict(orient="records")
        for rec in records:
            rec["top_pairs"] = top_pairs.get(int(rec["neighbor_cluster"]), [])
        return json.dumps(records, indent=2)
    if fmt == "csv":
        return _to_csv(grouped[cols])
    return _to_table(grouped[cols])


def format_edges_top_active(
    graph_edges_df: pd.DataFrame,
    cluster_metrics_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    commits_df: pd.DataFrame,
    *,
    top_active: int = 3,
    max_neighbors: int = 0,
    window: int = 30,
    fmt: str = "table",
) -> str:
    """Show edges for the top-N most active clusters by file_change_count."""
    if commits_df.empty or file_metrics_df.empty:
        return "No commit data available to determine active clusters."
    # Compute velocity to find top-active cluster IDs
    path_cluster = file_metrics_df[["path", "cluster_id"]].drop_duplicates("path")
    merged = commits_df.merge(path_cluster, on="path", how="inner")
    if merged.empty:
        return "No commits match tracked files."
    max_ts = int(merged["commit_ts"].max())
    cutoff = max_ts - (window * 86400)
    current = merged[merged["commit_ts"] >= cutoff]
    if current.empty:
        return "No commits in the current window."
    counts = current.groupby("cluster_id")["commit_ts"].count().reset_index(name="file_change_count")
    active_ids = counts.sort_values("file_change_count", ascending=False).head(top_active)["cluster_id"].tolist()

    sections: list[str] = []
    for cid in active_ids:
        section = format_edges(graph_edges_df, cluster_metrics_df, file_metrics_df, int(cid), max_neighbors=max_neighbors, fmt=fmt)
        if fmt == "json":
            try:
                parsed = json.loads(section)
                sections.append(json.dumps({"cluster_id": int(cid), "edges": parsed}, indent=2))
            except (json.JSONDecodeError, TypeError):
                sections.append(section)
        else:
            sections.append(f"--- Cluster {cid} ---")
            sections.append(section)
    if fmt == "json":
        return "[" + ",\n".join(sections) + "]"
    return "\n\n".join(sections)


# ---------------------------------------------------------------------------
# Format: clusters
# ---------------------------------------------------------------------------

_CLUSTER_TABLE_COLS = ["cluster_id", "size", "cohesion", "leakage", "conductance",
                       "internal_weight", "external_weight", "external_inbound_weight",
                       "risk_mean", "risk_max",
                       "recent_file_changes_30d", "recent_file_changes_90d"]
_CLUSTER_JSON_COLS = _CLUSTER_TABLE_COLS  # top_paths added separately


def _extract_paths_list(paths_val: object) -> list[str]:
    """Normalise a paths column value to a list of strings."""
    if isinstance(paths_val, str):
        return paths_val.strip().split("\n")
    if isinstance(paths_val, list):
        return paths_val
    return []


def format_clusters(
    df: pd.DataFrame,
    *,
    sort_by: str = "leakage",
    fmt: str = "table",
    min_size: int = 2,
    file_metrics_df: pd.DataFrame | None = None,
) -> str:
    filtered = df[df["size"] >= min_size].copy() if "size" in df.columns else df.copy()
    if sort_by in filtered.columns:
        filtered = filtered.sort_values(sort_by, ascending=False)

    risk_weights = _build_risk_weights(file_metrics_df) if file_metrics_df is not None else None

    # Use canonical label from parquet when available; regenerate as fallback
    has_stored_labels = "label" in filtered.columns and filtered["label"].notna().any()

    if fmt == "json":
        cols = [c for c in _CLUSTER_JSON_COLS if c in filtered.columns]
        records = _round_floats(filtered[cols]).to_dict(orient="records")
        if "paths" in filtered.columns:
            paths_list = filtered["paths"].tolist()
            sizes_list = filtered["size"].tolist() if "size" in filtered.columns else [None] * len(paths_list)
            for rec, paths_val, csize in zip(records, paths_list, sizes_list):
                all_paths = _extract_paths_list(paths_val)
                rec["top_paths"] = all_paths[:5]
                if not has_stored_labels:
                    rec["label"] = _generate_cluster_label(all_paths, weights=risk_weights, cluster_size=int(csize) if csize is not None else None)
        if has_stored_labels:
            for rec, label in zip(records, filtered["label"].tolist()):
                rec["label"] = str(label) if label else ""
        return json.dumps(records, indent=2)
    if fmt == "csv":
        cols = [c for c in _CLUSTER_TABLE_COLS if c in filtered.columns]
        return _to_csv(_round_floats(filtered[cols]))

    # table — add label column if not already present
    cols = [c for c in _CLUSTER_TABLE_COLS if c in filtered.columns]
    out = _round_floats(filtered[cols])
    if has_stored_labels:
        out = out.copy()
        out["label"] = filtered["label"].tolist()
    elif "paths" in filtered.columns:
        out = out.copy()
        sizes = filtered["size"].tolist() if "size" in filtered.columns else [None] * len(filtered)
        out["label"] = [
            _generate_cluster_label(_extract_paths_list(p), weights=risk_weights, cluster_size=int(s) if s is not None else None)
            for p, s in zip(filtered["paths"].tolist(), sizes)
        ]
    return _to_table(out)


# ---------------------------------------------------------------------------
# Format: drift
# ---------------------------------------------------------------------------

_DRIFT_COLS = ["window_end", "cluster_count", "modularity", "ari_prev", "algorithm", "trend"]


def _compute_drift_trend(df: pd.DataFrame) -> str:
    """Compute an overall drift trend label from ARI values.

    Returns one of: ``"stabilizing"``, ``"degrading"``, ``"volatile"``, ``"stable"``.
    """
    ari_col = "ari_prev" if "ari_prev" in df.columns else ("ari" if "ari" in df.columns else None)
    if ari_col is None or df.empty:
        return "stable"
    values = df[ari_col].dropna().tolist()
    if len(values) < 2:
        if values and float(values[0]) >= 0.80:
            return "stable"
        return "stable"
    recent = float(values[-1])
    prev = float(values[-2])
    # Check for oscillation (volatile) — direction flips across 3+ windows
    if len(values) >= 3:
        deltas = [float(values[i]) - float(values[i - 1]) for i in range(1, len(values))]
        sign_changes = sum(1 for i in range(1, len(deltas)) if deltas[i] * deltas[i - 1] < 0)
        if sign_changes >= 2:
            return "volatile"
    if recent > prev and recent >= 0.60:
        return "stabilizing"
    if recent < prev:
        return "degrading"
    if recent >= 0.80:
        return "stable"
    return "stable"


def format_drift(
    df: pd.DataFrame,
    *,
    fmt: str = "table",
    configured_windows: int | None = None,
) -> str:
    out = df.copy()

    # Convert unix timestamps to ISO 8601
    if "window_end_ts" in out.columns:
        out.insert(0, "window_end", out["window_end_ts"].apply(_ts_to_iso))
    elif "window_end" not in out.columns:
        out.insert(0, "window_end", "")

    # Normalise algorithm column name
    if "algorithm_used" in out.columns and "algorithm" not in out.columns:
        out = out.rename(columns={"algorithm_used": "algorithm"})

    # Compute and attach trend
    trend = _compute_drift_trend(df)
    out["trend"] = trend

    cols = [c for c in _DRIFT_COLS if c in out.columns]
    out = out[cols]

    actual_windows = len(out)

    if fmt == "json":
        records = out.to_dict(orient="records")
        result: dict[str, object] = {"windows": records}
        if configured_windows is not None:
            result["configured_windows"] = configured_windows
            result["actual_windows"] = actual_windows
            if actual_windows < configured_windows:
                result["note"] = (
                    f"Only {actual_windows} of {configured_windows} configured windows produced — "
                    f"the repository may lack sufficient history for all windows."
                )
        return json.dumps(result, indent=2)
    if fmt == "csv":
        return _to_csv(_round_floats(out))
    return _to_table(_round_floats(out))


# ---------------------------------------------------------------------------
# Format: summary
# ---------------------------------------------------------------------------

_SUMMARY_KEYS = [
    ("node_count", "Files"),
    ("edge_count", "Edges"),
    ("cluster_count", "Clusters"),
    ("modularity", "Modularity"),
    ("hub_deg", "Hub dominance"),
    ("embedding_provider", "Embedding provider"),
    ("algorithm_used", "Algorithm"),
    ("suggestion_engine", "Suggestion engine"),
]


def format_summary(data: dict, *, fmt: str = "table") -> str:
    if fmt == "json":
        return json.dumps(data, indent=2, default=str)

    rows = []
    for key, label in _SUMMARY_KEYS:
        if key in data:
            val = data[key]
            if isinstance(val, float):
                val = f"{val:.3f}"
            elif isinstance(val, int):
                val = f"{val:,}"
            rows.append({"Metric": label, "Value": str(val)})

    if fmt == "csv":
        return _to_csv(pd.DataFrame(rows))
    return _to_table(pd.DataFrame(rows))


# ---------------------------------------------------------------------------
# Format: all
# ---------------------------------------------------------------------------

def format_all(
    out: Path,
    *,
    top: int = 0,
    top_risks: int | None = None,
    top_clusters: int | None = None,
    fmt: str = "table",
    compact: bool = False,
) -> str:
    # Resolve split --top params: explicit overrides win, then --top, then 0 (all)
    effective_risks = top_risks if top_risks is not None else top
    effective_clusters = top_clusters if top_clusters is not None else top

    summary_data = read_summary(out)
    file_metrics = read_file_metrics(out)
    cluster_metrics = read_cluster_metrics(out)
    drift_df = read_drift(out)

    try:
        commits_df = read_commits(out)
    except SystemExit:
        commits_df = pd.DataFrame()

    try:
        graph_edges_df = read_graph_edges(out)
    except SystemExit:
        graph_edges_df = pd.DataFrame()

    try:
        suggestions_data = read_suggestions(out)
    except SystemExit:
        suggestions_data = {"engine": "none", "items": [], "error": "not found"}

    if fmt == "json":
        cols = [c for c in _RISK_COLS if c in file_metrics.columns]
        sorted_risks = file_metrics.sort_values("risk", ascending=False)
        if effective_risks > 0:
            sorted_risks = sorted_risks.head(effective_risks)
        risk_records = sorted_risks[cols].to_dict(orient="records")

        cluster_cols = [c for c in _CLUSTER_JSON_COLS if c in cluster_metrics.columns]
        filtered_clusters = (
            cluster_metrics[cluster_metrics["size"] >= 2]
            .sort_values("leakage", ascending=False)
        ) if "size" in cluster_metrics.columns else cluster_metrics.copy()
        if effective_clusters > 0:
            filtered_clusters = filtered_clusters.head(effective_clusters)
        cluster_records = filtered_clusters[cluster_cols].to_dict(orient="records")
        # Add top_paths and label (prefer canonical labels stored in parquet)
        has_stored_labels = "label" in filtered_clusters.columns and filtered_clusters["label"].notna().any()
        risk_weights = _build_risk_weights(file_metrics)
        if "paths" in filtered_clusters.columns:
            paths_list = filtered_clusters["paths"].tolist()
            label_list = filtered_clusters["label"].tolist() if has_stored_labels else [None] * len(paths_list)
            sizes_list = filtered_clusters["size"].tolist() if "size" in filtered_clusters.columns else [None] * len(paths_list)
            for rec, paths_val, stored_label, csize in zip(cluster_records, paths_list, label_list, sizes_list):
                all_paths = _extract_paths_list(paths_val)
                rec["top_paths"] = all_paths[:5]
                if has_stored_labels and stored_label:
                    rec["label"] = str(stored_label)
                else:
                    rec["label"] = _generate_cluster_label(all_paths, weights=risk_weights, cluster_size=int(csize) if csize is not None else None)

        drift_out = drift_df.copy()
        if "window_end_ts" in drift_out.columns:
            drift_out.insert(0, "window_end", drift_out["window_end_ts"].apply(_ts_to_iso))
        if "algorithm_used" in drift_out.columns:
            drift_out = drift_out.rename(columns={"algorithm_used": "algorithm"})
        drift_out["trend"] = _compute_drift_trend(drift_df)
        drift_cols = [c for c in _DRIFT_COLS if c in drift_out.columns]
        drift_records = drift_out[drift_cols].to_dict(orient="records")

        # Velocity data (compare enabled by default in show all)
        velocity_json = None
        if not commits_df.empty and not file_metrics.empty:
            velocity_raw = format_velocity(
                commits_df, file_metrics, cluster_metrics,
                window=30, compare=True, include_added_paths=True, fmt="json",
            )
            try:
                velocity_json = json.loads(velocity_raw)
            except (json.JSONDecodeError, TypeError):
                velocity_json = None

        # Top-cluster edges (edges for the top-N most active clusters)
        edge_limit = 3 if compact else 5
        top_cluster_edges: dict[str, object] = {}
        if velocity_json and not graph_edges_df.empty:
            active_ids = [rec["cluster_id"] for rec in velocity_json[:edge_limit]]
            for cid in active_ids:
                edge_raw = format_edges(
                    graph_edges_df, cluster_metrics, file_metrics, int(cid), fmt="json",
                )
                try:
                    top_cluster_edges[str(cid)] = json.loads(edge_raw)
                except (json.JSONDecodeError, TypeError):
                    pass

        combined: dict[str, object] = {
            "summary": summary_data,
            "risks": risk_records,
            "clusters": cluster_records,
            "drift": drift_records,
            "suggestions": suggestions_data.get("items", []),
        }
        if velocity_json is not None:
            combined["velocity"] = velocity_json
        if top_cluster_edges:
            combined["top_cluster_edges"] = top_cluster_edges
        return json.dumps(combined, indent=2, default=str)

    # table format — sections with headers
    risk_label = f"Top {effective_risks}" if effective_risks > 0 else "All"
    cluster_label = f"Top {effective_clusters}" if effective_clusters > 0 else "All"
    sections = []
    sections.append("=== Summary ===")
    sections.append(format_summary(summary_data, fmt="table"))
    sections.append("")
    sections.append(f"=== {risk_label} Risk Files ===")
    sections.append(format_risks(file_metrics, top=effective_risks, fmt="table"))
    sections.append("")
    sections.append(f"=== {cluster_label} Leaky Clusters ===")
    sections.append(format_clusters(cluster_metrics, sort_by="leakage", fmt="table", file_metrics_df=file_metrics))
    sections.append("")
    sections.append("=== Drift ===")
    sections.append(format_drift(drift_df, fmt="table"))
    if not commits_df.empty and not file_metrics.empty:
        sections.append("")
        sections.append("=== Velocity (30d, compare) ===")
        sections.append(format_velocity(
            commits_df, file_metrics, cluster_metrics,
            window=30, compare=True, fmt="table",
        ))
    return "\n".join(sections)


# ---------------------------------------------------------------------------
# Format: cluster-files
# ---------------------------------------------------------------------------

_CLUSTER_FILES_COLS = ["path", "risk", "xnbr", "hubness", "volatility"]


def format_cluster_files(
    file_metrics: pd.DataFrame,
    cluster_id: int,
    *,
    top: int = 20,
    fmt: str = "table",
) -> str:
    """Show files belonging to a specific cluster, sorted by risk."""
    if "cluster_id" not in file_metrics.columns:
        return "Error: cluster_id column not found in file_metrics."
    filtered = file_metrics[file_metrics["cluster_id"] == cluster_id].copy()
    if filtered.empty:
        return f"No files found in cluster {cluster_id}."
    filtered = filtered.sort_values("risk", ascending=False)
    if top > 0:
        filtered = filtered.head(top)

    cols = [c for c in _CLUSTER_FILES_COLS if c in filtered.columns]
    if fmt == "json":
        return _to_json_records(filtered[cols])
    if fmt == "csv":
        return _to_csv(_round_floats(filtered[cols]))
    out = _round_floats(filtered[cols])
    out["path"] = out["path"].apply(_truncate_path)
    return _to_table(out)


# ---------------------------------------------------------------------------
# Format: files
# ---------------------------------------------------------------------------

_FILES_COLS = ["path", "risk", "xnbr", "hubness", "volatility", "cluster_id"]


def format_files(
    df: pd.DataFrame,
    *,
    top: int = 0,
    fmt: str = "table",
    min_risk: float | None = None,
) -> str:
    """Dump file metrics with cluster assignments. Default: all files."""
    filtered = df.copy()
    if min_risk is not None:
        filtered = filtered[filtered["risk"] >= min_risk]
    filtered = filtered.sort_values("risk", ascending=False)
    if top > 0:
        filtered = filtered.head(top)

    cols = [c for c in _FILES_COLS if c in filtered.columns]
    if fmt == "json":
        return _to_json_records(filtered[cols])
    if fmt == "csv":
        return _to_csv(_round_floats(filtered[cols]))
    out = _round_floats(filtered[cols])
    out["path"] = out["path"].apply(_truncate_path)
    return _to_table(out)


# ---------------------------------------------------------------------------
# Format: suggestions
# ---------------------------------------------------------------------------


def format_suggestions(
    data: dict,
    *,
    limit: int = 0,
    fmt: str = "table",
) -> str:
    """Format suggestions from suggestions.json."""
    items = data.get("items", [])
    if not items:
        engine = data.get("engine", "unknown")
        error = data.get("error")
        msg = f"No suggestions available (engine={engine})"
        if error:
            msg += f": {error}"
        return msg

    if limit > 0:
        items = items[:limit]

    if fmt == "json":
        return json.dumps({"engine": data.get("engine", "unknown"), "items": items}, indent=2)

    if fmt == "csv":
        rows = pd.DataFrame(items)
        return _to_csv(rows)

    # table
    lines: list[str] = []
    lines.append(f"Suggestion engine: {data.get('engine', 'unknown')}")
    lines.append("")
    for i, item in enumerate(items, 1):
        lines.append(f"[{item.get('priority', '?')}] {i}. {item.get('title', '(no title)')}")
        if item.get("why"):
            lines.append(f"  Why: {item['why']}")
        if item.get("change"):
            lines.append(f"  Change: {item['change']}")
        if item.get("scope"):
            lines.append(f"  Scope: {item['scope']}")
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Format: hot-files
# ---------------------------------------------------------------------------

_HOT_FILES_COLS = ["path", "commit_count", "cluster_id", "risk"]
_HOT_FILES_TABLE_COLS = ["path", "commit_count", "cluster_id", "risk"]


def format_hot_files(
    commits_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    *,
    window: int = 30,
    top: int = 10,
    fmt: str = "table",
) -> str:
    """Return files sorted by raw commit count in the window, with cluster assignments."""
    if commits_df.empty or file_metrics_df.empty:
        return "No commit data available for hot-files analysis."

    max_ts = int(commits_df["commit_ts"].max())
    cutoff = max_ts - (window * 86400)
    current = commits_df[commits_df["commit_ts"] >= cutoff]
    if current.empty:
        return "No commits in the current window."

    # Count commits per file path
    counts = current.groupby("path").agg(
        commit_count=("commit_sha", "nunique"),
    ).reset_index()
    counts = counts.sort_values("commit_count", ascending=False).reset_index(drop=True)

    # Join cluster assignments and risk from file_metrics
    path_info = file_metrics_df[["path", "cluster_id", "risk"]].drop_duplicates("path")
    result = counts.merge(path_info, on="path", how="left")
    result["cluster_id"] = result["cluster_id"].fillna(-1).astype(int)

    if top > 0:
        result = result.head(top)

    cols = [c for c in _HOT_FILES_COLS if c in result.columns]
    if fmt == "json":
        return _to_json_records(_round_floats(result[cols]))
    if fmt == "csv":
        return _to_csv(_round_floats(result[cols]))
    out = _round_floats(result[cols])
    out["path"] = out["path"].apply(_truncate_path)
    return _to_table(out)


# ---------------------------------------------------------------------------
# Schema utility
# ---------------------------------------------------------------------------

def format_schema(base: Path, artifact_name: str) -> str:
    """Print column names and dtypes for a parquet artifact."""
    path = parquet_path(base, artifact_name)
    if not path.exists():
        print(f"Error: {path} not found.", file=sys.stderr)
        raise SystemExit(1)
    df = pd.read_parquet(path)
    lines = [f"{artifact_name}.parquet columns:"]
    for col in df.columns:
        lines.append(f"  {col:<25s} {df[col].dtype}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Format: team
# ---------------------------------------------------------------------------


def format_team(
    bus_factor_df: pd.DataFrame,
    concentration_df: pd.DataFrame,
    cluster_metrics_df: pd.DataFrame,
    *,
    sort_by: str = "bus_factor",
    min_size: int = 2,
    fmt: str = "table",
) -> str:
    """Format team analysis (bus factor + concentration) joined with cluster labels."""
    if bus_factor_df.empty or concentration_df.empty:
        return "[]" if fmt == "json" else "No team metrics available. Run `archobs report` first."

    # Join bus_factor with concentration
    merged = bus_factor_df.merge(concentration_df, on="cluster_id", how="outer")

    # Add cluster size and label if available
    if not cluster_metrics_df.empty:
        label_cols = ["cluster_id"]
        if "size" in cluster_metrics_df.columns:
            label_cols.append("size")
        if "label" in cluster_metrics_df.columns:
            label_cols.append("label")
        cluster_info = cluster_metrics_df[label_cols].drop_duplicates("cluster_id")
        merged = merged.merge(cluster_info, on="cluster_id", how="left")

    # Filter by min size
    if "size" in merged.columns:
        merged = merged[merged["size"] >= min_size]

    if merged.empty:
        return "[]" if fmt == "json" else "No clusters meet the minimum size filter."

    # Sort
    valid_sort_cols = {"bus_factor", "concentration", "size"}
    if sort_by == "concentration" and "hhi" in merged.columns:
        merged = merged.sort_values("hhi", ascending=False)
    elif sort_by == "size" and "size" in merged.columns:
        merged = merged.sort_values("size", ascending=False)
    else:
        merged = merged.sort_values("bus_factor", ascending=True)

    merged = merged.reset_index(drop=True)

    # Select display columns
    display_cols = ["cluster_id"]
    if "label" in merged.columns:
        display_cols.append("label")
    if "size" in merged.columns:
        display_cols.append("size")
    display_cols.extend(["bus_factor", "top_author", "top_author_pct"])
    if "hhi" in merged.columns:
        display_cols.append("hhi")
    if "author_count" in merged.columns:
        display_cols.append("author_count")

    display = _round_floats(merged[[c for c in display_cols if c in merged.columns]])

    if fmt == "json":
        return _to_json_records(display)
    elif fmt == "csv":
        return _to_csv(display)
    return _to_table(display)
