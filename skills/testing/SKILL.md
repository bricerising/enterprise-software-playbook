---
name: testing
description: "Create or expand test suites for microservices (unit, integration, consumer-contract tests for HTTP/gRPC handlers, service flows, event consumers, caches, jobs). Use when adding tests, raising coverage, writing regression tests, or validating consumer-facing behavior. NOT for adversarial code review (use review); NOT for final ship-readiness checks (use finish)."
metadata: {"stage":"Verify","tags":["test-coverage","consumer-tests","characterization","regression-prevention","unit-test","integration-test","mocking","vitest"],"aliases":["tests","unit-test","integration-test","coverage","test-suite","vitest","jest","consumer-contract"]}
---

# Testing (Consumer Test Coverage)

## Overview

Improve coverage by exercising consumer-visible behavior with infra mocked and behavior preserved.

## Inputs / Outputs

**Inputs**: Spec/contract artifacts from `spec` or `plan` (optional but preferred); consumer-facing entrypoints to test.
**Outputs**: Test suite pinning consumer-visible behavior; coverage report. Consumed by `finish` and `review`.

## Workflow

1. Read relevant specs (system + service) and map them to consumer-visible flows and invariants.
2. Identify consumer-facing entrypoints: HTTP/gRPC handlers, public service methods, event consumers, cache/storage adapters, jobs.

> **GATE**: Do not write tests until consumer-facing entrypoints are identified (step 2). If no entrypoints are listed, go back — tests without identified entrypoints tend to test implementation details.

3. Add tests for success and failure paths that a consumer can observe (invalid input, downstream failures, permissions, timeouts where applicable).
4. Mock infra boundaries (DB, Redis, network listeners, clocks/timers). Prefer calling handlers/functions directly instead of running real servers.
5. Run focused coverage and iterate until the target is met (default 80% unless the spec says otherwise).

## Minimum viable execution

When context or time is constrained, these are the load-bearing steps:

1. **Read specs and map to consumer-visible flows** (step 1) — tests must trace back to spec'd behavior.
2. **Identify consumer-facing entrypoints** (step 2) — determines what to test.
3. **Write success + failure path tests** (step 3) — both paths, not just happy path.
4. **Run coverage** (step 5) — verify the tests actually exercise the code.

Steps that can be cut under pressure: mocking strategy optimization (step 4), coverage iteration beyond first pass.

## Chooser (What Test Type Where)

- **New endpoint / handler change**: consumer-visible tests — call handler with mocked dependencies, assert response shape + status codes + error handling.
- **Refactor (no behavior change)**: characterization tests first — pin existing behavior before changing implementation.
- **New event consumer / job**: feed mixed payloads (valid, invalid, missing fields, duplicates); assert side effects and idempotency.
- **Boundary change (DB/cache/client)**: adapter tests — cover happy path, empty/null results, connection failures, timeouts.
- **Cross-service contract change**: consumer-contract tests — verify your consumer expectations match the provider's contract.
- **Coverage gap (existing code)**: start with the riskiest paths — auth/permissions, error handling, input validation, state transitions.

## Clarifying Questions

- What entrypoints are affected (HTTP handler, gRPC method, consumer, job, adapter)?
- Are there existing specs/contracts that define expected behavior?
- Is this new behavior (need new tests) or existing behavior (need characterization tests before refactoring)?
- What is the target coverage level (default: 80%)?
- What test runner and mocking setup does the project use?

## Testing Patterns

- Handler paths: call handler with mocked service, assert response, metrics, and error handling.
- Event consumers: feed mixed payload shapes (missing type, struct/list values, invalid entries).
- Cache/storage: cover cache hit/miss, null/empty results, invalidation behavior.
- Jobs: use fake timers; cover interval runs and error logging branches.
- Observability: assert metrics render and logging mixins without external services.
  - Vitest note: if mocked values are referenced by `vi.mock` factories, use `vi.hoisted` to avoid init-order bugs.

## Guardrails

- Preserve externally visible behavior and API shapes.
- Avoid real network/listen calls in unit tests; mock them.
- Keep tests consumer-focused; do not assert internal implementation details beyond outputs/side effects.

## Common failure modes

- Tests implementation details instead of consumer-visible behavior (e.g., asserting internal method call counts instead of response shape).
- Defaults to unit tests regardless of context — should use the chooser to pick the right test type.
- Mocks the thing being tested instead of its dependencies — the test exercises the mock, not the code.
- Tests happy path only, skips failure modes — missing tests for invalid input, downstream failures, permission denials, and timeouts.

## Commands

- Vitest example: `npx vitest run apps/<service>/**/*.test.ts --coverage --coverage.include='apps/<service>/src/**'`
- Generic: `cd apps/<service> && npm test -- --coverage`

## References

- Specs and contracts as test sources: [`spec`](../spec/SKILL.md)
- TypeScript test skeletons: [`references/snippets/typescript.md`](references/snippets/typescript.md)
- Related patterns: [`Consumer-side contract test`](../architecture/references/consumer-side-contract-test.md), [`Service integration contract test`](../architecture/references/service-integration-contract-test.md), [`Service component test`](../architecture/references/service-component-test.md)
- Telemetry verification (when tests cover boundary logging/metrics): [`observability`](../observability/SKILL.md)

## Output Template

When applying this skill, return:

- What consumer-visible behavior is now pinned (happy path + key failure modes).
- What tests were added/changed (by entrypoint: handler/consumer/job/adapter).
- Coverage/verification results (commands run + outcomes) and any notable gaps/follow-ups.
