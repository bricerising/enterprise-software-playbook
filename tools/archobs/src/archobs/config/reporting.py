from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ReportRenderOptions:
    """Rendering options for the report stage."""

    suggestions_provider: str = "rules"
    suggestion_count: int = 4
    codex_timeout_seconds: int = 45
    claude_timeout_seconds: int = 45


@dataclass(slots=True)
class ReportingConfig:
    top_risk_files: int = 50
    top_leaky_clusters: int = 20
    suggestions_provider: str = "rules"
    suggestion_count: int = 4
    codex_timeout_seconds: int = 45
    claude_timeout_seconds: int = 45

    def render_options(self) -> ReportRenderOptions:
        return ReportRenderOptions(
            suggestions_provider=self.suggestions_provider,
            suggestion_count=self.suggestion_count,
            codex_timeout_seconds=self.codex_timeout_seconds,
            claude_timeout_seconds=self.claude_timeout_seconds,
        )
