---
name: platform
description: "Design and maintain shared platform libraries (e.g. packages/shared) that standardize cross-cutting concerns (auth wrappers, config, HTTP/gRPC helpers, typed errors, retry policies, lifecycle hooks). Use when multiple services duplicate boundary logic or need a golden-path primitive; prevents \"utils junk drawer\" anti-pattern. NOT for single-service code structure (use typescript); NOT for choosing resilience patterns for one call (use resilience)."
metadata: {"stage":"Standardize","tags":["shared-library","golden-path","cross-cutting","standardization","boundary-wrappers","packages-shared","extraction"],"aliases":["shared-kernel","shared-library","packages-shared","golden-path","platform-library","common-lib"]}
---

# Platform (Shared Platform Library)

## Overview

Create a small, disciplined “shared kernel” that drives cohesion across services by providing stable primitives at boundaries (auth, RPC, config, telemetry, resilience, lifecycles).

The goal is not reuse-for-reuse’s-sake; it’s consistent behavior and lower cognitive load across a system.

## Inputs / Outputs

**Inputs**: Repeated boundary patterns identified across 2+ services; existing shared packages (if any).
**Outputs**: Shared package with stable API surface, adoption maturity tracks (V0/V1/V2), migration guidance. Consumed by `spec` (contract documentation), `testing` (seam tests), `finish` (adoption verification).

## Workflow

1. Define the objective function:
   - what this extraction optimizes (for example: reliability, cognitive load, release speed)
   - constraints and anti-goals
2. Define the “platform surface” (what belongs here vs per-service).
3. Inventory repetition across services and pick 1–2 extractions with the highest leverage.
4. Design the module boundaries and dependency direction (avoid cycles, keep exports stable).
5. Design APIs that are:
   - explicit about inputs/outputs and expected failures (`Result` / tagged errors)
   - explicit about lifetimes (create/start/stop/dispose)
   - explicit about cancellation/time budgets (`AbortSignal`, deadlines)
   - explicit about telemetry fields (trace/log/metrics correlation)
6. Define adoption maturity tracks with entry criteria:
   - **V0 (minimum viable)**: almost impossible to fail; one golden path; minimal config
   - **V1 (standard)**: default for most services; stronger contracts and verification
   - **V2 (advanced)**: optional optimizations for high-scale/high-complexity cases
7. Implement minimal primitives + one “golden path” usage in at least two services.
8. Add tests at the seam (unit tests for primitives + characterization tests for adopters if needed).
9. Document usage, deprecation/migration guidance, and reversal triggers.

## Minimum viable execution

When context or time is constrained, these are the load-bearing steps:

1. **Verify 2+ consumers** (step 3) — don't extract until two services actually need it.
2. **Define API surface** (step 5) — explicit inputs/outputs, error semantics, cancellation support.
3. **Implement + test in 2 services** (steps 7-8) — golden path usage in at least two adopters.
4. **Document reversal triggers** (step 9) — what would make you undo the extraction.

Steps that can be cut under pressure: adoption maturity tracks (step 6), detailed dependency direction analysis (step 4).

## Clarifying Questions

- How many services currently duplicate this boundary logic (need 2+ to justify extraction)?
- What is the adoption timeline (immediate extraction vs planned migration)?
- Who owns the shared package (one team, platform team, shared ownership)?
- What is the release/versioning strategy (monorepo linked, published package, vendored copy)?
- Are there existing shared packages or "utils" files that this should consolidate or replace?
- What maturity level are adopters at (can they handle V0 minimal, or do they need V1 contracts)?

## What Belongs In The Shared Platform Library

Prefer **boundary primitives** over “random helpers”:

- Auth/JWT verification utilities
- gRPC server/client helpers (handler wrappers, interceptors, service registration)
- HTTP client wrappers (timeouts, retries, tracing hooks)
- Typed error/result primitives and decoding helpers
- Lifecycle helpers (start/stop guards, “agent” patterns, shutdown coordination)
- Observability glue (log field mixins, span helpers, RED metric helpers)
- Resilience glue (retry helpers, circuit breaker/bulkhead primitives where applicable)

## What Does *Not* Belong

- Business/domain logic (rules, invariants, etc.)
- One-off utilities used by one call site (“utils junk drawer” risk)
- Hidden I/O at import time (no global clients created on module load)
- High-cardinality or PII-heavy telemetry helpers (keep privacy discipline explicit)

## Guardrails (Opinionated Defaults)

- “Two consumers” rule: don’t add a primitive until it’s used (or imminently needed) in 2+ services.
- Keep the public surface small: a few stable entrypoints beat dozens of micro-exports.
- Prefer composition over inheritance; “wrappers” should preserve response shapes and error semantics.
- Make operation names explicit (don’t depend on framework reflection/casing quirks).
- Keep dependencies minimal; avoid pulling in large frameworks into every service accidentally.
- If you introduce retries, you must introduce idempotency guidance.
- Don’t make V2 requirements mandatory for V0/V1 adopters.

## Common failure modes

- Extracts shared code too early — before 2+ services actually use it. The "two consumers" rule exists because premature extraction creates maintenance burden without proven value.
- Creates a "utils junk drawer" package — dumps unrelated helpers into one shared module instead of extracting focused, cohesive boundary primitives.
- Breaks encapsulation — exposes internal implementation details through the shared API, coupling consumers to things that should be free to change.
- Makes V2 requirements mandatory for V0 adopters — forces all consumers to handle advanced configuration/options even when the simple golden path would suffice.

## Pattern Catalogue (Common Shared Primitives)

- **Boundary handler wrappers (Template Method + interceptors)**: standardize “decode → call → map response” with consistent timing/logging/error mapping.
- **Client proxies**: wrap callback APIs into promises with `AbortSignal` support and timeouts.
- **Lifecycle facades**: stable `start()/stop()` APIs with concurrency guards to avoid start/stop races.
- **Service registration validators**: fail fast if a server registers an incomplete handler set.

## References

- Checklists: [`references/checklists.md`](references/checklists.md)
- Module layout guidance: [`references/module-layout.md`](references/module-layout.md)
- Templates/snippets: [`references/templates.md`](references/templates.md)
- Boundary wrappers (error/idempotency/telemetry contracts): [`references/boundary-wrappers.md`](references/boundary-wrappers.md)
- Related patterns: [`Microservice chassis`](../architecture/references/microservice-chassis.md), [`Service Template`](../architecture/references/service-template.md), [`Service deployment platform`](../architecture/references/service-deployment-platform.md)

Related skills:

- [`spec`](../spec/SKILL.md) (spec bundles + contracts)
- [`observability`](../observability/SKILL.md) (telemetry expectations)
- [`resilience`](../resilience/SKILL.md) (timeouts/retries/idempotency)
- [`security`](../security/SKILL.md) (authn/authz, input validation, secrets)
- [`typescript`](../typescript/SKILL.md) (typed boundaries/errors/lifetimes)
- [`design`](../design/SKILL.md) (structural and behavioral pattern references for wrappers/pipelines)

## Output Template

When applying this skill, return:

- Proposed module(s) and public API surface (what’s exported).
- What duplication this removes (call sites) and what invariants it enforces.
- Error semantics, cancellation/timeouts strategy, and telemetry fields.
- Adoption tracks (V0/V1/V2 entry criteria), first two migrations, and reversal triggers.
- Tests/verification and the review ritual for adoption progress.
