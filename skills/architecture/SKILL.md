---
name: architecture
description: "Design or refactor multi-service system architecture (domain boundaries, service decomposition, event-driven vs request/response, CQRS, sagas, API gateways, data ownership). Use when work spans multiple processes/services, needs eventual consistency, or requires clearer integration seams. NOT for in-process code structure like GoF patterns (use design); NOT for applying timeouts/retries/breakers to a single call (use resilience)."
metadata: {"stage":"Define","tags":["system-patterns","distributed-systems","consistency","microservices","integration","domain-boundaries","event-driven","saga"],"aliases":["system-design","distributed","multi-service","cross-service","decomposition","bounded-context"]}
---

# Architecture (System Pattern Chooser)

## Overview

Pick the smallest system/architecture pattern that addresses the pressure (reliability, consistency, domain boundaries, scalability).

Use code patterns for in-process structure; use system patterns when the problem is cross-process or cross-team.

## Workflow

1. Externalize the system model:
   - objective function (goal, constraints, anti-goals)
   - boundary (in/out), time horizon, actors/incentives, and key flows
2. Classify the problem: single-process design vs multi-process/distributed.
3. Identify the main pressure (pick 1):
   - Reliability under partial failure (timeouts/retries/circuit breaker/bulkheads)
   - Data consistency across boundaries (saga, event sourcing, CQRS)
   - Domain complexity and ownership (bounded contexts, aggregates, repositories, domain events)
   - Scalable coordination (leader election, sharding)
   - Migration/integration (anti-corruption layer, strangler fig, API gateway/BFF)
   - Streaming/reactivity (pub/sub, reactive streams/backpressure)
   - ML lifecycle (data pipeline, feature store, canary/blue-green, transfer learning)
4. State what’s stable and what can change (contracts, schemas, SLAs).
5. Build a compact decision table (2–3 options including no-pattern baseline):
   - what each option optimizes
   - what each option knowingly worsens
   - kill criteria / reversal trigger
6. Choose a primary pattern and 0–2 supporting ones (avoid “pattern soup”).
7. Stress-test with: happy path, failure path, ops path, and blast-radius path:
   - if X degrades, what breaks next?
   - what breaks silently?
   - what is the organizational cascade (handoffs/approvals/ownership gaps)?
8. Run a dynamics check:
   - where are delays (feedback, approvals, recovery)?
   - what accumulates (toil, backlog, queue lag, exceptions)?
   - what balancing loop prevents runaway growth?
9. Map to implementation tactics (often code-pattern wrappers/pipelines), testing strategy, and measurement ritual.

## Clarifying Questions

- What are the deployable units and trust boundaries (processes/services/teams)?
- Is failure partial (network timeouts, 5xx, queue backlog)? What are the SLOs?
- Do we require strong consistency, or is eventual consistency acceptable?
- Who owns each piece of data? What is the source of truth?
- What is the integration style: synchronous RPC, async events, or both?
- Do operations need to be idempotent? Do we have request IDs?
- What is the expected load profile (spikes, fan-out, long tails)?
- Can we tolerate duplication / reordering of messages?
- Where are the key delays between signal and action?
- What work or risk accumulates if this runs “hot” for weeks?
- What behavior might teams game once metrics are introduced?

## Pattern Chooser

### Cloud-Native / Microservices

- **Circuit Breaker**: stop cascading failures when a dependency is down/flaky.
- **Bulkhead**: isolate resource pools so one dependency can’t starve everything.
- **Saga**: multi-step business workflow across services with compensations.
- **API Gateway / BFF**: one entry point / client-specific API to avoid chatty clients.
- **API Composition**: implement a “distributed query” by aggregating responses from multiple services.
- **Database per Service**: keep each service’s data private; integrate via APIs and domain events.
- **Service Discovery (client-side/server-side) + Service Registry**: route service-to-service calls without hardcoding hostnames.
- **Externalized Configuration**: keep per-environment config outside the deployable artifact.
- **Health Check API**: standardize liveness/readiness signals for orchestration and ops.
- **Service Mesh**: offload retries/mTLS/routing/telemetry to infrastructure (still own correctness at the app layer).
- **Sidecar / Ambassador**: move cross-cutting networking concerns out of the app process (mesh/proxy).
- **Strangler Fig**: migrate a monolith incrementally by routing slices to new services.

