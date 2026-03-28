"""Output contract tests for archobs artifacts.

Validates that the schemas of persisted parquet and JSON artifacts match
what downstream consumers (skills, suggestions engine) expect.  These
tests break if a column is renamed, removed, or changes type.
"""

from __future__ import annotations

from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd

from archobs.clustering import cluster_files
from archobs.config import default_config
from archobs.metrics import compute_metrics
from archobs.pipeline import ReportResult, _compute_drift
from archobs.storage import ArtifactStore


# ---------------------------------------------------------------------------
# Expected column contracts
# ---------------------------------------------------------------------------

FILE_METRICS_COLUMNS = {
    "path", "cluster_id", "weighted_degree", "degree", "betweenness",
    "xnbr", "hubness", "volatility", "risk",
}

CLUSTER_METRICS_COLUMNS = {
    "cluster_id", "size", "cohesion", "leakage", "conductance",
    "internal_weight", "external_weight", "external_inbound_weight",
    "external_inbound_rank", "risk_mean", "risk_max", "paths",
}

DRIFT_COLUMNS = {
    "window_end_ts", "cluster_count", "modularity", "ari_prev", "algorithm_used",
}

SUMMARY_JSON_KEYS = {
    "node_count", "edge_count", "cluster_count", "hub_deg",
}

CLUSTERS_PARQUET_COLUMNS = {"path", "cluster_id"}

COMMITS_PARQUET_COLUMNS = {"commit_sha", "commit_ts", "status", "path"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_test_artifacts() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, dict]:
    """Build minimal metrics artifacts for contract validation."""
    g = nx.Graph()
    g.add_edge("a.py", "b.py", weight=1.0)
    g.add_edge("c.py", "d.py", weight=1.0)
    g.add_edge("b.py", "c.py", weight=0.5)

    files_df = pd.DataFrame([{"path": p} for p in ["a.py", "b.py", "c.py", "d.py"]])
    clusters_df = pd.DataFrame([
        {"path": "a.py", "cluster_id": 0},
        {"path": "b.py", "cluster_id": 0},
        {"path": "c.py", "cluster_id": 1},
        {"path": "d.py", "cluster_id": 1},
    ])
    commit_files_df = pd.DataFrame([
        {"commit_sha": "c1", "commit_ts": 1_700_000_000, "status": "M", "path": "a.py"},
        {"commit_sha": "c1", "commit_ts": 1_700_000_000, "status": "M", "path": "b.py"},
    ])
    sem_edges_df = pd.DataFrame([
        {"path_a": "a.py", "path_b": "c.py", "similarity": 0.8, "w_sem": 0.8},
    ])

    result = compute_metrics(files_df, commit_files_df, sem_edges_df, g, clusters_df)
    return result.file_metrics, result.cluster_metrics, pd.DataFrame(columns=list(DRIFT_COLUMNS)), result.summary.to_dict()


# ---------------------------------------------------------------------------
# Column schema contracts
# ---------------------------------------------------------------------------

def test_file_metrics_columns() -> None:
    file_metrics, _, _, _ = _build_test_artifacts()
    assert FILE_METRICS_COLUMNS.issubset(set(file_metrics.columns))


def test_cluster_metrics_columns() -> None:
    _, cluster_metrics, _, _ = _build_test_artifacts()
    assert CLUSTER_METRICS_COLUMNS.issubset(set(cluster_metrics.columns))


