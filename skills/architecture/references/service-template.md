# Service Template

## Intent
Bootstrap new services quickly and consistently using a standard template (repo skeleton + conventions).

## Use when
- You are creating services repeatedly and want consistent defaults (build/deploy, telemetry, lint, tests).
- You want to reduce “setup thrash” and make new services production-ready faster.

## Suggested skeleton (example)

```text
apps/<service>/
  src/
    app/                # composition root, startup/shutdown wiring
    domain/             # pure business logic + entities/value objects
    boundaries/         # handlers/adapters (http/grpc/events/jobs)
    infrastructure/     # db/cache/queue/http client adapters
    telemetry/          # logs/metrics/tracing helpers
  test/                 # consumer-visible tests
  spec/
    spec.md
    plan.md
    tasks.md
    quickstart.md
    data-model.md
    contracts/
  package.json
```

## Baseline defaults to include

- **Quality gates**: lint, typecheck, tests, build in CI.
- **Boundary contracts**: request decode/validate, typed error mapping, explicit timeouts/cancellation.
- **Resilience defaults**: retry policy only for idempotent operations, stable idempotency key strategy.
- **Security defaults**: authn/authz hooks, safe logging/redaction, outbound URL controls.
- **Observability defaults**: correlated logs (`traceId`), boundary RED metrics, root/child spans.

## Adoption workflow

1. Start from `specs/templates/service-spec-bundle/`.
2. Wire shared primitives from `platform` (avoid per-service copy/paste wrappers).
3. Add boundary tests from `testing` before broad rollout.
4. Track template changes via ADR when they alter service API expectations.

## Avoid / watch-outs

- Keep the template lean; large templates become hard to upgrade.
- Avoid framework lock-in at the template layer unless it is an explicit organizational standard.
- Prefer additive template evolution; avoid forced breaking migrations across all services.

## Skill mapping
- `platform`: define the template + keep it aligned with the chassis/shared primitives.
- `spec`: include a minimal spec bundle and quickstart expectations.
- `observability` / `resilience` / `security`: bake in defaults so services start safe by default.
