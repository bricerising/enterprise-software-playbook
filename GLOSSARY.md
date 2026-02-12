# Glossary

Short definitions for common terms used across **enterprise-software-playbook**.

This is intentionally lightweight. When in doubt, follow the workflow and treat boundaries/contracts as the source of truth.

## Workflow Artifacts

- **Decision record (ADR)**: A short doc capturing context → decision → consequences (trade-offs + migration/verification plan). See `spec` and `specs/decisions/`.
- **Spec bundle**: A small set of docs that pins intent and behavior (e.g., `spec.md`, `contracts/`, `plan.md`, `tasks.md`, `quickstart.md`). See `spec`.
- **Contract**: The consumer-facing shape and semantics at a boundary (HTTP/OpenAPI, proto/gRPC, event schema, WS). Contracts should change intentionally and come with tests. See `spec` and `testing`.
- **Boundary**: Any seam where data or control crosses trust/ownership (HTTP handler, RPC method, message consumer, DB adapter, third-party client). Boundaries get validation, stable errors, time budgets, and telemetry. See `typescript`, `resilience`, `observability`, `security`.

## Reliability (Partial Failure)

- **Timeout / time budget**: A hard cap on how long work is allowed to take. A time budget is the total allowed time across retries and downstream calls. See `resilience`.
- **Cancellation propagation**: When a request/job is canceled or times out, downstream work is also canceled (e.g., via `AbortSignal`). See `resilience`.
- **Retry (bounded)**: Re-attempt an operation only for retryable failures, with backoff+jitter and a cap on attempts/time. See `resilience`.
- **Idempotency**: “Same request twice has the same effect as once.” Usually implemented via an idempotency key or dedupe record. Required anywhere retries or at-least-once delivery exist. See `resilience`.
- **Dedupe**: Detect and safely ignore duplicates (often in event consumers). See `resilience`.
- **Circuit breaker**: A guard that stops calling an unhealthy dependency for a cooldown period (fail fast), then probes recovery. See `resilience`.
- **Bulkhead (concurrency limit)**: A per-dependency limit that prevents one slow/unhealthy dependency from saturating your process. See `resilience`.

## Observability

- **Correlation IDs**: Stable identifiers that let you connect logs ↔ traces ↔ metrics (often `traceId`, sometimes a separate `requestId`). See `observability`.
- **RED metrics**: Request **R**ate, **E**rrors, **D**uration for a boundary (per route/RPC). See `observability`.
- **High-cardinality labels**: Metric labels with unbounded values (user IDs, raw URLs) that make metrics expensive and unusable. Prefer logs/traces for per-entity detail. See `observability`.
- **Telemetry field contract**: A stable set of log keys/span attributes/metric labels used consistently across services. See `observability` and `platform`.

## Security

- **Authn (authentication)**: Proving who the caller is (e.g., validating a session/JWT). See `security`.
- **Authz (authorization)**: Proving what the caller is allowed to do (per action/resource/tenant). See `security`.
- **SSRF**: Server-Side Request Forgery; letting an attacker influence server-side network requests. Mitigated with allowlists and careful URL/DNS/IP validation. See `security`.

## Architecture (When Systems Grow)

- **Bounded context**: A boundary where a model and its language are consistent; changes across contexts require explicit integration seams. See `architecture`.
- **Saga**: A multi-step cross-service workflow coordinated via messages/compensations. Useful under partial failure; easy to misuse without idempotency and clear semantics. See `architecture`.
- **CQRS**: Separating write and read models for scaling/complexity reasons. Adds operational and consistency complexity. See `architecture`.
- **Event sourcing**: Persisting state as an append-only event log. Powerful, but high cost; avoid unless you can justify the operational and schema-evolution burden. See `architecture`.

## Decision Quality

- **Structured-thinking probe**: A compact checklist (1-3 bullets per prompt) used to stress-test non-trivial decisions. Covers first-principles assumptions, second-order effects, feedback loops, opportunity cost/bias, and learning loops. Probes attach to existing artifacts (objective function, system sketch, decision table, measurement ladder). See shared references in `skills/references/`.
- **Structured-thinking template pack**: A multi-prompt flow for a specific decision shape (design review, trade-off, retrospective, roadmap, PR/ADR recommendation framing). Use when compact probes are not enough — see escalation criteria in the checklists file. See shared references in `skills/references/`.

## Codebase Structure

- **Composition root**: The “wiring” module where dependencies are created and lifetimes are owned (start/stop). Avoid hidden globals and import-time I/O. See `typescript`.
- **Scriptic vs systemic**: “Scriptic” is short-lived glue code; “systemic” is long-lived production code. Systemic code needs explicit boundaries, error semantics, and lifetimes. See `typescript` and `design`.
