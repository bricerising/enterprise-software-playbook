"""Suggestion generation for architecture observability reports.

Extracted from report.py — contains rule-based, Codex, and Claude suggestion
providers, normalisation helpers, and HTML/Markdown rendering for suggestions.
"""

from __future__ import annotations

from collections import defaultdict
import html
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import TYPE_CHECKING, Callable

import pandas as pd

if TYPE_CHECKING:
    from archobs.graph_viz import ReportGraphSnapshot


# ---------------------------------------------------------------------------
# Path / label helpers
# ---------------------------------------------------------------------------


def _cluster_scope_paths(file_metrics_df: pd.DataFrame, cluster_id: int, limit: int = 4) -> str:
    if file_metrics_df.empty or "cluster_id" not in file_metrics_df:
        return f"cluster {cluster_id}"
    scoped = file_metrics_df[file_metrics_df["cluster_id"] == cluster_id].sort_values(
        ["risk", "xnbr", "hubness"],
        ascending=[False, False, False],
    )
    paths = scoped["path"].head(limit).tolist()
    if not paths:
        return f"cluster {cluster_id}"
    return ", ".join(str(path) for path in paths)


def _sample_cluster_paths(file_metrics_df: pd.DataFrame, cluster_id: int, limit: int = 4) -> list[str]:
    if file_metrics_df.empty or "cluster_id" not in file_metrics_df:
        return []
    scoped = file_metrics_df[file_metrics_df["cluster_id"] == cluster_id].sort_values(
        ["risk", "xnbr", "hubness"],
        ascending=[False, False, False],
    )
    return [str(path) for path in scoped["path"].head(limit).tolist()]


def _path_domain(path: str) -> str:
    parts = list(Path(path).parts)
    if len(parts) <= 1:
        return path
    if parts[0] in {"src", "packages"}:
        dirs = parts[:-1]
        return "/".join(dirs[: min(len(dirs), 4)])
    return "/".join(parts[:-1][:3]) or path


def _boundary_label(paths: list[str]) -> str:
    if not paths:
        return "the referenced files"
    ranked: dict[str, int] = defaultdict(int)
    for path in paths:
        ranked[_path_domain(path)] += 1
    ordered = sorted(ranked.items(), key=lambda item: (-item[1], item[0]))
    labels = [label for label, _ in ordered[:2]]
    return " + ".join(labels)


def _humanize_path_token(token: str) -> str:
    parts = [part for part in Path(token).parts if part not in {"src", "services", "controllers", "routes", "schemas", "packages", "lib", "test", "tests"}]
    cleaned = []
    for part in parts:
        stem = part.replace(".ts", "").replace(".js", "").replace(".py", "")
        stem = stem.replace(".service", "").replace(".controller", "").replace(".routes", "")
        stem = stem.replace(".schema", "").replace(".middleware", "").replace(".utils", "")
        stem = stem.replace("-", " ").replace("_", " ").strip()
        if stem and stem != "index":
            cleaned.append(stem)
    if not cleaned:
        return token.replace("/", " ").replace("-", " ").strip()
    return " ".join(cleaned[-2:])


def _humanize_area_label(label: str) -> str:
    parts = [part.strip() for part in label.split("+") if part.strip()]
    human = [_humanize_path_token(part) for part in parts[:2]]
    return " and ".join(part for part in human if part).strip() or label


def _collapse_duplicate_words(text: str) -> str:
    words = text.split()
    deduped: list[str] = []
    for word in words:
        normalized = re.sub(r"[^a-z0-9]+", "", word.lower())
        previous = re.sub(r"[^a-z0-9]+", "", deduped[-1].lower()) if deduped else ""
        if normalized and normalized == previous:
            continue
        deduped.append(word)
    return " ".join(deduped)


def _path_replacement_label(raw: str) -> str:
    candidate = raw.strip().strip(".,:;")
    if "+" in candidate or "/" in candidate:
        return _humanize_area_label(candidate)
    return candidate


# ---------------------------------------------------------------------------
# Suggestion text normalisation
# ---------------------------------------------------------------------------


