from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True)
class ExtractionConfig:
    parser_backend: str = "auto"
    langs: list[str] = field(default_factory=lambda: ["python", "typescript", "javascript"])
    preview_line_count: int = 40
    comment_line_count: int = 12
    import_list_limit: int = 20
    export_list_limit: int = 20
