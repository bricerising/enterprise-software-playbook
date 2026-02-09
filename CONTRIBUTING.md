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

## Verification

- Validate changed skills: `python3 .system/skill-creator/scripts/quick_validate.py skills/<skill-folder>`
- Validate repo-level docs/workflow consistency: `python3 .system/skill-creator/scripts/check_repo_consistency.py`
- Keep `README.md` and `PROMPTS.md` aligned with the workflow-stage grouping (Define/Standardize/Harden/Verify/Mechanics).
- Keep `specs/skills-manifest.json` aligned with each skill's frontmatter metadata (stage, tags, trigger, related, overhead).

## Feedback (what helps most)

If you file an issue or request a change, include:

- The prompt you used (and the tool/model if relevant).
- What you expected vs what happened.
- Links or snippets to the specific `SKILL.md` / spec section that felt confusing or missing.
