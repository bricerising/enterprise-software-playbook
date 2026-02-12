# PROMPTS (Prompt Recipes)

Copy/paste prompts for using **enterprise-software-playbook** with an AI coding assistant.

If your assistant supports “skills”, name them explicitly (e.g., `workflow`). If not, point it at the referenced `SKILL.md` files.

## Conversational bootstrap (auto-route)

Use this to start most sessions:

```text
Use workflow (read skills/workflow/SKILL.md).

Follow the default loop: Define → Standardize → Harden → Verify → Mechanics.
Keep overhead proportional (tiny changes stay lightweight).

For non-trivial work, externalize first:
- objective function (goal, constraints, anti-goals)
- one-page system sketch (boundary/time horizon, actors/incentives, key flows, bottlenecks)
- compact decision table (options, trade-offs, kill criteria)
- measurement ladder (leading/lagging indicators, owner/cadence, action trigger)
- structured-thinking probe (assumptions, second-order effects, feedback loops, opportunity cost/bias)

If you change a boundary contract/semantics (HTTP/gRPC/events/WS), update specs/contracts first and pin behavior with tests.

For non-trivial work, run finish before reporting completion.
When you finish, report: skills applied, what changed, verification, follow-ups.

Task: <describe what you want>
```

## Define (what are we building?)

### Write/update a spec bundle

```text
Use spec (read skills/spec/SKILL.md).

Goal: <feature/bug/refactor intent>

Before implementing, write or update the relevant spec bundle:
- System-level: specs/*.md and/or specs/decisions/*.md (if cross-service or significant)
- Service-level: apps/<service>/spec/ (spec.md, contracts/, plan.md, tasks.md, quickstart.md)

Include: acceptance scenarios, edge cases, failure-mode expectations, and a verification plan.
Also include: objective function, system sketch, decision table, structured-thinking probe, measurement ladder, and kill criteria.
```

### Create an implementation plan (tasks + verification)

```text
Use plan (read skills/plan/SKILL.md).

Task: <what do you want to build/fix?>

Produce an ordered checklist of tasks with acceptance checks and exact verification commands (or ask once if unknown).
Keep it short and reversible.
Include: system sketch, decision table, structured-thinking probe, blast-radius check, and measurement ladder.
```

### Choose a system/architecture pattern

```text
Use architecture (read skills/architecture/SKILL.md).

Context: <system pressure(s): partial failures, consistency, cross-service workflows, integration seams>
Constraints: <latency/SLOs, scalability, team boundaries, compliance>

Recommend the smallest viable pattern(s), risks/anti-patterns, and a validation plan.
Include: options table, what each option worsens, opportunity cost, kill criteria, pre-mortem risks, and a failure-propagation map.
```

### Choose an in-process/design pattern

```text
Use design (read skills/design/SKILL.md).

Context: <construction/structure/behavior pressure>
Constraints: <testability, extensibility, performance, simplicity>

Recommend the smallest viable pattern and show how it fits this codebase.
```

## Standardize (make it consistent)

### Extract a shared “golden path” primitive

```text
Use platform (read skills/platform/SKILL.md).

Problem: We have repeated boundary logic across services (timeouts/retries/error mapping/telemetry fields/etc.).
Goal: Propose a small shared primitive (two-consumer rule) that removes copy/paste drift.

Include: API shape, error envelope, time budget policy, telemetry field contract, and adoption steps.
Use adoption maturity tracks (V0/V1/V2) with entry criteria.
```

### TypeScript safety/refactor pass

```text
Use typescript (read skills/typescript/SKILL.md).

Goal: Improve maintainability and runtime safety without changing behavior.
Focus: typed boundaries, explicit lifetimes, safe module structure, and predictable error handling.
```

## Harden (make it survive reality)

### Resilience hardening for I/O boundaries

```text
Use resilience (read skills/resilience/SKILL.md).

Boundary: <HTTP/gRPC/DB/cache/queue/external API>
Risk: <timeouts, retries, at-least-once delivery, partial failure>

Add explicit time budgets + cancellation propagation. Only add retries when safe and idempotent.
```

### Security hardening for boundaries

```text
Use security (read skills/security/SKILL.md).

Boundary: <HTTP/gRPC/WS/events/outbound HTTP/DB/etc>
Risk: <authn/authz, injection, SSRF, secrets/PII, multi-tenant isolation>

Add authn/authz checks, strict input validation, safe logging/telemetry, and SSRF/injection guardrails where applicable.
```

