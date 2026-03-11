from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
from pathlib import Path
from typing import Any

from archobs.config.clustering import ClusteringConfig
from archobs.config.embedding import EmbeddingConfig
from archobs.config.extraction import ExtractionConfig
from archobs.config.filter import (
    DEFAULT_EXCLUDE_PREFIXES,
    DEFAULT_EXCLUDE_SUFFIXES,
    DEFAULT_LANGUAGE_EXTENSIONS,
    FilterConfig,
)
from archobs.config.graph import GraphConfig
from archobs.config.reporting import ReportingConfig

__all__ = [
    "DEFAULT_EXCLUDE_PREFIXES",
    "DEFAULT_EXCLUDE_SUFFIXES",
    "DEFAULT_LANGUAGE_EXTENSIONS",
    "FilterConfig",
    "ExtractionConfig",
    "EmbeddingConfig",
    "GraphConfig",
    "ClusteringConfig",
    "ReportingConfig",
    "ArchobsConfig",
    "default_config",
    "save_config",
    "load_config",
]


@dataclass(slots=True)
class ArchobsConfig:
    repo: str = "."
    out: str = ".archobs"
    filters: FilterConfig = field(default_factory=FilterConfig)
    extraction: ExtractionConfig = field(default_factory=ExtractionConfig)
    embedding: EmbeddingConfig = field(default_factory=EmbeddingConfig)
    graph: GraphConfig = field(default_factory=GraphConfig)
    clustering: ClusteringConfig = field(default_factory=ClusteringConfig)
    reporting: ReportingConfig = field(default_factory=ReportingConfig)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def default_config(repo: str | Path = ".", out: str | Path = ".archobs") -> ArchobsConfig:
    return ArchobsConfig(repo=str(repo), out=str(out))


def save_config(config: ArchobsConfig, path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(config.to_dict(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return target


def load_config(path: str | Path) -> ArchobsConfig:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    filters = FilterConfig(**payload.get("filters", {}))
    extraction = ExtractionConfig(**payload.get("extraction", {}))
    embedding = EmbeddingConfig(**payload.get("embedding", {}))
    graph = GraphConfig(**payload.get("graph", {}))
    clustering = ClusteringConfig(**payload.get("clustering", {}))
    reporting = ReportingConfig(**payload.get("reporting", {}))
    return ArchobsConfig(
        repo=payload.get("repo", "."),
        out=payload.get("out", ".archobs"),
        filters=filters,
        extraction=extraction,
        embedding=embedding,
        graph=graph,
        clustering=clustering,
        reporting=reporting,
    )
