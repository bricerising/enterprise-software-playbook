# Spec 004: Change Process (Evolving the Skill Library)

## Overview

This repo is an opinionated system. “Random improvements” are how it becomes incoherent.

Use this process so changes remain cohesive, reviewable, and compatible with existing prompts.

## When You MUST Update Specs

Update `specs/` (and usually add a decision record) when you:

- Add a new skill
- Rename a skill or change its purpose
- Change taxonomy/terminology/default workflow
- Add a new “constitution” invariant that should be enforced by multiple skills

## Default Change Workflow

1. **Write/Update the spec**
   - Update the relevant `specs/00x-*.md` file(s).
   - For non-trivial changes, add a decision record under `specs/decisions/`.
   - For non-trivial workflow/process updates, include: objective function, options + trade-offs, kill criteria, and measurement ritual.
2. **Implement the change**
   - Keep diffs small; avoid broad renames/moves.
   - Prefer cross-links to other skills over duplicating content.
3. **Validate**
   - Run `python3 .system/skill-creator/scripts/quick_validate.py skills/<skill>` for changed skills.
   - Run `python3 .system/skill-creator/scripts/check_repo_consistency.py` for README/PROMPTS taxonomy and prompt drift.
4. **Update navigation**
   - Update `README.md` and `PROMPTS.md` so users can find the new/changed skill.
   - Update `specs/skills-manifest.json` to match the skill's frontmatter metadata (stage, tags, trigger, related, overhead).
5. **Add verification guidance**
   - Ensure the changed skill contains an output template and verification steps.
6. **Package (optional)**
   - If you distribute `.skill` artifacts, re-package affected skills into `dist/`.

## Capturing Learnings From Real Projects

When you learn something from a target enterprise app (e.g., an internal pilot project), capture it as:

- a new **invariant** (if it should apply broadly), and/or
- a new **operational workflow/checklist** in the relevant skill, and/or
- a new **shared platform primitive** recommendation (if it prevents drift), and/or
- a concrete “gotcha” in a `references/` file (preferred over long narrative)

Avoid turning the repo into a diary; preserve only what improves future agent performance.

## Decision Records (ADR-style)

Store significant decisions in `specs/decisions/NNN-<topic>.md`.

Each decision SHOULD include:

- Context (what problem we’re solving)
- Options considered (what each optimizes and worsens)
- Decision (what we chose)
- Kill criteria / reversal trigger
- Measurement + review ritual (owner/cadence/action trigger)
- Consequences (trade-offs, migration impact)

## Acceptance

This process is working when:

- Significant changes are driven by updates in `specs/` (not just code edits).
- Skill names remain stable or have explicit shims/migrations.
- New skills are discoverable in `README.md` and usable via copy/paste prompts in `PROMPTS.md`.
