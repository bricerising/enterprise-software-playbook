from __future__ import annotations

from dataclasses import asdict, is_dataclass
import html
import json
from pathlib import Path
import re
import time
from typing import TYPE_CHECKING, Any
from uuid import uuid4

import numpy as np
import pandas as pd

if TYPE_CHECKING:
    from archobs.clustering import ClusteringResult
    from archobs.deps import DependencyExtractionResult
    from archobs.embedding import EmbeddingResult
    from archobs.graph import GraphArtifacts
    from archobs.pipeline import GitHistoryResult, ReportResult


def ensure_dir(path: str | Path) -> Path:
    target = Path(path)
    target.mkdir(parents=True, exist_ok=True)
    return target


def artifact_dir(base: str | Path) -> Path:
    return ensure_dir(base)


def parquet_path(base: str | Path, name: str) -> Path:
    return artifact_dir(base) / f"{name}.parquet"


def json_path(base: str | Path, name: str) -> Path:
    return artifact_dir(base) / f"{name}.json"


def npy_path(base: str | Path, name: str) -> Path:
    return artifact_dir(base) / f"{name}.npy"


def report_dir(base: str | Path) -> Path:
    return ensure_dir(Path(base) / "report")


def _atomic_temp_path(target: Path) -> Path:
    return target.with_name(f".{target.name}.{uuid4().hex}.tmp")


def write_parquet(df: pd.DataFrame, base: str | Path, name: str) -> Path:
    target = parquet_path(base, name)
    tmp = _atomic_temp_path(target)
    try:
        with tmp.open("wb") as handle:
            df.to_parquet(handle, compression="snappy", index=False)
        tmp.replace(target)
    finally:
        if tmp.exists():
            tmp.unlink()
    return target


def read_parquet(base: str | Path, name: str) -> pd.DataFrame:
    return pd.read_parquet(parquet_path(base, name))


def write_json(data: Any, base: str | Path, name: str) -> Path:
    return write_json_path(data, json_path(base, name))


