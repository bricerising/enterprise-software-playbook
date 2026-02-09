#!/usr/bin/env python3
"""
Quick validation script for skills - minimal version
"""

import json
import re
import sys
from pathlib import Path

MAX_SKILL_NAME_LENGTH = 64
ALLOWED_STAGES = {"Define", "Standardize", "Harden", "Verify", "Mechanics"}
TAG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
REQUIRED_SECTION_PATTERNS = {
    "workflow": re.compile(r"^##\s+.*workflow\b", re.IGNORECASE | re.MULTILINE),
    "output template": re.compile(r"^##\s+.*output template\b", re.IGNORECASE | re.MULTILINE),
}


def _parse_frontmatter(frontmatter_text: str) -> tuple[dict, str | None]:
    """
    Parse a minimal subset of YAML frontmatter without external dependencies.

    Supports:
      - Top-level `key: value` pairs
      - Top-level `key:` pairs (nested values are ignored)
      - Folded/literal blocks for scalar values (`key: >` or `key: |`)

    Returns (frontmatter_dict, error_message_or_none).
    """

    def parse_scalar(raw: str) -> str:
        value = raw.strip()
        if len(value) >= 2 and ((value[0] == value[-1] == '"') or (value[0] == value[-1] == "'")):
            return value[1:-1]
        return value

    lines = frontmatter_text.splitlines()
    frontmatter: dict[str, str] = {}

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue

        # Only consider top-level keys (no indentation).
        if line[:1].isspace():
            i += 1
            continue

        match = re.match(r"^([A-Za-z0-9_-]+):(?:\s*(.*))?$", line)
        if not match:
            return {}, f"Invalid frontmatter line: {line!r}"

        key = match.group(1)
        raw_value = (match.group(2) or "").rstrip()

        if raw_value in ("|", ">"):
            block_style = raw_value
            block_lines: list[str] = []
            i += 1
            while i < len(lines):
                next_line = lines[i]
                if not next_line.strip():
                    block_lines.append("")
                    i += 1
                    continue
                if not next_line[:1].isspace():
                    break
                block_lines.append(next_line.lstrip())
                i += 1

            if block_style == "|":
                frontmatter[key] = "\n".join(block_lines).rstrip()
            else:
                # Folded: join non-empty lines with spaces; preserve blank lines as paragraph breaks.
                paragraphs: list[str] = []
                current: list[str] = []
                for bl in block_lines:
                    if bl == "":
                        if current:
                            paragraphs.append(" ".join(part.strip() for part in current).strip())
                            current = []
                        continue
                    current.append(bl)
                if current:
                    paragraphs.append(" ".join(part.strip() for part in current).strip())
                frontmatter[key] = "\n\n".join(p for p in paragraphs if p)
            continue

        frontmatter[key] = parse_scalar(raw_value)
        i += 1

    return frontmatter, None


