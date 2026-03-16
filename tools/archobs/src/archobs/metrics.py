"""Internal metrics primitives for the analysis engine boundary."""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from math import comb

import networkx as nx
import numpy as np
import pandas as pd

__all__ = [
    "MetricsSummary",
    "MetricsResult",
    "adjusted_rand_index",
    "compute_metrics",
    "metrics_report_inputs",
]


# ---------------------------------------------------------------------------
# Public data contracts
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class MetricsSummary:
    """Typed summary of graph-level metrics."""

    node_count: int
    edge_count: int
    cluster_count: int
    hub_deg: float

    def to_dict(self) -> dict[str, object]:
        return {
            "node_count": self.node_count,
            "edge_count": self.edge_count,
            "cluster_count": self.cluster_count,
            "hub_deg": self.hub_deg,
        }


@dataclass(frozen=True, slots=True)
class MetricsResult:
    """Stable return type for :func:`compute_metrics`.

    Attributes:
        file_metrics: Per-file metrics (path, cluster_id, weighted_degree,
            degree, betweenness, xnbr, hubness, volatility, risk).
        cluster_metrics: Per-cluster metrics (cluster_id, size, cohesion,
            leakage, conductance, internal_weight, external_weight,
            risk_mean, risk_max, paths).
        summary: Graph-level summary counters.
    """

    file_metrics: pd.DataFrame
    cluster_metrics: pd.DataFrame
    summary: MetricsSummary

    def report_inputs(self) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, object]]:
        return metrics_report_inputs(self)


def metrics_report_inputs(metrics: MetricsResult) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, object]]:
    """Expose report inputs from the published metrics result."""

    return metrics.file_metrics, metrics.cluster_metrics, metrics.summary.to_dict()


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

def _safe_divide(numerator: float, denominator: float) -> float:
    return float(numerator / denominator) if denominator else 0.0


def _normalize_series(values: dict[str, float]) -> dict[str, float]:
    if not values:
        return {}
    max_value = max(values.values()) or 0.0
    if max_value <= 0:
        return {key: 0.0 for key in values}
    return {key: float(value / max_value) for key, value in values.items()}


def adjusted_rand_index(labels_a: list[int], labels_b: list[int]) -> float:
    if len(labels_a) != len(labels_b):
        raise ValueError("Partitions must have the same number of items.")
    n = len(labels_a)
    if n < 2:
        return 1.0
    contingency: defaultdict[tuple[int, int], int] = defaultdict(int)
    counts_a: Counter[int] = Counter()
    counts_b: Counter[int] = Counter()
    for left, right in zip(labels_a, labels_b, strict=True):
        contingency[(left, right)] += 1
        counts_a[left] += 1
        counts_b[right] += 1
    sum_comb = sum(comb(count, 2) for count in contingency.values())
    sum_a = sum(comb(count, 2) for count in counts_a.values())
    sum_b = sum(comb(count, 2) for count in counts_b.values())
    total = comb(n, 2)
    expected = (sum_a * sum_b) / total if total else 0.0
    max_index = 0.5 * (sum_a + sum_b)
    denominator = max_index - expected
    if denominator == 0:
        return 1.0
    return float((sum_comb - expected) / denominator)


# ---------------------------------------------------------------------------
# Internal computation stages
#
# Each stage is a pure function that takes explicit inputs and returns a
# narrow result.  This keeps individual concerns (centrality, boundary
# crossing, churn volatility, cluster aggregation) independently testable
# and allows the outer ``compute_metrics`` to remain a thin orchestrator.
# ---------------------------------------------------------------------------

def _compute_centrality(
    graph: nx.Graph,
    *,
    seed: int,
) -> tuple[dict[str, float], dict[str, int], dict[str, float]]:
    """Return weighted degree, unweighted degree, and betweenness centrality."""
    weighted_degree = {node: float(value) for node, value in graph.degree(weight="weight")}
    unweighted_degree = {node: int(value) for node, value in graph.degree()}

    distance_graph = nx.Graph()
    distance_graph.add_nodes_from(graph.nodes(data=True))
    for left, right, attrs in graph.edges(data=True):
        distance_graph.add_edge(left, right, distance=1.0 / max(float(attrs["weight"]), 1e-9))

    if graph.number_of_nodes() > 200:
        betweenness = nx.betweenness_centrality(
            distance_graph,
            k=min(200, graph.number_of_nodes()),
            weight="distance",
            seed=seed,
            normalized=True,
        )
    else:
        betweenness = nx.betweenness_centrality(distance_graph, weight="distance", normalized=True)

    return weighted_degree, unweighted_degree, betweenness


