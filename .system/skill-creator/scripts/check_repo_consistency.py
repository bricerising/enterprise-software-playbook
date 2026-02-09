#!/usr/bin/env python3
"""
Check repo-level skill documentation consistency.

This script enforces lightweight drift guards for:
- workflow-stage headings in README/PROMPTS
- skill discoverability in README
- skill usability prompts in PROMPTS
- skill metadata/index consistency (`specs/skills-manifest.json`)
"""

import re
import sys
import json
from pathlib import Path

REQUIRED_WORKFLOW_HEADINGS = (
    "Define (what are we building?)",
    "Standardize (make it consistent)",
    "Harden (make it survive reality)",
    "Verify (prove behavior)",
    "Mechanics (in-process building blocks)",
)

PATTERN_SKILLS = {
    "patterns-creational",
    "patterns-structural",
    "patterns-behavioral",
}
STAGE_NAMES = ("Define", "Standardize", "Harden", "Verify", "Mechanics")


def _load_text(path: Path) -> str:
    try:
        return path.read_text()
    except FileNotFoundError:
        raise ValueError(f"Missing required file: {path}")


def _load_skill_frontmatter(skill_md_path: Path) -> dict[str, str]:
    try:
        content = skill_md_path.read_text()
    except FileNotFoundError:
        raise ValueError(f"Missing required file: {skill_md_path}")

    if not content.startswith("---"):
        raise ValueError(f"SKILL.md missing YAML frontmatter: {skill_md_path}")

    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not match:
        raise ValueError(f"Invalid frontmatter format in: {skill_md_path}")

    frontmatter_text = match.group(1)
    frontmatter: dict[str, str] = {}
    for line in frontmatter_text.splitlines():
        if not line.strip():
            continue
        if line[:1].isspace():
            continue
        kv = re.match(r"^([A-Za-z0-9_-]+):(?:\s*(.*))?$", line)
        if not kv:
            continue
        key = kv.group(1)
        value = (kv.group(2) or "").strip()
        if len(value) >= 2 and (
            (value[0] == value[-1] == '"') or (value[0] == value[-1] == "'")
        ):
            value = value[1:-1]
        frontmatter[key] = value
    return frontmatter


def _check_headings(readme_text: str, prompts_text: str, errors: list[str]) -> None:
    for heading in REQUIRED_WORKFLOW_HEADINGS:
        if heading not in readme_text:
            errors.append(f"README.md missing workflow heading: {heading}")
        if heading not in prompts_text:
            errors.append(f"PROMPTS.md missing workflow heading: {heading}")


def _check_readme_skills(skill_names: list[str], readme_text: str, errors: list[str]) -> None:
    for skill_name in skill_names:
        path_ref = f"skills/{skill_name}/SKILL.md"
        if path_ref not in readme_text:
            errors.append(f"README.md missing skill link: {path_ref}")


def _check_prompt_skills(skill_names: list[str], prompts_text: str, errors: list[str]) -> None:
    for skill_name in skill_names:
        if skill_name in PATTERN_SKILLS:
            if (
                "Use patterns-<creational|structural|behavioral>" in prompts_text
                or re.search(rf"\bUse\s+{re.escape(skill_name)}\b", prompts_text)
            ):
                continue
            errors.append(
                "PROMPTS.md missing pattern prompt coverage for "
                f"{skill_name} (expected combined or direct pattern prompt)"
            )
            continue

        if not re.search(rf"\bUse\s+{re.escape(skill_name)}\b", prompts_text):
            errors.append(f"PROMPTS.md missing copy/paste usage prompt for skill: {skill_name}")


def _check_finish_order(prompts_text: str, errors: list[str]) -> None:
    if "run finish first" in prompts_text.lower():
        errors.append("PROMPTS.md contains contradictory guidance: 'run finish first'")


