"""Pipeline orchestration for archobs analysis.

Replaces the former multi-layer wiring (application_contracts, application,
engine, _execution, stages, analysis, core) with a single module that calls
leaf computation modules directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import shutil

import pandas as pd

from archobs.config import ArchobsConfig, default_config, load_config, save_config
from archobs.storage import ArtifactStore, read_json


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RunConfigOverrides:
    """CLI override contract for analysis configuration."""

    provider: str | None = None
    model: str | None = None
    dimensions: int | None = None
    k_sem: int | None = None
    tau_sem: float | None = None
    algo: str | None = None
    resolution: float | None = None
    suggestions_provider: str | None = None
    codex_timeout_seconds: int | None = None
    claude_timeout_seconds: int | None = None


@dataclass(frozen=True, slots=True)
class ReportResult:
    """Return type for the full report pipeline."""

    summary: dict[str, object]
    file_metrics: pd.DataFrame
    cluster_metrics: pd.DataFrame
    drift_df: pd.DataFrame


@dataclass(frozen=True, slots=True)
class GitHistoryResult:
    """Stable return type for git-history extraction."""

    commit_files_df: pd.DataFrame
    git_stats_df: pd.DataFrame

    def enrich_files(self, files_df: pd.DataFrame) -> pd.DataFrame:
        merged = files_df.merge(self.git_stats_df, on="path", how="left")
        for column in ["commit_count", "last_commit_ts"]:
            if column not in merged:
                merged[column] = 0
            merged[column] = merged[column].fillna(0).astype(int)
        return merged

    @property
    def commit_file_row_count(self) -> int:
        return int(len(self.commit_files_df))

    def persist(self, out: str | Path) -> None:
        from archobs.storage import write_parquet

        write_parquet(self.commit_files_df, out, "commits")
        write_parquet(self.git_stats_df, out, "git_stats")


# ---------------------------------------------------------------------------
# Config resolution
# ---------------------------------------------------------------------------


def resolve_config(
    repo: str | Path,
    out: str | Path,
    config_path: str | Path | None = None,
) -> tuple[ArchobsConfig, Path]:
    if config_path:
        path = Path(config_path)
        return load_config(path), path
    path = Path(out) / "config.json"
    if path.exists():
        return load_config(path), path
    return default_config(repo, out), path


def _apply_overrides(config: ArchobsConfig, overrides: RunConfigOverrides | None) -> ArchobsConfig:
    if overrides is None:
        return config
    if overrides.provider is not None:
        config.embedding.provider = overrides.provider
    if overrides.model is not None:
        config.embedding.model = overrides.model
    if overrides.dimensions is not None:
        config.embedding.dimensions = overrides.dimensions
    if overrides.k_sem is not None:
        config.graph.k_sem = overrides.k_sem
    if overrides.tau_sem is not None:
        config.graph.tau_sem = overrides.tau_sem
    if overrides.algo is not None:
        config.clustering.algorithm = overrides.algo
    if overrides.resolution is not None:
        config.clustering.resolution = overrides.resolution
    if overrides.suggestions_provider is not None:
        config.reporting.suggestions_provider = overrides.suggestions_provider
    if overrides.codex_timeout_seconds is not None:
        config.reporting.codex_timeout_seconds = overrides.codex_timeout_seconds
    if overrides.claude_timeout_seconds is not None:
        config.reporting.claude_timeout_seconds = overrides.claude_timeout_seconds
    return config


def prepare_config(
    repo: str | Path,
    out: str | Path,
    config_path: str | Path | None = None,
    overrides: RunConfigOverrides | None = None,
) -> tuple[ArchobsConfig, Path]:
    config, path = resolve_config(repo, out, config_path)
    save_config(_apply_overrides(config, overrides), path)
    return config, path


def initialize_workspace(
    repo: str | Path,
    out: str | Path,
    config_path: str | Path | None = None,
) -> tuple[ArchobsConfig, Path]:
    store = ArtifactStore(out)
    store.init_workspace()
    return prepare_config(repo, out, config_path)


# ---------------------------------------------------------------------------
# Dependency checking
# ---------------------------------------------------------------------------


def check_dependencies() -> list[str]:
    """Check for required external dependencies and return warning messages."""
    git_bin = shutil.which("git")
    if not git_bin:
        return ["Error: git is not installed or not on PATH"]
    from archobs.embedding import codanna_dependency_warning

    warning = codanna_dependency_warning()
    return [warning] if warning else []


# ---------------------------------------------------------------------------
# Pipeline run
# ---------------------------------------------------------------------------


@dataclass
class AnalysisRun:
    """Runs the analysis pipeline, persisting artifacts to store."""

    repo: str | Path | None
    store: ArtifactStore
    config: ArchobsConfig
    _inventory_df: pd.DataFrame | None = field(default=None, init=False, repr=False)
    _git_result: GitHistoryResult | None = field(default=None, init=False, repr=False)
    _deps_result: object | None = field(default=None, init=False, repr=False)
    _embedding_result: object | None = field(default=None, init=False, repr=False)
    _edge_result: object | None = field(default=None, init=False, repr=False)
    _cluster_result: object | None = field(default=None, init=False, repr=False)

    def _required_repo(self) -> str | Path:
        if self.repo is None:
            raise ValueError("repo is required for this analysis stage")
        return self.repo

    def inventory(self) -> pd.DataFrame:
        if self._inventory_df is None:
            from archobs.inventory import build_inventory

            files_df = build_inventory(self._required_repo(), self.config.filters)
            self.store.save_inventory(files_df)
            self._inventory_df = files_df
        return self._inventory_df

    def git(self, files_df: pd.DataFrame | None = None) -> GitHistoryResult:
        if self._git_result is None:
            from archobs.git_history import compute_git_file_stats, extract_git_history

            resolved_files_df = files_df if files_df is not None else self.inventory()
            commit_files_df = extract_git_history(
                self._required_repo(),
                set(resolved_files_df["path"].tolist()),
            )
            git_stats_df = compute_git_file_stats(commit_files_df)
            git_result = GitHistoryResult(
                commit_files_df=commit_files_df,
                git_stats_df=git_stats_df,
            )
            git_result.persist(self.store.base_path)
            self._git_result = git_result
        return self._git_result

    def deps(self, files_df: pd.DataFrame | None = None):
        if self._deps_result is None:
            from archobs.deps import extract_dependencies

            resolved_files_df = files_df if files_df is not None else self.inventory()
            deps_result = extract_dependencies(
                self._required_repo(),
                resolved_files_df,
                self.config.extraction,
            )
            deps_result.persist(self.store.base_path)
            self._deps_result = deps_result
        return self._deps_result

    def embed(self, files_df: pd.DataFrame | None = None, deps_result=None):
        if self._embedding_result is None:
            from archobs.embedding import embed_analysis

            resolved_files_df = files_df if files_df is not None else self.inventory()
            resolved_deps = deps_result if deps_result is not None else self.deps(resolved_files_df)
            analysis_df = resolved_deps.analysis_inputs()
            embedding_result = embed_analysis(analysis_df, self.config.embedding)
            self._inventory_df = self.store.save_embeddings(embedding_result, resolved_files_df)
            self._embedding_result = embedding_result
        return self._embedding_result

    def build_graph(
        self,
        files_df: pd.DataFrame | None = None,
        commit_files_df: pd.DataFrame | None = None,
        deps_result=None,
        embedding_result=None,
    ):
        if self._edge_result is None:
            from archobs.graph import build_graph_artifacts

            resolved_files_df = files_df if files_df is not None else self.inventory()
            resolved_git_result = self.git(resolved_files_df)
            resolved_deps = deps_result if deps_result is not None else self.deps(resolved_files_df)
            resolved_embedding = (
                embedding_result
                if embedding_result is not None
                else self.embed(resolved_files_df, deps_result=resolved_deps)
            )
            graph_files_df = self._inventory_df if self._inventory_df is not None else resolved_files_df
            imports_df, analysis_df = resolved_deps.graph_inputs()
            edge_result = build_graph_artifacts(
                self._required_repo(),
                graph_files_df,
                commit_files_df if commit_files_df is not None else resolved_git_result.commit_files_df,
                imports_df,
                analysis_df,
                resolved_embedding.graph_embeddings(),
                resolved_embedding.provider_used,
                self.config.graph,
                cache_path=self.store.cache_path,
            )
            edge_result.persist(self.store.base_path)
            self._edge_result = edge_result
        return self._edge_result

    def cluster(self, files_df: pd.DataFrame | None = None, edge_result=None):
        if self._cluster_result is None:
            from archobs.clustering import cluster_files
            from archobs.graph import build_graph

            resolved_files_df = files_df if files_df is not None else (
                self._inventory_df if self._inventory_df is not None else self.store.load_inventory()
            )
            resolved_edge_result = edge_result if edge_result is not None else self.build_graph()
            graph = build_graph(resolved_files_df, resolved_edge_result.cluster_inputs())
            cluster_result = cluster_files(graph, self.config.clustering)
            cluster_result.persist(self.store.base_path)
            self._cluster_result = cluster_result
        return self._cluster_result

    def report(self) -> ReportResult:
        """Run the full pipeline and produce a report."""
        from archobs.graph import build_graph
        from archobs.graph_viz import build_report_graph_snapshot
        from archobs.metrics import compute_metrics
        from archobs.report import build_report_artifacts
        from archobs.storage import write_parquet

        # Run all stages
        files_df = self.inventory()
        git_result = self.git(files_df)
        commit_files_df = git_result.commit_files_df
        files_df = git_result.enrich_files(files_df)
        self.store.save_inventory(files_df)
        self._inventory_df = files_df

        deps_result = self.deps(files_df)
        embedding_result = self.embed(files_df, deps_result=deps_result)
        files_df = self._inventory_df if self._inventory_df is not None else self.store.load_inventory()

        edge_result = self.build_graph(
            files_df=files_df,
            commit_files_df=commit_files_df,
            deps_result=deps_result,
            embedding_result=embedding_result,
        )
        cluster_result = self.cluster(files_df=files_df, edge_result=edge_result)

        # Compute metrics
        sem_df, dep_df, fused_df = edge_result.report_inputs()
        clusters_df, cluster_metadata = cluster_result.report_inputs()
        graph = build_graph(files_df, fused_df)
        metrics = compute_metrics(
            files_df,
            commit_files_df,
            sem_df,
            graph,
            clusters_df,
            seed=self.config.clustering.seed,
            drift_window_days=self.config.clustering.drift_window_days,
            drift_window_count=self.config.clustering.drift_window_count,
        )
        file_metrics_df, cluster_metrics_df, metrics_summary = metrics.report_inputs()

        # Compute drift
        drift_df = _compute_drift(
            files_df, commit_files_df, sem_df, dep_df, self.config,
        )

        # Build summary
        summary_base = {
            **metrics_summary,
            **(cluster_metadata or {}),
            "embedding_provider": embedding_result.provider_used,
            "top_risk_files": self.config.reporting.top_risk_files,
            "top_leaky_clusters": self.config.reporting.top_leaky_clusters,
        }

        # Build graph snapshot
        graph_snapshot = build_report_graph_snapshot(
            files_df, fused_df, clusters_df, file_metrics_df, cluster_metrics_df,
        )
        unresolved_df = deps_result.unresolved_imports()

        # Build a prepared analysis view for report rendering
        prepared = _PreparedAnalysisView(
            repo=self.repo,
            out=self.store.base_path,
            file_metrics_df=file_metrics_df,
            cluster_metrics_df=cluster_metrics_df,
            drift_df=drift_df,
            summary_base=summary_base,
            graph_snapshot=graph_snapshot,
            unresolved_df=unresolved_df,
        )

        # Render report
        options = self.config.reporting.render_options()
        summary = build_report_artifacts(
            prepared,
            suggestions_provider=options.suggestions_provider,
            suggestion_count=options.suggestion_count,
            codex_timeout_seconds=options.codex_timeout_seconds,
            claude_timeout_seconds=options.claude_timeout_seconds,
        )
        result = ReportResult(
            summary=summary,
            file_metrics=file_metrics_df,
            cluster_metrics=cluster_metrics_df,
            drift_df=drift_df,
        )

        # Persist report metrics
        write_parquet(file_metrics_df, self.store.base_path, "file_metrics")
        write_parquet(cluster_metrics_df, self.store.base_path, "cluster_metrics")
        write_parquet(drift_df, self.store.base_path, "drift")

        return result


# ---------------------------------------------------------------------------
# Internal prepared analysis view for report rendering
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _PreparedAnalysisView:
    """Lightweight view satisfying the PreparedReportView protocol."""

    repo: str | Path | None
    out: str | Path
    file_metrics_df: pd.DataFrame
    cluster_metrics_df: pd.DataFrame
    drift_df: pd.DataFrame
    summary_base: dict[str, object]
    graph_snapshot: object
    unresolved_df: pd.DataFrame

    @property
    def analysis(self):
        return self

    @property
    def metrics_summary(self) -> dict[str, object]:
        return {
            "node_count": int(self.summary_base.get("node_count", 0)),
            "edge_count": int(self.summary_base.get("edge_count", 0)),
            "cluster_count": int(self.summary_base.get("cluster_count", 0)),
            "hub_deg": float(self.summary_base.get("hub_deg", 0.0)),
        }

    @property
    def cluster_metadata(self) -> dict[str, object]:
        algorithm_used = str(self.summary_base.get("algorithm_used", "unknown"))
        return {
            "algorithm_requested": str(self.summary_base.get("algorithm_requested", algorithm_used)),
            "algorithm_used": algorithm_used,
            "cluster_count": int(self.summary_base.get("cluster_count", 0)),
            "modularity": float(self.summary_base.get("modularity", 0.0)),
        }


# ---------------------------------------------------------------------------
# Drift computation
# ---------------------------------------------------------------------------


def _drift_window_ends(
    *,
    analysis_ts: int,
    min_ts: int,
    drift_window_days: int,
    drift_window_count: int,
) -> list[int]:
    """Return snapshot boundaries for drift analysis.

    Prefer configured fixed-width windows. If those would yield fewer than two
    snapshots for a young or densely committed repository, fall back to evenly
    spaced boundaries across the available history span.
    """
    if drift_window_count < 2:
        return []

    width = drift_window_days * 86400
    if width <= 0:
        return []

    fixed = sorted(
        {
            boundary
            for offset in range(drift_window_count - 1, -1, -1)
            for boundary in [analysis_ts - (offset * width)]
            if boundary >= min_ts
        }
    )
    if len(fixed) >= 2 or analysis_ts <= min_ts:
        return fixed

    span = analysis_ts - min_ts
    if span <= 0:
        return fixed

    return sorted(
        {
            min_ts + ((span * index) // (drift_window_count - 1))
            for index in range(drift_window_count)
        }
    )


def _compute_drift(
    files_df: pd.DataFrame,
    commit_files_df: pd.DataFrame,
    sem_edges_df: pd.DataFrame,
    dep_edges_df: pd.DataFrame,
    config: ArchobsConfig,
) -> pd.DataFrame:
    """Compute temporal clustering drift over time-windowed graphs."""
    if commit_files_df.empty or config.clustering.drift_window_count < 2:
        return pd.DataFrame(columns=["window_end_ts", "cluster_count", "modularity", "ari_prev", "algorithm_used"])

    from archobs.clustering import cluster_files
    from archobs.git_history import build_cochange_edges
    from archobs.graph import build_graph, fuse_edges
    from archobs.metrics import adjusted_rand_index

    analysis_ts = int(commit_files_df["commit_ts"].max())
    min_ts = int(commit_files_df["commit_ts"].min())
    window_ends = _drift_window_ends(
        analysis_ts=analysis_ts,
        min_ts=min_ts,
        drift_window_days=config.clustering.drift_window_days,
        drift_window_count=config.clustering.drift_window_count,
    )
    if len(window_ends) < 2:
        return pd.DataFrame(columns=["window_end_ts", "cluster_count", "modularity", "ari_prev", "algorithm_used"])

    path_order = sorted(files_df["path"].tolist())
    previous_labels: list[int] | None = None
    rows = []

    for boundary in window_ends:
        subset = commit_files_df[commit_files_df["commit_ts"] <= boundary].copy()
        co_edges_df, _ = build_cochange_edges(subset, config.graph)
        fused_df = fuse_edges(sem_edges_df, co_edges_df, dep_edges_df, config.graph)
        graph = build_graph(files_df, fused_df)
        cluster_result = cluster_files(graph, config.clustering)
        clusters_df, _ = cluster_result.report_inputs()
        label_map = dict(zip(clusters_df["path"], clusters_df["cluster_id"], strict=True))
        labels = [int(label_map.get(path, -1)) for path in path_order]
        ari_prev = adjusted_rand_index(previous_labels, labels) if previous_labels is not None else 1.0
        previous_labels = labels
        rows.append(
            {
                "window_end_ts": boundary,
                "cluster_count": cluster_result.cluster_count,
                "modularity": cluster_result.modularity,
                "ari_prev": float(ari_prev),
                "algorithm_used": cluster_result.algorithm_used,
            }
        )

    return pd.DataFrame(rows).sort_values("window_end_ts").reset_index(drop=True)


# ---------------------------------------------------------------------------
# Convenience functions
# ---------------------------------------------------------------------------


def run_report(
    repo: str | Path,
    out: str | Path,
    config: ArchobsConfig,
) -> ReportResult:
    """Create a store, run the full pipeline, and return the report."""
    store = ArtifactStore(out)
    store.init_workspace()
    run = AnalysisRun(repo=repo, store=store, config=config)
    return run.report()


def load_suggestions(
    out: str | Path,
    *,
    limit: int = 0,
) -> tuple[list[str], str | None]:
    """Read suggestions.json and format as markdown blocks."""
    from archobs.suggestions import format_suggestion_markdown

    from archobs.storage import json_path

    path = json_path(out, "suggestions")
    if not path.exists():
        return [], "no suggestions.json found"

    data = read_json(out, "suggestions")
    items = data.get("items", [])
    engine = data.get("engine", "")
    error = data.get("error")

    if not items:
        reason = error if error and engine.endswith("-error") else "no suggestions found"
        return [], reason

    if limit > 0:
        items = items[:limit]
    total = len(items)
    blocks = [format_suggestion_markdown(item, index + 1, total) for index, item in enumerate(items)]
    return blocks, None
