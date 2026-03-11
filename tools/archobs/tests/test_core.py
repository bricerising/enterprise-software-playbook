from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd
from typer.testing import CliRunner

import archobs.embedding as embedding_module
import archobs.graph as graph_module
import archobs.suggestions as suggestions_module
from archobs.cli import app
from archobs.config import default_config, load_config, save_config
from archobs.deps import build_summary_text, extract_dependencies
from archobs.embedding import EmbeddingResult, EmbeddingRunMeta
from archobs.git_history import build_cochange_edges
from archobs.graph import GraphArtifacts, build_graph_artifacts, build_semantic_edges
from archobs.graph_viz import _build_attributed_graph, _focus_graph, build_report_graph_snapshot, write_graph_html
from archobs.inventory import build_inventory
from archobs.metrics import MetricsResult, MetricsSummary, adjusted_rand_index
from archobs.pipeline import ReportResult
from archobs.report import write_report_html
from archobs.storage import ArtifactStore
from archobs.clustering import cluster_files


runner = CliRunner()


def _run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True, env=env)


def _commit(repo: Path, message: str, when: str) -> None:
    env = {
        **os.environ,
        "GIT_AUTHOR_DATE": when,
        "GIT_COMMITTER_DATE": when,
    }
    _run(["git", "add", "."], cwd=repo, env=env)
    _run(["git", "commit", "-m", message], cwd=repo, env=env)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def build_sample_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "sample"
    repo.mkdir()
    _run(["git", "init"], cwd=repo)
    _run(["git", "config", "user.name", "Test User"], cwd=repo)
    _run(["git", "config", "user.email", "test@example.com"], cwd=repo)

    _write(
        repo / "payments" / "__init__.py",
        "from .service import settle_payment\n",
    )
    _write(
        repo / "payments" / "utils.py",
        "def format_amount(value: int) -> str:\n    return f'${value}'\n",
    )
    _write(
        repo / "payments" / "service.py",
        "from .utils import format_amount\n\n\ndef settle_payment(value: int) -> str:\n    return format_amount(value)\n",
    )
    _commit(repo, "add payments", "2025-01-15T12:00:00")

    _write(
        repo / "documents" / "__init__.py",
        "from .service import render_document\n",
    )
    _write(
        repo / "documents" / "utils.py",
        "def slugify(name: str) -> str:\n    return name.lower().replace(' ', '-')\n",
    )
    _write(
        repo / "documents" / "service.py",
        "from .utils import slugify\n\n\ndef render_document(name: str) -> str:\n    return slugify(name)\n",
    )
    _commit(repo, "add documents", "2025-02-15T12:00:00")

    _write(
        repo / "shared" / "logger.py",
        "def log_event(name: str) -> str:\n    return f'event:{name}'\n",
    )
    _write(
        repo / "payments" / "service.py",
        "from .utils import format_amount\nfrom shared.logger import log_event\n\n\ndef settle_payment(value: int) -> str:\n    return log_event(format_amount(value))\n",
    )
    _write(
        repo / "documents" / "service.py",
        "from .utils import slugify\nfrom shared.logger import log_event\n\n\ndef render_document(name: str) -> str:\n    return log_event(slugify(name))\n",
    )
    _commit(repo, "add shared logger", "2025-03-15T12:00:00")
    return repo


def test_config_roundtrip(tmp_path: Path) -> None:
    config = default_config(repo="/repo", out="/repo/.archobs")
    target = tmp_path / "config.json"
    save_config(config, target)
    loaded = load_config(target)
    assert loaded.repo == "/repo"
    assert loaded.out == "/repo/.archobs"
    assert loaded.embedding.provider == "auto"
    assert loaded.graph.k_sem == 20
    assert loaded.reporting.suggestions_provider == "rules"
    assert loaded.reporting.codex_timeout_seconds == 45
    assert loaded.reporting.claude_timeout_seconds == 45


def test_python_dependency_resolution(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _run(["git", "init"], cwd=repo)
    _run(["git", "config", "user.name", "Test User"], cwd=repo)
    _run(["git", "config", "user.email", "test@example.com"], cwd=repo)
    _write(repo / "pkg" / "__init__.py", "")
    _write(repo / "pkg" / "utils.py", "def helper():\n    return 1\n")
    _write(repo / "pkg" / "service.py", "from . import utils\nfrom .utils import helper\n")
    _commit(repo, "initial", "2025-01-01T12:00:00")

    files_df = build_inventory(repo, default_config().filters)
    imports_df, analysis_df, unresolved_df = extract_dependencies(repo, files_df, default_config().extraction)

    resolved_targets = set(imports_df["resolved_path"].dropna().tolist())
    assert "pkg/utils.py" in resolved_targets
    assert unresolved_df.empty
    summary_text = analysis_df.loc[analysis_df["path"] == "pkg/service.py", "summary_text"].iloc[0]
    assert "pkg/service.py" in summary_text


def test_semantic_edges_are_mutual_and_thresholded() -> None:
    paths = ["a.py", "b.py", "c.py"]
    embeddings = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.9, 0.1, 0.0],
            [0.0, 1.0, 0.0],
        ],
        dtype=np.float32,
    )
    embeddings = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)
    config = default_config().graph
    config.k_sem = 1
    config.tau_sem = 0.5
    sem_df = build_semantic_edges(paths, embeddings, config)
    assert sem_df[["path_a", "path_b"]].values.tolist() == [["a.py", "b.py"]]
    assert sem_df["w_sem"].iloc[0] > 0


