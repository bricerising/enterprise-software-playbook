# Decision 015: Add Context-Specific Structured-Thinking Template Packs

**Date**: 2026-02-12
**Status**: Accepted

## Context

Decision 014 added compact structured-thinking probes across core skills. Those probes improved consistency, but they intentionally stayed minimal. For higher-stakes work, maintainers still need context-specific flows (design review, trade-off selection, postmortem, strategy, and communication hand-off) without creating a new top-level skill.

The user provided a structured-thinking template set that maps directly to those recurring decision shapes.

- **Goal**: Improve quality and repeatability of non-trivial decisions by adding reusable, context-specific template packs.
- **Constraints**: Keep skill files concise, avoid taxonomy churn, and preserve existing skill names/triggers.
- **Anti-goals**: Do not replace compact probes; do not force heavyweight process on tiny changes.
- **Boundary + time horizon**: Define/Verify stage skills, plus `debug` as an incident-learning bridge in Harden; immediate rollout with short adoption feedback loop.
- **Actors + incentives**: Skill users need clearer prompts for common high-stakes decisions; maintainers need low-drift docs and stable routing.

## Options considered

| Option | Optimizes for | Knowingly worsens | Reversibility |
| --- | --- | --- | --- |
| A. Keep only compact probes (Decision 014 scope) | Minimal overhead | Less guidance for common complex decision shapes | Immediate |
| B. Replace probes with full templates everywhere | Maximum explicitness | Output bloat; friction for normal/tiny work | Medium |
| C. Keep probes + add optional template packs and cross-links in relevant skills | Better guidance with bounded overhead | Slightly more reference surface to maintain | High |

## Decision

Choose **Option C**:

- Add `skills/workflow/references/structured-thinking-templates.md` with five selector packs:
  - Technical Design Review
  - Trade-Off / Project Decision
  - Retrospective / Postmortem
  - Strategic Planning / Roadmap
  - Communication & Influence
- Keep compact probes as the default baseline.
- Add lightweight, optional hooks in `workflow`, `plan`, `spec`, `architecture`, `review`, `finish`, and `debug` pointing to the relevant pack.

This preserves existing behavior while improving prompt quality for recurring non-trivial decision types.

## Kill criteria / reversal trigger

Reverse or trim this decision if either condition persists for two review cycles:

- Template packs are used in <10% of big-scope outputs, indicating the escalation criteria are unclear or too restrictive.
- Maintainers report that cross-links are rarely used or create confusion in skill selection.

If triggered, reduce to only two packs (`Trade-Off / Project Decision`, `Retrospective / Postmortem`) and remove low-usage links.

## Measurement + review ritual

- **Sampling protocol**:
  - Per review cycle: sample 10 non-trivial outputs spanning at least 3 relevant skills (`workflow`, `plan`, `spec`, `architecture`, `review`, `finish`, `debug`).
  - Use a consistent measurement method each cycle (word count from final response + elapsed task time in session logs + explicit template mention in output).
- **Template-fit rubric (0/1 per criterion)**:
  - A template was used only when a decision shape warranted it (per escalation criteria).
  - Exactly one template pack was selected per decision checkpoint.
  - Template output remained attached to existing artifacts (not a separate long essay).
  - Template output included explicit opportunity cost and owner/date follow-up where applicable.
  - Track rubric score as `% criteria met` per cycle.

- **Leading indicators (early)**:
  - Non-trivial outputs with template usage score >=75% on the template-fit rubric above.
  - `finish` outputs more consistently include owner-backed retrospective controls.
  - Skill validation and repo-consistency checks remain green.
- **Lagging outcomes**:
  - Fewer late-stage reversals from unstated trade-offs.
  - Better decision clarity in architecture/spec/review hand-offs.
  - Faster convergence in non-trivial planning discussions.
- **Instrumentation source**:
  - Sampled non-trivial task outputs in repos using this playbook.
  - Retrospectives/PR narratives for notable incidents or reversals.
  - Validation scripts (`quick_validate.py`, `check_repo_consistency.py`).
- **Owner + cadence + action trigger**:
  - Owner: repo maintainers.
  - Cadence: bi-weekly for one month, then monthly.
  - Action trigger: if kill criteria are met, open follow-up ADR to narrow scope.

## Consequences

- Positive outcomes / what gets simpler:
  - Better fit between problem type and reasoning structure.
  - Stronger decision hand-offs via communication framing prompts.
  - Cleaner retrospective learning capture with explicit owners.
- Trade-offs / what gets harder:
  - Slightly larger reference surface area.
  - Need to keep pack links current across a handful of skills.
- Compatibility/migration impact:
  - Additive only; no skill rename, taxonomy change, or prompt breakage.

## Review date

2026-03-20
