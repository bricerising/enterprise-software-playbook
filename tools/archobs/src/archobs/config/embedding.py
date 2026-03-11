from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class EmbeddingConfig:
    provider: str = "auto"
    model: str = "codanna-semantic-search"
    dimensions: int = 256
    batch_size: int = 32
    max_summary_chars: int = 6000