def test_build_graph_artifacts_publishes_stable_contract(tmp_path: Path) -> None:
    sem_df = pd.DataFrame([{"path_a": "a.py", "path_b": "b.py", "similarity": 0.9, "w_sem": 0.8}])
    co_df = pd.DataFrame([{"path_a": "a.py", "path_b": "b.py", "w_co": 0.5}])
    dep_df = pd.DataFrame(
        [{"path_a": "a.py", "path_b": "b.py", "imports_ab": 1.0, "imports_ba": 0.0, "w_dep_raw": 0.69, "w_dep": 0.4}]
    )
    fused_df = pd.DataFrame([{"path_a": "a.py", "path_b": "b.py", "w_sem": 0.8, "w_co": 0.5, "w_dep": 0.4, "weight": 0.6}])
    calls: list[str] = []

    def fake_semantic(
        repo: str | Path,
        files_df: pd.DataFrame,
        analysis_df: pd.DataFrame,
        embeddings: np.ndarray | None,
        provider_used: str,
        graph_config,
        cache_path: str | Path | None,
    ) -> pd.DataFrame:
        calls.append("semantic")
        assert repo == "repo"
        assert provider_used == "hashing"
        assert cache_path == tmp_path / "cache.json"
        return sem_df

    def fake_cochange(commit_files_df: pd.DataFrame, graph_config) -> tuple[pd.DataFrame, dict[str, object]]:
        calls.append("cochange")
        return co_df, {"analysis_ts": 1_700_000_000.0}

    def fake_dependency(imports_df: pd.DataFrame, graph_config) -> pd.DataFrame:
        calls.append("dependency")
        return dep_df

    def fake_fuse(
        incoming_sem_df: pd.DataFrame,
        incoming_co_df: pd.DataFrame,
        incoming_dep_df: pd.DataFrame,
        graph_config,
    ) -> pd.DataFrame:
        calls.append("fuse")
        assert incoming_sem_df is sem_df
        assert incoming_co_df is co_df
        assert incoming_dep_df is dep_df
        return fused_df

    result = build_graph_artifacts(
        repo="repo",
        files_df=pd.DataFrame([{"path": "a.py"}, {"path": "b.py"}]),
        commit_files_df=pd.DataFrame([{"commit_sha": "abc", "commit_ts": 1, "status": "M", "path": "a.py"}]),
        imports_df=pd.DataFrame(columns=["source_path", "resolved_path", "count"]),
        analysis_df=pd.DataFrame([{"path": "a.py"}, {"path": "b.py"}]),
        embeddings=np.array([[1.0], [0.0]], dtype=np.float32),
        provider_used="hashing",
        graph_config=default_config().graph,
        cache_path=tmp_path / "cache.json",
        semantic_edge_builder=fake_semantic,
        dependency_edge_builder=fake_dependency,
        cochange_edge_builder=fake_cochange,
        edge_fuser=fake_fuse,
    )

    assert isinstance(result, GraphArtifacts)
    assert calls == ["semantic", "cochange", "dependency", "fuse"]
    assert result.edge_count == 1
    assert result.cluster_inputs().equals(fused_df)
    report_sem_df, report_dep_df, report_fused_df = result.report_inputs()
    assert report_sem_df.equals(sem_df)
    assert report_dep_df.equals(dep_df)
    assert report_fused_df.equals(fused_df)

    result.persist(tmp_path)
    assert (tmp_path / "sem_edges.parquet").exists()
    assert (tmp_path / "co_edges.parquet").exists()
    assert (tmp_path / "dep_edges.parquet").exists()
    assert (tmp_path / "graph_edges.parquet").exists()
    assert json.loads((tmp_path / "cochange_run.json").read_text(encoding="utf-8"))["analysis_ts"] == 1_700_000_000.0


def test_cochange_edges_use_latest_commit_as_reference() -> None:
    commit_files_df = pd.DataFrame(
        [
            {"commit_sha": "a", "commit_ts": 1_700_000_000, "status": "M", "path": "a.py"},
            {"commit_sha": "a", "commit_ts": 1_700_000_000, "status": "M", "path": "b.py"},
            {"commit_sha": "b", "commit_ts": 1_700_000_000 + 86400, "status": "M", "path": "a.py"},
            {"commit_sha": "b", "commit_ts": 1_700_000_000 + 86400, "status": "M", "path": "b.py"},
        ]
    )
    co_df, meta = build_cochange_edges(commit_files_df, default_config().graph)
    assert meta["analysis_ts"] == float(1_700_000_000 + 86400)
    assert len(co_df) == 1
    assert co_df["w_co"].iloc[0] > 0


def test_adjusted_rand_index_identity() -> None:
    assert adjusted_rand_index([0, 0, 1, 1], [0, 0, 1, 1]) == 1.0


def test_cluster_files_returns_contract_with_legacy_unpacking() -> None:
    graph = nx.Graph()
    graph.add_edge("a.py", "b.py", weight=1.0)

    config = default_config().clustering
    config.algorithm = "greedy-modularity"
    result = cluster_files(graph, config)

    assert result.cluster_count == 1
    assert result.algorithm_used == "greedy-modularity"
    assert not result.clusters_df.empty
    assert result.metadata["cluster_count"] == 1
    assert result.metadata["algorithm_used"] == "greedy-modularity"


