"""Output formatting for ``archobs show`` subcommands."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

from archobs.storage import json_path, parquet_path


# ---------------------------------------------------------------------------
# Artifact readers
# ---------------------------------------------------------------------------

def _require_parquet(base: Path, name: str) -> pd.DataFrame:
    path = parquet_path(base, name)
    if not path.exists():
        print(f"Error: {path} not found. Run `archobs report` first.", file=sys.stderr)
        raise SystemExit(1)
    return pd.read_parquet(path)


def _require_json(base: Path, name: str) -> Any:
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_GENERIC_STEMS = {
    "src", "services", "controllers", "routes", "schemas", "packages",
    "lib", "test", "tests", "utils", "helpers", "common", "shared",
    "middleware", "config", "types", "interfaces", "models", "modules",
    "core", "app", "apps", "index", "main", "init", "__init__",
}


def _generate_cluster_label(paths: list[str], max_length: int = 50) -> str:
    """Generate a heuristic label from the dominant path prefixes in a cluster.

    Extracts domain keywords from filenames (e.g. "orders", "payments") and
    prepends when a single dominant stem appears in >40% of files.
    """
    if not paths:
        return ""
    from collections import Counter
    from pathlib import PurePosixPath

    prefixes: list[str] = []
    stems: list[str] = []
    for p in paths:
        parts = p.split("/")
        # Skip common root segments like src/, packages/, apps/
        start = 0
        if parts and parts[0] in {"src", "packages", "apps", "lib"}:
            start = 1
        segments = parts[start:start + 2]
        if segments:
            prefixes.append("/".join(segments))
        # Extract domain keyword from filename stem
        raw_stem = PurePosixPath(p).stem.split(".")[0]  # orders.service.ts -> orders
        raw_stem = raw_stem.replace("-", "_").split("_")[0]  # order-events -> order
        if raw_stem.lower() not in _GENERIC_STEMS and len(raw_stem) > 1:
            stems.append(raw_stem.lower())

    if not prefixes:
        return ""
    prefix_counts = Counter(prefixes)
    top = prefix_counts.most_common(2)
    structural = " + ".join(prefix for prefix, _ in top)

    # Check for dominant domain keyword
    if stems:
        stem_counts = Counter(stems)
        dominant_stem, dominant_count = stem_counts.most_common(1)[0]
        if dominant_count / len(paths) > 0.40:
            label = f"{dominant_stem} ({structural})"
        else:
            label = structural
    else:
        label = structural

    if len(label) > max_length:
        label = label[:max_length - 3] + "..."
    return label


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
) -> str:
    filtered = df.copy()
    if min_risk is not None:
        filtered = filtered[filtered["risk"] >= min_risk]
    if min_xnbr is not None:
        filtered = filtered[filtered["xnbr"] >= min_xnbr]
    if min_hubness is not None:
        filtered = filtered[filtered["hubness"] >= min_hubness]
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
    "cluster_id", "label", "commit_count", "added_count", "modified_count",
    "deleted_count", "growth_ratio", "churn_ratio",
]
_VELOCITY_JSON_COLS = _VELOCITY_TABLE_COLS  # acceleration added when --compare


def format_velocity(
    commits_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    cluster_metrics_df: pd.DataFrame,
    *,
    window: int = 30,
    compare: bool = False,
    fmt: str = "table",
) -> str:
    """Compute per-cluster velocity metrics from commit history."""
    if commits_df.empty or file_metrics_df.empty:
        return "No commit data available for velocity analysis."

    # Map commits to clusters via file_metrics path -> cluster_id
    path_cluster = file_metrics_df[["path", "cluster_id"]].drop_duplicates("path")
    merged = commits_df.merge(path_cluster, on="path", how="inner")
    if merged.empty:
        return "No commits match tracked files."

    max_ts = int(merged["commit_ts"].max())
    cutoff = max_ts - (window * 86400)
    current = merged[merged["commit_ts"] >= cutoff]

    def _compute_velocity(df: pd.DataFrame) -> pd.DataFrame:
        if df.empty:
            return pd.DataFrame(columns=["cluster_id", "commit_count", "added_count",
                                          "modified_count", "deleted_count",
                                          "growth_ratio", "churn_ratio"])
        grouped = df.groupby("cluster_id").agg(
            commit_count=("commit_ts", "count"),
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
    velocity = velocity.sort_values("commit_count", ascending=False).reset_index(drop=True)

    # Add cluster labels from cluster_metrics paths
    if "paths" in cluster_metrics_df.columns:
        label_map = {}
        for _, row in cluster_metrics_df.iterrows():
            all_paths = _extract_paths_list(row.get("paths", ""))
            label_map[int(row["cluster_id"])] = _generate_cluster_label(all_paths)
        velocity["label"] = velocity["cluster_id"].map(label_map).fillna("")
    else:
        velocity["label"] = ""

    if compare:
        prior_cutoff = cutoff - (window * 86400)
        prior = merged[(merged["commit_ts"] >= prior_cutoff) & (merged["commit_ts"] < cutoff)]
        prior_velocity = _compute_velocity(prior)
        prior_map = dict(zip(prior_velocity["cluster_id"], prior_velocity["commit_count"]))
        velocity["acceleration"] = velocity.apply(
            lambda r: round(r["commit_count"] / max(prior_map.get(r["cluster_id"], 0), 1), 2),
            axis=1,
        )

    cols = [c for c in _VELOCITY_JSON_COLS if c in velocity.columns]
    if compare and "acceleration" in velocity.columns:
        cols = cols + ["acceleration"]

    if fmt == "json":
        return _to_json_records(_round_floats(velocity[cols]))
    if fmt == "csv":
        return _to_csv(_round_floats(velocity[cols]))
    return _to_table(_round_floats(velocity[cols]))


# ---------------------------------------------------------------------------
# Format: edges
# ---------------------------------------------------------------------------


def format_edges(
    graph_edges_df: pd.DataFrame,
    cluster_metrics_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    cluster_id: int,
    *,
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

    # Build label map from cluster_metrics paths
    label_map: dict[int, str] = {}
    if "paths" in cluster_metrics_df.columns:
        for _, row in cluster_metrics_df.iterrows():
            all_paths = _extract_paths_list(row.get("paths", ""))
            label_map[int(row["cluster_id"])] = _generate_cluster_label(all_paths)

    # Group by neighbor cluster
    grouped = cross.groupby("neighbor_cluster").agg(
        total_weight=("weight", "sum"),
        edge_count=("weight", "count"),
    ).reset_index()
    grouped = grouped.sort_values("total_weight", ascending=False).reset_index(drop=True)
    grouped["neighbor_label"] = grouped["neighbor_cluster"].map(label_map).fillna("")
    grouped["total_weight"] = grouped["total_weight"].round(3)

    # Add top connecting file pairs per neighbor
    top_pairs: dict[int, list[dict[str, str]]] = {}
    for nbr_id, nbr_df in cross.groupby("neighbor_cluster"):
        sorted_edges = nbr_df.sort_values("weight", ascending=False).head(3)
        pairs = [
            {"path_a": str(r["path_a"]), "path_b": str(r["path_b"]), "weight": round(float(r["weight"]), 3)}
            for _, r in sorted_edges.iterrows()
        ]
        top_pairs[int(nbr_id)] = pairs

    cols = ["neighbor_cluster", "neighbor_label", "total_weight", "edge_count"]
    if fmt == "json":
        records = grouped[cols].to_dict(orient="records")
        for rec in records:
            rec["top_pairs"] = top_pairs.get(int(rec["neighbor_cluster"]), [])
        return json.dumps(records, indent=2)
    if fmt == "csv":
        return _to_csv(grouped[cols])
    return _to_table(grouped[cols])


# ---------------------------------------------------------------------------
# Format: clusters
# ---------------------------------------------------------------------------

_CLUSTER_TABLE_COLS = ["cluster_id", "size", "cohesion", "leakage", "conductance",
                       "internal_weight", "external_weight", "risk_mean", "risk_max",
                       "recent_commits_30d", "recent_commits_90d"]
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
) -> str:
    filtered = df[df["size"] >= min_size].copy() if "size" in df.columns else df.copy()
    if sort_by in filtered.columns:
        filtered = filtered.sort_values(sort_by, ascending=False)

    if fmt == "json":
        cols = [c for c in _CLUSTER_JSON_COLS if c in filtered.columns]
        records = _round_floats(filtered[cols]).to_dict(orient="records")
        # Add top_paths and label from the paths column if available
        if "paths" in filtered.columns:
            paths_list = filtered["paths"].tolist()
            for rec, paths_val in zip(records, paths_list):
                all_paths = _extract_paths_list(paths_val)
                rec["top_paths"] = all_paths[:5]
                rec["label"] = _generate_cluster_label(all_paths)
        return json.dumps(records, indent=2)
    if fmt == "csv":
        cols = [c for c in _CLUSTER_TABLE_COLS if c in filtered.columns]
        return _to_csv(_round_floats(filtered[cols]))

    # table — add label column if paths data is available
    cols = [c for c in _CLUSTER_TABLE_COLS if c in filtered.columns]
    out = _round_floats(filtered[cols])
    if "paths" in filtered.columns:
        out = out.copy()
        out["label"] = [
            _generate_cluster_label(_extract_paths_list(p))
            for p in filtered["paths"].tolist()
        ]
    return _to_table(out)


# ---------------------------------------------------------------------------
# Format: drift
# ---------------------------------------------------------------------------

_DRIFT_COLS = ["window_end", "cluster_count", "modularity", "ari_prev", "algorithm"]


def format_drift(df: pd.DataFrame, *, fmt: str = "table") -> str:
    out = df.copy()

    # Convert unix timestamps to ISO 8601
    if "window_end_ts" in out.columns:
        out.insert(0, "window_end", out["window_end_ts"].apply(_ts_to_iso))
    elif "window_end" not in out.columns:
        out.insert(0, "window_end", "")

    # Normalise algorithm column name
    if "algorithm_used" in out.columns and "algorithm" not in out.columns:
        out = out.rename(columns={"algorithm_used": "algorithm"})

    cols = [c for c in _DRIFT_COLS if c in out.columns]
    out = out[cols]

    if fmt == "json":
        return _to_json_records(out)
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
) -> str:
    # Resolve split --top params: explicit overrides win, then --top, then 0 (all)
    effective_risks = top_risks if top_risks is not None else top
    effective_clusters = top_clusters if top_clusters is not None else top

    summary_data = read_summary(out)
    file_metrics = read_file_metrics(out)
    cluster_metrics = read_cluster_metrics(out)
    drift_df = read_drift(out)

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
        # Add top_paths and label from the paths column if available (consistent with format_clusters)
        if "paths" in filtered_clusters.columns:
            paths_list = filtered_clusters["paths"].tolist()
            for rec, paths_val in zip(cluster_records, paths_list):
                all_paths = _extract_paths_list(paths_val)
                rec["top_paths"] = all_paths[:5]
                rec["label"] = _generate_cluster_label(all_paths)

        drift_out = drift_df.copy()
        if "window_end_ts" in drift_out.columns:
            drift_out.insert(0, "window_end", drift_out["window_end_ts"].apply(_ts_to_iso))
        if "algorithm_used" in drift_out.columns:
            drift_out = drift_out.rename(columns={"algorithm_used": "algorithm"})
        drift_cols = [c for c in _DRIFT_COLS if c in drift_out.columns]
        drift_records = drift_out[drift_cols].to_dict(orient="records")

        combined = {
            "summary": summary_data,
            "risks": risk_records,
            "clusters": cluster_records,
            "drift": drift_records,
            "suggestions": suggestions_data.get("items", []),
        }
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
    sections.append(format_clusters(cluster_metrics, sort_by="leakage", fmt="table"))
    sections.append("")
    sections.append("=== Drift ===")
    sections.append(format_drift(drift_df, fmt="table"))
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
