from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pandas as pd
from typer.testing import CliRunner

from archobs.cli import app
from archobs.storage import ArtifactStore


runner = CliRunner()


def _initialize_repo(repo: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    source = repo / "src" / "current.py"
    source.parent.mkdir()
    source.write_text("value = 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "src/current.py"], cwd=repo, check=True)


def _write_legacy_consumer_artifacts(out: Path) -> None:
    pd.DataFrame(
        [
            {
                "path": "src/legacy.py",
                "cluster_id": 0,
                "risk": 0.1,
                "xnbr": 0.1,
                "hubness": 0.1,
                "volatility": 0.1,
            }
        ]
    ).to_parquet(out / "file_metrics.parquet", index=False)
    pd.DataFrame(
        [
            {
                "cluster_id": 0,
                "size": 2,
                "leakage": 0.1,
                "cohesion": 0.8,
                "risk_mean": 0.1,
            }
        ]
    ).to_parquet(out / "cluster_metrics.parquet", index=False)
    (out / "suggestions.json").write_text(
        json.dumps(
            {
                "engine": "rules",
                "error": None,
                "items": [
                    {
                        "priority": "High",
                        "title": "Legacy guidance",
                        "why": "Old analysis",
                        "change": "Do not emit after a targeted write",
                        "scope": "src/legacy.py",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def _write_legacy_static_reports(out: Path) -> None:
    report = out / "report"
    report.mkdir()
    document = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>archobs report</title></head>
<body><main>Prior completed analysis</main></body>
</html>
"""
    for name in ("index.html", "graph.html"):
        (report / name).write_text(document, encoding="utf-8")


def test_targeted_command_invalidates_manifestless_legacy_workspace(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _initialize_repo(repo)
    out = repo / ".archobs"
    out.mkdir()
    _write_legacy_consumer_artifacts(out)
    _write_legacy_static_reports(out)
    assert not (out / "run_manifest.json").exists()

    targeted = runner.invoke(
        app,
        ["extract", "inventory", "--repo", str(repo), "--out", str(out)],
    )

    assert targeted.exit_code == 0, targeted.output
    manifest = json.loads((out / "run_manifest.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "stale"
    assert manifest["stale_reason"] == "targeted command: extract inventory"
    assert manifest["completed_stages"] == []
    assert pd.read_parquet(out / "files.parquet")["path"].tolist() == ["src/current.py"]
    for name in ("index.html", "graph.html"):
        document = (out / "report" / name).read_text(encoding="utf-8")
        assert "Analysis is stale." in document
        assert "targeted command: extract inventory" in document
        assert document.count('id="archobs-stale-report"') == 1

    check = runner.invoke(app, ["check", "--out", str(out), "--ci"])
    assert check.exit_code == 1
    assert json.loads(check.stdout)["by_category"]["artifact_consistency"] == 1

    prompts = runner.invoke(app, ["prompts", "--out", str(out)])
    assert prompts.exit_code == 0
    assert "Legacy guidance" not in prompts.stdout
    assert "mixed-generation" in prompts.stderr

    show = runner.invoke(
        app,
        ["show", "risks", "--out", str(out), "--format", "json"],
    )
    assert show.exit_code == 1
    assert "src/legacy.py" not in show.stdout
    assert "mixed-generation" in show.stderr


def test_targeted_command_continues_when_static_report_is_malformed(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _initialize_repo(repo)
    out = repo / ".archobs"
    out.mkdir()
    (out / "run_manifest.json").write_text(
        json.dumps({"status": "complete", "completed_stages": ["persist"]}),
        encoding="utf-8",
    )
    _write_legacy_static_reports(out)
    malformed_document = "<html><head><title>partial report"
    (out / "report" / "index.html").write_text(malformed_document, encoding="utf-8")

    targeted = runner.invoke(
        app,
        ["extract", "inventory", "--repo", str(repo), "--out", str(out)],
    )

    assert targeted.exit_code == 0, targeted.output
    manifest = json.loads((out / "run_manifest.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "stale"
    assert manifest["stale_reason"] == "targeted command: extract inventory"
    assert pd.read_parquet(out / "files.parquet")["path"].tolist() == ["src/current.py"]
    assert (out / "report" / "index.html").read_text(encoding="utf-8") == malformed_document
    graph_document = (out / "report" / "graph.html").read_text(encoding="utf-8")
    assert "Analysis is stale." in graph_document
    assert "targeted command: extract inventory" in graph_document


def test_invalidation_preserves_existing_manifest_fields(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path)
    store.put_json(
        "run_manifest",
        {
            "run_id": "existing-run",
            "status": "complete",
            "completed_stages": ["persist"],
            "repo_head": "abc123",
        },
    )

    store.invalidate_run_manifest("targeted command: cluster")

    manifest = store.get_json("run_manifest")
    assert manifest["run_id"] == "existing-run"
    assert manifest["repo_head"] == "abc123"
    assert manifest["completed_stages"] == ["persist"]
    assert manifest["status"] == "stale"
    assert manifest["stale_reason"] == "targeted command: cluster"
