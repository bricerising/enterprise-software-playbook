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

## Skill affinity

Not every skill needs every probe. Prioritize by fit:

| Probe | Primary skills | Secondary |
| --- | --- | --- |
| #1 Assumptions | `plan`, `spec`, `architecture`, `design` | `review` |
| #2 Second-Order Effects (+ pre-mortem) | `plan`, `architecture`, `spec` | `review`, `design` |
| #3 Feedback Loops | `architecture` (covered natively by its inline dynamics check — do not run separately) | `plan`, `spec` |
| #4 Opportunity Cost | `plan`, `spec`, `architecture` | `review`, `design` |
| #5 Learning Loop | `finish`, `debug` | — |

---

## Core Probes (run inline for non-trivial work)

### 1) First-Principles Assumption Audit

Use when starting plans/specs/architecture/design decisions.

- What is true regardless of tooling preference or team habit?
- What are assumptions (not facts), and why do we believe each one?
- Which assumption is least certain and how will we validate it quickly?

Output (attach to decision table):
- `facts`
- `assumptions`
- `assumption-to-test-first`

### 2) Second-Order Effects Scan (includes pre-mortem)

Use before locking a decision.

- If we choose this option, what likely happens next week, next quarter, next year?
- What new load, toil, coupling, or failure mode might this create?
- Which stakeholder/team absorbs the downside later?
- Pre-mortem: if this fails in 6-12 months, what likely caused failure?

Output (attach to decision table):
- `near-term effects`
- `long-term effects`
- `deferred cost owner`
- `pre-mortem cause`

### 3) Feedback Loop and Dynamics Check

Use for system and operations changes. In `architecture`, the inline dynamics check (step 9) already covers this probe — do not run both.

- Reinforcing loop: what could amplify in a good or bad direction?
- Balancing loop: what mechanism keeps runaway behavior in check?
- Where are delays between signal and action, and what accumulates during the delay?

Output (attach to system sketch):
- `reinforcing loop`
- `balancing loop`
- `delay + accumulation risk`

### 4) Opportunity Cost and Bias Check

Use when options are close or politically loaded.

- What are we explicitly saying "no" to with this choice?
- Are we favoring this because of sunk cost, familiarity, or novelty bias?
- What would a neutral reviewer challenge first?

Output (attach to decision table):
- `opportunity cost`
- `bias risks`
- `external challenge`

### 5) Learning Loop

Use in `finish` (after delivery) or `debug` (after incident/rollback). For the full cause-chain flow, escalate to **Retrospective / Postmortem** from [`structured-thinking-templates.md`](structured-thinking-templates.md).

- What happened vs what was expected?
- Which assumption was confirmed or updated, and why? (always answer — even when expectations were met)
- What one process/control change would reduce repeat risk? (only when expectations diverged; flag for human to assign owner)

Output (attach to finish packet):
- `outcome delta`
- `assumption confirmed or updated`
- `next control + owner` (only when expectations diverged)
