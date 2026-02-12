# Decision 014: Add Structured-Thinking Probes To Core Skills

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
| C. Shared reference + small probe hooks in core skills | High leverage with low overhead; reuse existing workflow artifacts | Requires coordinated edits across several skills | High (remove hooks/reference if noisy) |

## Decision

Choose **Option C**:

- Add one shared reference with compact probes (first principles, second-order effects, feedback loops, opportunity cost, bias, pre-mortem, retrospective, communication framing).
- Integrate lightweight probe checkpoints into `workflow`, `plan`, `architecture`, `spec`, `review`, and `finish`.
- Update `PROMPTS.md` and Spec 001 so the behavior is explicit and discoverable.

This keeps the existing taxonomy intact while improving reasoning quality where non-trivial decisions are made.

## Kill criteria / reversal trigger

Reverse or narrow this change if either condition is observed for two consecutive review cycles:

- Median non-trivial output size increases by >20% versus baseline (measurement protocol below) with no measurable reduction in avoidable follow-up defects/incidents.
- Maintainers or users report that probe steps are routinely skipped because they are too abstract or too verbose.

If triggered, reduce scope to only `workflow` + `plan` or simplify probe fields.

## Measurement + review ritual

- **Sampling protocol (to keep decisions objective)**:
  - Baseline: capture the most recent 20 non-trivial outputs before 2026-02-12 and record median output length (words) plus median turnaround time (minutes).
  - Per review cycle: sample 10 non-trivial outputs spanning at least 3 core skills (`workflow`, `plan`, `spec`, `architecture`, `review`, `finish`).
  - Use the same measurement method each cycle (word count from final response + elapsed task time in session logs).
- **Scoring rubric (0/1 per criterion)**:
  - Includes explicit `facts vs assumptions`.
  - Includes at least one explicit second-order effect.
  - Includes at least one feedback-loop/delay note.
  - Includes an explicit opportunity cost or bias risk.
  - Includes an owner-backed learning/control follow-up when `finish` is used.
  - Track rubric score as `% criteria met` and compare against baseline.

- **Leading indicators (early)**:
  - Non-trivial outputs score >=80% on the rubric above.
  - `finish` outputs include a learning-loop section with owner.
  - Skill validators and repo consistency checks remain green.
- **Lagging outcomes**:
  - Fewer avoidable reversals caused by unstated assumptions.
  - Fewer "surprise" second-order issues discovered late in rollout.
  - Faster alignment in design/review decisions (fewer back-and-forth cycles).
- **Instrumentation source**:
  - Sampled session outputs from non-trivial tasks.
  - PR/issue retrospectives where this playbook is used.
  - Validation scripts (`quick_validate.py`, `check_repo_consistency.py`).
- **Owner + cadence + action trigger**:
  - Owner: repo maintainers.
  - Cadence: bi-weekly for first month, then monthly.
  - Action trigger: if kill criteria are met, propose a follow-up ADR to reduce or reshape probes.

## Consequences

- Positive outcomes / what gets simpler:
  - Clearer assumption tracking and decision rationale in non-trivial work.
  - Better anticipation of delayed/systemic side effects.
  - More consistent decision hand-off and learning capture.
- Trade-offs / what gets harder:
  - Slightly more structure in planning/review/finish outputs.
  - Additional maintenance of one shared reference file.
- Compatibility/migration impact:
  - Additive only; no skill rename or taxonomy change.
  - Existing prompts continue to work and gain extra guidance when updated.

## Review date

2026-03-15