### Functional / Safer Flow

- **Immutability & pure functions**: reduce shared state; make concurrency and testing easier.
- **Higher-order functions & composition**: prefer passing behavior directly over object-heavy indirection.
- **Option/Maybe (and Either/Result)**: make absence and expected failures explicit (avoid `null`).

### Reactive / Event-Driven

- **Pub/Sub**: decouple producers/consumers via events.
- **Transactional outbox + idempotent consumer (inbox)**: avoid dual-write bugs; make at-least-once delivery safe with dedupe.
- **Reactive streams + backpressure**: prevent fast producers from overwhelming slow consumers.
- **Event Sourcing**: store events as source of truth; rebuild state by replay.
- **CQRS**: separate command (write) model from query (read) model.
- **Command-side replica**: replicate reference data into the command service to avoid synchronous cross-service reads.

### Domain-Driven Design (DDD)

- **Bounded Context**: define model boundaries + translations/anti-corruption layers.
- **Aggregate**: enforce invariants within a consistency boundary.
- **Repository**: hide persistence behind an in-memory collection-like interface.
- **Domain Events**: publish business facts; decouple side effects.
- **Anti-Corruption Layer**: translate external/legacy concepts to protect your domain.
- **Hexagonal architecture (ports & adapters)**: keep domain core independent from infrastructure.

### Distributed Coordination & Scale

- **Actor model**: concurrency via message-passing, isolation, supervision.
- **Leader election**: choose a single coordinator for exclusive work.
- **Sharding**: partition data/work across nodes.
- **Idempotency + retries/backoff**: tolerate duplicates and transient failures safely.
- **MapReduce**: batch/distributed processing by map then reduce.

### AI/ML Lifecycle

- **Data pipeline (batch vs streaming; lambda/kappa)**: move data reliably into training/serving.
- **Feature store**: single source of truth for feature definitions/serving.
- **Transfer learning**: adapt a pre-trained model instead of training from scratch.
- **Blue-green/canary model deploys**: reduce risk when shipping new model versions.

## Map To Existing Skills

- Spec + contracts + plans: [`spec`](../spec/SKILL.md).
- Shared primitives across services: [`platform`](../platform/SKILL.md).
- Observability (logs/metrics/traces correlation): [`observability`](../observability/SKILL.md).
- Timeouts / retries / idempotency / circuit breaker / bulkheads: [`resilience`](../resilience/SKILL.md) (often implemented via `Proxy`/`Decorator`).
- Circuit breaker / caching / rate limiting (in-process structure): often a `Proxy` or `Decorator` ([`patterns-structural`](../patterns-structural/SKILL.md)).
- Saga orchestration: often a `State` machine + `Command` objects ([`patterns-behavioral`](../patterns-behavioral/SKILL.md)).
- Pub/sub + domain events: `Observer` ([`patterns-behavioral`](../patterns-behavioral/SKILL.md)).
- Hexagonal architecture: ports are interfaces; adapters are often `Adapter` or `Facade` ([`patterns-structural`](../patterns-structural/SKILL.md)).
- Option/Result: aligns with typed error boundaries ([`typescript`](../typescript/SKILL.md)).

## References

- Decision tree (pressure → patterns → risks): [`references/decision-tree.md`](references/decision-tree.md)
- Pattern index (one file per pattern): [`references/patterns.md`](references/patterns.md)

## Output Template

When recommending a pattern:

- 1–2 sentences: pattern + why it fits (pressure, assumptions).
- Decision table summary: options considered, explicit trade-offs, and kill criteria.
- Blast-radius + dynamics notes: failure propagation, silent failures, delays, accumulations, balancing loop.
- A minimal implementation plan (boundaries, contracts, data ownership, tests/metrics, and review ritual owner/cadence).
