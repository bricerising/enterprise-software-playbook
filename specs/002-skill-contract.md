# Spec 002: Skill Contract

## Overview

In this repo, a **skill** is a small, explicit playbook that can be invoked by name and applied procedurally.

Skill names and folder layout are treated as an API: prompts depend on them.

## Folder Contract

In this repo, installable skills live under:

```
skills/<skill-name>/
  SKILL.md
  references/   (optional)
  scripts/      (optional)
  assets/       (optional)
```

Skill folders SHOULD NOT include extra docs like `README.md`, changelogs, or long essays. Keep `SKILL.md` lean; put depth in `references/`.

## `SKILL.md` Frontmatter Contract

`SKILL.md` MUST start with YAML frontmatter containing:

- `name`: MUST match the folder name.
- `description`: MUST be specific about when to use the skill (trigger precision matters). SHOULD include "NOT for X (use Y)" clauses for confusable skill pairs.
- `metadata`: MUST be a JSON object string with:
  - `stage`: one of `Define`, `Standardize`, `Harden`, `Verify`
  - `tags`: non-empty list of lower-kebab-case retrieval keywords (include common query terms users actually type)
  - `aliases`: list of alternate query terms for synonym-based routing
  - Example: `metadata: {"stage":"Harden","tags":["security","authz","csrf"],"aliases":["auth","hardening"]}`

## `SKILL.md` Body Contract (Minimum Shape)

Each skill MUST contain:

- **Overview**: what problem it solves and what success looks like.
- **Workflow**: a short numbered procedure that can be followed.
- **Output template**: what the agent should return (plan + verification + summary).

Each skill SHOULD contain:

- **Chooser**: decision aid for picking sub-approach within the skill (e.g., "what test type where").
- **Inputs / Outputs**: what the skill requires from upstream skills and what it produces for downstream skills. Place after Chooser. Keep to 5-10 lines.
- **Clarifying Questions**: what to ask the user before applying the workflow.
- **Guardrails**: what not to do / common pitfalls.
- **Common failure modes**: 3-5 bullets documenting how agents actually fail when applying this skill. These serve as anti-anchors — "if your output looks like this, you're doing it wrong." Place after Guardrails.
- **Minimum viable execution**: the 3-4 load-bearing steps that must always run, vs nice-to-have steps that can be cut under context or time pressure. Place after Workflow.
- **References**: pointers to `references/` files (progressive disclosure).

### Inline Gate Annotations

Workflow steps MAY include `GATE:` annotations at critical decision points where agents commonly skip or execute superficially. Gates are inline content within Workflow, not a separate section.

Format:

```markdown
> **GATE**: <condition that must be true before proceeding>
```

Gates differ from guardrails: guardrails are general rules; gates are step-specific checkpoints that block forward progress until satisfied.

## Progressive Disclosure Rules

- `SKILL.md` SHOULD be under ~500 lines; move depth to `references/`.
- Avoid deep reference chains (keep references one level deep from `SKILL.md`).
- Prefer reusable templates/checklists over prose.

## Machine-readable Index Contract

For fast retrieval/routing, this repo includes:

- `specs/skills-manifest.json`: canonical machine-readable index
  - `stages`: explicit stage-to-skill mapping
  - `skills`: per-skill entry with:
    - `path`, `stage`, `tags`: MUST match frontmatter metadata
    - `trigger`: 1-line routing hint (when to use this skill)
    - `related`: list of related skill names for cross-reference routing
    - `overhead`: `"minimal"` | `"moderate"` | `"significant"` (helps proportionality decisions)
    - `role` (optional, Define-stage only): `"data-source"` | `"decision"` — routing hint distinguishing skills that gather data from skills that make decisions. Manifest-only field (not in frontmatter metadata).
- The manifest MUST stay aligned with each `skills/<name>/SKILL.md` frontmatter metadata.

## Compatibility Rules (Skill Names Are API)

- Prefer stable skill names and avoid renaming skill folders or `name:` values.
- If a rename is required:
  - capture it in a decision record under `specs/decisions/` (include a rename map)
  - update `README.md`, `PROMPTS.md`, and templates in the same change
  - add shim skills only when compatibility is a requirement (optional in early-stage/breaking revamps)

## Validation + Packaging

- Skills MUST pass validation:
  - `python3 .system/skill-creator/scripts/quick_validate.py skills/<skill-folder>`
- Skills MAY be packaged into `.skill` files for distribution:
  - `python3 .system/skill-creator/scripts/package_skill.py skills/<skill-folder> ./dist`
- `dist/` is intentionally not committed; treat packaged artifacts as build output.

## Acceptance

This contract is satisfied when:

- Every skill folder matches the folder/frontmatter contract.
- Every skill has valid `metadata` (`stage` + `tags`) and matches the manifest.
- Validation passes for every skill in the repo.
- Significant behavior changes come with spec updates under `specs/` and a migration story if skill APIs change.
  - For breaking renames, the migration story may be “no shims” as long as the decision record includes the mapping.
