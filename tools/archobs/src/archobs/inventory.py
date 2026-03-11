from __future__ import annotations

from hashlib import sha1
from pathlib import Path
from subprocess import run

import pandas as pd

from archobs.config.filter import DEFAULT_LANGUAGE_EXTENSIONS, FilterConfig


def stable_id(path: str) -> str:
    return sha1(path.encode("utf-8")).hexdigest()


def language_for_path(path: str) -> str:
    return DEFAULT_LANGUAGE_EXTENSIONS.get(Path(path).suffix.lower(), "unknown")


def should_include_path(path: str, filters: FilterConfig) -> bool:
    normalized = path.replace("\\", "/")
    if any(normalized.startswith(prefix) for prefix in filters.exclude_prefixes):
        return False
    if any(normalized.endswith(suffix) for suffix in filters.exclude_suffixes):
        return False
    suffix = Path(normalized).suffix.lower()
    if filters.include_extensions and suffix not in filters.include_extensions:
        return False
    return True


def _looks_binary(path: Path) -> bool:
    try:
        chunk = path.read_bytes()[:4096]
    except OSError:
        return True
    return b"\0" in chunk


def git_ls_files(repo_path: str | Path) -> list[str]:
    proc = run(
        ["git", "ls-files", "-z"],
        cwd=repo_path,
        check=True,
        capture_output=True,
        text=False,
    )
    return [item.decode("utf-8") for item in proc.stdout.split(b"\0") if item]


def build_inventory(repo_path: str | Path, filters: FilterConfig) -> pd.DataFrame:
    repo_root = Path(repo_path)
    records: list[dict[str, object]] = []
    for rel_path in sorted(git_ls_files(repo_root)):
        if not should_include_path(rel_path, filters):
            continue
        abs_path = repo_root / rel_path
        if not abs_path.is_file() or _looks_binary(abs_path):
            continue
        try:
            stat = abs_path.stat()
        except OSError:
            continue
        if stat.st_size > filters.max_file_bytes:
            continue
        try:
            text = abs_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        records.append(
            {
                "id": stable_id(rel_path),
                "path": rel_path,
                "language": language_for_path(rel_path),
                "extension": abs_path.suffix.lower(),
                "size_bytes": stat.st_size,
                "loc": text.count("\n") + (1 if text else 0),
            }
        )
    df = pd.DataFrame(records)
    if df.empty:
        return pd.DataFrame(columns=["id", "path", "language", "extension", "size_bytes", "loc"])
    return df.sort_values("path").reset_index(drop=True)
