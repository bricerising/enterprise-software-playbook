"""Tests for boundary health calculations in the metrics module.

Covers leakage/cohesion/conductance formulas, cross-boundary neighbor
counting, volatility variance, risk formula weights, and adjusted Rand
index edge cases.
"""

from __future__ import annotations

from collections import defaultdict

import networkx as nx
import numpy as np
import pandas as pd

from archobs.metrics import (
    _build_cluster_metrics,
    _build_file_metrics,
    _compute_centrality,
    _compute_xnbr,
    _compute_volatility,
    _normalize_series,
    _safe_divide,
    adjusted_rand_index,
    compute_metrics,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _simple_graph() -> tuple[nx.Graph, pd.DataFrame, dict[str, int]]:
    """Two-cluster graph: {a, b} and {c, d} with one cross-cluster edge."""
    g = nx.Graph()
    g.add_edge("a", "b", weight=1.0)
    g.add_edge("c", "d", weight=1.0)
    g.add_edge("b", "c", weight=0.5)  # cross-cluster
    clusters_df = pd.DataFrame([
        {"path": "a", "cluster_id": 0},
        {"path": "b", "cluster_id": 0},
        {"path": "c", "cluster_id": 1},
        {"path": "d", "cluster_id": 1},
    ])
    cluster_by_path = {"a": 0, "b": 0, "c": 1, "d": 1}
    return g, clusters_df, cluster_by_path


# ---------------------------------------------------------------------------
# _safe_divide / _normalize_series
# ---------------------------------------------------------------------------

def test_safe_divide_normal() -> None:
    assert _safe_divide(10.0, 2.0) == 5.0


def test_safe_divide_zero_denominator() -> None:
    assert _safe_divide(10.0, 0.0) == 0.0


def test_normalize_series_empty() -> None:
    assert _normalize_series({}) == {}


def test_normalize_series_all_zero() -> None:
    assert _normalize_series({"a": 0.0, "b": 0.0}) == {"a": 0.0, "b": 0.0}


def test_normalize_series_scales_to_one() -> None:
    result = _normalize_series({"a": 2.0, "b": 4.0})
    assert result["b"] == 1.0
    assert result["a"] == 0.5


# ---------------------------------------------------------------------------
# adjusted_rand_index
# ---------------------------------------------------------------------------

def test_ari_identical_partitions() -> None:
    assert adjusted_rand_index([0, 0, 1, 1], [0, 0, 1, 1]) == 1.0


def test_ari_completely_different_partitions() -> None:
    # Each element in its own cluster vs all in one cluster
    ari = adjusted_rand_index([0, 1, 2, 3], [0, 0, 0, 0])
    assert ari == 0.0


def test_ari_partial_agreement() -> None:
    ari = adjusted_rand_index([0, 0, 1, 1, 1], [0, 0, 0, 1, 1])
    assert 0.0 < ari < 1.0


def test_ari_single_element() -> None:
    assert adjusted_rand_index([0], [1]) == 1.0


def test_ari_mismatched_lengths_raises() -> None:
    try:
        adjusted_rand_index([0, 1], [0])
        assert False, "Expected ValueError"
    except ValueError:
        pass


def test_ari_symmetric() -> None:
    a = [0, 0, 1, 1, 2]
    b = [1, 0, 0, 1, 2]
    assert adjusted_rand_index(a, b) == adjusted_rand_index(b, a)


# ---------------------------------------------------------------------------
# _compute_xnbr
# ---------------------------------------------------------------------------

def test_xnbr_no_cross_boundary_edges() -> None:
    sem_edges = pd.DataFrame([
        {"path_a": "a", "path_b": "b"},  # same cluster
    ])
    cluster_by_path = {"a": 0, "b": 0, "c": 1}
    sem_total, sem_cross = _compute_xnbr(sem_edges, cluster_by_path)
    assert sem_total["a"] == 1
    assert sem_total["b"] == 1
    assert sem_cross["a"] == 0
    assert sem_cross["b"] == 0


def test_xnbr_all_cross_boundary() -> None:
    sem_edges = pd.DataFrame([
        {"path_a": "a", "path_b": "c"},  # cross cluster
    ])
    cluster_by_path = {"a": 0, "c": 1}
    sem_total, sem_cross = _compute_xnbr(sem_edges, cluster_by_path)
    assert sem_total["a"] == 1
    assert sem_cross["a"] == 1
    assert sem_cross["c"] == 1


def test_xnbr_mixed() -> None:
    sem_edges = pd.DataFrame([
        {"path_a": "a", "path_b": "b"},  # same cluster
        {"path_a": "a", "path_b": "c"},  # cross cluster
    ])
    cluster_by_path = {"a": 0, "b": 0, "c": 1}
    sem_total, sem_cross = _compute_xnbr(sem_edges, cluster_by_path)
    assert sem_total["a"] == 2
    assert sem_cross["a"] == 1  # one of two edges is cross-boundary


# ---------------------------------------------------------------------------
# _compute_volatility
# ---------------------------------------------------------------------------

def test_volatility_uniform_commits_is_zero() -> None:
    """Files committed equally across all windows have zero variance."""
    base = 1_700_000_000
    window_days = 30
    window_width = window_days * 86400
    rows = []
    for i in range(6):
        rows.append({"commit_sha": f"c{i}", "commit_ts": base - (i * window_width) + 1000, "path": "a.py"})
    df = pd.DataFrame(rows)
    vol = _compute_volatility(df, drift_window_days=window_days, drift_window_count=6)
    assert vol["a.py"] == 0.0


def test_volatility_bursty_commits_is_positive() -> None:
    """All commits in a single window produce positive variance."""
    base = 1_700_000_000
    rows = [
        {"commit_sha": "c1", "commit_ts": base - 100, "path": "a.py"},
        {"commit_sha": "c2", "commit_ts": base - 200, "path": "a.py"},
        {"commit_sha": "c3", "commit_ts": base - 300, "path": "a.py"},
    ]
    df = pd.DataFrame(rows)
    vol = _compute_volatility(df, drift_window_days=30, drift_window_count=6)
    assert vol["a.py"] > 0.0


def test_volatility_empty_df() -> None:
    df = pd.DataFrame(columns=["commit_sha", "commit_ts", "path"])
    vol = _compute_volatility(df, drift_window_days=30, drift_window_count=6)
    assert vol == {}


# ---------------------------------------------------------------------------
# _build_cluster_metrics — leakage, cohesion, conductance
# ---------------------------------------------------------------------------

def test_cluster_metrics_isolated_clusters_have_zero_leakage() -> None:
    """Clusters with no cross-boundary edges have leakage=0, cohesion=1."""
    g = nx.Graph()
    g.add_edge("a", "b", weight=1.0)
    g.add_edge("c", "d", weight=1.0)
    clusters_df = pd.DataFrame([
        {"path": "a", "cluster_id": 0},
        {"path": "b", "cluster_id": 0},
        {"path": "c", "cluster_id": 1},
        {"path": "d", "cluster_id": 1},
    ])
    cluster_by_path = {"a": 0, "b": 0, "c": 1, "d": 1}
    weighted_degree = {n: float(v) for n, v in g.degree(weight="weight")}
    risk_by_path = {"a": 0.1, "b": 0.2, "c": 0.1, "d": 0.2}

    result = _build_cluster_metrics(g, clusters_df, cluster_by_path, weighted_degree, risk_by_path)
    for _, row in result.iterrows():
        assert row["leakage"] == 0.0
        assert row["cohesion"] == 1.0
        assert row["conductance"] == 0.0


def test_cluster_metrics_cross_boundary_edges_produce_leakage() -> None:
    """A cross-cluster edge should increase leakage and reduce cohesion."""
    g, clusters_df, cluster_by_path = _simple_graph()
    weighted_degree = {n: float(v) for n, v in g.degree(weight="weight")}
    risk_by_path = {"a": 0.1, "b": 0.2, "c": 0.1, "d": 0.2}

    result = _build_cluster_metrics(g, clusters_df, cluster_by_path, weighted_degree, risk_by_path)
    for _, row in result.iterrows():
        assert row["leakage"] > 0.0
        assert row["cohesion"] < 1.0


def test_leakage_equals_one_minus_cohesion() -> None:
    g, clusters_df, cluster_by_path = _simple_graph()
    weighted_degree = {n: float(v) for n, v in g.degree(weight="weight")}
    risk_by_path = {"a": 0.1, "b": 0.2, "c": 0.1, "d": 0.2}

    result = _build_cluster_metrics(g, clusters_df, cluster_by_path, weighted_degree, risk_by_path)
    for _, row in result.iterrows():
        assert abs(row["leakage"] - (1.0 - row["cohesion"])) < 1e-9


def test_cohesion_formula() -> None:
    """cohesion = internal_weight / (internal_weight + external_weight)."""
    g, clusters_df, cluster_by_path = _simple_graph()
    weighted_degree = {n: float(v) for n, v in g.degree(weight="weight")}
    risk_by_path = {"a": 0.1, "b": 0.2, "c": 0.1, "d": 0.2}

    result = _build_cluster_metrics(g, clusters_df, cluster_by_path, weighted_degree, risk_by_path)
    for _, row in result.iterrows():
        expected = row["internal_weight"] / (row["internal_weight"] + row["external_weight"])
        assert abs(row["cohesion"] - expected) < 1e-9


def test_conductance_formula() -> None:
    """conductance = cut / min(volume, total_volume - volume)."""
    g, clusters_df, cluster_by_path = _simple_graph()
    weighted_degree = {n: float(v) for n, v in g.degree(weight="weight")}
    risk_by_path = {"a": 0.1, "b": 0.2, "c": 0.1, "d": 0.2}

    result = _build_cluster_metrics(g, clusters_df, cluster_by_path, weighted_degree, risk_by_path)
    total_volume = sum(weighted_degree.values())
    for _, row in result.iterrows():
        paths = row["paths"].split("\n")
        volume = sum(weighted_degree.get(p, 0.0) for p in paths)
        # cut == external_weight for undirected graphs counted per-cluster
        expected = row["external_weight"] / min(volume, total_volume - volume)
        assert abs(row["conductance"] - expected) < 1e-9


def test_cluster_metrics_risk_aggregation() -> None:
    """risk_mean and risk_max should reflect per-file risk values."""
    g = nx.Graph()
    g.add_edge("a", "b", weight=1.0)
    clusters_df = pd.DataFrame([
        {"path": "a", "cluster_id": 0},
        {"path": "b", "cluster_id": 0},
    ])
    cluster_by_path = {"a": 0, "b": 0}
    weighted_degree = {n: float(v) for n, v in g.degree(weight="weight")}
    risk_by_path = {"a": 0.3, "b": 0.7}

    result = _build_cluster_metrics(g, clusters_df, cluster_by_path, weighted_degree, risk_by_path)
    row = result.iloc[0]
    assert abs(row["risk_mean"] - 0.5) < 1e-9
    assert abs(row["risk_max"] - 0.7) < 1e-9


def test_external_inbound_rank_is_percentile() -> None:
    """external_inbound_rank should be a percentile rank between 0 and 1."""
    g, clusters_df, cluster_by_path = _simple_graph()
    weighted_degree = {n: float(v) for n, v in g.degree(weight="weight")}
    risk_by_path = {"a": 0.1, "b": 0.2, "c": 0.1, "d": 0.2}

    result = _build_cluster_metrics(g, clusters_df, cluster_by_path, weighted_degree, risk_by_path)
    assert "external_inbound_rank" in result.columns
    for val in result["external_inbound_rank"]:
        assert 0.0 <= val <= 1.0


# ---------------------------------------------------------------------------
# _build_file_metrics — risk formula
# ---------------------------------------------------------------------------

def test_risk_formula_weights() -> None:
    """risk = 0.5 * xnbr + 0.3 * hubness + 0.2 * volatility."""
    g = nx.Graph()
    g.add_edge("a", "b", weight=1.0)
    g.add_edge("b", "c", weight=0.5)
    files_df = pd.DataFrame([{"path": "a"}, {"path": "b"}, {"path": "c"}])
    clusters_df = pd.DataFrame([
        {"path": "a", "cluster_id": 0},
        {"path": "b", "cluster_id": 0},
        {"path": "c", "cluster_id": 1},
    ])
    cluster_by_path = {"a": 0, "b": 0, "c": 1}
    sem_edges = pd.DataFrame([
        {"path_a": "a", "path_b": "b"},
        {"path_a": "b", "path_b": "c"},
    ])

    weighted_degree, unweighted_degree, betweenness = _compute_centrality(g, seed=42)
    sem_total, sem_cross = _compute_xnbr(sem_edges, cluster_by_path)
    volatility_raw: dict[str, float] = {}

    result = _build_file_metrics(
        files_df, cluster_by_path,
        weighted_degree, unweighted_degree, betweenness,
        sem_total, sem_cross, volatility_raw,
    )

    for _, row in result.iterrows():
        expected = 0.5 * row["xnbr"] + 0.3 * row["hubness"] + 0.2 * row["volatility"]
        assert abs(row["risk"] - expected) < 1e-9


# ---------------------------------------------------------------------------
# compute_metrics — integration
# ---------------------------------------------------------------------------

def test_compute_metrics_empty_files() -> None:
    result = compute_metrics(
        files_df=pd.DataFrame(columns=["path"]),
        commit_files_df=pd.DataFrame(columns=["commit_sha", "commit_ts", "path"]),
        sem_edges_df=pd.DataFrame(columns=["path_a", "path_b"]),
        graph=nx.Graph(),
        clusters_df=pd.DataFrame(columns=["path", "cluster_id"]),
    )
    assert result.file_metrics.empty
    assert result.cluster_metrics.empty
    assert result.summary.node_count == 0


def test_compute_metrics_produces_expected_columns() -> None:
    g, clusters_df, cluster_by_path = _simple_graph()
    files_df = pd.DataFrame([{"path": p} for p in cluster_by_path])
    commit_files_df = pd.DataFrame([
        {"commit_sha": "c1", "commit_ts": 1_700_000_000, "status": "M", "path": "a"},
        {"commit_sha": "c1", "commit_ts": 1_700_000_000, "status": "M", "path": "b"},
    ])
    sem_edges_df = pd.DataFrame([{"path_a": "a", "path_b": "c", "similarity": 0.8, "w_sem": 0.8}])

    result = compute_metrics(files_df, commit_files_df, sem_edges_df, g, clusters_df)

    assert set(result.file_metrics.columns) >= {"path", "cluster_id", "xnbr", "hubness", "volatility", "risk"}
    assert set(result.cluster_metrics.columns) >= {"cluster_id", "cohesion", "leakage", "conductance"}
    assert result.summary.node_count == 4
    assert result.summary.edge_count == 3