def test_drift_columns() -> None:
    """Drift DataFrame has the expected column contract."""
    config = default_config()
    config.clustering.algorithm = "greedy-modularity"
    config.clustering.drift_window_count = 4

    files_df = pd.DataFrame([{"path": "a.py"}, {"path": "b.py"}])
    base = 1_700_000_000
    commit_files_df = pd.DataFrame([
        {"commit_sha": "c1", "commit_ts": base, "status": "A", "path": "a.py"},
        {"commit_sha": "c1", "commit_ts": base, "status": "A", "path": "b.py"},
        {"commit_sha": "c2", "commit_ts": base + 3600, "status": "M", "path": "a.py"},
        {"commit_sha": "c3", "commit_ts": base + 7200, "status": "M", "path": "b.py"},
    ])
    sem_edges_df = pd.DataFrame(columns=["path_a", "path_b", "similarity", "w_sem"])
    dep_edges_df = pd.DataFrame(columns=["path_a", "path_b", "imports_ab", "imports_ba", "w_dep_raw", "w_dep"])

    drift_df = _compute_drift(files_df, commit_files_df, sem_edges_df, dep_edges_df, config)
    assert DRIFT_COLUMNS.issubset(set(drift_df.columns))


def test_summary_json_keys() -> None:
    _, _, _, summary = _build_test_artifacts()
    assert SUMMARY_JSON_KEYS.issubset(set(summary.keys()))


# ---------------------------------------------------------------------------
# Type contracts (values are the expected types, not just column presence)
# ---------------------------------------------------------------------------

def test_file_metrics_types() -> None:
    file_metrics, _, _, _ = _build_test_artifacts()
    row = file_metrics.iloc[0]
    assert isinstance(row["path"], str)
    assert isinstance(row["risk"], float)
    assert isinstance(row["xnbr"], float)
    assert isinstance(row["hubness"], float)
    assert isinstance(row["volatility"], float)


def test_cluster_metrics_types() -> None:
    _, cluster_metrics, _, _ = _build_test_artifacts()
    row = cluster_metrics.iloc[0]
    assert isinstance(row["cohesion"], float)
    assert isinstance(row["leakage"], float)
    assert isinstance(row["conductance"], float)
    assert isinstance(row["paths"], str)


def test_summary_json_types() -> None:
    _, _, _, summary = _build_test_artifacts()
    assert isinstance(summary["node_count"], int)
    assert isinstance(summary["edge_count"], int)
    assert isinstance(summary["cluster_count"], int)
    assert isinstance(summary["hub_deg"], float)


# ---------------------------------------------------------------------------
# Value invariants
# ---------------------------------------------------------------------------

def test_risk_bounded_zero_one() -> None:
    """Risk values should be in [0, 1]."""
    file_metrics, _, _, _ = _build_test_artifacts()
    assert (file_metrics["risk"] >= 0.0).all()
    assert (file_metrics["risk"] <= 1.0).all()


def test_cohesion_bounded_zero_one() -> None:
    _, cluster_metrics, _, _ = _build_test_artifacts()
    assert (cluster_metrics["cohesion"] >= 0.0).all()
    assert (cluster_metrics["cohesion"] <= 1.0).all()


def test_leakage_bounded_zero_one() -> None:
    _, cluster_metrics, _, _ = _build_test_artifacts()
    assert (cluster_metrics["leakage"] >= 0.0).all()
    assert (cluster_metrics["leakage"] <= 1.0).all()


# ---------------------------------------------------------------------------
# Persistence round-trip
# ---------------------------------------------------------------------------

def test_artifact_store_round_trip(tmp_path: Path) -> None:
    """Persisted artifacts can be read back with the same schema."""
    file_metrics, cluster_metrics, drift_df, summary = _build_test_artifacts()

    report = ReportResult(
        summary=summary,
        file_metrics=file_metrics,
        cluster_metrics=cluster_metrics,
        drift_df=drift_df,
    )

    store = ArtifactStore(tmp_path)
    store.save_report(report)

    loaded_fm = pd.read_parquet(tmp_path / "file_metrics.parquet")
    loaded_cm = pd.read_parquet(tmp_path / "cluster_metrics.parquet")
    assert FILE_METRICS_COLUMNS.issubset(set(loaded_fm.columns))
    assert CLUSTER_METRICS_COLUMNS.issubset(set(loaded_cm.columns))
