"""Internal clustering primitives owned behind the analysis engine boundary."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import warnings

import networkx as nx
import pandas as pd

from archobs.config.clustering import ClusteringConfig

__all__ = [
    "ClusteringResult",
    "cluster_metadata",
    "cluster_files",
    "cluster_report_inputs",
    "persist_cluster_artifacts",
]


@dataclass(frozen=True, slots=True)
class ClusteringResult:
    """Stable return type for :func:`cluster_files`."""

    clusters_df: pd.DataFrame
    algorithm_requested: str
    algorithm_used: str
    cluster_count: int
    modularity: float

    @property
    def metadata(self) -> dict[str, object]:
        return cluster_metadata(self)

    def report_inputs(self) -> tuple[pd.DataFrame, dict[str, object]]:
        return cluster_report_inputs(self)

    def persist(self, out: str | Path) -> None:
        persist_cluster_artifacts(self, out)


def cluster_metadata(cluster_result: ClusteringResult) -> dict[str, object]:
    """Expose stable clustering metadata from the published result."""

    return {
        "algorithm_requested": cluster_result.algorithm_requested,
        "algorithm_used": cluster_result.algorithm_used,
        "cluster_count": cluster_result.cluster_count,
        "modularity": cluster_result.modularity,
    }


def cluster_report_inputs(cluster_result: ClusteringResult) -> tuple[pd.DataFrame, dict[str, object]]:
    """Expose report inputs from the published clustering result."""

    return cluster_result.clusters_df, cluster_metadata(cluster_result)


def persist_cluster_artifacts(cluster_result: ClusteringResult, out: str | Path) -> None:
    """Persist clustering artifacts through the published result contract."""

    from archobs.storage import write_json, write_parquet

    write_parquet(cluster_result.clusters_df, out, "clusters")
    write_json(cluster_metadata(cluster_result), out, "cluster_run")


def _normalize_communities(communities: list[set[str]]) -> list[list[str]]:
    ordered = [sorted(community) for community in communities]
    ordered.sort(key=lambda items: (-len(items), items[0] if items else ""))
    return ordered


def _greedy_modularity(graph: nx.Graph, resolution: float) -> list[list[str]]:
    communities = nx.algorithms.community.greedy_modularity_communities(
        graph, weight="weight", resolution=resolution
    )
    return _normalize_communities([set(community) for community in communities])


def _leiden(graph: nx.Graph, resolution: float, seed: int) -> list[list[str]]:
    import igraph as ig
    import leidenalg

    nodes = sorted(graph.nodes())
    index = {node: idx for idx, node in enumerate(nodes)}
    edges = [(index[u], index[v]) for u, v in graph.edges()]
    ig_graph = ig.Graph(n=len(nodes), edges=edges, directed=False)
    ig_graph.es["weight"] = [float(graph[u][v]["weight"]) for u, v in graph.edges()]

    try:
        partition = leidenalg.find_partition(
            ig_graph,
            leidenalg.RBConfigurationVertexPartition,
            weights="weight",
            resolution_parameter=resolution,
            seed=seed,
        )
    except TypeError:
        leidenalg.set_rng_seed(seed)
        partition = leidenalg.find_partition(
            ig_graph,
            leidenalg.RBConfigurationVertexPartition,
            weights="weight",
            resolution_parameter=resolution,
        )

    memberships = partition.membership
    groups: dict[int, set[str]] = {}
    for node, membership in zip(nodes, memberships, strict=True):
        groups.setdefault(int(membership), set()).add(node)
    return _normalize_communities(list(groups.values()))


def cluster_files(graph: nx.Graph, config: ClusteringConfig) -> ClusteringResult:
    if graph.number_of_nodes() == 0:
        return ClusteringResult(
            clusters_df=pd.DataFrame(columns=["path", "cluster_id"]),
            algorithm_requested=config.algorithm,
            algorithm_used="none",
            cluster_count=0,
            modularity=0.0,
        )

    requested = config.algorithm
    algorithm = requested
    if algorithm == "auto":
        try:
            communities = _leiden(graph, config.resolution, config.seed)
            algorithm = "leiden"
        except Exception as exc:
            warnings.warn(f"Leiden unavailable; falling back to greedy modularity: {exc}", stacklevel=2)
            communities = _greedy_modularity(graph, config.resolution)
            algorithm = "greedy-modularity"
    elif algorithm == "leiden":
        communities = _leiden(graph, config.resolution, config.seed)
    elif algorithm == "greedy-modularity":
        communities = _greedy_modularity(graph, config.resolution)
    else:
        raise ValueError(f"Unsupported clustering algorithm: {algorithm}")

    rows = []
    for cluster_id, paths in enumerate(communities):
        for path in paths:
            rows.append({"path": path, "cluster_id": cluster_id})

    clusters_df = pd.DataFrame(rows).sort_values(["cluster_id", "path"]).reset_index(drop=True)
    partition = [set(group) for group in communities]
    modularity = (
        nx.algorithms.community.quality.modularity(graph, partition, weight="weight")
        if graph.number_of_edges() > 0 and partition
        else 0.0
    )
    return ClusteringResult(
        clusters_df=clusters_df,
        algorithm_requested=requested,
        algorithm_used=algorithm,
        cluster_count=len(communities),
        modularity=float(modularity),
    )