def _sanitize_suggestion_text(text: str) -> str:
    if not text:
        return ""
    cleaned = text
    cleaned = re.sub(r"`([^`]+)`", lambda match: _path_replacement_label(match.group(1)), cleaned)
    cleaned = re.sub(
        r"'((?:src|packages|apps|lib|tests?)/[^']+)'",
        lambda match: _path_replacement_label(match.group(1)),
        cleaned,
    )
    cleaned = re.sub(
        r"\b((?:src|packages|apps|lib|tests?)/[A-Za-z0-9_./+-]+)\b",
        lambda match: _path_replacement_label(match.group(1)),
        cleaned,
    )
    cleaned = cleaned.replace(" + ", " and ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def _normalize_suggestion_title(title: str) -> str:
    cleaned = _sanitize_suggestion_text(title).replace("/", " and ").replace("'", "")
    cleaned = _collapse_duplicate_words(re.sub(r"\s+", " ", cleaned).strip(" ."))
    if not cleaned:
        return "Clarify the boundary"
    return cleaned[0].upper() + cleaned[1:]


def _compact_why_text(text: str) -> str:
    cleaned = _sanitize_suggestion_text(text)
    sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", cleaned) if part.strip()]
    if len(sentences) > 2:
        cleaned = " ".join(sentences[:2])
    return cleaned


def _normalize_suggestion_payload(suggestions: list[dict[str, str]]) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    for suggestion in suggestions:
        normalized.append(
            {
                "priority": str(suggestion["priority"]),
                "title": _normalize_suggestion_title(str(suggestion["title"])),
                "why": _compact_why_text(str(suggestion["why"])),
                "change": _sanitize_suggestion_text(str(suggestion["change"])),
                "scope": str(suggestion["scope"]).strip(),
            }
        )
    return normalized


def _graph_boundary_profiles(graph_snapshot: ReportGraphSnapshot | None) -> list[dict[str, object]]:
    if graph_snapshot is None:
        return []
    return [dict(profile) for profile in graph_snapshot.boundary_profiles]


# ---------------------------------------------------------------------------
# Rule-based suggestion engine
# ---------------------------------------------------------------------------


def _rule_based_change_suggestions(
    summary: dict[str, object],
    cluster_metrics_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    unresolved_df: pd.DataFrame,
    drift_df: pd.DataFrame,
    boundary_profiles: list[dict[str, object]] | None = None,
    limit: int = 4,
) -> list[dict[str, str]]:
    suggestions: list[dict[str, str]] = []
    node_count = int(summary.get("node_count", 0))
    cluster_count = int(summary.get("cluster_count", 0))
    boundary_profiles = boundary_profiles or []

    if cluster_count <= 1 and node_count >= 10:
        scope = ", ".join(file_metrics_df["path"].head(4).tolist()) if not file_metrics_df.empty else "the current repo slice"
        suggestions.append(
            {
                "priority": "High",
                "title": "Separate product code from support code before the next refactor",
                "why": f"The current run collapsed {node_count} files into one subsystem, so the boundary map is too coarse to drive safe structural edits.",
                "change": "Pull tests, tooling, or cross-cutting support modules behind their own package boundary so the core product areas can cluster independently.",
                "scope": scope,
            }
        )

    if not cluster_metrics_df.empty:
        leaky = cluster_metrics_df.sort_values(["leakage", "risk_max"], ascending=[False, False]).iloc[0]
        if float(leaky["leakage"]) >= 0.20:
            cluster_id = int(leaky["cluster_id"])
            profile = next((item for item in boundary_profiles if int(item["cluster_id"]) == cluster_id), None)
            neighbor = profile["neighbors"][0] if profile and profile["neighbors"] else None
            if profile and neighbor:
                source_label = str(profile["label"])
                target_label = str(neighbor["label"])
                source_name = _humanize_area_label(source_label)
                target_name = _humanize_area_label(target_label)
                boundary_scope = ", ".join(list(profile["paths"][:2]) + list(neighbor["paths"][:2]))
                title = f"Separate {source_name} from {target_name}"
                why = (
                    f"Cluster {cluster_id} leaks {float(leaky['leakage']):.0%} of its weighted relationships, and its strongest outward pull is toward "
                    f"{target_name} (edge weight {float(neighbor['weight']):.2f})."
                )
                change = (
                    f"Create an explicit boundary between {source_name} and {target_name}, so one side consumes a stable contract instead of reaching across the seam directly."
                )
                scope = boundary_scope
            else:
                title = f"Introduce a narrower interface around cluster {cluster_id}"
                why = f"Cluster {cluster_id} leaks {float(leaky['leakage']):.0%} of its weighted relationships across its boundary, which suggests responsibilities are bleeding into neighboring subsystems."
                change = "Route cross-cluster coordination through a smaller facade or orchestration layer instead of letting many files depend on each other directly."
                scope = _cluster_scope_paths(file_metrics_df, cluster_id)
            suggestions.append(
                {
                    "priority": "High" if float(leaky["leakage"]) >= 0.40 else "Medium",
                    "title": title,
                    "why": why,
                    "change": change,
                    "scope": scope,
                }
            )

    if not file_metrics_df.empty:
        top_file = file_metrics_df.sort_values(["risk", "xnbr", "hubness"], ascending=[False, False, False]).iloc[0]
        path = str(top_file["path"])
        cluster_id = int(top_file.get("cluster_id", -1))
        area_name = _humanize_path_token(path)
        has_high_volatility = "volatility" in top_file.index and float(top_file.get("volatility", 0)) >= 0.8
        if float(top_file["xnbr"]) >= 0.35:
            # Boost to High if also highly volatile (being changed constantly AND risky)
            base_priority = "High" if float(top_file["xnbr"]) >= 0.50 else "Medium"
            if has_high_volatility and base_priority == "Medium":
                base_priority = "High"
            volatility_note = " It also has very high volatility, meaning it is being changed constantly." if has_high_volatility else ""
            suggestions.append(
                {
                    "priority": base_priority,
                    "title": f"Break apart mixed responsibilities in {area_name}",
                    "why": f"This area has a cross-boundary neighbor ratio of {float(top_file['xnbr']):.0%}, so it is semantically aligned with more than one concern.{volatility_note}",
                    "change": "Separate orchestration and shared boundary logic from the domain logic so this file stops acting as a conceptual bridge between subsystems.",
                    "scope": f"{path} plus nearby files in {_cluster_scope_paths(file_metrics_df, cluster_id, limit=3)}",
                }
            )
        elif float(top_file["hubness"]) >= 0.45:
            hub_priority = "High" if has_high_volatility else "Medium"
            volatility_note = " It is also highly volatile, compounding the blast radius." if has_high_volatility else ""
            suggestions.append(
                {
                    "priority": hub_priority,
                    "title": f"Reduce direct fan-in around {area_name}",
                    "why": f"This area is currently one of the strongest hubs in the graph, which increases blast radius when it changes.{volatility_note}",
                    "change": "Extract leaf helpers or add a narrower entrypoint so downstream files depend on one stable surface instead of this file's full implementation.",
                    "scope": path,
                }
            )

    if len(unresolved_df) > 0:
        import_scope = ", ".join(unresolved_df["source_path"].head(4).tolist())
        suggestions.append(
            {
                "priority": "Medium",
                "title": "Repair unresolved internal imports before moving code",
                "why": f"{len(unresolved_df)} unresolved imports weaken the dependency graph and make structural recommendations less trustworthy.",
                "change": "Normalize local module paths and internal import conventions so future moves and extractions operate on an accurate dependency map.",
                "scope": import_scope,
            }
        )

    drift_ari_column = None
    if "ari_prev" in drift_df:
        drift_ari_column = "ari_prev"
    elif "ari" in drift_df:
        drift_ari_column = "ari"

    if not drift_df.empty and drift_ari_column is not None:
        lowest = drift_df.sort_values(drift_ari_column, ascending=True).iloc[0]
        if float(lowest[drift_ari_column]) < 0.50:
            # Check the ARI trend (last 2 windows) to determine if architecture is stabilizing
            ari_values = drift_df[drift_ari_column].tolist()
            trend_rising = len(ari_values) >= 2 and ari_values[-1] > ari_values[-2]
            if trend_rising and ari_values[-1] >= 0.60:
                # ARI is rising and recent value is reasonable — downgrade to Low
                drift_priority = "Low"
                trend_note = f" However, the trend is stabilizing (recent ARI {float(ari_values[-1]):.2f})."
            else:
                drift_priority = "Medium"
                trend_note = ""
            suggestions.append(
                {
                    "priority": drift_priority,
                    "title": "Stabilize cluster naming and ownership before the next large move",
                    "why": f"The weakest drift window has ARI {float(lowest[drift_ari_column]):.2f}, which suggests the subsystem map is changing quickly over time.{trend_note}",
                    "change": "Avoid broad package moves until the unstable area has a clearer owner and a narrower boundary, otherwise future changes will continue to reshuffle the same files.",
                    "scope": "the lowest-stability cluster window in the drift table",
                }
            )

    if not suggestions:
        suggestions.append(
            {
                "priority": "Low",
                "title": "Preserve current boundaries while paying down small hotspots",
                "why": "The current snapshot does not show an urgent structural break, so the best next step is to make narrow changes instead of a broad reorganization.",
                "change": "Limit the next refactor to the top-risk file or the leakiest cluster and keep everything else stable until you have a new snapshot.",
                "scope": ", ".join(file_metrics_df["path"].head(3).tolist()) if not file_metrics_df.empty else "the current codebase slice",
            }
        )

    priority_rank = {"High": 0, "Medium": 1, "Low": 2}
    suggestions.sort(key=lambda item: (priority_rank.get(item["priority"], 9), item["title"]))
    deduped: list[dict[str, str]] = []
    seen_titles: set[str] = set()
    for suggestion in suggestions:
        if suggestion["title"] in seen_titles:
            continue
        seen_titles.add(suggestion["title"])
        deduped.append(suggestion)
        if len(deduped) >= limit:
            break
    return deduped


# ---------------------------------------------------------------------------
# Codex / Claude provider helpers
# ---------------------------------------------------------------------------


def _codex_prompt(
    summary: dict[str, object],
    cluster_metrics_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    unresolved_df: pd.DataFrame,
    drift_df: pd.DataFrame,
    boundary_profiles: list[dict[str, object]],
    limit: int,
) -> str:
    payload = {
        "summary": {
            "node_count": summary.get("node_count", 0),
            "edge_count": summary.get("edge_count", 0),
            "cluster_count": summary.get("cluster_count", 0),
            "hub_deg": summary.get("hub_deg", 0),
            "modularity": summary.get("modularity", 0),
            "embedding_provider": summary.get("embedding_provider", "unknown"),
        },
        "top_clusters": cluster_metrics_df[["cluster_id", "size", "cohesion", "leakage", "conductance", "risk_mean", "risk_max"]]
        .head(5)
        .to_dict(orient="records"),
        "top_files": file_metrics_df[["path", "cluster_id", "risk", "xnbr", "hubness", "volatility"]]
        .head(8)
        .to_dict(orient="records"),
        "boundary_profiles": boundary_profiles,
        "unresolved_imports": unresolved_df[["source_path", "raw_specifier", "count"]].head(8).to_dict(orient="records"),
        "drift": drift_df.head(4).to_dict(orient="records"),
    }
    return (
        "You are generating high-level code change suggestions for an architecture observability report.\n"
        f"Return at most {limit} suggestions.\n"
        "Rules:\n"
        "- Suggestions must be high level and architectural.\n"
        "- Do not include code snippets, pseudocode, diffs, or literal implementation steps.\n"
        "- Base suggestions only on the evidence provided below.\n"
        "- When suggesting a new boundary, name both sides of the boundary using actual repo areas, path groups, or neighboring cluster labels from the evidence.\n"
        "- Avoid generic phrases like 'logical clusters' or 'highest-leakage areas' when the evidence includes more specific boundary candidates.\n"
        "- Titles must be short, descriptive, and domain-oriented. Do not put file paths, folder paths, backticks, filenames, or slash-delimited repo segments in the title.\n"
        "- Prefer titles like 'Separate studio configuration from POS transactions' over titles that quote a folder name.\n"
        "- Put concrete repo areas and path groups in `scope`, not in the title.\n"
        "- Keep `why` evidence-focused, limited to 1-2 sentences, and avoid repeating file or folder paths that already appear in `scope`.\n"
        "- `scope` should be a compact comma-separated list of concrete repo areas or path groups, not a full sentence.\n"
        "- Return a JSON object with one field only: `suggestions`.\n"
        "- `suggestions` must be an array of objects.\n"
        "- Each suggestion object must fit these fields exactly: priority, title, why, change, scope.\n"
        "- `priority` must be one of: High, Medium, Low.\n\n"
        f"Analysis evidence:\n{json.dumps(payload, indent=2, sort_keys=True)}\n"
    )


def _suggestion_schema(limit: int) -> dict[str, object]:
    return {
        "type": "object",
        "required": ["suggestions"],
        "additionalProperties": False,
        "properties": {
            "suggestions": {
                "type": "array",
                "minItems": 1,
                "maxItems": max(1, limit),
                "items": {
                    "type": "object",
                    "required": ["priority", "title", "why", "change", "scope"],
                    "additionalProperties": False,
                    "properties": {
                        "priority": {"type": "string", "enum": ["High", "Medium", "Low"]},
                        "title": {"type": "string", "maxLength": 90, "pattern": r"^[^`/\\\\]+$"},
                        "why": {"type": "string"},
                        "change": {"type": "string"},
                        "scope": {"type": "string"},
                    },
                },
            },
        },
    }


def _coerce_suggestions(payload: object, provider_name: str) -> list[dict[str, str]]:
    suggestions: object | None = None
    if isinstance(payload, dict):
        suggestions = payload.get("suggestions")
        if suggestions is None and "structured_output" in payload:
            structured_output = payload.get("structured_output")
            if isinstance(structured_output, dict):
                suggestions = structured_output.get("suggestions")
        if suggestions is None and "result" in payload:
            result = payload.get("result")
            if isinstance(result, str):
                try:
                    nested = json.loads(result)
                except json.JSONDecodeError:
                    nested = None
                if isinstance(nested, dict):
                    suggestions = nested.get("suggestions")
            elif isinstance(result, dict):
                suggestions = result.get("suggestions")
    elif isinstance(payload, list):
        suggestions = payload

    if not isinstance(suggestions, list) or not suggestions:
        raise RuntimeError(f"{provider_name} returned no suggestions")

    return [
        {
            "priority": str(item["priority"]),
            "title": str(item["title"]),
            "why": str(item["why"]),
            "change": str(item["change"]),
            "scope": str(item["scope"]),
        }
        for item in suggestions
    ]


def _claude_error_message(stdout: str, stderr: str) -> str:
    raw_stdout = stdout.strip()
    if raw_stdout:
        try:
            payload = json.loads(raw_stdout)
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict):
            errors = payload.get("errors")
            if isinstance(errors, list) and errors:
                compact = " | ".join(str(item).strip() for item in errors if str(item).strip())
                if compact:
                    return compact[:400]
            result = payload.get("result")
            if isinstance(result, str) and result.strip():
                return result.strip()[:400]
    raw_stderr = stderr.strip()
    if raw_stderr:
        return raw_stderr[:400]
    if raw_stdout:
        return raw_stdout[:400]
    return "claude suggestion generation failed"


