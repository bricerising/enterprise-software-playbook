"""Tests for the flattened pipeline module."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from archobs.config import default_config, load_config
from archobs.graph import GraphArtifacts
from archobs.graph_viz import build_report_graph_snapshot
from archobs.pipeline import (
    AnalysisRun,
    GitHistoryResult,
    ReportResult,
    RunConfigOverrides,
    _compute_drift,
    _persist_team_metric_artifacts,
    check_dependencies,
    load_suggestions,
    prepare_config,
    run_report,
)
from archobs.storage import ArtifactStore, write_json, write_parquet


def test_prepare_config_applies_overrides(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    out = tmp_path / ".archobs"

    config, config_path = prepare_config(
        repo,
        out,
        config_path=None,
        overrides=RunConfigOverrides(
            provider="hashing",
            model="hashing",
            dimensions=64,
            k_sem=8,
            tau_sem=0.25,
            algo="greedy-modularity",
            resolution=1.5,
            suggestions_provider="rules",
            codanna_index_timeout_seconds=111,
            codanna_search_timeout_seconds=22,
            codex_timeout_seconds=12,
            claude_timeout_seconds=34,
        ),
    )

    persisted = load_config(config_path)
    assert config_path == out / "config.json"
    assert config.embedding.provider == "hashing"
    assert config.embedding.dimensions == 64
    assert config.graph.k_sem == 8
    assert config.graph.tau_sem == 0.25
    assert config.clustering.algorithm == "greedy-modularity"
    assert config.clustering.resolution == 1.5
    assert config.graph.codanna_index_timeout_seconds == 111
    assert config.graph.codanna_search_timeout_seconds == 22
    assert config.reporting.suggestions_provider == "rules"
    assert config.reporting.codex_timeout_seconds == 12
    assert config.reporting.claude_timeout_seconds == 34
    assert persisted.embedding.provider == "hashing"
    assert persisted.graph.k_sem == 8
    assert persisted.graph.codanna_index_timeout_seconds == 111
    assert persisted.graph.codanna_search_timeout_seconds == 22
    assert persisted.reporting.claude_timeout_seconds == 34


def test_run_report_writes_completed_manifest(tmp_path: Path, monkeypatch) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    out = tmp_path / ".archobs"
    messages: list[str] = []

    def fake_report(self: AnalysisRun) -> ReportResult:
        self._start_stage("inventory")
        self._finish_stage("inventory")
        return ReportResult(
            summary={"report_index": "report/index.html"},
            file_metrics=pd.DataFrame([{"path": "a.py", "risk": 0.1}]),
            cluster_metrics=pd.DataFrame([{"cluster_id": 0, "leakage": 0.0}]),
            drift_df=pd.DataFrame(columns=["window_end_ts", "cluster_count", "modularity", "ari_prev", "algorithm_used"]),
        )

    monkeypatch.setattr(AnalysisRun, "report", fake_report)
    result = run_report(repo, out, default_config(), progress=messages.append)

    manifest = json.loads((out / "run_manifest.json").read_text(encoding="utf-8"))
    assert result.summary["report_index"] == "report/index.html"
    assert messages == ["inventory started", "inventory completed"]
    assert manifest["status"] == "complete"
    assert manifest["completed_stages"] == ["inventory"]
    assert manifest["repo"] == str(repo)
    assert len(manifest["run_id"]) == 32
    assert len(manifest["config_hash"]) == 64


def test_run_report_marks_manifest_failed(tmp_path: Path, monkeypatch) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    out = tmp_path / ".archobs"

    def fake_report(self: AnalysisRun) -> ReportResult:
        self._finish_stage("inventory")
        raise RuntimeError("boom")

    monkeypatch.setattr(AnalysisRun, "report", fake_report)
    try:
        run_report(repo, out, default_config())
        assert False, "Expected RuntimeError"
    except RuntimeError:
        pass

    manifest = json.loads((out / "run_manifest.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "failed"
    assert manifest["completed_stages"] == ["inventory"]
    assert "RuntimeError: boom" in manifest["error"]


def test_analysis_run_records_semantic_fallback_provenance(tmp_path: Path) -> None:
    class FakeEmbeddingMeta:
        provider_requested = "auto"

        def to_dict(self) -> dict[str, object]:
            return {"provider_requested": "auto", "provider_used": "codanna"}

    class FakeEmbedding:
        provider_used = "codanna"
        meta = FakeEmbeddingMeta()

    class FakeEdges:
        semantic_meta = {
            "semantic_provider_requested": "auto",
            "semantic_provider": "hashing",
            "semantic_fallback_reason": "codanna search timed out",
        }

    run = AnalysisRun(repo=None, store=ArtifactStore(tmp_path), config=default_config())
    enriched = run._record_semantic_provenance(
        pd.DataFrame([{"path": "a.py"}]),
        FakeEmbedding(),
        FakeEdges(),
    )

    manifest = json.loads((tmp_path / "embedding_run.json").read_text(encoding="utf-8"))
    files_df = pd.read_parquet(tmp_path / "files.parquet")
    assert enriched["semantic_provider"].tolist() == ["hashing"]
    assert files_df["semantic_fallback_reason"].tolist() == ["codanna search timed out"]
    assert manifest["provider_used"] == "codanna"
    assert manifest["semantic_provider"] == "hashing"
    assert manifest["semantic_fallback_reason"] == "codanna search timed out"


def test_check_dependencies_returns_warnings(monkeypatch) -> None:
    import shutil as _shutil

    original_which = _shutil.which
    monkeypatch.setattr(
        _shutil,
        "which",
        lambda name: None if name == "codanna" else original_which(name),
    )
    warnings = check_dependencies()
    assert any("codanna" in warning for warning in warnings)
    assert not any(warning.startswith("Error:") for warning in warnings)


def test_check_dependencies_error_when_git_missing(monkeypatch) -> None:
    import shutil as _shutil

    monkeypatch.setattr(_shutil, "which", lambda name: None)
    warnings = check_dependencies()
    assert any(warning.startswith("Error:") for warning in warnings)


def test_git_history_result_persists_and_enriches(tmp_path: Path) -> None:
    commit_files_df = pd.DataFrame(
        [{"commit_sha": "abc", "commit_ts": 1_700_000_000, "status": "M", "path": "a.py"}]
    )
    git_stats_df = pd.DataFrame(
        [{"path": "a.py", "commit_count": 1, "last_commit_ts": 1_700_000_000}]
    )
    result = GitHistoryResult(commit_files_df=commit_files_df, git_stats_df=git_stats_df)

    assert result.commit_file_row_count == 1

    result.persist(tmp_path)
    assert (tmp_path / "commits.parquet").exists()
    assert (tmp_path / "git_stats.parquet").exists()

    files_df = pd.DataFrame([{"path": "a.py", "language": "python"}])
    enriched = result.enrich_files(files_df)
    assert "commit_count" in enriched.columns


def test_report_result_dataclass() -> None:
    result = ReportResult(
        summary={"report_index": "report/index.html"},
        file_metrics=pd.DataFrame([{"path": "a.py", "risk": 0.5}]),
        cluster_metrics=pd.DataFrame([{"cluster_id": 0, "leakage": 0.1}]),
        drift_df=pd.DataFrame(columns=["window_end_ts"]),
    )
    assert result.summary["report_index"] == "report/index.html"
    assert not result.file_metrics.empty


def test_load_suggestions_reads_stored_json(tmp_path: Path) -> None:
    suggestions_data = {
        "engine": "rules",
        "error": None,
        "items": [
            {
                "priority": "High",
                "title": "Separate concerns",
                "why": "The boundary is leaking.",
                "change": "Create an interface.",
                "scope": "src/a.py, src/b.py",
            }
        ],
    }
    (tmp_path / "suggestions.json").write_text(json.dumps(suggestions_data), encoding="utf-8")
    blocks, error = load_suggestions(tmp_path, limit=0)
    assert blocks
    assert error is None
    assert "## Suggestion 1/1: Separate concerns" in blocks[0]


def test_load_suggestions_blocks_stale_manifest(tmp_path: Path) -> None:
    (tmp_path / "suggestions.json").write_text(
        json.dumps(
            {
                "engine": "rules",
                "error": None,
                "items": [
                    {
                        "priority": "High",
                        "title": "Old guidance",
                        "why": "Stale",
                        "change": "Do not emit",
                        "scope": "src/",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "run_manifest.json").write_text(
        json.dumps({"status": "stale", "stale_reason": "targeted command: cluster"}),
        encoding="utf-8",
    )

    blocks, error = load_suggestions(tmp_path, limit=0)

    assert blocks == []
    assert error is not None
    assert "targeted command: cluster" in error


def test_load_suggestions_returns_empty_when_missing(tmp_path: Path) -> None:
    blocks, error = load_suggestions(tmp_path, limit=0)
    assert blocks == []
    assert error is not None


def test_team_artifacts_overwrite_stale_outputs_with_empty_frames(tmp_path: Path) -> None:
    pd.DataFrame([{"cluster_id": 1, "author": "old", "commit_count": 3, "file_count": 1, "pct_of_cluster": 1.0}]).to_parquet(
        tmp_path / "author_stats.parquet",
        index=False,
    )
    pd.DataFrame([{"cluster_id": 1, "bus_factor": 1, "top_author": "old", "top_author_pct": 1.0}]).to_parquet(
        tmp_path / "bus_factor.parquet",
        index=False,
    )
    pd.DataFrame([{"cluster_id": 1, "hhi": 1.0, "author_count": 1}]).to_parquet(
        tmp_path / "concentration.parquet",
        index=False,
    )

    _persist_team_metric_artifacts(
        pd.DataFrame([{"commit_sha": "abc", "commit_ts": 1, "status": "M", "path": "a.py"}]),
        pd.DataFrame([{"path": "a.py", "cluster_id": 0}]),
        tmp_path,
    )

    assert pd.read_parquet(tmp_path / "author_stats.parquet").empty
    assert pd.read_parquet(tmp_path / "bus_factor.parquet").empty
    assert pd.read_parquet(tmp_path / "concentration.parquet").empty


def test_compute_drift_uses_available_history_when_fixed_windows_are_too_wide() -> None:
    files_df = pd.DataFrame([{"path": "a.py"}, {"path": "b.py"}])
    start_ts = 1_700_000_000
    commit_files_df = pd.DataFrame(
        [
            {"commit_sha": "c1", "commit_ts": start_ts, "status": "A", "path": "a.py"},
            {"commit_sha": "c1", "commit_ts": start_ts, "status": "A", "path": "b.py"},
            {"commit_sha": "c2", "commit_ts": start_ts + 3600, "status": "M", "path": "a.py"},
            {"commit_sha": "c3", "commit_ts": start_ts + 7200, "status": "M", "path": "b.py"},
            {"commit_sha": "c4", "commit_ts": start_ts + 10_800, "status": "M", "path": "a.py"},
            {"commit_sha": "c4", "commit_ts": start_ts + 10_800, "status": "M", "path": "b.py"},
        ]
    )

    config = default_config()
    config.clustering.algorithm = "greedy-modularity"
    config.clustering.drift_window_days = 30
    config.clustering.drift_window_count = 6

    drift_df = _compute_drift(
        files_df,
        commit_files_df,
        pd.DataFrame(columns=["path_a", "path_b", "similarity", "w_sem"]),
        pd.DataFrame(columns=["path_a", "path_b", "imports_ab", "imports_ba", "w_dep_raw", "w_dep"]),
        config,
    )

    assert len(drift_df) == 6
    assert drift_df["window_end_ts"].tolist() == [
        start_ts,
        start_ts + 2160,
        start_ts + 4320,
        start_ts + 6480,
        start_ts + 8640,
        start_ts + 10_800,
    ]
    assert drift_df["algorithm_used"].tolist() == ["greedy-modularity"] * 6