def validate_skill(skill_path):
    """Basic validation of a skill"""
    skill_path = Path(skill_path)
    if not skill_path.exists():
        return False, f"Skill path does not exist: {skill_path}"
    if not skill_path.is_dir():
        return False, f"Skill path is not a directory: {skill_path}"

    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md not found"

    content = skill_md.read_text()
    if not content.startswith("---"):
        return False, "No YAML frontmatter found"

    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return False, "Invalid frontmatter format"

    frontmatter_text = match.group(1)

    frontmatter, parse_error = _parse_frontmatter(frontmatter_text)
    if parse_error:
        return False, f"Invalid YAML in frontmatter: {parse_error}"

    allowed_properties = {"name", "description", "license", "allowed-tools", "metadata"}

    unexpected_keys = set(frontmatter.keys()) - allowed_properties
    if unexpected_keys:
        allowed = ", ".join(sorted(allowed_properties))
        unexpected = ", ".join(sorted(unexpected_keys))
        return (
            False,
            f"Unexpected key(s) in SKILL.md frontmatter: {unexpected}. Allowed properties are: {allowed}",
        )

    if "name" not in frontmatter:
        return False, "Missing 'name' in frontmatter"
    if "description" not in frontmatter:
        return False, "Missing 'description' in frontmatter"
    if "metadata" not in frontmatter:
        return False, "Missing 'metadata' in frontmatter"

    name = frontmatter.get("name", "")
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name = name.strip()
    if not name:
        return False, "Frontmatter 'name' must be non-empty"
    if name != skill_path.name:
        return False, f"Name '{name}' must match skill folder name '{skill_path.name}'"
    if not re.match(r"^[a-z0-9-]+$", name):
        return (
            False,
            f"Name '{name}' should be hyphen-case (lowercase letters, digits, and hyphens only)",
        )
    if name.startswith("-") or name.endswith("-") or "--" in name:
        return (
            False,
            f"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens",
        )
    if len(name) > MAX_SKILL_NAME_LENGTH:
        return (
            False,
            f"Name is too long ({len(name)} characters). "
            f"Maximum is {MAX_SKILL_NAME_LENGTH} characters.",
        )

    description = frontmatter.get("description", "")
    if not isinstance(description, str):
        return False, f"Description must be a string, got {type(description).__name__}"
    description = description.strip()
    if not description:
        return False, "Frontmatter 'description' must be non-empty"
    if "<" in description or ">" in description:
        return False, "Description cannot contain angle brackets (< or >)"
    if len(description) > 1024:
        return (
            False,
            f"Description is too long ({len(description)} characters). Maximum is 1024 characters.",
        )

    metadata_raw = frontmatter.get("metadata", "")
    if not isinstance(metadata_raw, str):
        return False, f"Metadata must be a string, got {type(metadata_raw).__name__}"
    metadata_raw = metadata_raw.strip()
    if not metadata_raw:
        return False, "Frontmatter 'metadata' must be non-empty"

    try:
        metadata = json.loads(metadata_raw)
    except json.JSONDecodeError as error:
        return (
            False,
            "Frontmatter 'metadata' must be a valid JSON object string "
            f"(parse error: {error})",
        )

    if not isinstance(metadata, dict):
        return False, "Frontmatter 'metadata' must decode to a JSON object"

    allowed_metadata_keys = {"stage", "tags", "aliases"}
    unexpected_metadata_keys = set(metadata.keys()) - allowed_metadata_keys
    if unexpected_metadata_keys:
        unexpected = ", ".join(sorted(unexpected_metadata_keys))
        allowed = ", ".join(sorted(allowed_metadata_keys))
        return (
            False,
            "Frontmatter metadata contains unexpected key(s): "
            f"{unexpected}. Allowed keys are: {allowed}",
        )

    stage = metadata.get("stage")
    if not isinstance(stage, str) or stage not in ALLOWED_STAGES:
        allowed_stages = ", ".join(sorted(ALLOWED_STAGES))
        return (
            False,
            "Frontmatter metadata 'stage' must be one of: "
            f"{allowed_stages}",
        )

    tags = metadata.get("tags")
    if not isinstance(tags, list) or not tags:
        return False, "Frontmatter metadata 'tags' must be a non-empty array"
    for tag in tags:
        if not isinstance(tag, str):
            return False, "Frontmatter metadata 'tags' values must be strings"
        tag = tag.strip()
        if not TAG_PATTERN.match(tag):
            return (
                False,
                "Frontmatter metadata tag "
                f"'{tag}' must be lower-kebab-case and <=64 chars",
            )

    aliases = metadata.get("aliases")
    if aliases is not None:
        if not isinstance(aliases, list):
            return False, "Frontmatter metadata 'aliases' must be an array when present"
        for alias in aliases:
            if not isinstance(alias, str) or not alias.strip():
                return False, "Frontmatter metadata 'aliases' values must be non-empty strings"

    for section_name, pattern in REQUIRED_SECTION_PATTERNS.items():
        if not pattern.search(content):
            return (
                False,
                "Missing required SKILL.md section heading for "
                f"'{section_name}' (expected an H2 such as '## Workflow')",
            )

    return True, "Skill is valid!"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)

    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
