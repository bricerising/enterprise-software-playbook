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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _generate_cluster_label(paths: list[str], max_length: int = 50) -> str:
    """Generate a heuristic label from the dominant path prefixes in a cluster."""
    if not paths:
        return ""
    from collections import Counter
    prefixes: list[str] = []
    for p in paths:
        parts = p.split("/")
        # Skip common root segments like src/, packages/, apps/
        start = 0
        if parts and parts[0] in {"src", "packages", "apps", "lib"}:
            start = 1
        segments = parts[start:start + 2]
        if segments:
            prefixes.append("/".join(segments))
    if not prefixes:
        return ""
    counts = Counter(prefixes)
    top = counts.most_common(2)
    label = " + ".join(prefix for prefix, _ in top)
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
# Format: clusters
# ---------------------------------------------------------------------------

_CLUSTER_TABLE_COLS = ["cluster_id", "size", "cohesion", "leakage", "conductance",
                       "internal_weight", "external_weight", "risk_mean", "risk_max"]
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
    top: int = 10,
    fmt: str = "table",
) -> str:
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
        if top > 0:
            sorted_risks = sorted_risks.head(top)
        risk_records = sorted_risks[cols].to_dict(orient="records")

        cluster_cols = [c for c in _CLUSTER_JSON_COLS if c in cluster_metrics.columns]
        filtered_clusters = (
            cluster_metrics[cluster_metrics["size"] >= 2]
            .sort_values("leakage", ascending=False)
        ) if "size" in cluster_metrics.columns else cluster_metrics.copy()
        if top > 0:
            filtered_clusters = filtered_clusters.head(top)
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
    sections = []
    sections.append("=== Summary ===")
    sections.append(format_summary(summary_data, fmt="table"))
    sections.append("")
    sections.append(f"=== Top {top} Risk Files ===")
    sections.append(format_risks(file_metrics, top=top, fmt="table"))
    sections.append("")
    sections.append(f"=== Top {top} Leaky Clusters ===")
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
