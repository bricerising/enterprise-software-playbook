---
name: spec
description: "Write and maintain spec-first artifacts (service specs, API contracts via OpenAPI/protobuf/WebSocket schemas, ADRs, task lists, quickstarts). Use when creating specs/*.md, apps/*/spec/ bundles, or contracts/ docs, especially before major behavior changes or multi-agent collaboration. NOT for implementation task breakdown without spec artifacts (use plan); NOT for choosing system or code patterns (use architecture or design)."
metadata: {"stage":"Define","tags":["spec-first","contracts","acceptance-criteria","decision-records","nfrs","openapi","protobuf","adr"],"aliases":["specification","contract","api-contract","schema","acceptance","requirements"]}
---

# Spec (Spec-Driven Development)

## Overview

Create a stable “source of truth” for agents and humans: write specs with testable acceptance criteria and keep them aligned with implementation.

This skill treats specs as **operational tooling**: they prevent scope drift, enforce invariants, and make AI iteration converge.

## Core Idea

- Specs define **what must be true** (contracts, scenarios, invariants, NFRs), not “how we coded it”.
- Plans/tasks define **how we’ll get there** (phases, work breakdown, acceptance per task).
- Code + tests are the proof.

## Where Specs Live (Opinionated)

Use one (or both) of these:

- **System specs**: `specs/*.md` for cross-service rules and shared constraints (auth, observability, eventing, product scope).
- **Decision records**: `specs/decisions/*.md` for significant choices (trade-offs, migrations, taxonomy, compatibility).
- **Service spec bundle**: `apps/<service>/spec/` for service-local truth:
  - `spec.md`: requirements and acceptance scenarios
  - `contracts/`: OpenAPI/proto/WS message contracts
  - `data-model.md`: domain entities + storage boundaries
  - `plan.md`: phases and wiring/structure
  - `tasks.md`: checklist-style backlog with acceptance criteria
  - `quickstart.md`: how to run/verify the service in dev

## Chooser (What Spec Artifact To Write)

- **Cross-service rule or shared constraint** (auth, observability, eventing, product scope): write/update a system spec (`specs/NNN-<topic>.md`).
- **Significant trade-off or migration decision**: write a decision record (`specs/decisions/NNN-<topic>.md`).
- **New or changed service behavior**: write/update the service spec bundle (`apps/<service>/spec/`).
- **API/contract change** (new endpoint, changed schema, new event): update contracts (`contracts/`: OpenAPI/proto/WS docs) in the spec bundle.
- **Task breakdown for implementation**: update `tasks.md` in the spec bundle (or `specs/tasks.md` for repo-level backlog).
- **Minor behavior tweak within existing contracts**: update acceptance scenarios in the existing spec; no new artifacts needed.

## Clarifying Questions

- Is this change scoped to one service or does it cross service boundaries?
- Does it change externally visible behavior (API shapes, error codes, event schemas, auth rules)?
- Are there existing specs/contracts that should be updated vs creating new ones?
- Who are the consumers of this contract (other services, clients, external partners)?
- Is backward compatibility required, or can we make breaking changes?

## Workflow

1. Decide the scope:
   - One service? write/update the service spec bundle.
   - Cross-service or product-wide? write/update a system spec.
2. Write the objective function up front:
   - goal, constraints, anti-goals
   - boundary (in/out) and time horizon
3. Externalize the system sketch:
   - actors + incentives
   - key flows (work/data/risk)
   - top constraints/bottlenecks
4. Write acceptance-first:
   - user story + “independent test”
   - acceptance scenarios (Given/When/Then)
   - edge cases and invariants (“constitution requirements”)
5. Lock down contracts:
   - HTTP/gRPC schemas, message types, error codes, idempotency keys
   - versioning rules and backward compatibility expectations
6. Add non-functional requirements (NFRs) that matter:
   - latency budgets, concurrency, durability, audit, privacy
   - observability and resilience requirements (trace/log/metrics, timeouts/retries/idempotency)
7. Add a compact decision table:
   - options considered (include baseline/no-change)
   - what is optimized vs knowingly worsened
   - kill criteria / reversal trigger
8. Add a measurement ladder:
   - decision being measured
   - leading indicators (early signal)
   - lagging outcomes (business/ops)
   - instrumentation sources + review ritual (owner/cadence/action trigger)
9. Break it into tasks with acceptance:
   - keep tasks small and orderable
   - each task has an observable acceptance check
10. Implement and keep docs honest:
   - if implementation forces a change in behavior, update specs first
   - keep quickstarts and contracts current

## Guardrails

- “No spec, no change”: don’t implement major behavior without updating the spec surface.
- Don’t hide requirements in code; put them in `spec.md` where agents can find them.
- Keep contracts stable; prefer additive changes and version explicitly when you can’t.
- Write down **non-goals** to stop scope creep.
- No metric without a named decision and review ritual.
- If a design cannot be measured cheaply enough to guide weekly decisions, treat that as a constraint and simplify.

## References

- Templates: [`references/templates.md`](references/templates.md)
- Spec quality checklist: [`references/checklists.md`](references/checklists.md)
- Architecture choices: [`architecture`](../architecture/SKILL.md)
- In-process pattern choices: [`design`](../design/SKILL.md)
- Typed boundaries/errors/lifetimes: [`typescript`](../typescript/SKILL.md)
- Consumer-visible tests: [`testing`](../testing/SKILL.md)

## Output Template

When using this skill, return:

- **Scope + objective**: boundary, constraints, anti-goals.
- **Artifacts created/updated**: exact spec files (and contracts/ADRs when relevant).
- **Decision summary**: options considered, selected option, trade-offs, and kill criteria.
- **Measurement ladder**: leading + lagging indicators, owner/cadence/action trigger.
- **Verification plan**: concrete checks/commands that prove acceptance scenarios and failure expectations.
- **Next implementation tasks**: ordered checklist with observable acceptance per task.
