# Contributing

This repo is an opinionated system. Changes should preserve coherence and prompting compatibility.

## Start here

- Read `specs/000-index.md` and `specs/004-change-process.md`.
- Review taxonomy/workflow in `specs/003-taxonomy-and-workflow.md`.

## High-signal rules

- Treat skill names as API: prefer stable names; if you rename, capture it in a decision record and update docs (`specs/002-skill-contract.md`).
- For non-trivial changes, update the relevant spec and usually add an ADR in `specs/decisions/`.
- Keep `SKILL.md` lean; put depth in `references/` (progressive disclosure).
- Prefer cross-links between skills over duplicating content.

## Tool subprojects

The `tools/` directory contains bundled tool implementations (e.g., `tools/archobs/`, `tools/intelligence/`). Each tool is a self-contained project with its own package manifest, license, and tests.

When modifying a tool subproject:

- Run the tool's own tests: `pytest -q tools/<tool>/tests` (Python) or `npm test` in `tools/<tool>/` (Node.js).
- Keep the corresponding skill docs (`skills/<name>/references/`) aligned with tool behavior.
- Tool subprojects may have different licenses than the top-level repo (e.g., MIT for archobs). Preserve license files within the tool directory.
- See `specs/decisions/015-vendor-archobs-tool.md` for the rationale behind this pattern.

## Verification

- Validate changed skills: `python3 .system/skill-creator/scripts/quick_validate.py skills/<skill-folder>`
- Validate repo-level docs/workflow consistency: `python3 .system/skill-creator/scripts/check_repo_consistency.py`
- Keep `README.md` and `PROMPTS.md` aligned with the workflow-stage grouping (Define/Standardize/Harden/Verify).
- Keep `specs/skills-manifest.json` aligned with each skill's frontmatter metadata (stage, tags) and maintain manifest-only fields (trigger, related, overhead).
- Build docs locally: `python3 .system/docs/generate_mkdocs_nav.py > mkdocs.yml && pip install mkdocs-material && mkdocs build --strict` (see `specs/quickstart.md`).

## Feedback (what helps most)

If you file an issue or request a change, include:

- The prompt you used (and the tool/model if relevant).
- What you expected vs what happened.
- Links or snippets to the specific `SKILL.md` / spec section that felt confusing or missing.
