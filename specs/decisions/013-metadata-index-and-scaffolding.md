# Decision 013: Add Skill Metadata, Manifest Index, and Copy-First Scaffolding

**Date**: 2026-02-08  
**Status**: Accepted

## Context

The repository already had strong human-readable structure, but AI retrieval/execution still depended on scanning multiple files:

- skill frontmatter did not include normalized stage/tag metadata,
- there was no canonical machine-readable stage/tag index for fast lookup,
- concrete copy-first templates for CI quality gates and service spec bundles were limited.

Goal: improve retrieval precision and implementation speed without renaming skills or changing taxonomy.

## Options considered

| Option | Optimizes for | Knowingly worsens | Reversibility |
| --- | --- | --- | --- |
| A) Keep docs as-is and rely on prose | Lowest immediate change cost | Weaker retrieval/routing precision and less execution scaffolding | High |
| B) Add manifest only | Faster tool-side lookup | Metadata drift risk between skills and manifest | High |
| C) Add frontmatter metadata + manifest + guardrails + templates (chosen) | Strong retrieval consistency and concrete execution starting points | More metadata maintenance | High |

## Decision

Adopt Option C:

1. Require `metadata` in each `skills/*/SKILL.md` frontmatter (`stage`, `tags`).
2. Add canonical machine-readable index `specs/skills-manifest.json` with:
   - stage-to-skill mapping
   - per-skill path/stage/tags
3. Extend validation/consistency scripts to enforce:
   - metadata presence and shape
   - stage/tag constraints
   - manifest/frontmatter alignment
4. Add copy-first templates and references:
   - `specs/templates/ci/github-actions-quality.yml`
   - `specs/templates/service-spec-bundle/*`
   - security/observability TypeScript snippet references
   - expanded architecture service template reference

## Kill criteria / reversal trigger

Revisit if either condition repeats for two consecutive review cycles:

- metadata/manifest maintenance overhead causes repeated false-positive review friction, or
- the metadata schema no longer supports retrieval quality (for example, stage/tag granularity is consistently insufficient).

## Measurement + review ritual

- **Leading indicators (early)**: fewer skill-selection ambiguities during prompts; consistency checks catch metadata/index drift pre-merge.
- **Lagging outcomes**: faster first-pass agent execution (less manual context gathering) and fewer missing-template setup errors.
- **Instrumentation source**: PR review feedback, CI failures from consistency checks, and issue reports.
- **Owner + cadence + action trigger**: maintainers review monthly; adjust schema/templates when drift failures or retrieval misses repeat in two+ PRs.

## Consequences

- Positive:
  - Skills are now self-describing for retrieval (`stage` + `tags`).
  - A single manifest file enables fast stage/tag routing.
  - Agents get direct template scaffolding for CI and spec bundles.
- Trade-offs:
  - Additional metadata must be maintained when adding/changing skills.
  - Consistency checks are stricter and may fail on stale metadata.
- Compatibility/migration impact:
  - Additive; no skill renames and no taxonomy changes.
