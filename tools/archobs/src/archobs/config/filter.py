from __future__ import annotations

from dataclasses import dataclass, field


DEFAULT_EXCLUDE_PREFIXES = [
    ".git/",
    ".archobs/",
    "node_modules/",
    "dist/",
    "build/",
    "vendor/",
    ".venv/",
    "venv/",
    "__pycache__/",
]

DEFAULT_EXCLUDE_SUFFIXES = [
    ".min.js",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".pdf",
    ".svg",
    ".ico",
    ".zip",
    ".gz",
    ".tar",
    ".jar",
    ".class",
]

DEFAULT_LANGUAGE_EXTENSIONS = {
    ".py": "python",
    ".pyi": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".java": "java",
}


@dataclass(slots=True)
class FilterConfig:
    include_extensions: list[str] = field(
        default_factory=lambda: sorted(DEFAULT_LANGUAGE_EXTENSIONS)
    )
    exclude_prefixes: list[str] = field(default_factory=lambda: list(DEFAULT_EXCLUDE_PREFIXES))
    exclude_suffixes: list[str] = field(default_factory=lambda: list(DEFAULT_EXCLUDE_SUFFIXES))
    max_file_bytes: int = 256_000
