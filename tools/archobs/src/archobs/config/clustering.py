from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class ClusteringConfig:
    algorithm: str = "auto"
    resolution: float = 1.0
    seed: int = 42
    drift_window_days: int = 30
    drift_window_count: int = 6
