# Specs Index

This folder is the stable “source of truth” for how **enterprise-software-playbook** is organized and evolved.

Use it to prevent taxonomy drift and to make multi-agent iteration converge.

## How To Use These Specs

- Before adding/renaming a skill, changing terminology, or changing the default workflow, update/add a spec (and usually a decision record).
- Keep specs aligned with `README.md` and `PROMPTS.md`.

## Documents

- [`specs/001-skill-library.md`](001-skill-library.md): Charter for what this repo is for (goals, non-goals, constitution, acceptance).
- [`specs/002-skill-contract.md`](002-skill-contract.md): What a “skill” is in this repo (folder format, metadata, compatibility, validation/packaging).
- [`specs/003-taxonomy-and-workflow.md`](003-taxonomy-and-workflow.md): The workflow-stage taxonomy (Define/Standardize/Harden/Verify/Mechanics) and how it maps to skills.
- [`specs/004-change-process.md`](004-change-process.md): How to evolve this repo without breaking prompting compatibility or bloating context.
- [`specs/005-application-integration.md`](005-application-integration.md): How to integrate this library into a target app repo so agents auto-apply the workflow.
- [`specs/skills-manifest.json`](skills-manifest.json): Machine-readable stage/tag index for retrieval and routing.
- [`specs/tasks.md`](tasks.md): Backlog of work with acceptance criteria.
- [`specs/quickstart.md`](quickstart.md): Copy/paste commands to validate/package skills locally.
- [`specs/decisions/`](decisions/): ADR-style decision records (see [`specs/decisions/000-template.md`](decisions/000-template.md)).
- [`specs/templates/`](templates/README.md): Copy/paste templates for app-repo integration, CI quality gates, and service spec bundles.