def test_embedding_result_owns_contract_operations(tmp_path: Path) -> None:
    files_df = pd.DataFrame([{"path": "pkg/service.py", "language": "python"}])
    embedding_result = EmbeddingResult(
        vector_meta=pd.DataFrame(
            [
                {
                    "path": "pkg/service.py",
                    "embedding_vector_id": 0,
                    "embedding_provider": "hashing",
                    "embedding_model": "hashing",
                    "embedding_dim": 2,
                    "summary_sha1": "deadbeef",
                }
            ]
        ),
        embeddings=np.array([[1.0, 0.0]], dtype=np.float32),
        meta=EmbeddingRunMeta(
            provider_requested="auto",
            provider_used="hashing",
            model="hashing",
            dimensions=2,
        ),
    )

    assert embedding_result.graph_embeddings().shape == (1, 2)
    assert embedding_result.vector_count == 1
    enriched = embedding_result.enrich_files(files_df)
    assert enriched["embedding_provider"].tolist() == ["hashing"]

    embedding_result.persist(tmp_path)
    assert (tmp_path / "embedding_metadata.parquet").exists()
    assert (tmp_path / "embeddings.npy").exists()
    assert json.loads((tmp_path / "embedding_run.json").read_text(encoding="utf-8"))["provider_used"] == "hashing"


def test_artifact_store_consumes_embedding_and_report_contracts(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path)
    files_df = pd.DataFrame([{"path": "pkg/service.py", "language": "python"}])
    embedding_result = EmbeddingResult(
        vector_meta=pd.DataFrame(
            [
                {
                    "path": "pkg/service.py",
                    "embedding_vector_id": 0,
                    "embedding_provider": "hashing",
                    "embedding_model": "hashing",
                    "embedding_dim": 2,
                    "summary_sha1": "deadbeef",
                }
            ]
        ),
        embeddings=np.array([[1.0, 0.0]], dtype=np.float32),
        meta=EmbeddingRunMeta(
            provider_requested="auto",
            provider_used="hashing",
            model="hashing",
            dimensions=2,
        ),
    )

    enriched = store.save_embeddings(embedding_result, files_df)
    assert enriched["embedding_provider"].tolist() == ["hashing"]
    assert store.load_inventory()["embedding_provider"].tolist() == ["hashing"]

    report_result = ReportResult(
        summary={"report_index": "report/index.html"},
        file_metrics=pd.DataFrame([{"path": "pkg/service.py", "risk": 0.0}]),
        cluster_metrics=pd.DataFrame([{"cluster_id": 0, "leakage": 0.0}]),
        drift_df=pd.DataFrame(columns=["window_end_ts", "cluster_count", "modularity", "ari_prev", "algorithm_used"]),
    )
    store.save_report(report_result)

    assert (tmp_path / "embedding_metadata.parquet").exists()
    assert (tmp_path / "file_metrics.parquet").exists()
    assert (tmp_path / "cluster_metrics.parquet").exists()
    assert (tmp_path / "drift.parquet").exists()


def test_metrics_and_clustering_results_expose_report_contracts(tmp_path: Path) -> None:
    metrics_result = MetricsResult(
        file_metrics=pd.DataFrame([{"path": "a.py", "risk": 0.2}]),
        cluster_metrics=pd.DataFrame([{"cluster_id": 0, "leakage": 0.1}]),
        summary=MetricsSummary(node_count=2, edge_count=1, cluster_count=1, hub_deg=1.0),
    )

    file_metrics_df, cluster_metrics_df, summary = metrics_result.report_inputs()
    assert file_metrics_df["path"].tolist() == ["a.py"]
    assert cluster_metrics_df["cluster_id"].tolist() == [0]
    assert summary["cluster_count"] == 1

    graph = nx.Graph()
    graph.add_edge("a.py", "b.py", weight=1.0)
    config = default_config().clustering
    config.algorithm = "greedy-modularity"
    cluster_result = cluster_files(graph, config)

    clusters_df, metadata = cluster_result.report_inputs()
    assert not clusters_df.empty
    assert metadata["cluster_count"] == cluster_result.cluster_count

    cluster_result.persist(tmp_path)
    assert (tmp_path / "clusters.parquet").exists()
    assert json.loads((tmp_path / "cluster_run.json").read_text(encoding="utf-8"))["cluster_count"] == 1


def test_codanna_semantic_edges(monkeypatch) -> None:
    files_df = pd.DataFrame(
        [
            {"path": "a.py"},
            {"path": "b.py"},
            {"path": "c.py"},
        ]
    )
    analysis_rows = []
    for path, export in [("a.py", ["alpha"]), ("b.py", ["beta"]), ("c.py", ["gamma"])]:
        row = {
            "path": path,
            "module_name": path.replace(".py", ""),
            "language": "python",
            "exported_symbols": json.dumps(export),
            "docstring": "",
            "comment_excerpt": "",
            "preview_excerpt": "",
            "import_specifiers": json.dumps([]),
        }
        row["summary_text"] = build_summary_text(row)
        analysis_rows.append(row)
    analysis_df = pd.DataFrame(analysis_rows)

    monkeypatch.setattr(graph_module, "_ensure_codanna_index", lambda repo_path, files: None)

    def fake_search(repo_path: Path, query: str, limit: int) -> list[dict[str, object]]:
        if "alpha" in query:
            return [{"file_path": "b.py", "score": 10.0}]
        if "beta" in query:
            return [{"file_path": "a.py", "score": 9.0}]
        return [{"file_path": "a.py", "score": 2.0}]

    monkeypatch.setattr(graph_module, "_codanna_search", fake_search)

    config = default_config().graph
    config.k_sem = 1
    config.tau_sem = 0.5
    sem_df = graph_module.build_codanna_semantic_edges(Path("."), files_df, analysis_df, config)
    assert sem_df[["path_a", "path_b"]].values.tolist() == [["a.py", "b.py"]]
    assert sem_df["w_sem"].iloc[0] > 0


