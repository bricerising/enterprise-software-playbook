# Decision 001: Workflow-Stage Taxonomy For Skills

**Date**: 2026-01-31
**Status**: Accepted
**Amended by**: [ADR 016](016-collapse-mechanics-into-design.md) (Mechanics stage removed, 2026-03-28)

## Context

The repo needs a stable way to organize skills so users/agents can select the right next skill quickly.

Grouping by “code vs system vs operational” describes **scope**, but creates a misleading navigation experience because:

- Some skills are “choosers” (contain many patterns) rather than “pattern lists”.
- Many skills span multiple concerns (e.g., a style guide touches boundaries, tests, and implementation).

## Decision

Organize the repo’s skill list by **workflow stage**:

1. Define
2. Standardize
3. Harden
4. Verify
5. Mechanics

Keep “code/system/operational” as terminology, not the primary navigation structure.

## Consequences

- Clearer default sequencing for enterprise web apps (lower decision friction).
- Skills become easier to compose in prompts (“what do we do next?”).
- We still need to keep scope terminology consistent inside skill bodies to avoid conceptual drift.