def _compute_xnbr(
    sem_edges_df: pd.DataFrame,
    cluster_by_path: dict[str, int],
) -> tuple[defaultdict[str, int], defaultdict[str, int]]:
    """Return per-path semantic total and cross-boundary neighbor counts."""
    sem_total: defaultdict[str, int] = defaultdict(int)
    sem_cross: defaultdict[str, int] = defaultdict(int)
    for row in sem_edges_df.itertuples(index=False):
        sem_total[row.path_a] += 1
        sem_total[row.path_b] += 1
        if cluster_by_path.get(row.path_a) != cluster_by_path.get(row.path_b):
            sem_cross[row.path_a] += 1
            sem_cross[row.path_b] += 1
    return sem_total, sem_cross


def _compute_volatility(
    commit_files_df: pd.DataFrame,
    *,
    drift_window_days: int,
    drift_window_count: int,
) -> dict[str, float]:
    """Return per-path raw volatility (variance of windowed commit counts)."""
    analysis_ts = int(commit_files_df["commit_ts"].max()) if not commit_files_df.empty else 0
    window_width = drift_window_days * 86400
    window_count = drift_window_count
    volatility_counts: defaultdict[str, list[int]] = defaultdict(lambda: [0] * window_count)
    if analysis_ts and window_width > 0:
        floor_ts = analysis_ts - (window_count * window_width)
        recent = commit_files_df[commit_files_df["commit_ts"] > floor_ts]
        for row in recent.itertuples(index=False):
            index = int((analysis_ts - int(row.commit_ts)) // window_width)
            if 0 <= index < window_count:
                bucket = window_count - index - 1
                volatility_counts[row.path][bucket] += 1

    return {
        path: float(np.var(counts))
        for path, counts in volatility_counts.items()
    }


def _build_file_metrics(
    files_df: pd.DataFrame,
    cluster_by_path: dict[str, int],
    weighted_degree: dict[str, float],
    unweighted_degree: dict[str, int],
    betweenness: dict[str, float],
    sem_total: defaultdict[str, int],
    sem_cross: defaultdict[str, int],
    volatility_raw: dict[str, float],
) -> pd.DataFrame:
    """Assemble per-file metrics DataFrame from pre-computed components."""
    degree_norm = _normalize_series(weighted_degree)
    betweenness_norm = _normalize_series({key: float(value) for key, value in betweenness.items()})
    volatility_norm = _normalize_series(volatility_raw)

    file_rows = []
    for row in files_df.sort_values("path").itertuples(index=False):
        xnbr = _safe_divide(sem_cross[row.path], sem_total[row.path])
        hubness = 0.5 * degree_norm.get(row.path, 0.0) + 0.5 * betweenness_norm.get(row.path, 0.0)
        volatility = volatility_norm.get(row.path, 0.0)
        risk = 0.5 * xnbr + 0.3 * hubness + 0.2 * volatility
        file_rows.append(
            {
                "path": row.path,
                "cluster_id": cluster_by_path.get(row.path, -1),
                "weighted_degree": weighted_degree.get(row.path, 0.0),
                "degree": unweighted_degree.get(row.path, 0),
                "betweenness": float(betweenness.get(row.path, 0.0)),
                "xnbr": xnbr,
                "hubness": hubness,
                "volatility": volatility,
                "risk": risk,
            }
        )
    return pd.DataFrame(file_rows).sort_values(["risk", "path"], ascending=[False, True]).reset_index(drop=True)


def _build_cluster_metrics(
    graph: nx.Graph,
    clusters_df: pd.DataFrame,
    cluster_by_path: dict[str, int],
    weighted_degree: dict[str, float],
    risk_by_path: dict[str, float],
) -> pd.DataFrame:
    """Assemble per-cluster metrics DataFrame."""
    win: defaultdict[int, float] = defaultdict(float)
    wout: defaultdict[int, float] = defaultdict(float)
    cut: defaultdict[int, float] = defaultdict(float)
    # Directional inbound weight: weight of cross-cluster edges where this cluster is *target*
    # For undirected co-change/semantic edges we split equally; for directed dep edges
    # we attribute to both sides.  Here we count each cross-cluster edge toward both
    # endpoints' inbound tally (since the graph is undirected).  The result measures
    # "how much do other clusters pull toward me."
    inbound: defaultdict[int, float] = defaultdict(float)
    for left, right, attrs in graph.edges(data=True):
        weight = float(attrs["weight"])
        cluster_left = cluster_by_path.get(left, -1)
        cluster_right = cluster_by_path.get(right, -1)
        if cluster_left == cluster_right:
            win[cluster_left] += weight
        else:
            wout[cluster_left] += weight
            wout[cluster_right] += weight
            cut[cluster_left] += weight
            cut[cluster_right] += weight
            inbound[cluster_left] += weight
            inbound[cluster_right] += weight

    total_volume = float(sum(weighted_degree.values()))
    cluster_rows = []
    for cluster_id, group in clusters_df.groupby("cluster_id", sort=True):
        paths = sorted(group["path"].tolist())
        volume = float(sum(weighted_degree.get(path, 0.0) for path in paths))
        inner = win[cluster_id]
        outer = wout[cluster_id]
        cohesion = _safe_divide(inner, inner + outer)
        leakage = 1.0 - cohesion if inner + outer else 0.0
        conductance = _safe_divide(cut[cluster_id], min(volume, total_volume - volume)) if total_volume else 0.0
        cluster_rows.append(
            {
                "cluster_id": int(cluster_id),
                "size": len(paths),
                "cohesion": cohesion,
                "leakage": leakage,
                "conductance": conductance,
                "internal_weight": inner,
                "external_weight": outer,
                "external_inbound_weight": inbound[cluster_id],
                "risk_mean": float(np.mean([risk_by_path[path] for path in paths])) if paths else 0.0,
                "risk_max": max((risk_by_path[path] for path in paths), default=0.0),
                "paths": "\n".join(paths[:50]),
            }
        )
    return pd.DataFrame(cluster_rows).sort_values(["leakage", "cluster_id"], ascending=[False, True]).reset_index(drop=True)


_EMPTY_FILE_COLUMNS = ["path", "cluster_id", "weighted_degree", "degree", "betweenness", "xnbr", "hubness", "volatility", "risk"]
_EMPTY_CLUSTER_COLUMNS = ["cluster_id", "size", "cohesion", "leakage", "conductance", "internal_weight", "external_weight", "external_inbound_weight", "risk_mean", "risk_max", "paths"]


# ---------------------------------------------------------------------------
# Public entry point — thin orchestrator over internal stages
# ---------------------------------------------------------------------------

def compute_metrics(
    files_df: pd.DataFrame,
    commit_files_df: pd.DataFrame,
    sem_edges_df: pd.DataFrame,
    graph: nx.Graph,
    clusters_df: pd.DataFrame,
    *,
    seed: int = 42,
    drift_window_days: int = 90,
    drift_window_count: int = 6,
) -> MetricsResult:
    if files_df.empty:
        return MetricsResult(
            file_metrics=pd.DataFrame(columns=_EMPTY_FILE_COLUMNS),
            cluster_metrics=pd.DataFrame(columns=_EMPTY_CLUSTER_COLUMNS),
            summary=MetricsSummary(node_count=0, edge_count=0, cluster_count=0, hub_deg=0.0),
        )

    cluster_by_path = dict(zip(clusters_df["path"], clusters_df["cluster_id"], strict=True))

    weighted_degree, unweighted_degree, betweenness = _compute_centrality(graph, seed=seed)
    sem_total, sem_cross = _compute_xnbr(sem_edges_df, cluster_by_path)
    volatility_raw = _compute_volatility(
        commit_files_df,
        drift_window_days=drift_window_days,
        drift_window_count=drift_window_count,
    )

    file_metrics_df = _build_file_metrics(
        files_df, cluster_by_path,
        weighted_degree, unweighted_degree, betweenness,
        sem_total, sem_cross, volatility_raw,
    )

    risk_by_path = dict(zip(file_metrics_df["path"], file_metrics_df["risk"], strict=True))
    cluster_metrics_df = _build_cluster_metrics(
        graph, clusters_df, cluster_by_path, weighted_degree, risk_by_path,
    )

    mean_degree = float(np.mean(list(unweighted_degree.values()))) if unweighted_degree else 0.0
    hub_deg = _safe_divide(max(unweighted_degree.values(), default=0.0), mean_degree)
    summary = MetricsSummary(
        node_count=int(graph.number_of_nodes()),
        edge_count=int(graph.number_of_edges()),
        cluster_count=int(clusters_df["cluster_id"].nunique()) if not clusters_df.empty else 0,
        hub_deg=hub_deg,
    )
    return MetricsResult(
        file_metrics=file_metrics_df,
        cluster_metrics=cluster_metrics_df,
        summary=summary,
    )