def test_codanna_semantic_edges_dedupes_and_caches(tmp_path: Path, monkeypatch) -> None:
    files_df = pd.DataFrame(
        [
            {"path": "a.py"},
            {"path": "b.py"},
        ]
    )
    analysis_df = pd.DataFrame(
        [
            {
                "path": "a.py",
                "module_name": "m.a",
                "language": "python",
                "exported_symbols": json.dumps(["shared"]),
                "docstring": "",
                "comment_excerpt": "",
                "preview_excerpt": "",
                "import_specifiers": json.dumps([]),
                "summary_text": "a",
            },
            {
                "path": "b.py",
                "module_name": "m.b",
                "language": "python",
                "exported_symbols": json.dumps(["shared"]),
                "docstring": "",
                "comment_excerpt": "",
                "preview_excerpt": "",
                "import_specifiers": json.dumps([]),
                "summary_text": "b",
            },
        ]
    )

    calls = {"count": 0}

    monkeypatch.setattr(graph_module, "_ensure_codanna_index", lambda repo_path, files: None)
    monkeypatch.setattr(graph_module, "_codanna_query_text", lambda row: "same query")

    def fake_search(repo_path: Path, query: str, limit: int) -> list[dict[str, object]]:
        calls["count"] += 1
        return [{"file_path": "a.py", "score": 10.0}, {"file_path": "b.py", "score": 9.0}]

    monkeypatch.setattr(graph_module, "_codanna_search", fake_search)

    config = default_config().graph
    config.k_sem = 1
    cache_path = tmp_path / "codanna_cache.json"
    graph_module.build_codanna_semantic_edges(Path("."), files_df, analysis_df, config, cache_path)
    assert calls["count"] == 1
    assert cache_path.exists()

    graph_module.build_codanna_semantic_edges(Path("."), files_df, analysis_df, config, cache_path)
    assert calls["count"] == 1


def test_graph_html_renders_self_contained_svg(tmp_path: Path) -> None:
    files_df = pd.DataFrame(
        [
            {"path": "a.py"},
            {"path": "b.py"},
        ]
    )
    fused_df = pd.DataFrame(
        [
            {"path_a": "a.py", "path_b": "b.py", "weight": 0.8, "w_sem": 0.8, "w_co": 0.0, "w_dep": 0.0},
        ]
    )
    clusters_df = pd.DataFrame([{"path": "a.py", "cluster_id": 0}, {"path": "b.py", "cluster_id": 0}])
    file_metrics_df = pd.DataFrame(
        [
            {"path": "a.py", "risk": 0.2, "xnbr": 0.0, "hubness": 0.1, "volatility": 0.0},
            {"path": "b.py", "risk": 0.3, "xnbr": 0.0, "hubness": 0.2, "volatility": 0.0},
        ]
    )
    cluster_metrics_df = pd.DataFrame([{"cluster_id": 0, "leakage": 0.0}])
    graph_snapshot = build_report_graph_snapshot(files_df, fused_df, clusters_df, file_metrics_df, cluster_metrics_df)

    target = write_graph_html(graph_snapshot, tmp_path)
    html_text = target.read_text(encoding="utf-8")
    assert target.exists()
    assert '<svg id="graph"' in html_text
    assert "Focused Graph View" in html_text
    assert "const payload =" in html_text
    assert "Find a file in the focused graph" in html_text
    assert 'id="cluster-select"' in html_text
    assert "Jump to cluster..." in html_text
    assert "Cluster Files" in html_text
    assert "visible files in the focused graph" in html_text
    assert "a.py" in html_text and "b.py" in html_text


def test_focus_graph_hides_isolates_and_limits_edges() -> None:
    files_df = pd.DataFrame([{"path": f"f{i}.py"} for i in range(8)])
    fused_rows = []
    dense_nodes = [f"f{i}.py" for i in range(5)]
    for i, left in enumerate(dense_nodes):
        for right in dense_nodes[i + 1 :]:
            fused_rows.append({"path_a": left, "path_b": right, "weight": 0.5, "w_sem": 0.5, "w_co": 0.0, "w_dep": 0.0})
    fused_df = pd.DataFrame(fused_rows)
    clusters_df = pd.DataFrame([{"path": row["path"], "cluster_id": 0} for row in files_df.to_dict(orient="records")])
    file_metrics_df = pd.DataFrame(
        [{"path": f"f{i}.py", "risk": 0.1 * i, "xnbr": 0.0, "hubness": 0.1 * i, "volatility": 0.0} for i in range(8)]
    )
    cluster_metrics_df = pd.DataFrame([{"cluster_id": 0, "leakage": 0.0}])
    graph_snapshot = build_report_graph_snapshot(files_df, fused_df, clusters_df, file_metrics_df, cluster_metrics_df)
    graph = _build_attributed_graph(graph_snapshot.nodes_df, graph_snapshot.edges_df)
    focused, meta = _focus_graph(graph, max_nodes=4, max_edges=3, per_node_edge_limit=2)

    assert meta["hidden_isolates"] == 3
    assert focused.number_of_nodes() <= 4
    assert focused.number_of_edges() <= 3
    assert all(node in dense_nodes for node in focused.nodes())


