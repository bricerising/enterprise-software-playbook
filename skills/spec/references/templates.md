# Spec Templates (Enterprise Web Apps)

These templates are designed to be copied into a repo and then edited until they reflect reality.

Keep the language concrete and testable. Prefer “MUST/SHOULD/MAY” and explicit acceptance criteria.

## Concrete starter files (copy-first)

- Service spec bundle directory: [`specs/templates/service-spec-bundle/`](../../../specs/templates/service-spec-bundle/README.md)
- CI quality pipeline template: [`specs/templates/ci/github-actions-quality.yml`](../../../specs/templates/ci/github-actions-quality.yml)

## System Spec Template (`specs/NNN-<topic>.md`)

```md
# Spec NNN: <Topic>

## Overview

What problem this spec solves and which services/teams it applies to.

## Goals

- ...

## Constraints

- ...

## Non-goals

- ...

## Anti-goals

- ...

## System Sketch

- Boundary (in/out):
- Time horizon:
- Actors + incentives:
- Key flows (work/data/risk):
- Top constraints/bottlenecks:

## Definitions

- ...

## Requirements

### Functional

- **R-001**: ...

### Non-functional

- **NFR-001**: ...
- **NFR-002**: ...

## Invariants (“Constitution”)

Non-negotiable system rules (security boundaries, consistency boundaries, audit requirements, etc.).

- ...

## Observability

- Logs: required fields
- Traces: boundaries + propagation expectations
- Metrics: RED metrics + business metrics

## Resilience

- timeouts, retries/backoff, idempotency expectations
- circuit breaker/bulkhead expectations (where relevant)

## Security / Privacy

- authn/authz rules
- PII handling rules

## Decision Table

| Option | Optimizes for | Knowingly worsens | Kill criteria |
| --- | --- | --- | --- |
| A | ... | ... | ... |
| B | ... | ... | ... |
| C (optional) | ... | ... | ... |

## Measurement Ladder

- Decision being measured:
- Leading indicators (early):
- Lagging outcomes:
- Instrumentation source:
- Review ritual (owner + cadence + action trigger):

## Dynamics + Blast Radius

- If X degrades, what breaks next?
- What breaks silently?
- What accumulates over time (toil/backlog/lag/exceptions)?
- What balancing loop limits runaway growth?

## Acceptance

How you’ll verify the spec is satisfied (tests, e2e flows, manual checks).

- ...
```

## Decision Record Template (`specs/decisions/NNN-<topic>.md`)

Use this when making a choice that has meaningful trade-offs or migration impact.

```md
# Decision NNN: <Title>

**Date**: YYYY-MM-DD
**Status**: Proposed | Accepted | Rejected | Superseded

## Context

What problem are we solving? What pressures/constraints matter?

- **Goal**:
- **Constraints**:
- **Anti-goals**:
- **Boundary + time horizon**:
- **Actors + incentives**:

## Options considered

| Option | Optimizes for | Knowingly worsens | Reversibility |
| --- | --- | --- | --- |
| A | ... | ... | ... |
| B | ... | ... | ... |
| C (optional) | ... | ... | ... |

## Decision

What we chose and why (short, concrete).

## Kill criteria / reversal trigger

- ...

## Measurement + review ritual

- **Leading indicators (early)**:
- **Lagging outcomes**:
- **Instrumentation source**:
- **Owner + cadence + action trigger**:

## Consequences

- Positive outcomes / what gets simpler
- Trade-offs / what gets harder
- Compatibility/migration impact

## Review date

YYYY-MM-DD
```

## Service Spec Template (`apps/<service>/spec/spec.md`)

```md
# Feature Specification: <Service>

**Service**: `<package-name>`
**Created**: YYYY-MM-DD
**Status**: Planned | In Progress | Shipped

## Overview

What the service does, who uses it, how it integrates (HTTP/gRPC/events), and what it does not do.

## Objective Function

- Goal:
- Constraints:
- Anti-goals:

## System Sketch

- Boundary (in/out):
- Time horizon:
- Actors + incentives:
- Key flows:
- Top bottlenecks:

## User Scenarios & Testing

### User Story 1 - <Scenario Name> (Priority: P1)

As a <role>, I can <do X> so that <value>.

**Independent Test**: <one sentence you can turn into an automated test>

**Acceptance Scenarios**:

1. **Given** ..., **When** ..., **Then** ...
2. ...

---

### Edge Cases

- ...

## Constitution Requirements

Non-negotiable rules for correctness and safety.

- boundary validation rules
- security boundary (who trusts whom)
- consistency boundary and ownership
- idempotency rules
- observability requirements

## Requirements

### Functional Requirements

- **FR-001**: ...

### Non-Functional Requirements

- **NFR-001**: latency budget ...
- **NFR-002**: concurrency ...
- **NFR-003**: durability/audit ...
- **NFR-004**: telemetry ...

## Key Entities

- ...

## Success Criteria

Measurable outcomes (latency, error rate, correctness invariants, coverage).

- ...

## Decision Table

| Option | Optimizes for | Knowingly worsens | Kill criteria |
| --- | --- | --- | --- |
| A | ... | ... | ... |
| B | ... | ... | ... |

## Measurement Ladder

- Decision being measured:
- Leading indicators:
- Lagging outcomes:
- Instrumentation source:
- Review ritual (owner + cadence + action trigger):

## Assumptions

- ...
```

## Service Plan Template (`apps/<service>/spec/plan.md`)

```md
# Implementation Plan: <Service>

## Overview

What you’re building, and how it fits the system.

## Architecture (High Level)

Diagram or bullet list of dependencies and boundaries.

## Failure Propagation Map

- If X degrades, what breaks next?
- What breaks silently?
- Organizational cascade points (handoffs/approvals/ownership gaps):

## Dynamics Check

- Where are the main delays?
- What accumulates over time?
- What balancing loop prevents runaway growth?

## Directory Structure (Planned)

Short tree of where things will live. Keep it honest; update if it changes.

## Phases

### Phase 1: <Name>

- ...

### Phase 2: <Name>

- ...
```

## Service Tasks Template (`apps/<service>/spec/tasks.md`)

```md
# Tasks: <Service>

## Phase 1: <Name>

### T001: <Task name>

- **Files**: `...`
- **Acceptance**: <copy/paste runnable checks, tests, or specific observable behavior>
- **Dependencies**: <T000, libs, env vars>

### T002: <Task name>

- ...
```

## Contract Templates (`apps/<service>/spec/contracts/`)

Pick the minimal contract surface that matches your boundary.

### HTTP (`openapi.yaml`)

- define routes, request/response schemas, and error responses
- include auth requirements and headers
- document idempotency keys when needed

### gRPC (`*.proto`)

- prefer explicit “business error” response envelopes when failures are expected
- reserve gRPC status errors for transport/system failures

### WebSocket (`ws-messages.md`)

- list message types and payload shapes
- define auth handshake, error messages, and resync behavior
```
