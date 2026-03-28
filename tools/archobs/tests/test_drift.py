"""Tests for drift detection and velocity summary in the pipeline module.

Covers _drift_window_ends boundary logic and _compute_velocity_summary
acceleration/growth calculations.
"""

from __future__ import annotations

import pandas as pd

from archobs.pipeline import _compute_velocity_summary, _drift_window_ends


# ---------------------------------------------------------------------------
# _drift_window_ends
# ---------------------------------------------------------------------------

def test_drift_window_ends_fixed_width() -> None:
    """When history spans enough windows, use fixed-width boundaries."""
    analysis_ts = 1_700_000_000
    width = 30 * 86400  # 30 days in seconds
    min_ts = analysis_ts - (10 * width)  # plenty of history

    ends = _drift_window_ends(
        analysis_ts=analysis_ts,
        min_ts=min_ts,
        drift_window_days=30,
        drift_window_count=6,
    )
    assert len(ends) == 6
    # Boundaries should be evenly spaced by window width
    for i in range(1, len(ends)):
        assert ends[i] - ends[i - 1] == width


def test_drift_window_ends_fallback_to_evenly_spaced() -> None:
    """Short history forces fallback to evenly-spaced boundaries."""
    analysis_ts = 1_700_000_000
    min_ts = analysis_ts - 3600  # only 1 hour of history

    ends = _drift_window_ends(
        analysis_ts=analysis_ts,
        min_ts=min_ts,
        drift_window_days=30,  # 30 days > 1 hour → fixed yields <2 windows
        drift_window_count=6,
    )
    assert len(ends) >= 2
    assert ends[0] >= min_ts
    assert ends[-1] <= analysis_ts


def test_drift_window_ends_minimum_count() -> None:
    """drift_window_count < 2 returns empty list."""
    ends = _drift_window_ends(
        analysis_ts=1_700_000_000,
        min_ts=1_600_000_000,
        drift_window_days=30,
        drift_window_count=1,
    )
    assert ends == []


def test_drift_window_ends_zero_width() -> None:
    """Zero-day windows return empty list."""
    ends = _drift_window_ends(
        analysis_ts=1_700_000_000,
        min_ts=1_600_000_000,
        drift_window_days=0,
        drift_window_count=6,
    )
    assert ends == []


def test_drift_window_ends_analysis_equals_min() -> None:
    """When analysis_ts == min_ts, should still return fixed windows."""
    ts = 1_700_000_000
    ends = _drift_window_ends(
        analysis_ts=ts,
        min_ts=ts,
        drift_window_days=30,
        drift_window_count=6,
    )
    # Only one boundary can fall at or above min_ts (analysis_ts itself)
    assert len(ends) <= 1


def test_drift_window_ends_boundaries_sorted() -> None:
    """Boundaries should always be sorted ascending."""
    ends = _drift_window_ends(
        analysis_ts=1_700_000_000,
        min_ts=1_690_000_000,
        drift_window_days=1,
        drift_window_count=4,
    )
    assert ends == sorted(ends)


# ---------------------------------------------------------------------------
# _compute_velocity_summary
# ---------------------------------------------------------------------------

def _make_velocity_data(
    base_ts: int = 1_700_000_000,
    window: int = 30,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Build minimal dataframes for velocity tests."""
    day = 86400

    commit_files = pd.DataFrame([
        # Current window: 3 commits in cluster 0 (within last 30 days of max_ts)
        {"commit_sha": "c1", "commit_ts": base_ts, "status": "M", "path": "a.py"},
        {"commit_sha": "c2", "commit_ts": base_ts - 100, "status": "A", "path": "b.py"},
        {"commit_sha": "c3", "commit_ts": base_ts - 200, "status": "M", "path": "a.py"},
        # Prior window: 1 commit clearly 35 days before max_ts
        {"commit_sha": "c4", "commit_ts": base_ts - (35 * day), "status": "M", "path": "a.py"},
    ])

    file_metrics = pd.DataFrame([
        {"path": "a.py", "cluster_id": 0, "risk": 0.3},
        {"path": "b.py", "cluster_id": 0, "risk": 0.5},
    ])

    cluster_metrics = pd.DataFrame([
        {"cluster_id": 0, "size": 2, "leakage": 0.1},
    ])

    return commit_files, file_metrics, cluster_metrics


def test_velocity_summary_acceleration() -> None:
    """acceleration = current_commits / max(prior_commits, 1)."""
    commit_files, file_metrics, cluster_metrics = _make_velocity_data()
    result = _compute_velocity_summary(commit_files, file_metrics, cluster_metrics, window=30)
    assert result is not None
    row = result.iloc[0]
    # Current window: 3 distinct commits (c1, c2, c3). Prior: 1 (c4).
    assert row["distinct_commits"] == 3
    assert row["prior_commit_count"] == 1
    assert row["acceleration"] == 3.0


def test_velocity_summary_growth_ratio() -> None:
    """growth_ratio = added / (added + modified + deleted)."""
    commit_files, file_metrics, cluster_metrics = _make_velocity_data()
    result = _compute_velocity_summary(commit_files, file_metrics, cluster_metrics, window=30)
    assert result is not None
    row = result.iloc[0]
    # Current window has 1 add (b.py) and 2 modifies (a.py twice)
    # growth_ratio = 1 / (1 + 2 + 0) = 1/3
    assert abs(row["growth_ratio"] - 1.0 / 3.0) < 1e-9


def test_velocity_summary_empty_commits() -> None:
    commit_files = pd.DataFrame(columns=["commit_sha", "commit_ts", "status", "path"])
    file_metrics = pd.DataFrame(columns=["path", "cluster_id", "risk"])
    cluster_metrics = pd.DataFrame(columns=["cluster_id", "size"])
    result = _compute_velocity_summary(commit_files, file_metrics, cluster_metrics)
    assert result is None


def test_velocity_summary_no_prior_window() -> None:
    """When there's no prior window, prior_commit_count should be 0 and acceleration uses max(0,1)=1."""
    base_ts = 1_700_000_000
    commit_files = pd.DataFrame([
        {"commit_sha": "c1", "commit_ts": base_ts - 100, "status": "M", "path": "a.py"},
        {"commit_sha": "c2", "commit_ts": base_ts - 200, "status": "M", "path": "a.py"},
    ])
    file_metrics = pd.DataFrame([{"path": "a.py", "cluster_id": 0, "risk": 0.3}])
    cluster_metrics = pd.DataFrame([{"cluster_id": 0, "size": 1}])

    result = _compute_velocity_summary(commit_files, file_metrics, cluster_metrics, window=30)
    assert result is not None
    row = result.iloc[0]
    assert row["prior_commit_count"] == 0
    # acceleration = 2 / max(0, 1) = 2.0
    assert row["acceleration"] == 2.0
