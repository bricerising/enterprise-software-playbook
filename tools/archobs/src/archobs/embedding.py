"""Internal embedding primitives published through the analysis service boundary."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha1
from pathlib import Path
import shutil
from typing import Protocol
import warnings

import numpy as np
import pandas as pd

from archobs.config.embedding import EmbeddingConfig

__all__ = [
    "DefaultEmbeddingProvider",
    "EmbeddingProvider",
    "EmbeddingRunMeta",
    "EmbeddingResult",
    "choose_provider",
    "codanna_available",
    "codanna_dependency_warning",
    "default_embedding_provider",
    "build_hashing_embeddings",
    "embedding_graph_embeddings",
    "embedding_provider_used",
    "embedding_vector_count",
    "enrich_files_with_embeddings",
    "embed_analysis",
    "persist_embedding_artifacts",
    "resolve_embedding_provider",
]


@dataclass(frozen=True, slots=True)
class EmbeddingRunMeta:
    """Typed metadata for a single embedding run."""

    provider_requested: str
    provider_used: str
    model: str
    dimensions: int
    empty_input: bool = False
    fallback_reason: str | None = None

    def to_dict(self) -> dict[str, object]:
        result: dict[str, object] = {
            "provider_requested": self.provider_requested,
            "provider_used": self.provider_used,
            "model": self.model,
            "dimensions": self.dimensions,
        }
        if self.empty_input:
            result["empty_input"] = True
        if self.fallback_reason is not None:
            result["fallback_reason"] = self.fallback_reason
        return result


@dataclass(frozen=True, slots=True)
class EmbeddingResult:
    """Stable embedding artifact contract exposed above analysis internals."""

    vector_meta: pd.DataFrame
    embeddings: np.ndarray
    meta: EmbeddingRunMeta

    @property
    def provider_used(self) -> str:
        return embedding_provider_used(self)

    @property
    def vector_count(self) -> int:
        return embedding_vector_count(self)

    def graph_embeddings(self) -> np.ndarray:
        return embedding_graph_embeddings(self)

    def enrich_files(self, files_df: pd.DataFrame) -> pd.DataFrame:
        return enrich_files_with_embeddings(files_df, self)

    def persist(self, out: str | Path) -> None:
        persist_embedding_artifacts(self, out)


class EmbeddingProvider(Protocol):
    """Stable provider boundary for embedding execution and availability checks."""

    def choose_provider(self, provider: str) -> str: ...

    def dependency_warning(self) -> str | None: ...

    def embed_analysis(self, analysis_df: pd.DataFrame, config: EmbeddingConfig) -> EmbeddingResult: ...


def embedding_graph_embeddings(embedding: EmbeddingResult) -> np.ndarray:
    """Return graph-ready embeddings from the published embedding result."""

    return embedding.embeddings


def embedding_provider_used(embedding: EmbeddingResult) -> str:
    """Return the resolved provider from the published embedding result."""

    return embedding.meta.provider_used


def embedding_vector_count(embedding: EmbeddingResult) -> int:
    """Return the number of embedding vectors in the published result."""

    embeddings = embedding_graph_embeddings(embedding)
    return int(embeddings.shape[0]) if embeddings.ndim == 2 else 0


def enrich_files_with_embeddings(files_df: pd.DataFrame, embedding: EmbeddingResult) -> pd.DataFrame:
    """Merge embedding metadata into a files inventory using the published result."""

    cols = [
        column
        for column in ("embedding_vector_id", "embedding_provider", "embedding_model", "embedding_dim")
        if column in embedding.vector_meta.columns
    ]
    return files_df.merge(
        embedding.vector_meta[["path", *cols]],
        on="path",
        how="left",
    )


def persist_embedding_artifacts(embedding: EmbeddingResult, out: str | Path) -> None:
    """Persist embedding artifacts through the published result contract."""

    from archobs.storage import write_json, write_npy, write_parquet

    write_parquet(embedding.vector_meta, out, "embedding_metadata")
    write_npy(embedding_graph_embeddings(embedding), out, "embeddings")
    write_json(embedding.meta.to_dict(), out, "embedding_run")


def _normalize_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def _hashing_embeddings(texts: list[str], dimensions: int) -> np.ndarray:
    matrix = np.zeros((len(texts), dimensions), dtype=np.float32)
    for row_idx, text in enumerate(texts):
        tokens = text.lower().replace("\n", " ").split()
        if not tokens:
            continue
        for token in tokens:
            digest = sha1(token.encode("utf-8")).digest()
            index = int.from_bytes(digest[:4], "big") % dimensions
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            matrix[row_idx, index] += sign
    return _normalize_rows(matrix)


def build_hashing_embeddings(texts: list[str], dimensions: int) -> np.ndarray:
    """Build deterministic local embeddings for fallback semantic graph edges."""

    return _hashing_embeddings(texts, dimensions)


def codanna_available() -> bool:
    return shutil.which("codanna") is not None


@dataclass(frozen=True, slots=True)
class DefaultEmbeddingProvider:
    """Default embedding-provider boundary used above pipeline coordination."""

    def choose_provider(self, provider: str) -> str:
        if provider != "auto":
            return provider
        return "codanna" if codanna_available() else "hashing"

    def dependency_warning(self) -> str | None:
        if codanna_available():
            return None
        return (
            "Warning: codanna is not installed. Semantic search features will use"
            " the hashing fallback.\nSee https://codanna.dev for install instructions."
        )

    def embed_analysis(self, analysis_df: pd.DataFrame, config: EmbeddingConfig) -> EmbeddingResult:
        provider_used = self.choose_provider(config.provider)
        if analysis_df.empty:
            vector_meta = pd.DataFrame(
                columns=[
                    "path",
                    "embedding_vector_id",
                    "embedding_provider",
                    "embedding_model",
                    "embedding_dim",
                    "summary_sha1",
                ]
            )
            meta = EmbeddingRunMeta(
                provider_requested=config.provider,
                provider_used=provider_used,
                model=config.model,
                dimensions=config.dimensions,
                empty_input=True,
            )
            return EmbeddingResult(vector_meta, np.zeros((0, config.dimensions), dtype=np.float32), meta)

        texts = analysis_df["summary_text"].tolist()
        fallback_reason: str | None = None
        try:
            if provider_used == "codanna":
                if not codanna_available():
                    raise RuntimeError("codanna CLI is not installed or not on PATH.")
                embeddings = np.zeros((len(analysis_df), 0), dtype=np.float32)
            elif provider_used == "hashing":
                embeddings = _hashing_embeddings(texts, config.dimensions)
            else:
                raise ValueError(f"Unsupported embedding provider: {provider_used}")
        except Exception as exc:
            if config.provider != "auto":
                raise RuntimeError(f"Embedding provider {provider_used} failed: {exc}") from exc
            warnings.warn(f"Embedding provider {provider_used} failed; falling back to hashing: {exc}", stacklevel=2)
            provider_used = "hashing"
            fallback_reason = str(exc)
            embeddings = _hashing_embeddings(texts, config.dimensions)

        vector_meta = analysis_df[["path"]].copy()
        vector_meta["embedding_vector_id"] = np.arange(len(analysis_df), dtype=np.int64)
        vector_meta["embedding_provider"] = provider_used
        vector_meta["embedding_model"] = config.model if provider_used == "codanna" else "hashing"
        vector_meta["embedding_dim"] = embeddings.shape[1] if embeddings.ndim == 2 else config.dimensions
        vector_meta["summary_sha1"] = [sha1(text.encode("utf-8")).hexdigest() for text in texts]

        meta = EmbeddingRunMeta(
            provider_requested=config.provider,
            provider_used=provider_used,
            model=config.model,
            dimensions=config.dimensions,
            fallback_reason=fallback_reason,
        )
        return EmbeddingResult(vector_meta, embeddings.astype(np.float32), meta)


_DEFAULT_EMBEDDING_PROVIDER = DefaultEmbeddingProvider()


def default_embedding_provider() -> EmbeddingProvider:
    return _DEFAULT_EMBEDDING_PROVIDER


def resolve_embedding_provider(embedding_provider: EmbeddingProvider | None = None) -> EmbeddingProvider:
    return embedding_provider if embedding_provider is not None else default_embedding_provider()


def choose_provider(provider: str, *, embedding_provider: EmbeddingProvider | None = None) -> str:
    return resolve_embedding_provider(embedding_provider).choose_provider(provider)


def codanna_dependency_warning(*, embedding_provider: EmbeddingProvider | None = None) -> str | None:
    return resolve_embedding_provider(embedding_provider).dependency_warning()


def embed_analysis(
    analysis_df: pd.DataFrame,
    config: EmbeddingConfig,
    *,
    embedding_provider: EmbeddingProvider | None = None,
) -> EmbeddingResult:
    return resolve_embedding_provider(embedding_provider).embed_analysis(analysis_df, config)
