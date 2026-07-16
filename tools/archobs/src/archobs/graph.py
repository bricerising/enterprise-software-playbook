"""Internal graph-construction primitives for the analysis engine boundary."""

from __future__ import annotations

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from hashlib import sha1
from itertools import combinations
import json
from math import log
from pathlib import Path
import shutil
from subprocess import CalledProcessError, TimeoutExpired, run
from typing import Callable
import warnings

import networkx as nx
import numpy as np
import pandas as pd

from archobs.config.graph import GraphConfig
from archobs.embedding import build_hashing_embeddings
from archobs.git_history import build_cochange_edges

SemanticEdgeBuilder = Callable[
    [str | Path, pd.DataFrame, pd.DataFrame, np.ndarray | None, str, GraphConfig, str | Path | None],
    pd.DataFrame,
]
DependencyEdgeBuilder = Callable[[pd.DataFrame, GraphConfig], pd.DataFrame]
CochangeEdgeBuilder = Callable[[pd.DataFrame, GraphConfig], tuple[pd.DataFrame, dict[str, object]]]
EdgeFuser = Callable[[pd.DataFrame, pd.DataFrame, pd.DataFrame, GraphConfig], pd.DataFrame]

__all__ = [
    "GraphArtifacts",
    "build_graph_artifacts",
    "build_codanna_semantic_edges",
    "build_dependency_edges",
    "build_graph",
    "build_semantic_edge_set",
    "build_semantic_edges",
    "fuse_edges",
    "graph_cluster_inputs",
    "graph_edge_count",
    "graph_report_inputs",
    "persist_graph_artifacts",
]


def _p95_scale(values: np.ndarray) -> float:
    if values.size == 0:
        return 0.0
    percentile = float(np.percentile(values, 95))
    return percentile or float(values.max()) or 0.0


@dataclass(frozen=True, slots=True)
class GraphArtifacts:
    """Stable return type for the graph-assembly stage."""

    sem_df: pd.DataFrame
    co_df: pd.DataFrame
    dep_df: pd.DataFrame
    fused_df: pd.DataFrame
    co_meta: dict[str, object]
    semantic_meta: dict[str, object] = field(default_factory=dict)

    @property
    def edge_count(self) -> int:
        return graph_edge_count(self)

    def persist(self, out: str | Path) -> None:
        persist_graph_artifacts(self, out)

    def cluster_inputs(self) -> pd.DataFrame:
        return graph_cluster_inputs(self)

    def report_inputs(self) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        return graph_report_inputs(self)

    def __iter__(self):
        yield self.sem_df
        yield self.co_df
        yield self.dep_df
        yield self.fused_df
        yield self.co_meta


def graph_edge_count(graph_result: GraphArtifacts) -> int:
    """Expose the fused edge count from the published graph result."""

    return int(len(graph_result.fused_df))


def graph_cluster_inputs(graph_result: GraphArtifacts) -> pd.DataFrame:
    """Expose the fused graph edges used by clustering."""

    return graph_result.fused_df


