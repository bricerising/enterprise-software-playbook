from __future__ import annotations

from collections import defaultdict
from itertools import combinations
from math import pow
from pathlib import Path
from subprocess import CalledProcessError, run

import numpy as np
import pandas as pd

from archobs.config.graph import GraphConfig


LOG_FORMAT = ["git", "log", "--date-order", "--reverse", "--pretty=format:--COMMIT--%n%H%n%ct%n%an%n%s", "--name-status", "--no-renames", "--", "."]

_MESSAGE_MAX_LEN = 80


def extract_git_history(repo_path: str | Path, tracked_paths: set[str]) -> pd.DataFrame:
    try:
        proc = run(LOG_FORMAT, cwd=repo_path, check=True, capture_output=True, text=True)
    except CalledProcessError as exc:
        if exc.returncode == 128:
            return pd.DataFrame(columns=["commit_sha", "commit_ts", "author", "message", "status", "path"])
        raise
    rows: list[dict[str, object]] = []
    commit_sha: str | None = None
    commit_ts: int | None = None
    commit_author: str = ""
    commit_msg: str = ""
    awaiting_sha = False
    awaiting_ts = False
    awaiting_author = False
    awaiting_msg = False

    for raw_line in proc.stdout.splitlines():
        line = raw_line.strip("\n")
        if line == "--COMMIT--":
            awaiting_sha = True
            awaiting_ts = False
            awaiting_author = False
            awaiting_msg = False
            continue
        if awaiting_sha:
            commit_sha = line.strip()
            awaiting_sha = False
            awaiting_ts = True
            continue
        if awaiting_ts:
            commit_ts = int(line.strip())
            awaiting_ts = False
            awaiting_author = True
            continue
        if awaiting_author:
            commit_author = line.strip()
            awaiting_author = False
            awaiting_msg = True
            continue
        if awaiting_msg:
            commit_msg = line.strip()[:_MESSAGE_MAX_LEN]
            awaiting_msg = False
            continue
        if not line or commit_sha is None or commit_ts is None:
            continue
        parts = line.split("\t", 1)
        if len(parts) != 2:
            continue
        status, rel_path = parts
        rel_path = rel_path.strip()
        if rel_path not in tracked_paths:
            continue
        rows.append(
            {
                "commit_sha": commit_sha,
                "commit_ts": commit_ts,
                "author": commit_author,
                "message": commit_msg,
                "status": status,
                "path": rel_path,
            }
        )

    if not rows:
        return pd.DataFrame(columns=["commit_sha", "commit_ts", "author", "message", "status", "path"])
    return pd.DataFrame(rows).sort_values(["commit_ts", "commit_sha", "path"]).reset_index(drop=True)


def compute_git_file_stats(commit_files_df: pd.DataFrame) -> pd.DataFrame:
    if commit_files_df.empty:
        return pd.DataFrame(columns=["path", "commit_count", "last_commit_ts"])
    grouped = (
        commit_files_df.groupby("path", as_index=False)
        .agg(commit_count=("commit_sha", "nunique"), last_commit_ts=("commit_ts", "max"))
        .sort_values("path")
        .reset_index(drop=True)
    )
    return grouped


def build_cochange_edges(commit_files_df: pd.DataFrame, graph_config: GraphConfig) -> tuple[pd.DataFrame, dict[str, float]]:
    if commit_files_df.empty:
        return (
            pd.DataFrame(columns=["path_a", "path_b", "w_co_raw", "w_co"]),
            {"analysis_ts": 0.0, "p95": 0.0, "ignored_commits": 0.0},
        )
    analysis_ts = float(commit_files_df["commit_ts"].max())
    raw_weights: defaultdict[tuple[str, str], float] = defaultdict(float)
    ignored_commits = 0

    for (_, _), commit_group in commit_files_df.groupby(["commit_sha", "commit_ts"], sort=True):
        paths = sorted(set(commit_group["path"].tolist()))
        m = len(paths)
        if m < 2:
            continue
        if m > graph_config.commit_file_cap:
            ignored_commits += 1
            continue
        age_days = max(0.0, (analysis_ts - float(commit_group["commit_ts"].iloc[0])) / 86400.0)
        decay = pow(2.0, -age_days / graph_config.half_life_days)
        contribution = decay / max(1, m - 1)
        for path_a, path_b in combinations(paths, 2):
            raw_weights[(path_a, path_b)] += contribution

    if not raw_weights:
        return (
            pd.DataFrame(columns=["path_a", "path_b", "w_co_raw", "w_co"]),
            {"analysis_ts": analysis_ts, "p95": 0.0, "ignored_commits": float(ignored_commits)},
        )

    values = np.array(list(raw_weights.values()), dtype=np.float64)
    p95 = float(np.percentile(values, 95)) if len(values) else 0.0
    p95 = p95 or float(values.max())

    rows = []
    for (path_a, path_b), raw_weight in sorted(raw_weights.items()):
        rows.append(
            {
                "path_a": path_a,
                "path_b": path_b,
                "w_co_raw": raw_weight,
                "w_co": min(1.0, raw_weight / p95) if p95 > 0 else 0.0,
            }
        )

    cochange_df = pd.DataFrame(rows)
    if cochange_df.empty:
        return cochange_df, {"analysis_ts": analysis_ts, "p95": p95, "ignored_commits": float(ignored_commits)}

    retained: set[tuple[str, str]] = set()
    for _, row in cochange_df.iterrows():
        if float(row["w_co"]) >= graph_config.tau_co:
            retained.add((row["path_a"], row["path_b"]))

    if graph_config.k_co > 0:
        per_node = defaultdict(list)
        for _, row in cochange_df.sort_values(["w_co", "path_a", "path_b"], ascending=[False, True, True]).iterrows():
            per_node[row["path_a"]].append((row["path_b"], float(row["w_co"])))
            per_node[row["path_b"]].append((row["path_a"], float(row["w_co"])))
        for node, neighbors in per_node.items():
            for other, _ in neighbors[: graph_config.k_co]:
                retained.add(tuple(sorted((node, other))))

    filtered = cochange_df[
        cochange_df.apply(lambda row: (row["path_a"], row["path_b"]) in retained, axis=1)
    ].sort_values(["path_a", "path_b"]).reset_index(drop=True)

    return filtered, {"analysis_ts": analysis_ts, "p95": p95, "ignored_commits": float(ignored_commits)}
