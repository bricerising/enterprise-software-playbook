"""Internal dependency-analysis primitives for the analysis engine boundary."""

from __future__ import annotations

import ast
from dataclasses import dataclass
import json
import re
from pathlib import Path, PurePosixPath

import pandas as pd

from archobs.config.extraction import ExtractionConfig

__all__ = [
    "DependencyExtractionResult",
    "build_summary_text",
    "extract_dependencies",
]


IMPORT_RE = re.compile(
    r"""(?mx)
    ^\s*import\s+[^'"]+\s+from\s+['"](?P<spec1>[^'"]+)['"] |
    ^\s*export\s+[^'"]+\s+from\s+['"](?P<spec2>[^'"]+)['"] |
    ^\s*import\s+['"](?P<spec0>[^'"]+)['"] |
    require\(\s*['"](?P<spec3>[^'"]+)['"]\s*\) |
    import\(\s*['"](?P<spec4>[^'"]+)['"]\s*\)
    """
)

EXPORT_RE = re.compile(
    r"""(?mx)
    ^\s*export\s+(?:async\s+)?function\s+(?P<fn>[A-Za-z_][A-Za-z0-9_]*) |
    ^\s*export\s+class\s+(?P<class>[A-Za-z_][A-Za-z0-9_]*) |
    ^\s*export\s+(?:const|let|var)\s+(?P<var>[A-Za-z_][A-Za-z0-9_]*)
    """
)

BLOCK_COMMENT_RE = re.compile(r"/\*(.*?)\*/", re.DOTALL)


@dataclass(frozen=True, slots=True)
class DependencyExtractionResult:
    """Stable return type for :func:`extract_dependencies`."""

    imports_df: pd.DataFrame
    analysis_df: pd.DataFrame
    unresolved_df: pd.DataFrame

    def persist(self, out: str | Path) -> None:
        from archobs.storage import write_parquet

        write_parquet(self.imports_df, out, "imports")
        write_parquet(self.analysis_df, out, "analysis")
        write_parquet(self.unresolved_df, out, "unresolved_imports")

    @property
    def resolved_import_count(self) -> int:
        return int(len(self.imports_df))

    @property
    def unresolved_import_count(self) -> int:
        return int(len(self.unresolved_df))

    def __iter__(self):
        yield self.imports_df
        yield self.analysis_df
        yield self.unresolved_df

    def analysis_inputs(self) -> pd.DataFrame:
        return self.analysis_df

    def graph_inputs(self) -> tuple[pd.DataFrame, pd.DataFrame]:
        return self.imports_df, self.analysis_df

    def unresolved_imports(self) -> pd.DataFrame:
        return self.unresolved_df


def build_python_module_map(paths: list[str]) -> dict[str, str]:
    module_map: dict[str, str] = {}
    for rel_path in paths:
        if Path(rel_path).suffix != ".py":
            continue
        parts = list(PurePosixPath(rel_path).with_suffix("").parts)
        if not parts:
            continue
        if parts[-1] == "__init__":
            parts = parts[:-1]
        module_name = ".".join(parts)
        if module_name:
            module_map[module_name] = rel_path
    return module_map


def python_module_name(path: str) -> str:
    parts = list(PurePosixPath(path).with_suffix("").parts)
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def resolve_python_module(source_path: str, module: str | None, level: int, module_map: dict[str, str]) -> str | None:
    current_module = python_module_name(source_path)
    package_parts = current_module.split(".") if source_path.endswith("__init__.py") else current_module.split(".")[:-1]
    if level > 0:
        trim = max(0, level - 1)
        if trim:
            package_parts = package_parts[: max(0, len(package_parts) - trim)]
    base = ".".join(package_parts)
    full = module or ""
    if level > 0:
        full = ".".join([part for part in [base, module or ""] if part])
    full = full.strip(".")
    return module_map.get(full) if full else None


def resolve_python_relative_alias(source_path: str, alias: str, level: int, module_map: dict[str, str]) -> str | None:
    current_module = python_module_name(source_path)
    package_parts = current_module.split(".") if source_path.endswith("__init__.py") else current_module.split(".")[:-1]
    trim = max(0, level - 1)
    if trim:
        package_parts = package_parts[: max(0, len(package_parts) - trim)]
    full = ".".join([part for part in [".".join(package_parts), alias] if part]).strip(".")
    return module_map.get(full)


