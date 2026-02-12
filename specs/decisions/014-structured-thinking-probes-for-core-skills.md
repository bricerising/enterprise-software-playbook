# Decision 014: Add Structured-Thinking Probes and Template Packs to Core Skills

**Date**: 2026-02-12
**Status**: Accepted

## Context

The library already requires objective functions, system sketches, decision tables, and measurement ladders for non-trivial work. In practice, teams still miss several recurring failure modes:

- assumptions are not clearly separated from facts
- second-order effects are mentioned but not tested
- feedback-loop dynamics are under-specified
- opportunity cost and cognitive bias checks are inconsistent
- end-of-work learning loops are often skipped

The user provided external structured-thinking templates that reinforce these gaps and provide reusable prompt checklists.

- **Goal**: Improve decision quality and post-change learning in non-trivial work without adding heavy process.
- **Constraints**: Keep skill docs concise; avoid adding a new top-level workflow stage; preserve existing skill names and routing.
- **Anti-goals**: Do not create a long narrative framework; do not require heavyweight docs for tiny changes.
- **Boundary + time horizon**: Repo-level skill guidance for Define and Verify stages, effective immediately and reviewed after short adoption.
- **Actors + incentives**: Agent operators need faster, higher-confidence decisions; maintainers need low-bloat, stable skill APIs.

## Options considered

| Option | Optimizes for | Knowingly worsens | Reversibility |
| --- | --- | --- | --- |
| A. Keep current state | Zero migration effort | Missed assumptions/second-order risks persist | Immediate (no change) |
| B. New dedicated `structured-thinking` skill | Explicit discoverability | More routing complexity and workflow overhead | Medium (requires prompt/docs migration) |
| C. Shared references + small probe hooks in core skills | High leverage with low overhead; reuse existing workflow artifacts | Requires coordinated edits across several skills | High (remove hooks/references if noisy) |

## Decision

Choose **Option C**, implemented in two phases:

### Phase 1: Compact probes

- Add one shared reference (`skills/references/structured-thinking-checklists.md`) with 5 compact probes: first-principles assumptions, second-order effects, feedback loops/dynamics, opportunity cost/bias, and learning loop.
- Integrate lightweight probe pointers into `workflow`, `plan`, `architecture`, `spec`, `review`, `finish`, `debug`, and `design`.
- Each skill points to the canonical probes file and specifies which probes are most relevant (via a skill-affinity table in the checklists file).
- The first Define-stage skill in a flow owns the probe output; subsequent skills refine it.

### Phase 2: Template packs

- Add `skills/references/structured-thinking-templates.md` with five selector packs for recurring decision shapes:
  - Technical Design Review
  - Trade-Off / Project Decision
  - Retrospective / Postmortem
  - Strategic Planning / Roadmap
  - Recommendation Brief
- Keep compact probes as the default baseline; template packs are used only when escalation criteria are met.
- Add lightweight, optional hooks in relevant skills pointing to the matching pack.

This keeps the existing taxonomy intact while improving reasoning quality where non-trivial decisions are made.

## Kill criteria / reversal trigger

Reverse or narrow this change if either condition is observed for two consecutive review cycles:

- Probe sections are empty or marked "n/a" in >50% of sampled non-trivial outputs — indicating probes are too abstract or too verbose for practical use.
- Template packs are used in <10% of big-scope outputs, indicating the escalation criteria are unclear or too restrictive.
- Maintainers or users report that probe steps are routinely skipped or add friction without improving decision quality.

If triggered, reduce scope to only `workflow` + `plan` or simplify probe fields. For template packs, reduce to only **Trade-Off / Project Decision** and **Retrospective / Postmortem**.

## Measurement + review ritual

- **Sampling protocol**:
  - Per review cycle: sample 10 non-trivial outputs spanning at least 3 core skills (`workflow`, `plan`, `spec`, `architecture`, `review`, `finish`).
  - Use a consistent measurement method each cycle (word count from final response + elapsed task time in session logs).
- **Scoring rubric (0/1 per criterion)**:
  - Includes explicit `facts vs assumptions`.
  - Includes at least one explicit second-order effect.
  - Includes at least one feedback-loop/delay note.
  - Includes an explicit opportunity cost or bias risk.
  - Includes an owner-backed learning/control follow-up when `finish` is used.
  - Template was used only when a decision shape warranted it (per escalation criteria).
  - Track rubric score as `% criteria met` per cycle.

- **Leading indicators (early)**:
  - Non-trivial outputs score >=80% on the rubric above.
  - `finish` outputs include a learning-loop section with owner.
  - Skill validators and repo consistency checks remain green.
- **Lagging outcomes**:
  - Fewer avoidable reversals caused by unstated assumptions.
  - Fewer "surprise" second-order issues discovered late in rollout.
  - Faster alignment in design/review decisions (fewer back-and-forth cycles).
  - Better decision clarity in architecture/spec/review hand-offs.
- **Instrumentation source**:
  - Sampled session outputs from non-trivial tasks.
  - PR/issue retrospectives where this playbook is used.
  - Validation scripts (`quick_validate.py`, `check_repo_consistency.py`).
- **Owner + cadence + action trigger**:
  - Owner: repo maintainers.
  - Cadence: bi-weekly for first month, then monthly.
  - Action trigger: if kill criteria are met, propose a follow-up ADR to reduce or reshape probes/packs.

## Consequences

- Positive outcomes / what gets simpler:
  - Clearer assumption tracking and decision rationale in non-trivial work.
  - Better anticipation of delayed/systemic side effects.
  - More consistent decision hand-off and learning capture.
  - Better fit between problem type and reasoning structure (via template packs).
- Trade-offs / what gets harder:
  - Slightly more structure in planning/review/finish outputs.
  - Two shared reference files to maintain.
  - Cross-links across several skills to keep current.
- Compatibility/migration impact:
  - Additive only; no skill rename or taxonomy change.
  - Existing prompts continue to work and gain extra guidance when updated.

## Review date

2026-03-15
