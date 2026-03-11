#!/usr/bin/env python3
"""Generate mkdocs.yml from specs/skills-manifest.json and filesystem discovery.

Reads the skills manifest for stage→skill ordering, walks the filesystem to
discover reference pages under each skill, and emits a complete mkdocs.yml
with an auto-generated nav section.

Because MkDocs 1.6+ forbids docs_dir from being the config file's parent, this
script also creates _build/docs/ with symlinks to the repo's markdown content.
Nav paths stay the same (e.g. skills/workflow/SKILL.md) — no content duplication.

Usage:
    python3 .system/docs/generate_mkdocs_nav.py > mkdocs.yml
"""

import json
import os
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
BUILD_DOCS_DIR = REPO_ROOT / "_build" / "docs"

# ---------------------------------------------------------------------------
# Symlink setup
# ---------------------------------------------------------------------------


def setup_docs_dir() -> None:
    """Create _build/docs/ with symlinks to source markdown content.

    This avoids duplicating files while satisfying MkDocs' requirement that
    docs_dir is not the config file's parent directory.
    """
    if BUILD_DOCS_DIR.exists():
        shutil.rmtree(BUILD_DOCS_DIR)
    BUILD_DOCS_DIR.mkdir(parents=True)

    # Symlink top-level markdown files
    for md in sorted(REPO_ROOT.glob("*.md")):
        target = os.path.relpath(md, BUILD_DOCS_DIR)
        (BUILD_DOCS_DIR / md.name).symlink_to(target)

    # Symlink content directories
    for dirname in ("skills", "specs", "tools"):
        src = REPO_ROOT / dirname
        if src.is_dir():
            target = os.path.relpath(src, BUILD_DOCS_DIR)
            (BUILD_DOCS_DIR / dirname).symlink_to(target)


# ---------------------------------------------------------------------------
# Title helpers
# ---------------------------------------------------------------------------

SPECIAL_TITLES = {
    "cqrs": "CQRS",
    "api-gateway-bff": "API Gateway / BFF",
    "remote-procedure-invocation-rpi": "Remote Procedure Invocation (RPI)",
    "SKILL": "Overview",
    "README": "Overview",
}

UPPERCASE_WORDS = {"api", "ui", "vm", "bff", "rpi", "cqrs", "nfrs", "http", "rpc"}


def _titlecase_words(text: str) -> str:
    """Convert hyphenated/underscored text to Title Case."""
    words = text.replace("-", " ").replace("_", " ").split()
    return " ".join(
        word.upper() if word.lower() in UPPERCASE_WORDS else word.capitalize()
        for word in words
    )


def title_from_filename(filename: str) -> str:
    """Derive a human-readable title from a markdown filename."""
    stem = Path(filename).stem
    if stem in SPECIAL_TITLES:
        return SPECIAL_TITLES[stem]
    return _titlecase_words(stem)


def title_for_decision(filename: str) -> str:
    """Format an ADR filename as 'ADR-NNN: Title'."""
    stem = Path(filename).stem
    if stem == "000-template":
        return "ADR Template"
    parts = stem.split("-", 1)
    if len(parts) == 2 and parts[0].isdigit():
        return f"ADR-{parts[0]}: {_titlecase_words(parts[1])}"
    return title_from_filename(filename)


# ---------------------------------------------------------------------------
# YAML helpers
# ---------------------------------------------------------------------------


def _yaml_safe(text: str) -> str:
    """Quote a string for use as a YAML key if it contains special chars."""
    if ": " in text or text.endswith(":") or "&" in text:
        return f'"{text}"'
    return text


def _serialize_nav_item(item: dict, indent: int) -> list[str]:
    """Recursively serialize a single nav mapping to YAML lines."""
    lines: list[str] = []
    prefix = " " * indent
    for key, value in item.items():
        safe_key = _yaml_safe(key)
        if isinstance(value, str):
            lines.append(f"{prefix}- {safe_key}: {value}")
        elif isinstance(value, list):
            lines.append(f"{prefix}- {safe_key}:")
            for child in value:
                lines.extend(_serialize_nav_item(child, indent + 2))
    return lines