def graph_report_inputs(graph_result: GraphArtifacts) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Expose report-facing graph artifacts from the published result."""

    return graph_result.sem_df, graph_result.dep_df, graph_result.fused_df


def persist_graph_artifacts(graph_result: GraphArtifacts, out: str | Path) -> None:
    """Persist graph artifacts through the published result contract."""

    from archobs.storage import write_json, write_parquet

    write_parquet(graph_result.sem_df, out, "sem_edges")
    write_parquet(graph_result.co_df, out, "co_edges")
    write_parquet(graph_result.dep_df, out, "dep_edges")
    write_parquet(graph_result.fused_df, out, "graph_edges")
    write_json(graph_result.co_meta, out, "cochange_run")
    write_json(graph_result.semantic_meta, out, "semantic_run")


def _with_semantic_meta(df: pd.DataFrame, metadata: dict[str, object]) -> pd.DataFrame:
    df.attrs["archobs_semantic_meta"] = metadata
    return df


def _semantic_meta_from_frame(
    sem_df: pd.DataFrame,
    *,
    provider_used: str,
    provider_requested: str | None,
) -> dict[str, object]:
    metadata = sem_df.attrs.get("archobs_semantic_meta")
    if isinstance(metadata, dict):
        return dict(metadata)
    return {
        "semantic_provider_requested": provider_requested if provider_requested is not None else provider_used,
        "semantic_provider": provider_used,
        "semantic_fallback_reason": None,
    }


def build_semantic_edges(paths: list[str], embeddings: np.ndarray, config: GraphConfig) -> pd.DataFrame:
    if len(paths) < 2 or embeddings.size == 0:
        return pd.DataFrame(columns=["path_a", "path_b", "similarity", "w_sem"])
    top_k = min(config.k_sem, len(paths) - 1)
    if top_k <= 0:
        return pd.DataFrame(columns=["path_a", "path_b", "similarity", "w_sem"])

    neighbors: dict[int, list[tuple[int, float]]] = {}
    for start in range(0, len(paths), config.similarity_batch_size):
        stop = min(len(paths), start + config.similarity_batch_size)
        sims = embeddings[start:stop] @ embeddings.T
        for row_offset in range(stop - start):
            idx = start + row_offset
            sims[row_offset, idx] = -np.inf
            candidate_idx = np.argpartition(sims[row_offset], -top_k)[-top_k:]
            candidate_scores = sims[row_offset, candidate_idx]
            order = np.argsort(candidate_scores)[::-1]
            neighbors[idx] = [
                (int(candidate_idx[pos]), float(candidate_scores[pos]))
                for pos in order
                if np.isfinite(candidate_scores[pos])
            ]

    neighbor_sets = {idx: {other for other, _ in values} for idx, values in neighbors.items()}
    rows = []
    for idx, values in neighbors.items():
        for other, similarity in values:
            if idx >= other or idx not in neighbor_sets.get(other, set()):
                continue
            if similarity < config.tau_sem:
                continue
            rows.append(
                {
                    "path_a": paths[idx],
                    "path_b": paths[other],
                    "similarity": similarity,
                    "w_sem": (similarity - config.tau_sem) / (1.0 - config.tau_sem),
                }
            )

    if not rows:
        return pd.DataFrame(columns=["path_a", "path_b", "similarity", "w_sem"])
    return pd.DataFrame(rows).sort_values(["path_a", "path_b"]).reset_index(drop=True)


def _run_codanna(repo_path: str | Path, args: list[str], timeout_seconds: int | None) -> str:
    timeout = timeout_seconds if timeout_seconds and timeout_seconds > 0 else None
    try:
        proc = run(
            ["codanna", *args],
            cwd=repo_path,
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except TimeoutExpired as exc:
        timeout_label = f"{timeout_seconds}s" if timeout_seconds else "the configured timeout"
        command = "codanna " + " ".join(args)
        raise RuntimeError(f"{command} timed out after {timeout_label}") from exc
    return proc.stdout


def _ensure_codanna_index(repo_path: str | Path, files_df: pd.DataFrame, timeout_seconds: int | None) -> None:
    if not shutil.which("codanna"):
        raise RuntimeError("codanna CLI is not installed or not on PATH.")
    index_paths = sorted(
        {
            str(Path(rel_path).parent) if str(Path(rel_path).parent) not in {"", "."} else "."
            for rel_path in files_df["path"].tolist()
        }
    )
    if not index_paths:
        return
    _run_codanna(repo_path, ["index", *index_paths, "--no-progress"], timeout_seconds)


def _safe_load_json(payload: str) -> dict[str, object]:
    try:
        return json.loads(payload)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Failed to parse codanna JSON output: {exc}") from exc


def _extract_codanna_hits(payload: dict[str, object]) -> list[dict[str, object]]:
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    hits: list[dict[str, object]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        symbol = item.get("symbol")
        if not isinstance(symbol, dict):
            continue
        file_path = symbol.get("file_path")
        score = item.get("score")
        if isinstance(file_path, str) and isinstance(score, (int, float)):
            hits.append({"file_path": file_path, "score": float(score)})
    return hits


def _query_parts(row: pd.Series) -> list[str]:
    parts = [
        str(row.get("module_name", "")),
        Path(str(row.get("path", ""))).stem,
    ]
    for column in ["exported_symbols", "import_specifiers"]:
        raw = row.get(column, "[]")
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, list):
                    parts.extend(str(item) for item in parsed)
                else:
                    parts.append(str(parsed))
            except json.JSONDecodeError:
                parts.append(raw)
    for column in ["docstring", "comment_excerpt"]:
        value = str(row.get(column, "")).strip()
        if value:
            parts.append(value)
    return [part for part in parts if part]


def _codanna_query_text(row: pd.Series) -> str:
    query = " ".join(_query_parts(row)).replace("\n", " ")
    return " ".join(query.split())[:280]


def _codanna_search(
    repo_path: str | Path,
    query: str,
    limit: int,
    timeout_seconds: int | None,
) -> list[dict[str, object]]:
    if not query:
        return []

    def invoke(args: list[str]) -> tuple[list[dict[str, object]], RuntimeError | None]:
        try:
            payload = _safe_load_json(_run_codanna(repo_path, args, timeout_seconds))
        except RuntimeError as exc:
            return [], exc
        except CalledProcessError as exc:
            stdout = exc.stdout or ""
            if stdout.strip().startswith("{"):
                try:
                    hits = _extract_codanna_hits(_safe_load_json(stdout))
                    if hits:
                        return hits, None
                except RuntimeError:
                    pass
            stderr = exc.stderr or ""
            detail = (stderr or stdout or str(exc)).strip()
            command = "codanna " + " ".join(args)
            return [], RuntimeError(f"{command} failed with exit {exc.returncode}: {detail}")
        return _extract_codanna_hits(payload), None

    hits, semantic_error = invoke(["mcp", "semantic_search_with_context", f"query:{query}", f"limit:{limit}", "--json"])
    if hits:
        return hits
    fallback_hits, fallback_error = invoke(["mcp", "search_symbols", f"query:{query}", f"limit:{limit}", "--json"])
    if fallback_hits:
        return fallback_hits
    if semantic_error is not None and fallback_error is not None:
        raise RuntimeError(f"{semantic_error}; {fallback_error}")
    return []


def _load_codanna_cache(cache_path: str | Path | None) -> dict[str, dict[str, object]]:
    if cache_path is None:
        return {}
    target = Path(cache_path)
    if not target.exists():
        return {}
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    cached = payload.get("queries")
    return cached if isinstance(cached, dict) else {}


def _save_codanna_cache(cache_path: str | Path | None, cache: dict[str, dict[str, object]]) -> None:
    if cache_path is None:
        return
    from archobs.storage import write_json_path

    write_json_path({"queries": cache}, Path(cache_path))


def build_codanna_semantic_edges(
    repo_path: str | Path,
    files_df: pd.DataFrame,
    analysis_df: pd.DataFrame,
    config: GraphConfig,
    cache_path: str | Path | None = None,
) -> pd.DataFrame:
    if files_df.empty or analysis_df.empty:
        return pd.DataFrame(columns=["path_a", "path_b", "similarity", "w_sem"])

    _ensure_codanna_index(repo_path, files_df, config.codanna_index_timeout_seconds)
    tracked_paths = set(files_df["path"].tolist())
    top_k = min(config.k_sem, max(0, len(tracked_paths) - 1))
    if top_k <= 0:
        return pd.DataFrame(columns=["path_a", "path_b", "similarity", "w_sem"])

    search_limit = max(8, top_k * 4)
    query_by_path: dict[str, str] = {}
    fallback_by_path: dict[str, str] = {}
    for row in analysis_df.sort_values("path").itertuples(index=False):
        series = pd.Series(row._asdict())
        query_by_path[row.path] = _codanna_query_text(series)
        fallback_by_path[row.path] = " ".join(_query_parts(series)[:6])

    unique_queries = sorted({query for query in query_by_path.values() if query})
    cache = _load_codanna_cache(cache_path)
    query_hits: dict[str, list[dict[str, object]]] = {}
    pending: list[str] = []
    for query in unique_queries:
        cache_key = f"{search_limit}:{sha1(query.encode('utf-8')).hexdigest()}"
        cached = cache.get(cache_key)
        if isinstance(cached, dict) and cached.get("query") == query:
            hits = cached.get("hits")
            if isinstance(hits, list):
                query_hits[query] = hits
                continue
        pending.append(query)

    if pending:
        max_workers = max(1, min(config.semantic_workers, len(pending)))
        executor = ThreadPoolExecutor(max_workers=max_workers)
        future_map = {
            executor.submit(
                _codanna_search,
                repo_path,
                query,
                search_limit,
                config.codanna_search_timeout_seconds,
            ): query
            for query in pending
        }
        try:
            for future in as_completed(future_map):
                query = future_map[future]
                hits = future.result()
                query_hits[query] = hits
                cache_key = f"{search_limit}:{sha1(query.encode('utf-8')).hexdigest()}"
                cache[cache_key] = {"query": query, "hits": hits}
        except Exception:
            for future in future_map:
                future.cancel()
            executor.shutdown(wait=True, cancel_futures=True)
            raise
        else:
            executor.shutdown(wait=True)
        _save_codanna_cache(cache_path, cache)

    neighbors: dict[str, list[tuple[str, float]]] = {}
    fallback_cache: dict[str, list[dict[str, object]]] = {}
    for row in analysis_df.sort_values("path").itertuples(index=False):
        hits = query_hits.get(query_by_path[row.path], [])
        if not hits:
            fallback_query = fallback_by_path[row.path]
            if fallback_query:
                hits = fallback_cache.get(fallback_query)
                if hits is None:
                    hits = _codanna_search(
                        repo_path,
                        fallback_query,
                        search_limit,
                        config.codanna_search_timeout_seconds,
                    )
                    fallback_cache[fallback_query] = hits
        per_file: dict[str, float] = {}
        max_score = max((hit["score"] for hit in hits), default=0.0)
        for hit in hits:
            file_path = str(hit["file_path"])
            if file_path == row.path or file_path not in tracked_paths:
                continue
            similarity = (float(hit["score"]) / max_score) if max_score > 0 else 0.0
            per_file[file_path] = max(per_file.get(file_path, 0.0), similarity)
        neighbors[row.path] = sorted(per_file.items(), key=lambda item: (-item[1], item[0]))[:top_k]

    neighbor_sets = {source: {target for target, _ in values} for source, values in neighbors.items()}
    rows = []
    for source, values in neighbors.items():
        for target, similarity in values:
            if source >= target or source not in neighbor_sets.get(target, set()):
                continue
            if similarity < config.tau_sem:
                continue
            rows.append(
                {
                    "path_a": source,
                    "path_b": target,
                    "similarity": similarity,
                    "w_sem": (similarity - config.tau_sem) / (1.0 - config.tau_sem),
                }
            )

    if not rows:
        return pd.DataFrame(columns=["path_a", "path_b", "similarity", "w_sem"])
    return pd.DataFrame(rows).sort_values(["path_a", "path_b"]).reset_index(drop=True)


def build_semantic_edge_set(
    repo: str | Path,
    files_df: pd.DataFrame,
    analysis_df: pd.DataFrame,
    embeddings: np.ndarray | None,
    provider_used: str,
    graph_config: GraphConfig,
    cache_path: str | Path | None = None,
    *,
    provider_requested: str | None = None,
    fallback_dimensions: int = 256,
) -> pd.DataFrame:
    """Route to the right semantic-edge builder based on the resolved provider.

    The caller (facade or pipeline) is responsible for resolving the
    provider string via ``embedding.choose_provider`` so that this module
    stays free of cross-primitive imports.
    """
    requested_provider = provider_requested if provider_requested is not None else provider_used
    if provider_used == "codanna":
        try:
            sem_df = build_codanna_semantic_edges(
                repo, files_df, analysis_df, graph_config, cache_path=cache_path,
            )
            return _with_semantic_meta(
                sem_df,
                {
                    "semantic_provider_requested": requested_provider,
                    "semantic_provider": "codanna",
                    "semantic_fallback_reason": None,
                },
            )
        except Exception as exc:
            if requested_provider != "auto":
                raise
            warnings.warn(
                f"Codanna semantic graph failed; falling back to hashing edges: {exc}",
                stacklevel=2,
            )
            summary_text = analysis_df["summary_text"] if "summary_text" in analysis_df else [""] * len(analysis_df)
            texts_by_path = dict(zip(analysis_df["path"], summary_text, strict=False))
            fallback_embeddings = build_hashing_embeddings(
                [str(texts_by_path.get(path, "")) for path in files_df["path"].tolist()],
                fallback_dimensions,
            )
            return _with_semantic_meta(
                build_semantic_edges(files_df["path"].tolist(), fallback_embeddings, graph_config),
                {
                    "semantic_provider_requested": requested_provider,
                    "semantic_provider": "hashing",
                    "semantic_fallback_reason": str(exc),
                },
            )
    if embeddings is not None:
        return _with_semantic_meta(
            build_semantic_edges(files_df["path"].tolist(), embeddings, graph_config),
            {
                "semantic_provider_requested": requested_provider,
                "semantic_provider": provider_used,
                "semantic_fallback_reason": None,
            },
        )
    return _with_semantic_meta(
        pd.DataFrame(columns=["path_a", "path_b", "similarity", "w_sem"]),
        {
            "semantic_provider_requested": requested_provider,
            "semantic_provider": provider_used,
            "semantic_fallback_reason": None,
        },
    )


def build_dependency_edges(imports_df: pd.DataFrame, graph_config: GraphConfig) -> pd.DataFrame:
    if imports_df.empty:
        return pd.DataFrame(columns=["path_a", "path_b", "imports_ab", "imports_ba", "w_dep_raw", "w_dep"])

    resolved = imports_df[imports_df["resolved_path"].notna()].copy()
    if resolved.empty:
        return pd.DataFrame(columns=["path_a", "path_b", "imports_ab", "imports_ba", "w_dep_raw", "w_dep"])

    directed = (
        resolved.groupby(["source_path", "resolved_path"], as_index=False)
        .agg(count=("count", "sum"))
        .sort_values(["source_path", "resolved_path"])
    )
    pairs: dict[tuple[str, str], dict[str, float]] = {}
    for row in directed.itertuples(index=False):
        if row.source_path == row.resolved_path:
            continue
        path_a, path_b = sorted((row.source_path, row.resolved_path))
        pair = pairs.setdefault((path_a, path_b), {"imports_ab": 0.0, "imports_ba": 0.0})
        if row.source_path == path_a:
            pair["imports_ab"] += float(row.count)
        else:
            pair["imports_ba"] += float(row.count)

    rows = []
    for (path_a, path_b), counts in sorted(pairs.items()):
        raw = log(1.0 + counts["imports_ab"]) + log(1.0 + counts["imports_ba"])
        rows.append(
            {
                "path_a": path_a,
                "path_b": path_b,
                "imports_ab": counts["imports_ab"],
                "imports_ba": counts["imports_ba"],
                "w_dep_raw": raw,
            }
        )
    if not rows:
        return pd.DataFrame(columns=["path_a", "path_b", "imports_ab", "imports_ba", "w_dep_raw", "w_dep"])

    dep_df = pd.DataFrame(rows)
    p95 = _p95_scale(dep_df["w_dep_raw"].to_numpy(dtype=np.float64))
    dep_df["w_dep"] = dep_df["w_dep_raw"].apply(lambda value: min(1.0, value / p95) if p95 > 0 else 0.0)
    dep_df = dep_df[dep_df["w_dep"] >= graph_config.tau_dep].sort_values(["path_a", "path_b"]).reset_index(drop=True)
    return dep_df


def fuse_edges(sem_df: pd.DataFrame, co_df: pd.DataFrame, dep_df: pd.DataFrame, config: GraphConfig) -> pd.DataFrame:
    edge_map: dict[tuple[str, str], dict[str, float]] = defaultdict(lambda: {"w_sem": 0.0, "w_co": 0.0, "w_dep": 0.0})

    for frame, column in [(sem_df, "w_sem"), (co_df, "w_co"), (dep_df, "w_dep")]:
        if frame.empty:
            continue
        for row in frame.itertuples(index=False):
            edge_map[(row.path_a, row.path_b)][column] = float(getattr(row, column))

    rows = []
    for (path_a, path_b), values in sorted(edge_map.items()):
        weight = config.alpha * values["w_sem"] + config.beta * values["w_co"] + config.gamma * values["w_dep"]
        if weight <= 0:
            continue
        rows.append(
            {
                "path_a": path_a,
                "path_b": path_b,
                "w_sem": values["w_sem"],
                "w_co": values["w_co"],
                "w_dep": values["w_dep"],
                "weight": weight,
            }
        )
    if not rows:
        return pd.DataFrame(columns=["path_a", "path_b", "w_sem", "w_co", "w_dep", "weight"])
    return pd.DataFrame(rows).sort_values(["path_a", "path_b"]).reset_index(drop=True)


def build_graph_artifacts(
    repo: str | Path,
    files_df: pd.DataFrame,
    commit_files_df: pd.DataFrame,
    imports_df: pd.DataFrame,
    analysis_df: pd.DataFrame,
    embeddings: np.ndarray | None,
    provider_used: str,
    graph_config: GraphConfig,
    cache_path: str | Path | None = None,
    *,
    provider_requested: str | None = None,
    fallback_dimensions: int = 256,
    semantic_edge_builder: SemanticEdgeBuilder | None = None,
    dependency_edge_builder: DependencyEdgeBuilder | None = None,
    cochange_edge_builder: CochangeEdgeBuilder | None = None,
    edge_fuser: EdgeFuser | None = None,
) -> GraphArtifacts:
    """Assemble semantic, cochange, and dependency edges into one graph contract."""

    dep_builder = dependency_edge_builder if dependency_edge_builder is not None else build_dependency_edges
    co_builder = cochange_edge_builder if cochange_edge_builder is not None else build_cochange_edges
    fuse = edge_fuser if edge_fuser is not None else fuse_edges

    if semantic_edge_builder is None:
        sem_df = build_semantic_edge_set(
            repo,
            files_df,
            analysis_df,
            embeddings,
            provider_used,
            graph_config,
            cache_path,
            provider_requested=provider_requested,
            fallback_dimensions=fallback_dimensions,
        )
    else:
        sem_df = semantic_edge_builder(
            repo,
            files_df,
            analysis_df,
            embeddings,
            provider_used,
            graph_config,
            cache_path,
        )
    semantic_meta = _semantic_meta_from_frame(
        sem_df,
        provider_used=provider_used,
        provider_requested=provider_requested,
    )
    co_df, co_meta = co_builder(commit_files_df, graph_config)
    dep_df = dep_builder(imports_df, graph_config)
    fused_df = fuse(sem_df, co_df, dep_df, graph_config)
    return GraphArtifacts(
        sem_df=sem_df,
        co_df=co_df,
        dep_df=dep_df,
        fused_df=fused_df,
        co_meta=co_meta,
        semantic_meta=semantic_meta,
    )


def build_graph(files_df: pd.DataFrame, fused_df: pd.DataFrame) -> nx.Graph:
    graph = nx.Graph()
    for row in files_df.sort_values("path").itertuples(index=False):
        attrs = row._asdict()
        graph.add_node(row.path, **attrs)
    for row in fused_df.itertuples(index=False):
        graph.add_edge(
            row.path_a,
            row.path_b,
            weight=float(row.weight),
            w_sem=float(row.w_sem),
            w_co=float(row.w_co),
            w_dep=float(row.w_dep),
        )
    return graph