def test_report_html_includes_actionable_sections(tmp_path: Path) -> None:
    summary = {
        "node_count": 15,
        "edge_count": 40,
        "cluster_count": 1,
        "hub_deg": 1.2,
        "modularity": 0.02,
        "embedding_provider": "codanna",
        "top_risk_files": 50,
        "top_leaky_clusters": 20,
    }
    cluster_metrics_df = pd.DataFrame(
        [
            {
                "cluster_id": 0,
                "size": 15,
                "cohesion": 0.55,
                "leakage": 0.45,
                "conductance": 0.3,
                "risk_mean": 0.4,
                "risk_max": 0.7,
            }
        ]
    )
    file_metrics_df = pd.DataFrame(
        [
            {"path": "src/a.py", "cluster_id": 0, "risk": 0.7, "xnbr": 0.6, "hubness": 0.2, "volatility": 0.1},
            {"path": "src/b.py", "cluster_id": 0, "risk": 0.5, "xnbr": 0.1, "hubness": 0.5, "volatility": 0.1},
        ]
    )
    drift_df = pd.DataFrame()
    unresolved_df = pd.DataFrame(
        [{"source_path": "src/a.py", "raw_specifier": "pkg.missing", "import_type": "import", "resolved_path": None, "count": 1}]
    )

    target = write_report_html(
        summary,
        cluster_metrics_df,
        file_metrics_df,
        drift_df,
        unresolved_df,
        tmp_path,
        suggestion_engine="codex-error",
        suggestion_error="timed out waiting for codex",
    )
    html_text = target.read_text(encoding="utf-8")
    assert "What To Do Next" in html_text
    assert "Suggested Changes" in html_text
    assert "suggestions-grid" in html_text
    assert "suggestion-card" in html_text
    assert "suggestion-rail" in html_text
    assert "box-sizing: border-box" in html_text
    assert "overflow: hidden" in html_text
    assert "scope-badge" in html_text
    assert "suggestion-change" in html_text
    assert "suggestion-why" in html_text
    assert html_text.index("suggestion-change") < html_text.index("suggestion-why")
    assert "Codex unavailable" in html_text
    assert "timed out waiting for codex" in html_text
    assert "Review Queue" in html_text
    assert "Resolve 1 internal imports" in html_text
    assert "Recover subsystem boundaries" in html_text
    assert "Split mixed concerns in src/a.py" in html_text


def test_build_change_suggestions_returns_error_when_strict_codex_fails() -> None:
    summary = {"node_count": 12, "cluster_count": 1}
    cluster_metrics_df = pd.DataFrame(
        [{"cluster_id": 0, "size": 12, "cohesion": 0.5, "leakage": 0.5, "conductance": 0.2, "risk_mean": 0.4, "risk_max": 0.7}]
    )
    file_metrics_df = pd.DataFrame(
        [{"path": "src/a.py", "cluster_id": 0, "risk": 0.8, "xnbr": 0.6, "hubness": 0.2, "volatility": 0.1}]
    )
    unresolved_df = pd.DataFrame([{"source_path": "src/a.py", "raw_specifier": "pkg.missing", "count": 1}])

    original = suggestions_module._codex_change_suggestions
    try:
        suggestions_module._codex_change_suggestions = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("offline"))
        suggestions, engine, error = suggestions_module.build_change_suggestions(
            Path("."),
            summary,
            cluster_metrics_df,
            file_metrics_df,
            unresolved_df,
            pd.DataFrame(),
            provider="codex",
            limit=3,
            codex_timeout_seconds=1,
        )
    finally:
        suggestions_module._codex_change_suggestions = original

    assert engine == "codex-error"
    assert suggestions == []
    assert error == "offline"


def test_build_change_suggestions_returns_error_when_strict_claude_fails() -> None:
    summary = {"node_count": 12, "cluster_count": 1}
    cluster_metrics_df = pd.DataFrame(
        [{"cluster_id": 0, "size": 12, "cohesion": 0.5, "leakage": 0.5, "conductance": 0.2, "risk_mean": 0.4, "risk_max": 0.7}]
    )
    file_metrics_df = pd.DataFrame(
        [{"path": "src/a.py", "cluster_id": 0, "risk": 0.8, "xnbr": 0.6, "hubness": 0.2, "volatility": 0.1}]
    )
    unresolved_df = pd.DataFrame([{"source_path": "src/a.py", "raw_specifier": "pkg.missing", "count": 1}])

    original = suggestions_module._claude_change_suggestions
    try:
        suggestions_module._claude_change_suggestions = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("offline"))
        suggestions, engine, error = suggestions_module.build_change_suggestions(
            Path("."),
            summary,
            cluster_metrics_df,
            file_metrics_df,
            unresolved_df,
            pd.DataFrame(),
            provider="claude",
            limit=3,
            claude_timeout_seconds=1,
        )
    finally:
        suggestions_module._claude_change_suggestions = original

    assert engine == "claude-error"
    assert suggestions == []
    assert error == "offline"