def _check_manifest(repo_root: Path, skill_names: list[str], errors: list[str]) -> None:
    manifest_path = repo_root / "specs" / "skills-manifest.json"
    if not manifest_path.exists():
        errors.append(f"Missing skill manifest: {manifest_path}")
        return

    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as error:
        errors.append(f"Invalid JSON in skill manifest ({manifest_path}): {error}")
        return

    if not isinstance(manifest, dict):
        errors.append(f"Skill manifest must be a JSON object: {manifest_path}")
        return

    stages = manifest.get("stages")
    skills = manifest.get("skills")
    if not isinstance(stages, dict):
        errors.append(f"Skill manifest 'stages' must be an object: {manifest_path}")
        return
    if not isinstance(skills, dict):
        errors.append(f"Skill manifest 'skills' must be an object: {manifest_path}")
        return

    stage_keys = set(stages.keys())
    expected_stage_keys = set(STAGE_NAMES)
    if stage_keys != expected_stage_keys:
        errors.append(
            "Skill manifest stage keys mismatch. "
            f"Expected {sorted(expected_stage_keys)}, got {sorted(stage_keys)}"
        )

    manifest_skill_names = sorted(skills.keys())
    if manifest_skill_names != skill_names:
        missing = sorted(set(skill_names) - set(manifest_skill_names))
        extra = sorted(set(manifest_skill_names) - set(skill_names))
        if missing:
            errors.append(f"Skill manifest missing skill entries: {', '.join(missing)}")
        if extra:
            errors.append(f"Skill manifest has unknown skill entries: {', '.join(extra)}")

    stage_membership: dict[str, set[str]] = {}
    for stage_name in STAGE_NAMES:
        stage_list = stages.get(stage_name)
        if not isinstance(stage_list, list):
            errors.append(f"Skill manifest stage '{stage_name}' must map to an array")
            continue
        stage_membership[stage_name] = set()
        for skill_name in stage_list:
            if not isinstance(skill_name, str):
                errors.append(
                    f"Skill manifest stage '{stage_name}' contains non-string skill entry"
                )
                continue
            stage_membership[stage_name].add(skill_name)

    for skill_name in skill_names:
        entry = skills.get(skill_name)
        if not isinstance(entry, dict):
            errors.append(f"Skill manifest entry for '{skill_name}' must be an object")
            continue

        expected_path = f"skills/{skill_name}/SKILL.md"
        path = entry.get("path")
        if path != expected_path:
            errors.append(
                f"Skill manifest path mismatch for '{skill_name}': "
                f"expected '{expected_path}', got '{path}'"
            )

        stage = entry.get("stage")
        if stage not in STAGE_NAMES:
            errors.append(
                f"Skill manifest stage for '{skill_name}' must be one of {list(STAGE_NAMES)}"
            )
            continue

        if skill_name not in stage_membership.get(stage, set()):
            errors.append(
                f"Skill manifest stage list '{stage}' is missing skill '{skill_name}'"
            )

        tags = entry.get("tags")
        if not isinstance(tags, list) or not tags:
            errors.append(f"Skill manifest tags for '{skill_name}' must be a non-empty array")

        skill_md_path = repo_root / expected_path
        try:
            frontmatter = _load_skill_frontmatter(skill_md_path)
        except ValueError as error:
            errors.append(str(error))
            continue

        metadata_raw = frontmatter.get("metadata")
        if not metadata_raw:
            errors.append(f"Missing frontmatter metadata in {skill_md_path}")
            continue

        try:
            metadata = json.loads(metadata_raw)
        except json.JSONDecodeError as error:
            errors.append(
                f"Invalid frontmatter metadata JSON in {skill_md_path}: {error}"
            )
            continue

        if not isinstance(metadata, dict):
            errors.append(f"Frontmatter metadata in {skill_md_path} must decode to an object")
            continue

        if metadata.get("stage") != stage:
            errors.append(
                f"Stage mismatch for '{skill_name}': frontmatter='{metadata.get('stage')}' "
                f"manifest='{stage}'"
            )

        metadata_tags = metadata.get("tags")
        if not isinstance(metadata_tags, list):
            errors.append(f"Frontmatter metadata tags must be an array in {skill_md_path}")
            continue

        if sorted(metadata_tags) != sorted(tags):
            errors.append(
                f"Tag mismatch for '{skill_name}' between frontmatter and manifest"
            )


def run_checks(repo_root: Path) -> list[str]:
    errors: list[str] = []

    readme_path = repo_root / "README.md"
    prompts_path = repo_root / "PROMPTS.md"
    skills_root = repo_root / "skills"

    readme_text = _load_text(readme_path)
    prompts_text = _load_text(prompts_path)

    if not skills_root.is_dir():
        return [f"Missing skills directory: {skills_root}"]

    skill_names = sorted(
        skill_dir.name for skill_dir in skills_root.iterdir() if skill_dir.is_dir()
    )
    _check_headings(readme_text, prompts_text, errors)
    _check_readme_skills(skill_names, readme_text, errors)
    _check_prompt_skills(skill_names, prompts_text, errors)
    _check_finish_order(prompts_text, errors)
    _check_manifest(repo_root, skill_names, errors)
    return errors


def main() -> int:
    repo_root = Path(__file__).resolve().parents[3]
    try:
        errors = run_checks(repo_root)
    except ValueError as error:
        print(f"[ERROR] {error}")
        return 1

    if errors:
        print("[ERROR] Repository consistency checks failed:")
        for error in errors:
            print(f" - {error}")
        return 1

    print("[OK] Repository consistency checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