def extract_python_details(path: str, text: str, config: ExtractionConfig, module_map: dict[str, str]) -> tuple[list[dict[str, object]], dict[str, object], list[dict[str, object]]]:
    imports: list[dict[str, object]] = []
    unresolved: list[dict[str, object]] = []
    exports: list[str] = []
    docstring = ""
    try:
        tree = ast.parse(text, filename=path)
        docstring = ast.get_docstring(tree) or ""
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                exports.append(node.name)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    target = module_map.get(alias.name)
                    row = {
                        "source_path": path,
                        "raw_specifier": alias.name,
                        "import_type": "import",
                        "resolved_path": target,
                        "count": 1,
                    }
                    if target:
                        imports.append(row)
                    else:
                        unresolved.append(row)
            elif isinstance(node, ast.ImportFrom):
                raw_specifier = "." * node.level + (node.module or "")
                if node.module:
                    target = resolve_python_module(path, node.module, node.level, module_map)
                    row = {
                        "source_path": path,
                        "raw_specifier": raw_specifier,
                        "import_type": "from",
                        "resolved_path": target,
                        "count": max(1, len(node.names)),
                    }
                    if target:
                        imports.append(row)
                    else:
                        unresolved.append(row)
                else:
                    for alias in node.names:
                        target = resolve_python_relative_alias(path, alias.name, node.level, module_map)
                        row = {
                            "source_path": path,
                            "raw_specifier": raw_specifier + alias.name,
                            "import_type": "from",
                            "resolved_path": target,
                            "count": 1,
                        }
                        if target:
                            imports.append(row)
                        else:
                            unresolved.append(row)
    except SyntaxError:
        pass

    comments = [line.strip() for line in text.splitlines() if line.strip().startswith("#")]
    analysis = {
        "path": path,
        "module_name": python_module_name(path),
        "language": "python",
        "exported_symbols": json.dumps(sorted(set(exports))[: config.export_list_limit]),
        "docstring": docstring[:4000],
        "comment_excerpt": "\n".join(comments[: config.comment_line_count]),
        "preview_excerpt": "\n".join(text.splitlines()[: config.preview_line_count]),
        "import_specifiers": json.dumps(sorted({row["raw_specifier"] for row in imports})[: config.import_list_limit]),
    }
    return imports, analysis, unresolved


def resolve_js_specifier(source_path: str, specifier: str, tracked_paths: set[str]) -> str | None:
    if not specifier.startswith("."):
        return None
    base = PurePosixPath(source_path).parent.joinpath(specifier)
    base_str = base.as_posix()
    candidates = [base_str]
    if Path(base_str).suffix:
        candidates.append(base_str)
    else:
        for suffix in [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]:
            candidates.append(base_str + suffix)
        for suffix in [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]:
            candidates.append(f"{base_str}/index{suffix}")
    normalized = []
    for candidate in candidates:
        norm = PurePosixPath(candidate).as_posix()
        while norm.startswith("./"):
            norm = norm[2:]
        normalized.append(norm)
    for candidate in normalized:
        if candidate in tracked_paths:
            return candidate
    return None


def extract_js_details(path: str, text: str, language: str, config: ExtractionConfig, tracked_paths: set[str]) -> tuple[list[dict[str, object]], dict[str, object], list[dict[str, object]]]:
    imports: list[dict[str, object]] = []
    unresolved: list[dict[str, object]] = []
    for match in IMPORT_RE.finditer(text):
        specifier = next(value for value in match.groupdict().values() if value)
        target = resolve_js_specifier(path, specifier, tracked_paths)
        row = {
            "source_path": path,
            "raw_specifier": specifier,
            "import_type": "import",
            "resolved_path": target,
            "count": 1,
        }
        if target:
            imports.append(row)
        else:
            unresolved.append(row)

    exports = [value for match in EXPORT_RE.finditer(text) for value in match.groupdict().values() if value]
    line_comments = [line.strip() for line in text.splitlines() if line.strip().startswith("//")]
    block_comments = [chunk.strip() for chunk in BLOCK_COMMENT_RE.findall(text)]
    analysis = {
        "path": path,
        "module_name": PurePosixPath(path).with_suffix("").as_posix().replace("/", "."),
        "language": language,
        "exported_symbols": json.dumps(sorted(set(exports))[: config.export_list_limit]),
        "docstring": "",
        "comment_excerpt": "\n".join((line_comments + block_comments)[: config.comment_line_count]),
        "preview_excerpt": "\n".join(text.splitlines()[: config.preview_line_count]),
        "import_specifiers": json.dumps(sorted({row["raw_specifier"] for row in imports})[: config.import_list_limit]),
    }
    return imports, analysis, unresolved


