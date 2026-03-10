# Structured Thinking Checklists

Use these probes to strengthen non-trivial decisions without adding heavy process.

In this repo, **non-trivial = normal or big scope** (see `workflow`); tiny changes always skip these probes.

**Decision-presence gate**: run probes only when the work involves choosing between 2+ viable approaches or when the decision table contains meaningful alternatives. If the path is obvious (single viable approach, well-understood change), note `probes: skipped — single viable approach` rather than filling fields with "n/a".

Keep answers short (1-3 bullets per prompt) and attach them to the existing artifacts:

- objective function
- system sketch
- decision table
- measurement ladder

## Ownership

The **first Define-stage skill** that runs probes owns the output (usually `plan`, `architecture`, or `spec`). Subsequent skills in the same flow **reference and update** the existing probe output rather than re-running from scratch. For example, if `plan` produced an assumptions list, `architecture` should refine it — not create a parallel one.

`finish` owns the learning loop (probe #5) at the end of the flow.

## When to escalate to a template pack

Use compact probes by default. Escalate to one targeted template from [`structured-thinking-templates.md`](structured-thinking-templates.md) when any of these apply:

- the decision table has **3+ viable options** with no clear winner
- **multiple stakeholders** must align on a recommendation
- a **rollback or incident** requires formal learning capture
- the work is **big scope** (cross-service, migration, multi-team) and the probes surfaced unresolved ambiguity

If none of these apply, compact probes are sufficient — do not run a template pack.

## Probe Index

The canonical probe definitions live inline in the skills that execute them. This table maps each probe to its canonical location and field outputs.

| # | Probe | Canonical location | Output fields | Attach to |
| --- | --- | --- | --- | --- |
| 1 | Assumptions | `plan` step 6 / `spec` step 8 / `architecture` step 6 / `design` step 5 | `facts`, `assumptions`, `assumption-to-test-first` | decision table |
| 2 | Second-Order Effects (+ pre-mortem) | `plan` step 6 / `spec` step 8 / `architecture` step 6 / `design` step 5 | `near-term effects`, `long-term effects`, `deferred cost owner`, `pre-mortem cause` | decision table (`architecture`: system sketch) |
| 3 | Feedback Loops | `architecture` step 9 (dynamics check — covers this natively) | `reinforcing loop`, `balancing loop`, `delay + accumulation risk` | system sketch |
| 4 | Opportunity Cost / Bias | `plan` step 6 / `spec` step 8 / `architecture` step 6 / `design` step 5 | `opportunity cost`, `bias risks`, `external challenge` | decision table |
| 5 | Learning Loop | `finish` step 6 | `outcome delta`, `assumption confirmed or updated`, `next control + owner` (when expectations diverge) | finish packet |

## Skill affinity

Not every skill needs every probe. Prioritize by fit:

| Probe | Primary skills | Secondary |
| --- | --- | --- |
| #1 Assumptions | `plan`, `spec`, `architecture`, `design` | `review` |
| #2 Second-Order Effects (+ pre-mortem) | `plan`, `architecture`, `spec`, `design` | `review` |
| #3 Feedback Loops | `architecture` (covered natively by its dynamics check — do not run separately) | `plan`, `spec` |
| #4 Opportunity Cost | `plan`, `spec`, `architecture`, `design` | `review` |
| #5 Learning Loop | `finish`, `debug` | — |

Skills not listed above (`testing`, `security`, `resilience`, `observability`, `typescript`, `platform`, `patterns-*`) consume probe output from the Define-stage skill that produced it. They do not run their own probes.

**Skill-specific tailoring notes:**
- `design` omits "load" and "toil" from Second-Order Effects because in-process pattern decisions don't create operational load or toil — coupling and failure modes are the relevant concerns.
- `architecture` omits the pre-mortem question from its probe block because it's already covered in its blast-radius step (step 8). `plan`, `spec`, and `design` include pre-mortem inline since they lack a separate blast-radius step.
- `architecture` is the only exception for Probe #2 attachment: it writes Second-Order Effects to the system sketch (not the decision table). Do not duplicate it in both places.
- `debug` is listed as primary for Learning Loop (#5) because incident resolution produces learning output, but debug's capture-learnings step (step 6) addresses systemic gaps discovered during triage (missing telemetry, retries without idempotency) rather than probe #5's outcome-vs-expectation format. For formal learning capture after incident resolution, debug flags a follow-up using the Retrospective template.
- For Learning Loop (#5), owner-backed control actions are conditional: include them when expectations diverge; otherwise include a brief explicit no-action rationale.