def write_json_path(data: Any, path: str | Path) -> Path:
    target = Path(path)
    ensure_dir(target.parent)
    serializable = asdict(data) if is_dataclass(data) else data
    tmp = _atomic_temp_path(target)
    try:
        tmp.write_text(json.dumps(serializable, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        tmp.replace(target)
    finally:
        if tmp.exists():
            tmp.unlink()
    return target


def read_json(base: str | Path, name: str) -> Any:
    return json.loads(json_path(base, name).read_text(encoding="utf-8"))


def run_manifest_issue(base: str | Path) -> str | None:
    root = Path(base)
    if root.name == "report" and json_path(root.parent, "run_manifest").exists():
        root = root.parent
    path = json_path(root, "run_manifest")
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return f"{path} could not be parsed. Artifacts may be incomplete or mixed-generation."
    if not isinstance(payload, dict):
        return f"{path} is not a JSON object. Artifacts may be incomplete or mixed-generation."
    status = payload.get("status")
    if status == "complete":
        return None
    stages = payload.get("completed_stages")
    stage_text = ", ".join(str(stage) for stage in stages) if isinstance(stages, list) else "unknown"
    reason = payload.get("stale_reason") or payload.get("error")
    detail = f" Reason: {reason}." if reason else ""
    return (
        f"{path} status is {status!r}. Artifacts may be incomplete or mixed-generation."
        f"{detail} Completed stages: {stage_text}."
    )


_STALE_REPORT_STYLE_ID = "archobs-stale-report-style"
_STALE_REPORT_START = "<!-- archobs-stale-report:start -->"
_STALE_REPORT_END = "<!-- archobs-stale-report:end -->"


def _stale_report_banner(reason: str) -> str:
    escaped_reason = html.escape(reason, quote=True)
    return (
        f"{_STALE_REPORT_START}\n"
        '<aside id="archobs-stale-report" role="alert" aria-live="assertive">\n'
        "  <strong>Analysis is stale.</strong> This workspace changed or a report run did not complete "
        "after this report was generated. Run <code>archobs report</code> before using these results. "
        f"Reason: {escaped_reason}\n"
        "</aside>\n"
        f"{_STALE_REPORT_END}"
    )


def _with_stale_report_banner(document: str, reason: str) -> str:
    """Add or replace the visible stale marker in an existing static report."""
    start = document.find(_STALE_REPORT_START)
    if start >= 0:
        end = document.find(_STALE_REPORT_END, start)
        if end < 0:
            raise ValueError("report contains an unterminated archobs stale marker")
        document = document[:start] + document[end + len(_STALE_REPORT_END):]

    if _STALE_REPORT_STYLE_ID not in document:
        head_end = re.search(r"</head\s*>", document, flags=re.IGNORECASE)
        if head_end is None:
            raise ValueError("report does not contain a closing </head> tag")
        style = f"""
<style id="{_STALE_REPORT_STYLE_ID}">
  #archobs-stale-report {{
    position: sticky;
    top: 0;
    z-index: 9999;
    margin: 0;
    padding: 0.9rem 1.25rem;
    border-bottom: 2px solid #991b1b;
    background: #fef2f2;
    color: #7f1d1d;
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif;
    line-height: 1.45;
    text-align: center;
  }}
  #archobs-stale-report code {{
    padding: 0.1rem 0.3rem;
    border-radius: 0.25rem;
    background: rgba(153, 27, 27, 0.12);
  }}
</style>
"""
        document = document[:head_end.start()] + style + document[head_end.start():]

    body_start = re.search(r"<body\b[^>]*>", document, flags=re.IGNORECASE)
    if body_start is None:
        raise ValueError("report does not contain an opening <body> tag")
    return document[:body_start.end()] + "\n" + _stale_report_banner(reason) + document[body_start.end():]


def _write_text_atomic(text: str, target: Path) -> None:
    tmp = _atomic_temp_path(target)
    try:
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(target)
    finally:
        if tmp.exists():
            tmp.unlink()


def _mark_static_reports_stale(base: Path, reason: str) -> None:
    report_root = base / "report"
    for name in ("index.html", "graph.html"):
        target = report_root / name
        if not target.exists():
            continue
        try:
            document = target.read_text(encoding="utf-8")
            _write_text_atomic(_with_stale_report_banner(document, reason), target)
        except (OSError, UnicodeError, ValueError):
            # The manifest is the freshness source of truth; static report banners are best-effort.
            continue


def write_npy(array: np.ndarray, base: str | Path, name: str) -> Path:
    target = npy_path(base, name)
    tmp = _atomic_temp_path(target)
    try:
        with tmp.open("wb") as handle:
            np.save(handle, array)
        tmp.replace(target)
    finally:
        if tmp.exists():
            tmp.unlink()
    return target


class ArtifactStore:
    """Encapsulates read/write of named pipeline artifacts.

    Pipeline stages receive a store instead of a raw ``out`` path,
    eliminating direct coupling to artifact names and file formats.
    """

    def __init__(self, base: str | Path) -> None:
        self._base = Path(base)
        artifact_dir(self._base)

    @property
    def base_path(self) -> Path:
        return self._base

    @property
    def cache_path(self) -> Path:
        return self._base / "codanna_semantic_cache.json"

    def put_df(self, name: str, df: pd.DataFrame) -> None:
        write_parquet(df, self._base, name)

    def get_df(self, name: str) -> pd.DataFrame:
        return read_parquet(self._base, name)

    def put_json(self, name: str, data: Any) -> None:
        write_json(data, self._base, name)

    def get_json(self, name: str) -> Any:
        return read_json(self._base, name)

    def put_array(self, name: str, array: np.ndarray) -> None:
        write_npy(array, self._base, name)

    def get_array(self, name: str) -> np.ndarray | None:
        path = npy_path(self._base, name)
        return np.load(path) if path.exists() else None

    def invalidate_run_manifest(self, reason: str) -> None:
        path = json_path(self._base, "run_manifest")
        manifest: dict[str, Any] = {}
        if path.exists():
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                manifest = payload if isinstance(payload, dict) else {}
            except json.JSONDecodeError:
                manifest = {}
        manifest.setdefault("completed_stages", [])
        manifest.update(
            {
                "status": "stale",
                "stale_reason": reason,
                "updated_at": int(time.time()),
            }
        )
        write_json(manifest, self._base, "run_manifest")
        self.mark_static_reports_stale(reason)

    def mark_static_reports_stale(self, reason: str) -> None:
        _mark_static_reports_stale(self._base, reason)

    def save_inventory(self, files_df: pd.DataFrame) -> None:
        self.put_df("files", files_df)

    def load_inventory(self) -> pd.DataFrame:
        return self.get_df("files")

    def save_git_history(self, git_result: "GitHistoryResult") -> None:
        git_result.persist(self._base)

    def save_dependencies(self, deps_result: "DependencyExtractionResult") -> None:
        deps_result.persist(self._base)

    def save_embeddings(self, embedding_result: "EmbeddingResult", files_df: pd.DataFrame) -> pd.DataFrame:
        embedding_result.persist(self._base)
        enriched_files_df = embedding_result.enrich_files(files_df)
        self.save_inventory(enriched_files_df)
        return enriched_files_df

    def save_edges(self, edge_result: "GraphArtifacts") -> None:
        edge_result.persist(self._base)

    def save_clusters(self, cluster_result: "ClusteringResult") -> None:
        cluster_result.persist(self._base)

    def save_report(self, report_result: "ReportResult") -> None:
        write_parquet(report_result.file_metrics, self._base, "file_metrics")
        write_parquet(report_result.cluster_metrics, self._base, "cluster_metrics")
        write_parquet(report_result.drift_df, self._base, "drift")

    def init_workspace(self) -> None:
        artifact_dir(self._base)
        report_dir(self._base)