def build_summary_text(row: dict[str, object]) -> str:
    return "\n".join(
        [
            f"path: {row['path']}",
            f"language: {row['language']}",
            f"module: {row['module_name']}",
            f"imports: {row['import_specifiers']}",
            f"exports: {row['exported_symbols']}",
            f"docstring: {row['docstring']}",
            f"comments: {row['comment_excerpt']}",
            "preview:",
            str(row["preview_excerpt"]),
        ]
    ).strip()


def extract_dependencies(
    repo_path: str | Path,
    files_df: pd.DataFrame,
    config: ExtractionConfig,
) -> DependencyExtractionResult:
    repo_root = Path(repo_path)
    tracked_paths = set(files_df["path"].tolist())
    python_module_map = build_python_module_map(files_df["path"].tolist())
    import_rows: list[dict[str, object]] = []
    analysis_rows: list[dict[str, object]] = []
    unresolved_rows: list[dict[str, object]] = []

    for row in files_df.sort_values("path").itertuples(index=False):
        abs_path = repo_root / row.path
        try:
            text = abs_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if row.language == "python":
            imports, analysis, unresolved = extract_python_details(row.path, text, config, python_module_map)
        elif row.language in {"javascript", "typescript"}:
            imports, analysis, unresolved = extract_js_details(row.path, text, row.language, config, tracked_paths)
        else:
            imports = []
            unresolved = []
            analysis = {
                "path": row.path,
                "module_name": PurePosixPath(row.path).with_suffix("").as_posix().replace("/", "."),
                "language": row.language,
                "exported_symbols": json.dumps([]),
                "docstring": "",
                "comment_excerpt": "",
                "preview_excerpt": "\n".join(text.splitlines()[: config.preview_line_count]),
                "import_specifiers": json.dumps([]),
            }
        analysis["summary_text"] = build_summary_text(analysis)[:6000]
        import_rows.extend(imports)
        analysis_rows.append(analysis)
        unresolved_rows.extend(unresolved)

    imports_df = pd.DataFrame(import_rows)
    if imports_df.empty:
        imports_df = pd.DataFrame(columns=["source_path", "raw_specifier", "import_type", "resolved_path", "count"])
    else:
        imports_df = (
            imports_df.groupby(["source_path", "raw_specifier", "import_type", "resolved_path"], as_index=False)
            .agg(count=("count", "sum"))
            .sort_values(["source_path", "raw_specifier", "resolved_path"])
            .reset_index(drop=True)
        )

    if analysis_rows:
        analysis_df = pd.DataFrame(analysis_rows).sort_values("path").reset_index(drop=True)
    else:
        analysis_df = pd.DataFrame(
            columns=[
                "path",
                "module_name",
                "language",
                "exported_symbols",
                "docstring",
                "comment_excerpt",
                "preview_excerpt",
                "import_specifiers",
                "summary_text",
            ]
        )

    unresolved_df = pd.DataFrame(unresolved_rows)
    if unresolved_df.empty:
        unresolved_df = pd.DataFrame(columns=["source_path", "raw_specifier", "import_type", "resolved_path", "count"])
    else:
        unresolved_df = (
            unresolved_df.groupby(["source_path", "raw_specifier", "import_type", "resolved_path"], as_index=False)
            .agg(count=("count", "sum"))
            .sort_values(["source_path", "raw_specifier"])
            .reset_index(drop=True)
        )

    return DependencyExtractionResult(
        imports_df=imports_df,
        analysis_df=analysis_df,
        unresolved_df=unresolved_df,
    )