def serialize_nav(nav: list) -> str:
    """Serialize the full nav list to a YAML string."""
    lines = ["nav:"]
    for item in nav:
        lines.extend(_serialize_nav_item(item, 2))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Nav building
# ---------------------------------------------------------------------------


def discover_references(skill_dir: Path) -> list[dict]:
    """Walk skills/<name>/references/ and return [{title: rel_path}, ...]."""
    refs_dir = skill_dir / "references"
    if not refs_dir.is_dir():
        return []
    refs = []
    for md_file in sorted(refs_dir.rglob("*.md")):
        rel_path = md_file.relative_to(REPO_ROOT)
        parts = md_file.relative_to(refs_dir).parts
        if len(parts) > 1:
            # e.g. snippets/typescript.md → "Snippets: TypeScript"
            subdir = _titlecase_words(parts[0])
            name = title_from_filename(parts[-1])
            title = f"{subdir}: {name}"
        else:
            title = title_from_filename(parts[0])
        refs.append({title: str(rel_path)})
    return refs


def _skill_display_name(skill_name: str) -> str:
    """Pretty-print a skill name for the nav."""
    if skill_name.startswith("patterns-"):
        kind = skill_name.split("-", 1)[1]
        return f"Patterns: {_titlecase_words(kind)}"
    return _titlecase_words(skill_name)


def build_skill_nav_entry(skill_name: str, skill_info: dict) -> dict:
    """Build a nav entry for one skill (with optional nested references)."""
    skill_path = skill_info["path"]
    skill_dir = REPO_ROOT / Path(skill_path).parent
    display_name = _skill_display_name(skill_name)
    refs = discover_references(skill_dir)

    if not refs:
        return {display_name: skill_path}

    entries: list[dict] = [{"Overview": skill_path}]
    entries.extend(refs)
    return {display_name: entries}


def build_nav(manifest: dict) -> list:
    """Assemble the complete nav list from the manifest + filesystem."""
    nav: list[dict] = []

    # ---- Home ----
    nav.append({"Home": "README.md"})

    # ---- Getting Started ----
    nav.append(
        {
            "Getting Started": [
                {"Prompt Recipes": "PROMPTS.md"},
                {"Tutorial": "TUTORIAL.md"},
                {"Glossary": "GLOSSARY.md"},
            ]
        }
    )

    # ---- Skills (grouped by stage) ----
    skills_section: list[dict] = []
    for stage_name, skill_names in manifest["stages"].items():
        stage_entries = [
            build_skill_nav_entry(name, manifest["skills"][name])
            for name in skill_names
        ]
        skills_section.append({stage_name: stage_entries})

    # Shared references (skills/references/)
    shared_dir = REPO_ROOT / "skills" / "references"
    if shared_dir.is_dir():
        shared = []
        for md in sorted(shared_dir.glob("*.md")):
            rel = str(md.relative_to(REPO_ROOT))
            t = "Overview" if md.name == "README.md" else title_from_filename(md.name)
            shared.append({t: rel})
        if shared:
            skills_section.append({"Shared References": shared})

    nav.append({"Skills": skills_section})

    # ---- Specifications ----
    specs_section: list[dict] = []
    spec_files = [
        ("Index", "specs/000-index.md"),
        ("Skill Library Charter", "specs/001-skill-library.md"),
        ("Skill Contract", "specs/002-skill-contract.md"),
        ("Taxonomy & Workflow", "specs/003-taxonomy-and-workflow.md"),
        ("Change Process", "specs/004-change-process.md"),
        ("Application Integration", "specs/005-application-integration.md"),
        ("Quickstart", "specs/quickstart.md"),
        ("Tasks", "specs/tasks.md"),
    ]
    for title, path in spec_files:
        if (REPO_ROOT / path).exists():
            specs_section.append({title: path})

    # Decision records
    decisions_dir = REPO_ROOT / "specs" / "decisions"
    if decisions_dir.is_dir():
        decision_entries = []
        for md in sorted(decisions_dir.glob("*.md")):
            rel = str(md.relative_to(REPO_ROOT))
            decision_entries.append({title_for_decision(md.name): rel})
        if decision_entries:
            specs_section.append({"Decision Records": decision_entries})

    nav.append({"Specifications": specs_section})

    # ---- Templates ----
    templates_section: list[dict] = []
    tpl_root = REPO_ROOT / "specs" / "templates"
    if (tpl_root / "README.md").exists():
        templates_section.append({"Overview": "specs/templates/README.md"})
    if (tpl_root / "app-repo" / "AGENTS.md").exists():
        templates_section.append(
            {"App-Repo AGENTS.md": "specs/templates/app-repo/AGENTS.md"}
        )

    bundle_dir = tpl_root / "service-spec-bundle"
    if bundle_dir.is_dir():
        bundle = []
        for md in sorted(bundle_dir.rglob("*.md")):
            rel = str(md.relative_to(REPO_ROOT))
            if md.name == "README.md":
                parent = md.parent.name
                t = "Overview" if parent == "service-spec-bundle" else _titlecase_words(parent)
            else:
                t = title_from_filename(md.name)
            bundle.append({t: rel})
        if bundle:
            templates_section.append({"Service Spec Bundle": bundle})

    nav.append({"Templates": templates_section})

    # ---- Top-level pages ----
    nav.append({"Contributing": "CONTRIBUTING.md"})
    nav.append({"Agent Integration": "AGENTS.md"})

    return nav


