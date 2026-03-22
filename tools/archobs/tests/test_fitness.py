"""Tests for archobs fitness check."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest
from typer.testing import CliRunner

from archobs.cli import app
from archobs.fitness import Thresholds, evaluate_fitness

runner = CliRunner()


def _make_file_metrics(tmp_path: Path, risks: list[float] | None = None) -> None:
    risks = risks or [0.3, 0.5, 0.7]
    df = pd.DataFrame({
        "path": [f"src/file{i}.py" for i in range(len(risks))],
        "cluster_id": [0] * len(risks),
        "risk": risks,
        "xnbr": [0.1] * len(risks),
        "hubness": [0.1] * len(risks),
        "volatility": [0.1] * len(risks),
    })
    df.to_parquet(tmp_path / "file_metrics.parquet", index=False)


def _make_cluster_metrics(
    tmp_path: Path,
    clusters: list[dict] | None = None,
) -> None:
    if clusters is None:
        clusters = [
            {"cluster_id": 0, "size": 5, "leakage": 0.2, "cohesion": 0.7, "risk_mean": 0.3, "label": "core"},
            {"cluster_id": 1, "size": 3, "leakage": 0.1, "cohesion": 0.8, "risk_mean": 0.2, "label": "utils"},
        ]
    df = pd.DataFrame(clusters)
    df.to_parquet(tmp_path / "cluster_metrics.parquet", index=False)


def _make_bus_factor(tmp_path: Path, factors: list[dict] | None = None) -> None:
    if factors is None:
        factors = [
            {"cluster_id": 0, "bus_factor": 3, "top_author": "Alice", "top_author_pct": 0.4},
            {"cluster_id": 1, "bus_factor": 2, "top_author": "Bob", "top_author_pct": 0.5},
        ]
    df = pd.DataFrame(factors)
    df.to_parquet(tmp_path / "bus_factor.parquet", index=False)


class TestEvaluateFitness:
    def test_all_passing(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path, [0.3, 0.5, 0.7])
        _make_cluster_metrics(tmp_path)
        _make_bus_factor(tmp_path)
        result = evaluate_fitness(tmp_path)
        assert result["pass"] is True
        assert result["total_violations"] == 0

    def test_file_risk_violations(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path, [0.3, 0.85, 0.95])
        _make_cluster_metrics(tmp_path)
        result = evaluate_fitness(tmp_path)
        assert result["pass"] is False
        assert result["by_category"]["file_risk"] == 2
        # Verify violation details
        risk_violations = [v for v in result["violations"] if v["category"] == "file_risk"]
        assert len(risk_violations) == 2
        assert all(v["value"] > 0.8 for v in risk_violations)

    def test_cluster_leakage_violations(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path)
        _make_cluster_metrics(tmp_path, [
            {"cluster_id": 0, "size": 5, "leakage": 0.75, "cohesion": 0.7, "risk_mean": 0.3, "label": "leaky"},
        ])
        result = evaluate_fitness(tmp_path)
        assert result["pass"] is False
        assert result["by_category"]["cluster_leakage"] == 1

    def test_cohesion_violations(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path)
        _make_cluster_metrics(tmp_path, [
            {"cluster_id": 0, "size": 5, "leakage": 0.1, "cohesion": 0.2, "risk_mean": 0.3, "label": "weak"},
        ])
        result = evaluate_fitness(tmp_path)
        assert result["pass"] is False
        assert result["by_category"]["cluster_cohesion"] == 1

    def test_risk_mean_violations(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path)
        _make_cluster_metrics(tmp_path, [
            {"cluster_id": 0, "size": 5, "leakage": 0.1, "cohesion": 0.7, "risk_mean": 0.7, "label": "risky"},
        ])
        result = evaluate_fitness(tmp_path)
        assert result["pass"] is False
        assert result["by_category"]["cluster_risk_mean"] == 1

    def test_bus_factor_violations(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path)
        _make_cluster_metrics(tmp_path)
        _make_bus_factor(tmp_path, [
            {"cluster_id": 0, "bus_factor": 1, "top_author": "Alice", "top_author_pct": 1.0},
        ])
        result = evaluate_fitness(tmp_path)
        assert result["pass"] is False
        assert result["by_category"]["bus_factor"] == 1

    def test_bus_factor_missing_graceful(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path)
        _make_cluster_metrics(tmp_path)
        # No bus_factor.parquet
        result = evaluate_fitness(tmp_path)
        assert result["pass"] is True
        assert "warnings" in result
        assert any("bus_factor" in w for w in result["warnings"])

    def test_min_cluster_size_filtering(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path)
        # Cluster 0 has size 1 (below default min_cluster_size=2), cluster 1 has size 5
        _make_cluster_metrics(tmp_path, [
            {"cluster_id": 0, "size": 1, "leakage": 0.9, "cohesion": 0.1, "risk_mean": 0.9, "label": "tiny"},
            {"cluster_id": 1, "size": 5, "leakage": 0.1, "cohesion": 0.8, "risk_mean": 0.2, "label": "good"},
        ])
        result = evaluate_fitness(tmp_path)
        # Cluster 0's violations should be filtered out
        assert result["pass"] is True

    def test_combined_violations(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path, [0.9, 0.95])
        _make_cluster_metrics(tmp_path, [
            {"cluster_id": 0, "size": 5, "leakage": 0.7, "cohesion": 0.3, "risk_mean": 0.6, "label": "bad"},
        ])
        _make_bus_factor(tmp_path, [
            {"cluster_id": 0, "bus_factor": 1, "top_author": "Alice", "top_author_pct": 1.0},
        ])
        result = evaluate_fitness(tmp_path)
        assert result["pass"] is False
        assert result["total_violations"] > 3  # file_risk + leakage + cohesion + risk_mean + bus_factor
        assert len(result["by_category"]) >= 3

    def test_custom_thresholds(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path, [0.6])
        _make_cluster_metrics(tmp_path)
        # Default threshold 0.8 would pass, but custom 0.5 should fail
        result = evaluate_fitness(
            tmp_path,
            Thresholds(max_file_risk=0.5),
        )
        assert result["pass"] is False
        assert result["by_category"]["file_risk"] == 1

    def test_missing_file_metrics(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            evaluate_fitness(tmp_path)


class TestCheckCli:
    def test_passing_exit_code(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path, [0.3, 0.5])
        _make_cluster_metrics(tmp_path)
        result = runner.invoke(app, ["check", "--out", str(tmp_path), "--format", "json"])
        assert result.exit_code == 0
        parsed = json.loads(result.stdout)
        assert parsed["pass"] is True

    def test_failing_exit_code(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path, [0.9, 0.95])
        _make_cluster_metrics(tmp_path)
        result = runner.invoke(app, ["check", "--out", str(tmp_path), "--format", "json"])
        assert result.exit_code == 1
        parsed = json.loads(result.stdout)
        assert parsed["pass"] is False

    def test_ci_flag_forces_json(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path, [0.3])
        _make_cluster_metrics(tmp_path)
        result = runner.invoke(app, ["check", "--out", str(tmp_path), "--ci"])
        assert result.exit_code == 0
        parsed = json.loads(result.stdout)
        assert parsed["pass"] is True

    def test_table_output(self, tmp_path: Path) -> None:
        _make_file_metrics(tmp_path, [0.3])
        _make_cluster_metrics(tmp_path)
        result = runner.invoke(app, ["check", "--out", str(tmp_path), "--format", "table"])
        assert result.exit_code == 0
        assert "PASS" in result.stdout
