# Decision 017: Skill Enhancements — Failure Modes, Gates, MVE, I/O Contracts

**Date**: 2026-03-28
**Status**: Accepted

## Context

Skills tell agents *what to do* but not *when they're doing it wrong* or *what to cut under pressure*. Observed failure patterns:

- **Goal**: Make skills self-correcting (agents recognize their own mistakes) and gracefully degradable (agents know which steps are load-bearing).
- **Constraints**: Must not break existing skill contract; must keep SKILL.md under ~500 lines; additive only.
- **Anti-goals**: Not adding new skills. Not restructuring existing workflows.
- **Boundary + time horizon**: All 17 skills, near-term (single batch of changes).
- **Actors + incentives**: AI agents following skill workflows — incentivized to complete quickly, which causes step-skipping.

## Options considered

| Option | Optimizes for | Knowingly worsens | Reversibility |
| --- | --- | --- | --- |
| A: Add inline failure modes + gates + MVE + I/O to each SKILL.md | Agent self-correction, composability, context efficiency | Slightly longer SKILL.md files (~24 lines each) | Fully reversible (remove sections) |
| B: Add failure modes to shared reference file | DRY, single update point | Loses per-skill specificity; agents must load extra file | Fully reversible |
| C: No change (rely on guardrails) | Simplicity | Agents continue failing in predictable, undocumented ways | N/A |

## Decision

Option A: Add four enhancements directly to each SKILL.md as SHOULD-have sections in the skill contract.

1. **Inputs / Outputs** — what a skill requires from upstream and produces for downstream (placed after Chooser).
2. **Common failure modes** — 3-5 bullets documenting how agents actually fail, serving as anti-anchors (placed after Guardrails).
3. **Minimum viable execution** — 3-4 load-bearing steps vs nice-to-have (placed after Workflow).
4. **GATE annotations** — inline blockquote annotations at critical workflow steps where agents commonly skip or execute superficially (inline within Workflow, not a separate section).

Additionally, add **proportionality boundary examples** to the workflow skill's Step 0 to help agents classify ambiguous changes.

Why not Option B: failure modes are only useful when they're specific to the skill being executed. A shared file loses that specificity and adds a file-load step agents might skip.

## Kill criteria / reversal trigger

- If agents consistently ignore the new sections (no measurable improvement in step completion), remove them to reduce context load.
- If SKILL.md files exceed ~500 lines after additions, move content to references/.

## Measurement + review ritual

- **Leading indicators (early)**: Agents cite failure modes when self-correcting; gate conditions appear in agent reasoning.
- **Lagging outcomes**: Fewer instances of known failure patterns (e.g., forecast default-association trap, review self-agreement).
- **Instrumentation source**: Manual review of agent transcripts.
- **Owner + cadence + action trigger**: Repo maintainer, quarterly, triggered if failure patterns persist unchanged.

## Consequences

- Positive: Skills become self-correcting; composition is explicit; agents can degrade gracefully under context pressure.
- Trade-offs: Each SKILL.md grows ~24 lines; maintenance burden increases slightly (failure modes must stay current).
- Compatibility: Fully backward-compatible. New sections are SHOULD-have, not MUST-have. Validation scripts unchanged.

## Review date

2026-06-28
