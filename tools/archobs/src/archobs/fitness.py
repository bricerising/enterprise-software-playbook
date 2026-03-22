"""Architecture fitness check: threshold-based evaluation of archobs artifacts."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd

from archobs.storage import parquet_path


@dataclass(frozen=True, slots=True)
class Thresholds:
    """Configurable thresholds for fitness evaluation."""

    max_file_risk: float = 0.8
    max_leakage: float = 0.6
    min_cohesion: float = 0.4
    max_risk_mean: float = 0.5
    min_bus_factor: int = 2
    min_cluster_size: int = 2


def evaluate_fitness(
    out: str | Path,
    thresholds: Thresholds | None = None,
) -> dict[str, Any]:
    """Evaluate architecture fitness against thresholds.

    Reads existing Parquet artifacts (never writes). Returns a structured
    result with pass/fail, violation counts, and per-violation detail.
    """
    out = Path(out)
    t = thresholds or Thresholds()

    violations: list[dict[str, Any]] = []
    by_category: dict[str, int] = {}
    warnings: list[str] = []

    # --- File risk ---
    file_metrics_path = parquet_path(out, "file_metrics")
    if not file_metrics_path.exists():
        raise FileNotFoundError(
            f"{file_metrics_path} not found. Run `archobs report` first."
        )
    file_metrics_df = pd.read_parquet(file_metrics_path)

    if "risk" in file_metrics_df.columns:
        risky = file_metrics_df[file_metrics_df["risk"] > t.max_file_risk]
        for _, row in risky.iterrows():
            violations.append({
                "category": "file_risk",
                "entity": str(row["path"]),
                "metric": "risk",
                "value": round(float(row["risk"]), 4),
                "threshold": t.max_file_risk,
            })
        by_category["file_risk"] = len(risky)

    # --- Cluster metrics ---
    cluster_metrics_path = parquet_path(out, "cluster_metrics")
    if not cluster_metrics_path.exists():
        raise FileNotFoundError(
            f"{cluster_metrics_path} not found. Run `archobs report` first."
        )
    cluster_metrics_df = pd.read_parquet(cluster_metrics_path)

    # Apply min_cluster_size filter
    if "size" in cluster_metrics_df.columns:
        filtered_clusters = cluster_metrics_df[
            cluster_metrics_df["size"] >= t.min_cluster_size
        ]
    else:
        filtered_clusters = cluster_metrics_df

    def _cluster_label(row: pd.Series) -> str:
        cid = str(row.get("cluster_id", "?"))
        label = row.get("label", "")
        return f"cluster:{cid}" if not label else f"cluster:{cid} ({label})"

    # Leakage check
    if "leakage" in filtered_clusters.columns:
        leaky = filtered_clusters[filtered_clusters["leakage"] > t.max_leakage]
        for _, row in leaky.iterrows():
            violations.append({
                "category": "cluster_leakage",
                "entity": _cluster_label(row),
                "metric": "leakage",
                "value": round(float(row["leakage"]), 4),
                "threshold": t.max_leakage,
            })
        by_category["cluster_leakage"] = len(leaky)

    # Cohesion check
    if "cohesion" in filtered_clusters.columns:
        low_cohesion = filtered_clusters[filtered_clusters["cohesion"] < t.min_cohesion]
        for _, row in low_cohesion.iterrows():
            violations.append({
                "category": "cluster_cohesion",
                "entity": _cluster_label(row),
                "metric": "cohesion",
                "value": round(float(row["cohesion"]), 4),
                "threshold": t.min_cohesion,
            })
        by_category["cluster_cohesion"] = len(low_cohesion)

    # Risk mean check
    if "risk_mean" in filtered_clusters.columns:
        high_risk = filtered_clusters[filtered_clusters["risk_mean"] > t.max_risk_mean]
        for _, row in high_risk.iterrows():
            violations.append({
                "category": "cluster_risk_mean",
                "entity": _cluster_label(row),
                "metric": "risk_mean",
                "value": round(float(row["risk_mean"]), 4),
                "threshold": t.max_risk_mean,
            })
        by_category["cluster_risk_mean"] = len(high_risk)

    # --- Bus factor (optional) ---
    bus_factor_path = parquet_path(out, "bus_factor")
    if bus_factor_path.exists():
        bus_factor_df = pd.read_parquet(bus_factor_path)

        # Join with cluster_metrics for size filter
        if "size" in cluster_metrics_df.columns:
            bus_with_size = bus_factor_df.merge(
                cluster_metrics_df[["cluster_id", "size"]],
                on="cluster_id",
                how="left",
            )
            bus_filtered = bus_with_size[
                bus_with_size["size"].fillna(0) >= t.min_cluster_size
            ]
        else:
            bus_filtered = bus_factor_df

        low_bus = bus_filtered[bus_filtered["bus_factor"] < t.min_bus_factor]
        for _, row in low_bus.iterrows():
            violations.append({
                "category": "bus_factor",
                "entity": f"cluster:{row['cluster_id']}",
                "metric": "bus_factor",
                "value": int(row["bus_factor"]),
                "threshold": t.min_bus_factor,
            })
        by_category["bus_factor"] = len(low_bus)
    else:
        warnings.append(
            "bus_factor.parquet not found — bus factor check skipped. "
            "Run `archobs report` with team analysis enabled to include this check."
        )

    total = len(violations)
    result: dict[str, Any] = {
        "pass": total == 0,
        "total_violations": total,
        "by_category": by_category,
        "thresholds": {
            "max_file_risk": t.max_file_risk,
            "max_leakage": t.max_leakage,
            "min_cohesion": t.min_cohesion,
            "max_risk_mean": t.max_risk_mean,
            "min_bus_factor": t.min_bus_factor,
            "min_cluster_size": t.min_cluster_size,
        },
        "violations": violations,
    }
    if warnings:
        result["warnings"] = warnings

    return result