# ---------------------------------------------------------------------------
# Config template
# ---------------------------------------------------------------------------

BASE_CONFIG = """\
# Auto-generated by .system/docs/generate_mkdocs_nav.py
# Re-run the script to update:  python3 .system/docs/generate_mkdocs_nav.py > mkdocs.yml

site_name: Enterprise Software Playbook
site_description: AI-assisted skills for building enterprise software
repo_url: https://github.com/bricerising/enterprise-software-playbook
repo_name: enterprise-software-playbook
docs_dir: _build/docs
site_dir: site

theme:
  name: material
  features:
    - navigation.tabs
    - navigation.sections
    - navigation.expand
    - navigation.top
    - navigation.indexes
    - navigation.instant
    - search.suggest
    - search.highlight
    - content.code.copy
    - content.tabs.link
    - toc.follow
  palette:
    - scheme: default
      primary: indigo
      accent: indigo
      toggle:
        icon: material/brightness-7
        name: Switch to dark mode
    - scheme: slate
      primary: indigo
      accent: indigo
      toggle:
        icon: material/brightness-4
        name: Switch to light mode
  icon:
    repo: fontawesome/brands/github

markdown_extensions:
  - admonition
  - pymdownx.details
  - pymdownx.superfences
  - pymdownx.highlight:
      anchor_linenums: true
  - pymdownx.inlinehilite
  - pymdownx.tabbed:
      alternate_style: true
  - pymdownx.tasklist:
      custom_checkbox: true
  - toc:
      permalink: true
  - tables
  - attr_list
  - md_in_html
  - def_list

plugins:
  - search

exclude_docs: |
  *.json
  *.yml
  *.yaml
  *.py
  *.pyc
  *.txt
  *.toml
  *.cfg

validation:
  nav:
    omitted_files: info
    not_found: warn
    absolute_links: info
"""

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    manifest_path = REPO_ROOT / "specs" / "skills-manifest.json"
    if not manifest_path.exists():
        print(f"Error: {manifest_path} not found", file=sys.stderr)
        sys.exit(1)

    with open(manifest_path) as f:
        manifest = json.load(f)

    setup_docs_dir()
    nav = build_nav(manifest)
    print(BASE_CONFIG)
    print(serialize_nav(nav))


if __name__ == "__main__":
    main()
