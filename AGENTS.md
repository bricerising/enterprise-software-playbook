# Agent Instructions (enterprise-software-playbook)

This repo is itself an opinionated system for writing agent skills. To prevent drift, follow the repo specs.

## Repo Structure

- `skills/` — one directory per skill, each containing `SKILL.md` (frontmatter + body) and optional `references/`
- `specs/` — specifications, decision records (`specs/decisions/`), templates, and `skills-manifest.json`
- `tools/` — bundled tool implementations (e.g., `tools/archobs/`, `tools/intelligence/`), each a self-contained project
- `.system/` — internal tooling: skill creator scripts, doc generation, CI templates

## Start Here

- Read `specs/000-index.md` (index) and `specs/004-change-process.md` (how to make changes).
- Taxonomy and default workflow live in `specs/003-taxonomy-and-workflow.md`.

## Change Rules (High Signal)

- Treat skill names as API: prefer stable names; if you rename, capture it in a decision record and update docs (`specs/002-skill-contract.md`).
- For non-trivial changes, add/update a decision record in `specs/decisions/`.
- Keep skills concise; put depth in `references/` (progressive disclosure).
- Prefer cross-links between skills over duplicating content.
- Keep `specs/skills-manifest.json` aligned with each skill's frontmatter metadata (stage, tags) and maintain manifest-only fields (trigger, related, overhead).

## Verification

- Validate changed skills: `python3 .system/skill-creator/scripts/quick_validate.py skills/<skill-folder>`
- Validate repo-level docs/workflow consistency: `python3 .system/skill-creator/scripts/check_repo_consistency.py`
- Keep `README.md` and `PROMPTS.md` aligned with the workflow-stage grouping (Define/Standardize/Harden/Verify).

## Packaging (Optional)

- Package skills to `dist/` (build output): `python3 .system/skill-creator/scripts/package_skill.py skills/<skill-folder> ./dist`