def _codex_change_suggestions(
    repo_path: str | Path,
    summary: dict[str, object],
    cluster_metrics_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    unresolved_df: pd.DataFrame,
    drift_df: pd.DataFrame,
    boundary_profiles: list[dict[str, object]],
    limit: int,
    timeout_seconds: int,
) -> list[dict[str, str]]:
    codex_bin = shutil.which("codex")
    if not codex_bin:
        raise FileNotFoundError("codex CLI is not installed")

    schema = _suggestion_schema(limit)

    with tempfile.TemporaryDirectory(prefix="archobs-codex-") as tmp_dir:
        tmp_root = Path(tmp_dir)
        schema_path = tmp_root / "suggestions.schema.json"
        output_path = tmp_root / "suggestions.json"
        schema_path.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
        prompt = _codex_prompt(summary, cluster_metrics_df, file_metrics_df, unresolved_df, drift_df, boundary_profiles, limit)
        completed = subprocess.run(
            [
                codex_bin,
                "exec",
                "--ephemeral",
                "--sandbox",
                "read-only",
                "--color",
                "never",
                "--output-schema",
                str(schema_path),
                "-o",
                str(output_path),
                prompt,
            ],
            cwd=Path(repo_path),
            capture_output=True,
            text=True,
            timeout=max(1, timeout_seconds),
            check=False,
        )
        if completed.returncode != 0 or not output_path.exists():
            raise RuntimeError((completed.stderr or completed.stdout).strip() or "codex suggestion generation failed")
        payload = json.loads(output_path.read_text(encoding="utf-8"))
        return _coerce_suggestions(payload, "codex")[:limit]