def test_build_change_suggestions_auto_falls_back_when_codex_fails() -> None:
    summary = {"node_count": 12, "cluster_count": 1}
    cluster_metrics_df = pd.DataFrame(
        [{"cluster_id": 0, "size": 12, "cohesion": 0.5, "leakage": 0.5, "conductance": 0.2, "risk_mean": 0.4, "risk_max": 0.7}]
    )
    file_metrics_df = pd.DataFrame(
        [{"path": "src/a.py", "cluster_id": 0, "risk": 0.8, "xnbr": 0.6, "hubness": 0.2, "volatility": 0.1}]
    )
    unresolved_df = pd.DataFrame([{"source_path": "src/a.py", "raw_specifier": "pkg.missing", "count": 1}])

    original_codex = suggestions_module._codex_change_suggestions
    original_claude = suggestions_module._claude_change_suggestions
    try:
        suggestions_module._codex_change_suggestions = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("offline"))
        suggestions_module._claude_change_suggestions = lambda *args, **kwargs: [
            {
                "priority": "High",
                "title": "Separate studio configuration from POS operations",
                "why": "The strongest cluster boundary is leaking into the POS runtime area.",
                "change": "Create an explicit contract between configuration publishing and runtime consumers.",
                "scope": "src/services/studio/settings, src/services/pos/orders",
            }
        ]
        suggestions, engine, error = suggestions_module.build_change_suggestions(
            Path("."),
            summary,
            cluster_metrics_df,
            file_metrics_df,
            unresolved_df,
            pd.DataFrame(),
            provider="auto",
            limit=3,
            codex_timeout_seconds=1,
            claude_timeout_seconds=1,
        )
    finally:
        suggestions_module._codex_change_suggestions = original_codex
        suggestions_module._claude_change_suggestions = original_claude

    assert engine == "claude"
    assert error is None
    assert suggestions
    assert suggestions[0]["priority"] in {"High", "Medium", "Low"}


def test_build_change_suggestions_formats_timeout_error() -> None:
    summary = {"node_count": 12, "cluster_count": 1}
    cluster_metrics_df = pd.DataFrame(
        [{"cluster_id": 0, "size": 12, "cohesion": 0.5, "leakage": 0.5, "conductance": 0.2, "risk_mean": 0.4, "risk_max": 0.7}]
    )
    file_metrics_df = pd.DataFrame(
        [{"path": "src/a.py", "cluster_id": 0, "risk": 0.8, "xnbr": 0.6, "hubness": 0.2, "volatility": 0.1}]
    )

    original = suggestions_module._codex_change_suggestions
    try:
        suggestions_module._codex_change_suggestions = lambda *args, **kwargs: (_ for _ in ()).throw(
            subprocess.TimeoutExpired(cmd=["codex", "exec"], timeout=45)
        )
        suggestions, engine, error = suggestions_module.build_change_suggestions(
            Path("."),
            summary,
            cluster_metrics_df,
            file_metrics_df,
            pd.DataFrame(),
            pd.DataFrame(),
            provider="codex",
            limit=3,
            codex_timeout_seconds=45,
        )
    finally:
        suggestions_module._codex_change_suggestions = original

    assert suggestions == []
    assert engine == "codex-error"
    assert error == "timed out after 45s waiting for `codex exec`"


def test_build_change_suggestions_formats_claude_timeout_error() -> None:
    summary = {"node_count": 12, "cluster_count": 1}
    cluster_metrics_df = pd.DataFrame(
        [{"cluster_id": 0, "size": 12, "cohesion": 0.5, "leakage": 0.5, "conductance": 0.2, "risk_mean": 0.4, "risk_max": 0.7}]
    )
    file_metrics_df = pd.DataFrame(
        [{"path": "src/a.py", "cluster_id": 0, "risk": 0.8, "xnbr": 0.6, "hubness": 0.2, "volatility": 0.1}]
    )

    original = suggestions_module._claude_change_suggestions
    try:
        suggestions_module._claude_change_suggestions = lambda *args, **kwargs: (_ for _ in ()).throw(
            subprocess.TimeoutExpired(cmd=["claude", "-p"], timeout=30)
        )
        suggestions, engine, error = suggestions_module.build_change_suggestions(
            Path("."),
            summary,
            cluster_metrics_df,
            file_metrics_df,
            pd.DataFrame(),
            pd.DataFrame(),
            provider="claude",
            limit=3,
            claude_timeout_seconds=30,
        )
    finally:
        suggestions_module._claude_change_suggestions = original

    assert suggestions == []
    assert engine == "claude-error"
    assert error == "timed out after 30s waiting for `claude -p`"