### Observability instrumentation + verification

```text
Use observability (read skills/observability/SKILL.md).

Boundary: <HTTP/gRPC/events/jobs>
Goal: Add correlated logs/traces/metrics and local verification steps (log → trace → metrics).

Define a stable telemetry field contract (IDs, names) and avoid high-cardinality metrics labels.
Map metrics to a named decision and define a review ritual (owner/cadence/action trigger).
```

### Triage an incident / regression (log → trace → metrics)

```text
Use debug (read skills/debug/SKILL.md).

Symptom: <what is broken/slow?>
Environment: <local/dev/staging/prod>
Time window: <start/end>
Exemplar: <traceId/requestId/log line timestamp/etc>

Guide a systematic investigation and end with: evidence, hypothesis, mitigation, and a fix/follow-up plan.
Include a failure-propagation map (what breaks next/silently/organizationally).
```

## Verify (prove behavior)

### Add consumer-centric tests

```text
Use testing (read skills/testing/SKILL.md).

Goal: Pin consumer-visible behavior for <feature/bug/refactor>.
Approach: characterization tests before refactors; avoid asserting implementation details.
```

### Run an adversarial code review debate

```text
Use review (read skills/review/SKILL.md).

Review type: general
Scope: <PR link / diff / commit range / file list>
Output dir: <where to write 1-critique.txt ... 4-verdict.txt>

Run the 4-phase protocol and finish with the skill’s output template.
```

### Finish (definition-of-done pass)

```text
Use finish (read skills/finish/SKILL.md).

Before calling the work done:
- run the best-available verification commands (tests/typecheck/lint/build)
- spot-check boundary discipline where applicable (timeouts/authz/telemetry)
- report two packets:
  - executive packet (goal, decision/bet, risks, signals/ritual, next step)
  - engineer packet (what changed, verification, risks/follow-ups)
- include a short learning loop (outcome vs expectation, assumption confirmed or updated, one owner-backed improvement if expectations diverged)
```

## Structured Thinking (decision-quality prompts)

These prompts go directly to template packs (the full multi-prompt flows). For the lighter-weight probe-first approach integrated into normal skill workflows, use the standard skill prompts above — probes run automatically for non-trivial work with 2+ viable approaches.

Use these when the primary goal is evaluating a decision or stress-testing a design rather than producing an implementation plan or spec artifact.

Full template details live in `skills/references/structured-thinking-templates.md`. Compact probe details live in `skills/references/structured-thinking-checklists.md`.

### Run a technical design review

```text
Use architecture (read skills/architecture/SKILL.md).
Stress-test the design for: <system/boundary being designed>
Prioritize: assumptions, feedback loops, second-order effects.
Include structured-thinking probes (see skills/references/structured-thinking-templates.md — Technical Design Review).
```

### Run a trade-off / project decision analysis

```text
Use plan (read skills/plan/SKILL.md).
Decision: <what are we choosing between?>
Options: <list options, including status quo>
Prioritize: assumptions, opportunity cost, second-order effects.
Include structured-thinking probes (see skills/references/structured-thinking-templates.md — Trade-Off / Project Decision).
```

### Run a retrospective / postmortem

```text
Use finish (read skills/finish/SKILL.md) for delivery learning,
 or debug (read skills/debug/SKILL.md) for incident triage.
Context: <what happened — delivery, incident, or rollback>
Prioritize: learning loop (outcome vs expectation, assumption update, owner-backed action).
Include the learning loop (see skills/references/structured-thinking-templates.md — Retrospective / Postmortem).
```

### Frame a technical recommendation for async review

```text
Use finish (read skills/finish/SKILL.md).
Recommendation: <what action/decision this PR/ADR is requesting>
Reviewers: <who will review and approve>
Prioritize: evidence, counterpoints, explicit owner + next step.
Include recommendation framing (see skills/references/structured-thinking-templates.md — Recommendation Brief).
```

## Mechanics (in-process building blocks)

### Apply a concrete GoF pattern

```text
Use patterns-<creational|structural|behavioral> (read the matching `skills/patterns-*/SKILL.md`).

Problem: <what needs structure?>
Goal: Introduce a pattern seam that improves readability/testability without over-engineering.
```