def _claude_change_suggestions(
    repo_path: str | Path,
    summary: dict[str, object],
    cluster_metrics_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    unresolved_df: pd.DataFrame,
    drift_df: pd.DataFrame,
    boundary_profiles: list[dict[str, object]],
    limit: int,
    timeout_seconds: int,
) -> list[dict[str, str]]:
    claude_bin = shutil.which("claude")
    if not claude_bin:
        raise FileNotFoundError("claude CLI is not installed")

    prompt = _codex_prompt(summary, cluster_metrics_df, file_metrics_df, unresolved_df, drift_df, boundary_profiles, limit)
    schema = json.dumps(_suggestion_schema(limit), separators=(",", ":"))
    completed = subprocess.run(
        [
            claude_bin,
            "-p",
            prompt,
            "--output-format",
            "json",
            "--json-schema",
            schema,
            "--permission-mode",
            "dontAsk",
            "--tools",
            "",
        ],
        cwd=Path(repo_path),
        capture_output=True,
        text=True,
        timeout=max(1, timeout_seconds),
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(_claude_error_message(completed.stdout, completed.stderr))
    raw_output = (completed.stdout or "").strip()
    if not raw_output:
        raise RuntimeError("claude returned no suggestions")
    payload = json.loads(raw_output)
    return _coerce_suggestions(payload, "claude")[:limit]


def _suggestion_error_message(error: Exception, provider_name: str) -> str:
    provider_command = "`codex exec`" if provider_name == "codex" else "`claude -p`"
    if isinstance(error, subprocess.TimeoutExpired):
        return f"timed out after {int(error.timeout)}s waiting for {provider_command}"
    if isinstance(error, FileNotFoundError):
        return f"the `{provider_name}` CLI is not installed or not on PATH"
    raw = str(error).strip() or error.__class__.__name__
    compact = " ".join(raw.split())
    return compact[:400]


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def build_change_suggestions(
    repo_path: str | Path | None,
    summary: dict[str, object],
    cluster_metrics_df: pd.DataFrame,
    file_metrics_df: pd.DataFrame,
    unresolved_df: pd.DataFrame,
    drift_df: pd.DataFrame,
    graph_snapshot: ReportGraphSnapshot | None = None,
    provider: str = "rules",
    limit: int = 4,
    codex_timeout_seconds: int = 45,
    claude_timeout_seconds: int = 45,
) -> tuple[list[dict[str, str]], str, str | None]:
    normalized = provider.lower().strip()
    if normalized == "off":
        return [], "off", None
    if normalized in {"codex", "claude"} and repo_path is None:
        return [], f"{normalized}-error", f"repository path was not provided for {normalized.title()} suggestion generation"
    boundary_profiles = _graph_boundary_profiles(graph_snapshot)

    provider_attempts: list[tuple[str, Callable[..., list[dict[str, str]]], int]] = []
    if normalized == "auto":
        provider_attempts = [
            ("claude", _claude_change_suggestions, claude_timeout_seconds),
            ("codex", _codex_change_suggestions, codex_timeout_seconds),
        ]
    elif normalized == "codex":
        provider_attempts = [("codex", _codex_change_suggestions, codex_timeout_seconds)]
    elif normalized == "claude":
        provider_attempts = [("claude", _claude_change_suggestions, claude_timeout_seconds)]

    if provider_attempts and repo_path is not None:
        failures: list[str] = []
        for provider_name, runner, timeout_seconds in provider_attempts:
            try:
                suggestions = _normalize_suggestion_payload(
                    runner(
                        repo_path,
                        summary,
                        cluster_metrics_df,
                        file_metrics_df,
                        unresolved_df,
                        drift_df,
                        boundary_profiles,
                        limit,
                        timeout_seconds,
                    )
                )
                if suggestions:
                    return suggestions, provider_name, None
            except (FileNotFoundError, RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError, OSError) as error:
                message = _suggestion_error_message(error, provider_name)
                if normalized == provider_name:
                    return [], f"{provider_name}-error", message
                failures.append(f"{provider_name}: {message}")

        fallback = _normalize_suggestion_payload(
            _rule_based_change_suggestions(
                summary,
                cluster_metrics_df,
                file_metrics_df,
                unresolved_df,
                drift_df,
                boundary_profiles,
                limit,
            )
        )
        if normalized == "auto":
            return fallback, "rules-fallback-auto", " | ".join(failures) if failures else None

    suggestions = _normalize_suggestion_payload(
        _rule_based_change_suggestions(
            summary,
            cluster_metrics_df,
            file_metrics_df,
            unresolved_df,
            drift_df,
            boundary_profiles,
            limit,
        )
    )
    return suggestions, "rules", None


# ---------------------------------------------------------------------------
# HTML rendering helpers (used by report.py)
# ---------------------------------------------------------------------------


def suggestion_engine_label(engine: str) -> str:
    return {
        "codex": "Generated with Codex",
        "claude": "Generated with Claude",
        "rules": "Generated locally",
        "rules-fallback-auto": "Local fallback after Codex/Claude",
        "rules-fallback-codex": "Local fallback after Codex",
        "rules-fallback-claude": "Local fallback after Claude",
        "codex-error": "Codex unavailable",
        "claude-error": "Claude unavailable",
        "off": "Suggestions disabled",
    }.get(engine, engine)


def suggestion_error_label(engine: str) -> str:
    if "codex" in engine:
        return "Codex error"
    if "claude" in engine:
        return "Claude error"
    return "Suggestion provider error"


def _scope_parts(scope: str) -> list[str]:
    code_parts = [part.strip().strip(".") for part in re.findall(r"`([^`]+)`", scope)]
    if code_parts:
        return code_parts
    cleaned = scope.replace("`", "").strip().strip(".")
    for prefix in ("Boundary between ", "Within ", "Scope: "):
        if cleaned.startswith(prefix):
            cleaned = cleaned[len(prefix) :]
    parts = []
    for part in cleaned.split(","):
        item = part.strip().strip(".")
        item = re.sub(r"^(and|plus|especially)\s+", "", item)
        if item:
            parts.append(item)
    return parts


def _scope_badges_html(scope: str) -> str:
    parts = _scope_parts(scope)
    if not parts:
        return f"<span class='scope-badge'>{html.escape(scope)}</span>"
    return "".join(f"<span class='scope-badge'>{html.escape(part)}</span>" for part in parts)


def suggestions_html(suggestions: list[dict[str, str]]) -> str:
    if not suggestions:
        return "<p class='quiet'>Suggestions are disabled for this run.</p>"
    return "\n".join(
        f"""
        <article class="action-card suggestion-card priority-{suggestion['priority'].lower()}">
          <div class="suggestion-rail">
            <div class="action-meta">{html.escape(suggestion['priority'])} priority</div>
            <h3>{html.escape(suggestion['title'])}</h3>
          </div>
          <div class="suggestion-body">
            <div class="suggestion-block suggestion-change">
              <div class="suggestion-label">Suggested Change</div>
              <p>{html.escape(suggestion['change'])}</p>
            </div>
            <div class="suggestion-block suggestion-why">
              <div class="suggestion-label">Why</div>
              <p>{html.escape(suggestion['why'])}</p>
            </div>
            <div class="suggestion-block suggestion-scope">
              <div class="suggestion-label">Scope</div>
              <div class="scope-badges">{_scope_badges_html(suggestion['scope'])}</div>
            </div>
          </div>
        </article>
        """
        for suggestion in suggestions
    )


# ---------------------------------------------------------------------------
# Markdown formatting
# ---------------------------------------------------------------------------


def format_suggestion_markdown(suggestion: dict[str, str], index: int, total: int) -> str:
    title = suggestion.get("title", "Untitled")
    priority = suggestion.get("priority", "Unknown")
    scope = suggestion.get("scope", "")
    why = suggestion.get("why", "")
    change = suggestion.get("change", "")
    return (
        f"## Suggestion {index}/{total}: {title}\n"
        f"\n"
        f"**Priority:** {priority}\n"
        f"\n"
        f"**Scope:** {scope}\n"
        f"\n"
        f"### Problem\n"
        f"{why}\n"
        f"\n"
        f"### Suggested Change\n"
        f"{change}\n"
        f"\n"
        f"Please analyze the files in the scope above and implement this change."
        f" Explain your reasoning before making edits."
    )