def test_claude_change_suggestions_parses_structured_stdout(monkeypatch) -> None:
    monkeypatch.setattr(suggestions_module.shutil, "which", lambda name: "/usr/local/bin/claude" if name == "claude" else None)

    recorded: dict[str, object] = {}

    def fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        recorded["cmd"] = cmd
        return subprocess.CompletedProcess(
            args=cmd,
            returncode=0,
            stdout=json.dumps(
                {
                    "type": "result",
                    "is_error": False,
                    "structured_output": {
                        "suggestions": [
                            {
                                "priority": "High",
                                "title": "Separate studio configuration from runtime transactions",
                                "why": "The studio settings area leaks into the main POS runtime cluster.",
                                "change": "Create a published configuration boundary between studio-owned settings and runtime consumers.",
                                "scope": "src/services/studio/settings, src/services/pos/orders",
                            }
                        ]
                    },
                }
            ),
            stderr="",
        )

    monkeypatch.setattr(suggestions_module.subprocess, "run", fake_run)

    suggestions = suggestions_module._claude_change_suggestions(
        Path("."),
        {"node_count": 10, "cluster_count": 3},
        pd.DataFrame(columns=["cluster_id", "size", "cohesion", "leakage", "conductance", "risk_mean", "risk_max"]),
        pd.DataFrame(columns=["path", "cluster_id", "risk", "xnbr", "hubness", "volatility"]),
        pd.DataFrame(columns=["source_path", "raw_specifier", "count"]),
        pd.DataFrame(columns=["window_end_ts", "ari", "nmi", "cluster_count"]),
        [],
        limit=2,
        timeout_seconds=30,
    )

    assert suggestions[0]["title"] == "Separate studio configuration from runtime transactions"
    assert "--json-schema" in recorded["cmd"]
    assert "--output-format" in recorded["cmd"]
    assert "--permission-mode" in recorded["cmd"]


def test_claude_error_message_prefers_structured_stdout() -> None:
    message = suggestions_module._claude_error_message(
        json.dumps({"errors": ["EPERM writing ~/.claude", "secondary detail"]}),
        "warn: cpu lacks avx",
    )

    assert message.startswith("EPERM writing ~/.claude")


def test_build_change_suggestions_names_concrete_boundary_when_graph_context_exists() -> None:
    summary = {"node_count": 6, "cluster_count": 2}
    cluster_metrics_df = pd.DataFrame(
        [
            {"cluster_id": 0, "size": 3, "cohesion": 0.45, "leakage": 0.55, "conductance": 0.4, "risk_mean": 0.4, "risk_max": 0.8},
            {"cluster_id": 1, "size": 3, "cohesion": 0.7, "leakage": 0.3, "conductance": 0.2, "risk_mean": 0.2, "risk_max": 0.4},
        ]
    )
    file_metrics_df = pd.DataFrame(
        [
            {"path": "src/services/orders/orders.service.ts", "cluster_id": 0, "risk": 0.8, "xnbr": 0.6, "hubness": 0.4, "volatility": 0.2},
            {"path": "src/controllers/orders/orders.controller.ts", "cluster_id": 0, "risk": 0.6, "xnbr": 0.5, "hubness": 0.2, "volatility": 0.1},
            {"path": "src/routes/orders/index.ts", "cluster_id": 0, "risk": 0.4, "xnbr": 0.2, "hubness": 0.1, "volatility": 0.1},
            {"path": "src/lib/events/order-events.ts", "cluster_id": 1, "risk": 0.4, "xnbr": 0.2, "hubness": 0.2, "volatility": 0.1},
            {"path": "src/services/events/publisher.ts", "cluster_id": 1, "risk": 0.3, "xnbr": 0.1, "hubness": 0.2, "volatility": 0.1},
            {"path": "src/schemas/orders/index.ts", "cluster_id": 1, "risk": 0.2, "xnbr": 0.1, "hubness": 0.1, "volatility": 0.1},
        ]
    )
    fused_df = pd.DataFrame(
        [
            {"path_a": "src/services/orders/orders.service.ts", "path_b": "src/lib/events/order-events.ts", "weight": 0.9, "w_sem": 0.6, "w_co": 0.2, "w_dep": 0.1},
            {"path_a": "src/controllers/orders/orders.controller.ts", "path_b": "src/schemas/orders/index.ts", "weight": 0.7, "w_sem": 0.5, "w_co": 0.1, "w_dep": 0.1},
        ]
    )
    clusters_df = pd.DataFrame(
        [
            {"path": "src/services/orders/orders.service.ts", "cluster_id": 0},
            {"path": "src/controllers/orders/orders.controller.ts", "cluster_id": 0},
            {"path": "src/routes/orders/index.ts", "cluster_id": 0},
            {"path": "src/lib/events/order-events.ts", "cluster_id": 1},
            {"path": "src/services/events/publisher.ts", "cluster_id": 1},
            {"path": "src/schemas/orders/index.ts", "cluster_id": 1},
        ]
    )
    files_df = pd.DataFrame([{"path": path} for path in clusters_df["path"].tolist()])
    graph_snapshot = build_report_graph_snapshot(files_df, fused_df, clusters_df, file_metrics_df, cluster_metrics_df)

    suggestions, engine, error = suggestions_module.build_change_suggestions(
        Path("."),
        summary,
        cluster_metrics_df,
        file_metrics_df,
        pd.DataFrame(),
        pd.DataFrame(),
        graph_snapshot=graph_snapshot,
        provider="rules",
        limit=4,
    )

    assert engine == "rules"
    assert error is None
    assert suggestions
    assert any(item["title"].startswith("Separate ") for item in suggestions)
    assert all("logical clusters" not in item["title"] for item in suggestions)
    assert all("/" not in item["title"] for item in suggestions)
    assert all("`" not in item["why"] for item in suggestions)


