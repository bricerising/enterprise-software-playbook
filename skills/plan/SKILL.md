---
name: plan
description: "Break a request into a scoped implementation plan with ordered tasks, risk flags, and verification steps. Use before starting non-trivial, cross-cutting, or ambiguous work to align on approach and prevent rework. NOT for writing spec artifacts or contracts (use spec); NOT for auto-routing across multiple skills (use workflow)."
metadata: {"stage":"Define","tags":["implementation-plan","task-breakdown","risk-assessment","verification-plan","scope","trade-offs","decision-table"],"aliases":["planning","task-list","breakdown","scope","work-breakdown"]}
---

# Plan

## Overview

Create a short plan that a developer (or agent) can execute end-to-end: ordered tasks, acceptance checks, and a concrete verification strategy.

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
4. Identify the primary risk(s) (pick 1–3): correctness, migration, partial failure, security/privacy, performance, operability.
5. Add a compact decision table (2–3 options including a no-change baseline):
   - what each option optimizes
   - what each option knowingly worsens
   - kill criteria / reversal trigger
6. Choose the minimum up-front artifacts:
   - if boundary semantics/contracts change → use `spec`
   - if cross-service/system pressure exists → use `architecture`
   - if in-process structure pressure exists → use `design`
   - if repeated boundary logic is likely → use `platform`
7. Produce an ordered task list:
   - tasks should be small, reversible, and verifiable
   - include “stop points” where you can re-check assumptions and kill criteria
   - include one quick blast-radius check (“if X degrades, what breaks next/silently?”)
8. Define measurement + verification:
   - measurement ladder: decision, 3 leading indicators, 3 lagging outcomes, instrumentation source, review ritual (owner + cadence + trigger)
   - exact commands (tests/lint/typecheck/build) if known
   - if unknown, list what you will run and ask once for preferred commands

## Guardrails

- Keep the plan short (usually 5–12 tasks). Avoid “spec theater” for tiny changes.
- Every task needs an observable acceptance check (test, command output, file diff, or demo step).
- Call out unknowns early; don’t pretend certainty.
- No metric without a named decision it informs.
- If you propose retries, also propose idempotency/dedupe and time budgets (`resilience`).

## Output Template

Return:

- **Goal**: 1–2 sentences.
- **Objective function**: goal + constraints + anti-goals.
- **System sketch**: boundary/time horizon, actors/incentives, key flows, bottlenecks.
- **Scope**: in/out.
- **Decision table**: options, optimizations, known downsides, kill criteria.
- **Risks/assumptions**: 3–6 bullets.
- **Plan**: ordered checklist with acceptance per task.
- **Measurement ladder**: leading/lagging indicators, instrumentation, owner/cadence/trigger.
- **Verification**: commands to run + what “good” looks like.
- **Open questions**: only if blocking.
