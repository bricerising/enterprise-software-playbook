from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class GraphConfig:
    k_sem: int = 20
    tau_sem: float = 0.35
    alpha: float = 0.45
    beta: float = 0.35
    gamma: float = 0.20
    tau_co: float = 0.10
    k_co: int = 10
    tau_dep: float = 0.0
    half_life_days: float = 180.0
    commit_file_cap: int = 50
    similarity_batch_size: int = 256
    semantic_workers: int = 4
    codanna_index_timeout_seconds: int = 180
    codanna_search_timeout_seconds: int = 30
