---
name: plan
description: "Break a request into a scoped implementation plan with ordered tasks, risk flags, and verification steps. Use before starting non-trivial, cross-cutting, or ambiguous work to align on approach and prevent rework. NOT for writing spec artifacts or contracts (use spec); NOT for auto-routing across multiple skills (use workflow)."
metadata: {"stage":"Define","tags":["implementation-plan","task-breakdown","risk-assessment","verification-plan","scope","trade-offs","decision-table"],"aliases":["planning","task-list","breakdown","scope","work-breakdown"]}
---

# Plan

## Overview

Create a short plan that a developer (or agent) can execute end-to-end: ordered tasks, acceptance checks, and a concrete verification strategy.

## Chooser

- Use **plan** when: starting non-trivial work that needs task ordering, risk flags, or cross-cutting coordination — especially when scope is ambiguous or multiple approaches exist.
- Do NOT use plan when: the change is tiny (rename, typo fix, single-file edit) — just do it.
- Do NOT use plan for: writing spec artifacts or contracts (use `spec`); auto-routing across multiple skills (use `workflow`).

## Inputs / Outputs

**Inputs**: User request; archobs JSON from `archobs show all --format json` (required for non-tiny); forecast data (if external dependencies involved via step 4b).
**Outputs**: Objective function, decision table (if 2+ approaches), ordered task list with acceptance criteria, measurement ladder. Consumed by downstream skills: `spec`, `architecture`, `design`, `testing`, `finish`.

## Workflow

1. Write the objective function:
   - goal (one sentence)
   - constraints (budget/time/compliance/latency/team capacity/etc.)
   - anti-goals (what you are explicitly not optimizing now)
2. Externalize a one-page system sketch:
   - boundary (in/out) + time horizon (near-term vs later)
   - actors + incentives
   - key flows (work/data/risk/attention)
   - top 3 constraints/bottlenecks
3. Scope the change:
   - impacted components/services
   - impacted boundaries/contracts (HTTP/gRPC/events/WS/data model)
   - what is explicitly *out of scope*
4. **Load archobs data** (required): Run `archobs show all --format json` to get risk scores, cluster health, and drift in one shot. Files with `risk > 0.5` and clusters with `leakage > 0.20` should appear earlier in the task order. Drift data (`ari_prev < 0.50`) flags areas to avoid broad moves in. If the artifacts do not exist, run `archobs report --repo <path> --out .archobs --suggestions-provider rules` and **wait for it to complete** before continuing.
4b. **Risk Amplification** (conditional — run when any high-risk files/clusters from archobs touch external dependencies or technology choices):

   ```bash
   intel forecast    # lifecycle phases for relevant dependencies
   ```

   **Cross-reference matrix**: See [Lifecycle Decision Mapping — Plan: Risk Amplification](../references/lifecycle-decision-mapping.md#plan-risk-amplification) for archobs signal x forecast signal → priority adjustment table.

5. Identify the primary risk(s) (pick 1–3): correctness, migration, partial failure, security/privacy, performance, operability.
6. Add a compact decision table (2–3 options including a no-change baseline):
   - what each option optimizes
   - what each option knowingly worsens
   - kill criteria / reversal trigger
7. Stress-test the decision (if 2+ viable approaches exist; skip for single viable approach):
   - **Assumptions**: What are facts vs assumptions? Which assumption is least certain — how will we validate it? Cross-reference with risk amplification from step 4b (if applicable). *(attach to decision table)*
   - **Second-Order Effects**: What happens next week / next quarter / next year? What new load, toil, coupling, or failure mode does this create? If this fails in 6-12 months, what likely caused failure? Cross-reference with risk amplification from step 4b (if applicable). *(attach to decision table)*
   - **Opportunity Cost**: What are we saying "no" to? Are we favoring this due to sunk cost, familiarity, or novelty? *(attach to decision table)*
   - If probe output already exists from an earlier Define-stage skill in this flow (including `workflow` orchestration), refine it instead of re-running.
> **GATE**: If step 6 identified 2+ viable approaches, a decision table MUST exist with trade-offs and kill criteria before proceeding. Do not skip to the task list — a plan without a decision is just a to-do list.

8. Choose the minimum up-front artifacts:
   - if boundary semantics/contracts change → use `spec`
   - if cross-service/system pressure exists → use `architecture`
   - if in-process structure pressure exists → use `design`
   - if repeated boundary logic is likely → use `platform`
9. Produce an ordered task list:
   - tasks should be small, reversible, and verifiable
   - include "stop points" where you can re-check assumptions and kill criteria
   - include one quick blast-radius check ("if X degrades, what breaks next/silently?")
10. Define measurement + verification:
   - measurement ladder: decision, 3 leading indicators, 3 lagging outcomes, instrumentation source, review ritual (owner + cadence + trigger)
   - exact commands (tests/lint/typecheck/build) if known
   - if unknown, list what you will run and ask once for preferred commands

## Minimum viable execution

When context or time is constrained, these are the load-bearing steps:

1. **Write objective function** (step 1) — goal + constraints + anti-goals.
2. **Load archobs data** (step 4) — risk-based task ordering depends on this.
3. **Decision table** (step 6) — required if 2+ approaches exist.
4. **Ordered task list with acceptance criteria** (step 9) — every task must be verifiable.

Steps that can be cut under pressure: system sketch (step 2), stress-test probes (step 7), measurement ladder (step 10).

## Clarifying Questions

- What is the goal in one sentence? What are we explicitly not optimizing?
- What components, services, or boundaries are affected?
- Are there time, budget, or compliance constraints?
- Is there existing archobs data or a recent report available?
- What verification commands are available (tests, lint, typecheck, build)?

## Guardrails

- Keep the plan short (usually 5–12 tasks). Avoid “spec theater” for tiny changes.
- Every task needs an observable acceptance check (test, command output, file diff, or demo step).
- Call out unknowns early; don’t pretend certainty.
- No metric without a named decision it informs.
- For non-trivial work, include explicit opportunity costs; avoid decision-by-default.
- If you propose retries, also propose idempotency/dedupe and time budgets (`resilience`).

## Common failure modes

- Produces task lists without acceptance criteria — tasks cannot be verified as done.
- Skips the decision table when 2+ approaches exist, defaulting to the first idea without evaluating alternatives.
- Does not load archobs data, so task ordering ignores empirical risk scores and cluster health.
- Conflates constraints with anti-goals — constraints are things you must satisfy; anti-goals are things you're explicitly choosing not to optimize.
- Plans that are just "the steps I was going to take anyway" — no risk identification, no stop points, no blast-radius check.

## Output Template

Return:

- **Goal**: 1–2 sentences.
- **Objective function**: goal + constraints + anti-goals.
- **System sketch**: boundary/time horizon, actors/incentives, key flows, bottlenecks.
- **Scope**: in/out.
- **Decision table**: options, optimizations, known downsides, kill criteria, assumptions (facts vs assumptions), and opportunity costs.
- **Risks/assumptions**: 3–6 bullets.
- **Plan**: ordered checklist with acceptance per task.
- **Measurement ladder**: leading/lagging indicators, instrumentation, owner/cadence/trigger.
- **Verification**: commands to run + what “good” looks like.
- **Open questions**: only if blocking.

## References

- Empirical risk data for prioritization: [`archobs`](../archobs/SKILL.md)
- Structured-thinking probes + templates: [`../references/`](../references/) (checklists for inline probes, templates for escalation)
