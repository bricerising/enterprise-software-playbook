"""Tests for team_metrics: author stats, bus factor, knowledge concentration."""

from __future__ import annotations

import pandas as pd
import pytest

from archobs.team_metrics import (
    compute_author_stats,
    compute_bus_factor,
    compute_knowledge_concentration,
)


def _make_commits(rows: list[dict]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=["commit_sha", "commit_ts", "author", "message", "status", "path"])


def _make_file_metrics(rows: list[dict]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=["path", "cluster_id", "risk"])


class TestComputeAuthorStats:
    def test_basic(self) -> None:
        commits = _make_commits([
            {"commit_sha": "a1", "commit_ts": 100, "author": "Alice", "message": "feat", "status": "M", "path": "src/a.py"},
            {"commit_sha": "a2", "commit_ts": 200, "author": "Alice", "message": "fix", "status": "M", "path": "src/a.py"},
            {"commit_sha": "b1", "commit_ts": 300, "author": "Bob", "message": "feat", "status": "M", "path": "src/a.py"},
        ])
        file_metrics = _make_file_metrics([
            {"path": "src/a.py", "cluster_id": 0, "risk": 0.5},
        ])
        result = compute_author_stats(commits, file_metrics)
        assert len(result) == 2
        alice = result[result["author"] == "Alice"].iloc[0]
        assert alice["commit_count"] == 2
        assert alice["pct_of_cluster"] == pytest.approx(2 / 3, abs=0.01)

    def test_multiple_clusters(self) -> None:
        commits = _make_commits([
            {"commit_sha": "a1", "commit_ts": 100, "author": "Alice", "message": "feat", "status": "M", "path": "src/a.py"},
            {"commit_sha": "b1", "commit_ts": 200, "author": "Bob", "message": "feat", "status": "M", "path": "lib/b.py"},
        ])
        file_metrics = _make_file_metrics([
            {"path": "src/a.py", "cluster_id": 0, "risk": 0.5},
            {"path": "lib/b.py", "cluster_id": 1, "risk": 0.3},
        ])
        result = compute_author_stats(commits, file_metrics)
        assert len(result) == 2
        c0 = result[result["cluster_id"] == 0]
        c1 = result[result["cluster_id"] == 1]
        assert len(c0) == 1
        assert len(c1) == 1

    def test_empty_commits(self) -> None:
        commits = _make_commits([])
        file_metrics = _make_file_metrics([{"path": "src/a.py", "cluster_id": 0, "risk": 0.5}])
        result = compute_author_stats(commits, file_metrics)
        assert result.empty

    def test_no_author_column(self) -> None:
        commits = pd.DataFrame(
            [{"commit_sha": "a1", "commit_ts": 100, "message": "feat", "status": "M", "path": "src/a.py"}]
        )
        file_metrics = _make_file_metrics([{"path": "src/a.py", "cluster_id": 0, "risk": 0.5}])
        result = compute_author_stats(commits, file_metrics)
        assert result.empty


class TestComputeBusFactor:
    def test_single_author(self) -> None:
        stats = pd.DataFrame([
            {"cluster_id": 0, "author": "Alice", "commit_count": 10, "file_count": 5, "pct_of_cluster": 1.0},
        ])
        result = compute_bus_factor(stats)
        assert len(result) == 1
        assert result.iloc[0]["bus_factor"] == 1
        assert result.iloc[0]["top_author"] == "Alice"
        assert result.iloc[0]["top_author_pct"] == 1.0

    def test_multiple_authors(self) -> None:
        stats = pd.DataFrame([
            {"cluster_id": 0, "author": "Alice", "commit_count": 8, "file_count": 5, "pct_of_cluster": 0.4},
            {"cluster_id": 0, "author": "Bob", "commit_count": 6, "file_count": 4, "pct_of_cluster": 0.3},
            {"cluster_id": 0, "author": "Carol", "commit_count": 4, "file_count": 3, "pct_of_cluster": 0.2},
            {"cluster_id": 0, "author": "Dave", "commit_count": 2, "file_count": 1, "pct_of_cluster": 0.1},
        ])
        result = compute_bus_factor(stats, threshold=0.8)
        # Alice(0.4) + Bob(0.3) = 0.7 < 0.8, need Carol(0.2) too → 0.9 >= 0.8 → 3 authors
        assert result.iloc[0]["bus_factor"] == 3

    def test_empty(self) -> None:
        stats = pd.DataFrame(columns=["cluster_id", "author", "commit_count", "file_count", "pct_of_cluster"])
        result = compute_bus_factor(stats)
        assert result.empty

    def test_threshold_custom(self) -> None:
        stats = pd.DataFrame([
            {"cluster_id": 0, "author": "Alice", "commit_count": 5, "file_count": 3, "pct_of_cluster": 0.5},
            {"cluster_id": 0, "author": "Bob", "commit_count": 5, "file_count": 3, "pct_of_cluster": 0.5},
        ])
        result = compute_bus_factor(stats, threshold=0.5)
        assert result.iloc[0]["bus_factor"] == 1  # Alice alone covers 50%


class TestComputeKnowledgeConcentration:
    def test_monopoly(self) -> None:
        stats = pd.DataFrame([
            {"cluster_id": 0, "author": "Alice", "commit_count": 10, "file_count": 5, "pct_of_cluster": 1.0},
        ])
        result = compute_knowledge_concentration(stats)
        assert len(result) == 1
        assert result.iloc[0]["hhi"] == pytest.approx(1.0)
        assert result.iloc[0]["author_count"] == 1

    def test_dispersed(self) -> None:
        # 4 authors with equal share = HHI = 4 * (0.25)^2 = 0.25
        stats = pd.DataFrame([
            {"cluster_id": 0, "author": "Alice", "commit_count": 5, "file_count": 3, "pct_of_cluster": 0.25},
            {"cluster_id": 0, "author": "Bob", "commit_count": 5, "file_count": 3, "pct_of_cluster": 0.25},
            {"cluster_id": 0, "author": "Carol", "commit_count": 5, "file_count": 3, "pct_of_cluster": 0.25},
            {"cluster_id": 0, "author": "Dave", "commit_count": 5, "file_count": 3, "pct_of_cluster": 0.25},
        ])
        result = compute_knowledge_concentration(stats)
        assert result.iloc[0]["hhi"] == pytest.approx(0.25)
        assert result.iloc[0]["author_count"] == 4

    def test_empty(self) -> None:
        stats = pd.DataFrame(columns=["cluster_id", "author", "commit_count", "file_count", "pct_of_cluster"])
        result = compute_knowledge_concentration(stats)
        assert result.empty

    def test_multiple_clusters(self) -> None:
        stats = pd.DataFrame([
            {"cluster_id": 0, "author": "Alice", "commit_count": 10, "file_count": 5, "pct_of_cluster": 1.0},
            {"cluster_id": 1, "author": "Bob", "commit_count": 5, "file_count": 3, "pct_of_cluster": 0.5},
            {"cluster_id": 1, "author": "Carol", "commit_count": 5, "file_count": 3, "pct_of_cluster": 0.5},
        ])
        result = compute_knowledge_concentration(stats)
        assert len(result) == 2
        c0 = result[result["cluster_id"] == 0].iloc[0]
        c1 = result[result["cluster_id"] == 1].iloc[0]
        assert c0["hhi"] == pytest.approx(1.0)
        assert c1["hhi"] == pytest.approx(0.5)