def test_build_change_suggestions_uses_ari_prev_drift_column() -> None:
    suggestions, engine, error = suggestions_module.build_change_suggestions(
        Path("."),
        {"node_count": 4, "cluster_count": 2},
        pd.DataFrame(columns=["cluster_id", "size", "cohesion", "leakage", "conductance", "risk_mean", "risk_max"]),
        pd.DataFrame(columns=["path", "cluster_id", "risk", "xnbr", "hubness", "volatility"]),
        pd.DataFrame(columns=["source_path", "raw_specifier", "count"]),
        pd.DataFrame(
            [
                {"window_end_ts": 1_700_000_000, "cluster_count": 2, "modularity": 0.2, "ari_prev": 1.0, "algorithm_used": "greedy-modularity"},
                {"window_end_ts": 1_700_086_400, "cluster_count": 2, "modularity": 0.1, "ari_prev": 0.25, "algorithm_used": "greedy-modularity"},
            ]
        ),
        provider="rules",
        limit=4,
    )

    assert engine == "rules"
    assert error is None
    assert any(item["title"] == "Stabilize cluster naming and ownership before the next large move" for item in suggestions)


def test_missing_git_exits_with_error(monkeypatch) -> None:
    import shutil as _shutil
    monkeypatch.setattr(_shutil, "which", lambda name: None)
    result = runner.invoke(app, ["report"])
    assert result.exit_code == 1
    assert "git is not installed" in result.output


def test_missing_codanna_warns_but_continues(tmp_path: Path, monkeypatch) -> None:
    import shutil as _shutil
    original_which = _shutil.which
    monkeypatch.setattr(
        _shutil,
        "which",
        lambda name: None if name == "codanna" else original_which(name),
    )
    monkeypatch.setattr(embedding_module, "codanna_available", lambda: False)
    result = runner.invoke(app, ["init", "--repo", str(tmp_path), "--out", str(tmp_path / ".archobs")])
    assert result.exit_code == 0
    assert "codanna is not installed" in result.output


def test_cli_report_smoke(tmp_path: Path) -> None:
    repo = build_sample_repo(tmp_path)
    out = repo / ".archobs"
    result = runner.invoke(
        app,
        [
            "report",
            "--repo",
            str(repo),
            "--out",
            str(out),
            "--provider",
            "hashing",
            "--algo",
            "greedy-modularity",
            "--dimensions",
            "128",
            "--k-sem",
            "4",
        ],
    )
    assert result.exit_code == 0, result.stdout
    summary_path = out / "summary.json"
    assert summary_path.exists()
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    assert summary["cluster_count"] >= 1
    assert (out / "report" / "index.html").exists()
    assert (out / "report" / "graph.graphml").exists()
    file_metrics = pd.read_parquet(out / "file_metrics.parquet")
    assert not file_metrics.empty


def test_cli_report_on_empty_tracked_repo(tmp_path: Path) -> None:
    repo = tmp_path / "empty"
    repo.mkdir()
    _run(["git", "init"], cwd=repo)
    _run(["git", "config", "user.name", "Test User"], cwd=repo)
    _run(["git", "config", "user.email", "test@example.com"], cwd=repo)
    _write(repo / "README.md", "# empty\n")
    out = repo / ".archobs"
    result = runner.invoke(
        app,
        [
            "report",
            "--repo",
            str(repo),
            "--out",
            str(out),
            "--provider",
            "hashing",
            "--algo",
            "greedy-modularity",
        ],
    )
    assert result.exit_code == 0, result.stdout
    summary = json.loads((out / "summary.json").read_text(encoding="utf-8"))
    assert summary["node_count"] == 0
    assert summary["cluster_count"] == 0


def test_prompts_outputs_markdown(tmp_path: Path) -> None:
    suggestions_data = {
        "engine": "rules",
        "error": None,
        "items": [
            {
                "priority": "High",
                "title": "Separate payments from documents",
                "why": "The payments module is tightly coupled to documents.",
                "change": "Introduce an interface boundary between them.",
                "scope": "payments/service.py, documents/service.py",
            },
            {
                "priority": "Medium",
                "title": "Extract shared logger",
                "why": "The logger is used across all modules.",
                "change": "Move logger to a dedicated package.",
                "scope": "shared/logger.py",
            },
        ],
    }
    (tmp_path / "suggestions.json").write_text(json.dumps(suggestions_data), encoding="utf-8")
    result = runner.invoke(app, ["prompts", "--out", str(tmp_path)])
    assert result.exit_code == 0, result.output
    assert "## Suggestion 1/2: Separate payments from documents" in result.output
    assert "## Suggestion 2/2: Extract shared logger" in result.output
    assert "**Priority:** High" in result.output
    assert "**Scope:** payments/service.py, documents/service.py" in result.output
    assert "### Problem" in result.output
    assert "### Suggested Change" in result.output
    assert "Please analyze the files in the scope above" in result.output


def test_prompts_empty_suggestions(tmp_path: Path) -> None:
    suggestions_data = {
        "engine": "rules",
        "error": None,
        "items": [],
    }
    (tmp_path / "suggestions.json").write_text(json.dumps(suggestions_data), encoding="utf-8")
    result = runner.invoke(app, ["prompts", "--out", str(tmp_path)])
    assert result.exit_code == 0, result.output
    assert "No prompts to generate" in result.output
