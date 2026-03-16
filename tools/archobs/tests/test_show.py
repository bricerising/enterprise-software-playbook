"""Tests for ``archobs show`` subcommands and display formatting."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
from typer.testing import CliRunner

from archobs.cli import app
from archobs.display import (
    format_all,
    format_clusters,
    format_drift,
    format_edges,
    format_risks,
    format_schema,
    format_summary,
    format_velocity,
    read_cluster_metrics,
    read_drift,
    read_file_metrics,
    read_suggestions,
    read_summary,
    _generate_cluster_label,
    _truncate_path,
)

runner = CliRunner()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_file_metrics(tmp_path: Path) -> pd.DataFrame:
    df = pd.DataFrame(
        {
            "path": [
                "src/services/orders/orders.service.ts",
                "src/controllers/settings/settings.controller.ts",
                "src/services/payments/payments.service.ts",
                "src/utils/helpers.ts",
                "src/very/deep/nested/path/to/some/module.ts",
            ],
            "cluster_id": [0, 0, 0, 1, 2],
            "weighted_degree": [37.51, 12.10, 18.30, 3.20, 1.10],
            "degree": [241, 80, 120, 20, 5],
            "betweenness": [0.155, 0.040, 0.080, 0.010, 0.002],
            "xnbr": [1.000, 1.000, 0.778, 0.100, 0.050],
            "hubness": [0.815, 0.239, 0.421, 0.050, 0.020],
            "volatility": [1.000, 0.018, 0.248, 0.500, 0.100],
            "risk": [0.944, 0.575, 0.565, 0.200, 0.050],
        }
    )
    df.to_parquet(tmp_path / "file_metrics.parquet", index=False)
    return df


def _make_cluster_metrics(tmp_path: Path) -> pd.DataFrame:
    df = pd.DataFrame(
        {
            "cluster_id": [0, 1, 2, 3],
            "size": [32, 75, 3, 1],
            "cohesion": [0.420, 0.449, 0.800, 1.000],
            "leakage": [0.580, 0.551, 0.200, 0.000],
            "conductance": [0.408, 0.380, 0.100, 0.000],
            "internal_weight": [30.615, 65.698, 5.000, 1.000],
            "external_weight": [42.249, 80.566, 1.250, 0.000],
            "risk_mean": [0.132, 0.050, 0.300, 0.010],
            "risk_max": [0.506, 0.434, 0.400, 0.010],
            "paths": [
                "src/a.ts\nsrc/b.ts\nsrc/c.ts\nsrc/d.ts\nsrc/e.ts\nsrc/f.ts",
                "src/x.ts\nsrc/y.ts",
                "src/u.ts\nsrc/v.ts\nsrc/w.ts",
                "src/solo.ts",
            ],
        }
    )
    df.to_parquet(tmp_path / "cluster_metrics.parquet", index=False)
    return df


def _make_drift(tmp_path: Path) -> pd.DataFrame:
    df = pd.DataFrame(
        {
            "window_end_ts": [1733914790, 1736510390, 1739188790, 1741694390],
            "cluster_count": [615, 393, 189, 67],
            "modularity": [0.720, 0.693, 0.657, 0.661],
            "ari_prev": [1.000, 0.361, 0.626, 0.697],
            "algorithm_used": ["leiden", "leiden", "leiden", "leiden"],
        }
    )
    df.to_parquet(tmp_path / "drift.parquet", index=False)
    return df


def _make_summary(tmp_path: Path) -> dict:
    data = {
        "node_count": 1246,
        "edge_count": 14110,
        "cluster_count": 67,
        "modularity": 0.661,
        "hub_deg": 15.233,
        "embedding_provider": "codanna",
        "algorithm_used": "leiden",
        "suggestion_engine": "rules",
        "report_index": str(tmp_path / "report" / "index.html"),
    }
    report_dir = tmp_path / "report"
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "summary.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
    return data


def _make_suggestions(tmp_path: Path) -> dict:
    data = {
        "engine": "rules",
        "error": None,
        "items": [
            {"priority": "high", "title": "Extract facade for orders", "why": "High coupling", "change": "Add facade", "scope": ["src/services/orders/"]},
        ],
    }
    (tmp_path / "suggestions.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
    return data


def _make_all_artifacts(tmp_path: Path) -> None:
    _make_file_metrics(tmp_path)
    _make_cluster_metrics(tmp_path)
    _make_drift(tmp_path)
    _make_summary(tmp_path)
    _make_suggestions(tmp_path)


# ---------------------------------------------------------------------------
# Path truncation
# ---------------------------------------------------------------------------

def test_truncate_path_short():
    assert _truncate_path("src/a/b.ts") == "src/a/b.ts"


def test_truncate_path_long():
    result = _truncate_path("src/test/unit/services/shared/customer-facing-menu/modifier.fetcher.test.ts")
    assert result.startswith(".../")
    assert "modifier.fetcher.test.ts" in result


# ---------------------------------------------------------------------------
# Readers — missing artifacts
# ---------------------------------------------------------------------------

def test_read_file_metrics_missing(tmp_path: Path):
    try:
        read_file_metrics(tmp_path)
        assert False, "Expected SystemExit"
    except SystemExit as e:
        assert e.code == 1


def test_read_cluster_metrics_missing(tmp_path: Path):
    try:
        read_cluster_metrics(tmp_path)
        assert False, "Expected SystemExit"
    except SystemExit as e:
        assert e.code == 1


def test_read_drift_missing(tmp_path: Path):
    try:
        read_drift(tmp_path)
        assert False, "Expected SystemExit"
    except SystemExit as e:
        assert e.code == 1


def test_read_summary_missing(tmp_path: Path):
    (tmp_path / "report").mkdir(parents=True, exist_ok=True)
    try:
        read_summary(tmp_path)
        assert False, "Expected SystemExit"
    except SystemExit as e:
        assert e.code == 1


def test_read_suggestions_missing(tmp_path: Path):
    try:
        read_suggestions(tmp_path)
        assert False, "Expected SystemExit"
    except SystemExit as e:
        assert e.code == 1


# ---------------------------------------------------------------------------
# Readers — success
# ---------------------------------------------------------------------------

def test_read_file_metrics_ok(tmp_path: Path):
    _make_file_metrics(tmp_path)
    df = read_file_metrics(tmp_path)
    assert len(df) == 5
    assert "risk" in df.columns


def test_read_cluster_metrics_ok(tmp_path: Path):
    _make_cluster_metrics(tmp_path)
    df = read_cluster_metrics(tmp_path)
    assert len(df) == 4
    assert "leakage" in df.columns


def test_read_drift_ok(tmp_path: Path):
    _make_drift(tmp_path)
    df = read_drift(tmp_path)
    assert len(df) == 4


def test_read_summary_ok(tmp_path: Path):
    _make_summary(tmp_path)
    data = read_summary(tmp_path)
    assert data["node_count"] == 1246


def test_read_suggestions_ok(tmp_path: Path):
    _make_suggestions(tmp_path)
    data = read_suggestions(tmp_path)
    assert data["engine"] == "rules"


# ---------------------------------------------------------------------------
# format_risks
# ---------------------------------------------------------------------------

def test_format_risks_table(tmp_path: Path):
    df = _make_file_metrics(tmp_path)
    text = format_risks(df, top=3, fmt="table")
    lines = text.strip().split("\n")
    # Header + 3 data rows
    assert len(lines) == 4
    assert "orders.service.ts" in lines[1]


def test_format_risks_json(tmp_path: Path):
    df = _make_file_metrics(tmp_path)
    text = format_risks(df, top=2, fmt="json")
    records = json.loads(text)
    assert len(records) == 2
    assert records[0]["risk"] > records[1]["risk"]
    # JSON preserves full precision
    assert "path" in records[0]


def test_format_risks_csv(tmp_path: Path):
    df = _make_file_metrics(tmp_path)
    text = format_risks(df, top=2, fmt="csv")
    lines = text.strip().split("\n")
    # Header + 2 data rows
    assert len(lines) == 3
    assert "path" in lines[0]


def test_format_risks_min_risk_filter(tmp_path: Path):
    df = _make_file_metrics(tmp_path)
    text = format_risks(df, top=0, fmt="json", min_risk=0.5)
    records = json.loads(text)
    assert all(r["risk"] >= 0.5 for r in records)
    assert len(records) == 3


def test_format_risks_min_xnbr_filter(tmp_path: Path):
    df = _make_file_metrics(tmp_path)
    text = format_risks(df, top=0, fmt="json", min_xnbr=0.5)
    records = json.loads(text)
    assert all(r["xnbr"] >= 0.5 for r in records)


def test_format_risks_min_hubness_filter(tmp_path: Path):
    df = _make_file_metrics(tmp_path)
    text = format_risks(df, top=0, fmt="json", min_hubness=0.4)
    records = json.loads(text)
    assert all(r["hubness"] >= 0.4 for r in records)
    assert len(records) == 2


def test_format_risks_combined_filters(tmp_path: Path):
    df = _make_file_metrics(tmp_path)
    text = format_risks(df, top=0, fmt="json", min_risk=0.5, min_xnbr=0.9)
    records = json.loads(text)
    assert all(r["risk"] >= 0.5 and r["xnbr"] >= 0.9 for r in records)


# ---------------------------------------------------------------------------
# format_clusters
# ---------------------------------------------------------------------------

def test_format_clusters_table(tmp_path: Path):
    df = _make_cluster_metrics(tmp_path)
    text = format_clusters(df, fmt="table")
    # Should exclude cluster with size=1 by default
    assert "solo" not in text.lower()
    lines = text.strip().split("\n")
    assert len(lines) == 4  # header + 3 clusters (size >= 2)


def test_format_clusters_json_includes_top_paths(tmp_path: Path):
    df = _make_cluster_metrics(tmp_path)
    text = format_clusters(df, fmt="json")
    records = json.loads(text)
    for r in records:
        assert "top_paths" in r
        assert len(r["top_paths"]) <= 5


def test_format_clusters_csv(tmp_path: Path):
    df = _make_cluster_metrics(tmp_path)
    text = format_clusters(df, fmt="csv")
    lines = text.strip().split("\n")
    assert "cluster_id" in lines[0]
    # paths column excluded
    assert "paths" not in lines[0]


def test_format_clusters_sort_by_cohesion(tmp_path: Path):
    df = _make_cluster_metrics(tmp_path)
    text = format_clusters(df, sort_by="cohesion", fmt="json")
    records = json.loads(text)
    cohesions = [r["cohesion"] for r in records]
    assert cohesions == sorted(cohesions, reverse=True)


def test_format_clusters_min_size(tmp_path: Path):
    df = _make_cluster_metrics(tmp_path)
    text = format_clusters(df, fmt="json", min_size=10)
    records = json.loads(text)
    assert all(r["size"] >= 10 for r in records)


# ---------------------------------------------------------------------------
# format_drift
# ---------------------------------------------------------------------------

def test_format_drift_table(tmp_path: Path):
    df = _make_drift(tmp_path)
    text = format_drift(df, fmt="table")
    # Should have ISO timestamps
    assert "T" in text  # ISO format contains T
    assert "leiden" in text


def test_format_drift_json(tmp_path: Path):
    df = _make_drift(tmp_path)
    text = format_drift(df, fmt="json")
    parsed = json.loads(text)
    records = parsed["windows"]
    assert len(records) == 4
    assert "window_end" in records[0]
    assert "algorithm" in records[0]


def test_format_drift_json_truncated_windows(tmp_path: Path):
    df = _make_drift(tmp_path)
    text = format_drift(df, fmt="json", configured_windows=6)
    parsed = json.loads(text)
    assert parsed["configured_windows"] == 6
    assert parsed["actual_windows"] == 4
    assert "note" in parsed
    assert "4 of 6" in parsed["note"]


def test_format_drift_csv(tmp_path: Path):
    df = _make_drift(tmp_path)
    text = format_drift(df, fmt="csv")
    lines = text.strip().split("\n")
    assert "window_end" in lines[0]


# ---------------------------------------------------------------------------
# format_summary
# ---------------------------------------------------------------------------

def test_format_summary_table(tmp_path: Path):
    data = _make_summary(tmp_path)
    text = format_summary(data, fmt="table")
    assert "Files" in text
    assert "1,246" in text
    assert "0.661" in text


def test_format_summary_json(tmp_path: Path):
    data = _make_summary(tmp_path)
    text = format_summary(data, fmt="json")
    parsed = json.loads(text)
    assert parsed["node_count"] == 1246
    assert parsed["modularity"] == 0.661


def test_format_summary_csv(tmp_path: Path):
    data = _make_summary(tmp_path)
    text = format_summary(data, fmt="csv")
    assert "Metric,Value" in text
    assert "Files" in text


# ---------------------------------------------------------------------------
# format_all
# ---------------------------------------------------------------------------

def test_format_all_json(tmp_path: Path):
    _make_all_artifacts(tmp_path)
    text = format_all(tmp_path, top=3, fmt="json")
    parsed = json.loads(text)
    assert "summary" in parsed
    assert "risks" in parsed
    assert "clusters" in parsed
    assert "drift" in parsed
    assert "suggestions" in parsed
    assert len(parsed["risks"]) <= 3


def test_format_all_table(tmp_path: Path):
    _make_all_artifacts(tmp_path)
    text = format_all(tmp_path, top=2, fmt="table")
    assert "=== Summary ===" in text
    assert "=== Drift ===" in text


# ---------------------------------------------------------------------------
# format_schema
# ---------------------------------------------------------------------------

def test_format_schema(tmp_path: Path):
    _make_file_metrics(tmp_path)
    text = format_schema(tmp_path, "file_metrics")
    assert "file_metrics.parquet columns:" in text
    assert "path" in text
    assert "risk" in text


def test_format_schema_missing(tmp_path: Path):
    try:
        format_schema(tmp_path, "nonexistent")
        assert False, "Expected SystemExit"
    except SystemExit as e:
        assert e.code == 1


# ---------------------------------------------------------------------------
# CLI integration
# ---------------------------------------------------------------------------

def test_cli_show_risks(tmp_path: Path):
    _make_file_metrics(tmp_path)
    result = runner.invoke(app, ["show", "risks", "--out", str(tmp_path)])
    assert result.exit_code == 0
    assert "orders.service.ts" in result.stdout


def test_cli_show_risks_json(tmp_path: Path):
    _make_file_metrics(tmp_path)
    result = runner.invoke(app, ["show", "risks", "--out", str(tmp_path), "--format", "json", "--top", "2"])
    assert result.exit_code == 0
    records = json.loads(result.stdout)
    assert len(records) == 2


def test_cli_show_clusters(tmp_path: Path):
    _make_cluster_metrics(tmp_path)
    result = runner.invoke(app, ["show", "clusters", "--out", str(tmp_path)])
    assert result.exit_code == 0
    assert "leakage" in result.stdout


def test_cli_show_drift(tmp_path: Path):
    _make_drift(tmp_path)
    result = runner.invoke(app, ["show", "drift", "--out", str(tmp_path)])
    assert result.exit_code == 0
    assert "leiden" in result.stdout


def test_cli_show_summary(tmp_path: Path):
    _make_summary(tmp_path)
    result = runner.invoke(app, ["show", "summary", "--out", str(tmp_path)])
    assert result.exit_code == 0
    assert "Files" in result.stdout


def test_cli_show_all(tmp_path: Path):
    _make_all_artifacts(tmp_path)
    result = runner.invoke(app, ["show", "all", "--out", str(tmp_path)])
    assert result.exit_code == 0
    assert "=== Summary ===" in result.stdout


def test_cli_show_risks_missing(tmp_path: Path):
    result = runner.invoke(app, ["show", "risks", "--out", str(tmp_path)])
    assert result.exit_code != 0


def test_cli_schema(tmp_path: Path):
    _make_file_metrics(tmp_path)
    result = runner.invoke(app, ["schema", "file_metrics", "--out", str(tmp_path)])
    assert result.exit_code == 0
    assert "file_metrics.parquet columns:" in result.stdout


def test_cli_show_risks_with_out_file(tmp_path: Path):
    _make_file_metrics(tmp_path)
    out_file = tmp_path / "output.txt"
    result = runner.invoke(app, ["show", "risks", "--out", str(tmp_path), "--out-file", str(out_file)])
    assert result.exit_code == 0
    assert out_file.exists()
    content = out_file.read_text(encoding="utf-8")
    assert "orders.service.ts" in content


# ---------------------------------------------------------------------------
# Velocity fixtures
# ---------------------------------------------------------------------------

def _make_commits(tmp_path: Path) -> pd.DataFrame:
    now = 1741694390
    df = pd.DataFrame(
        {
            "commit_sha": ["a1", "a2", "a3", "b1", "b2", "c1"],
            "commit_ts": [
                now - 10 * 86400,  # within 30d window
                now - 15 * 86400,
                now - 20 * 86400,
                now - 5 * 86400,
                now - 25 * 86400,
                now - 50 * 86400,  # outside 30d window
            ],
            "status": ["A", "M", "M", "A", "D", "M"],
            "path": [
                "src/services/orders/orders.service.ts",
                "src/services/orders/orders.service.ts",
                "src/controllers/settings/settings.controller.ts",
                "src/services/payments/payments.service.ts",
                "src/utils/helpers.ts",
                "src/services/orders/orders.service.ts",
            ],
        }
    )
    df.to_parquet(tmp_path / "commits.parquet", index=False)
    return df


def _make_graph_edges(tmp_path: Path) -> pd.DataFrame:
    df = pd.DataFrame(
        {
            "path_a": [
                "src/services/orders/orders.service.ts",
                "src/services/orders/orders.service.ts",
                "src/utils/helpers.ts",
            ],
            "path_b": [
                "src/utils/helpers.ts",
                "src/services/payments/payments.service.ts",
                "src/controllers/settings/settings.controller.ts",
            ],
            "weight": [0.8, 0.6, 0.3],
            "w_sem": [0.5, 0.4, 0.2],
            "w_co": [0.2, 0.1, 0.05],
            "w_dep": [0.1, 0.1, 0.05],
            "cluster_a": [0, 0, 1],
            "cluster_b": [1, 0, 0],
        }
    )
    df.to_parquet(tmp_path / "graph_edges.parquet", index=False)
    return df


# ---------------------------------------------------------------------------
# format_velocity
# ---------------------------------------------------------------------------

def test_format_velocity_table(tmp_path: Path):
    commits = _make_commits(tmp_path)
    fm = _make_file_metrics(tmp_path)
    cm = _make_cluster_metrics(tmp_path)
    text = format_velocity(commits, fm, cm, window=30, fmt="table")
    assert "cluster_id" in text
    assert "distinct_commits" in text


def test_format_velocity_json(tmp_path: Path):
    commits = _make_commits(tmp_path)
    fm = _make_file_metrics(tmp_path)
    cm = _make_cluster_metrics(tmp_path)
    text = format_velocity(commits, fm, cm, window=30, fmt="json")
    records = json.loads(text)
    assert len(records) > 0
    assert "distinct_commits" in records[0]
    assert "growth_ratio" in records[0]
    assert "churn_ratio" in records[0]
    # Should be sorted by distinct_commits desc
    counts = [r["distinct_commits"] for r in records]
    assert counts == sorted(counts, reverse=True)


def test_format_velocity_csv(tmp_path: Path):
    commits = _make_commits(tmp_path)
    fm = _make_file_metrics(tmp_path)
    cm = _make_cluster_metrics(tmp_path)
    text = format_velocity(commits, fm, cm, window=30, fmt="csv")
    lines = text.strip().split("\n")
    assert "distinct_commits" in lines[0]
    assert "growth_ratio" in lines[0]


def test_format_velocity_window_filtering(tmp_path: Path):
    commits = _make_commits(tmp_path)
    fm = _make_file_metrics(tmp_path)
    cm = _make_cluster_metrics(tmp_path)
    # 30-day window should exclude the commit at 50 days ago
    text_30 = format_velocity(commits, fm, cm, window=30, fmt="json")
    records_30 = json.loads(text_30)
    total_30 = sum(r["file_change_count"] for r in records_30)
    # All 6 file-change rows minus the one outside the window
    assert total_30 == 5


def test_format_velocity_compare(tmp_path: Path):
    commits = _make_commits(tmp_path)
    fm = _make_file_metrics(tmp_path)
    cm = _make_cluster_metrics(tmp_path)
    text = format_velocity(commits, fm, cm, window=30, compare=True, fmt="json")
    records = json.loads(text)
    assert len(records) > 0
    assert "acceleration" in records[0]


def test_format_velocity_empty(tmp_path: Path):
    empty = pd.DataFrame(columns=["commit_sha", "commit_ts", "status", "path"])
    fm = _make_file_metrics(tmp_path)
    cm = _make_cluster_metrics(tmp_path)
    text = format_velocity(empty, fm, cm, window=30, fmt="table")
    assert "No commit data" in text


# ---------------------------------------------------------------------------
# format_edges
# ---------------------------------------------------------------------------

def test_format_edges_table(tmp_path: Path):
    edges = _make_graph_edges(tmp_path)
    fm = _make_file_metrics(tmp_path)
    cm = _make_cluster_metrics(tmp_path)
    text = format_edges(edges, cm, fm, cluster_id=0, fmt="table")
    assert "neighbor_cluster" in text
    assert "total_weight" in text


def test_format_edges_json(tmp_path: Path):
    edges = _make_graph_edges(tmp_path)
    fm = _make_file_metrics(tmp_path)
    cm = _make_cluster_metrics(tmp_path)
    text = format_edges(edges, cm, fm, cluster_id=0, fmt="json")
    records = json.loads(text)
    assert len(records) >= 1
    assert "neighbor_cluster" in records[0]
    assert "total_weight" in records[0]
    assert "top_pairs" in records[0]


def test_format_edges_missing_cluster(tmp_path: Path):
    edges = _make_graph_edges(tmp_path)
    fm = _make_file_metrics(tmp_path)
    cm = _make_cluster_metrics(tmp_path)
    text = format_edges(edges, cm, fm, cluster_id=999, fmt="table")
    assert "No edges" in text


def test_format_edges_empty(tmp_path: Path):
    empty = pd.DataFrame(columns=["path_a", "path_b", "weight", "w_sem", "w_co", "w_dep", "cluster_a", "cluster_b"])
    fm = _make_file_metrics(tmp_path)
    cm = _make_cluster_metrics(tmp_path)
    text = format_edges(empty, cm, fm, cluster_id=0, fmt="table")
    assert "No graph edges" in text


# ---------------------------------------------------------------------------
# _generate_cluster_label with domain keywords
# ---------------------------------------------------------------------------

def test_cluster_label_domain_keyword():
    paths = [
        "src/services/orders/orders.service.ts",
        "src/services/orders/orders.controller.ts",
        "src/services/orders/orders.schema.ts",
        "src/services/orders/orders.routes.ts",
        "src/services/payments/payments.service.ts",
    ]
    label = _generate_cluster_label(paths)
    # "orders" appears in 4/5 (80%) of files, above the 40% threshold
    assert "orders" in label.lower()


def test_cluster_label_no_dominant_keyword():
    paths = [
        "src/services/alpha/service.ts",
        "src/services/beta/service.ts",
        "src/services/gamma/service.ts",
    ]
    label = _generate_cluster_label(paths)
    # No single stem dominates — should fall back to structural prefix
    assert "services" in label.lower() or "/" in label


def test_cluster_label_empty():
    assert _generate_cluster_label([]) == ""


# ---------------------------------------------------------------------------
# show all — split --top
# ---------------------------------------------------------------------------

def test_format_all_top_risks_split(tmp_path: Path):
    _make_all_artifacts(tmp_path)
    text = format_all(tmp_path, top_risks=2, top_clusters=1, fmt="json")
    parsed = json.loads(text)
    assert len(parsed["risks"]) <= 2
    assert len(parsed["clusters"]) <= 1


def test_format_all_defaults_to_all(tmp_path: Path):
    _make_all_artifacts(tmp_path)
    text = format_all(tmp_path, fmt="json")
    parsed = json.loads(text)
    # Default top=0 means all records
    assert len(parsed["risks"]) == 5  # all 5 files


# ---------------------------------------------------------------------------
# CLI: velocity and edges
# ---------------------------------------------------------------------------

def test_cli_show_velocity(tmp_path: Path):
    _make_commits(tmp_path)
    _make_file_metrics(tmp_path)
    _make_cluster_metrics(tmp_path)
    result = runner.invoke(app, ["show", "velocity", "--out", str(tmp_path), "--format", "json"])
    assert result.exit_code == 0
    records = json.loads(result.stdout)
    assert len(records) > 0


def test_cli_show_velocity_compare(tmp_path: Path):
    _make_commits(tmp_path)
    _make_file_metrics(tmp_path)
    _make_cluster_metrics(tmp_path)
    result = runner.invoke(app, ["show", "velocity", "--out", str(tmp_path), "--compare", "--format", "json"])
    assert result.exit_code == 0
    records = json.loads(result.stdout)
    assert "acceleration" in records[0]


def test_cli_show_edges(tmp_path: Path):
    _make_graph_edges(tmp_path)
    _make_file_metrics(tmp_path)
    _make_cluster_metrics(tmp_path)
    result = runner.invoke(app, ["show", "edges", "0", "--out", str(tmp_path), "--format", "json"])
    assert result.exit_code == 0
    records = json.loads(result.stdout)
    assert len(records) >= 1


def test_cli_show_all_split_top(tmp_path: Path):
    _make_all_artifacts(tmp_path)
    result = runner.invoke(app, ["show", "all", "--out", str(tmp_path), "--top-risks", "2", "--format", "json"])
    assert result.exit_code == 0
    parsed = json.loads(result.stdout)
    assert len(parsed["risks"]) <= 2
