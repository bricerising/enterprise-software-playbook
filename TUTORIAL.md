# Tutorial (Example Walkthrough)

This is a concrete example of using the playbook end-to-end on a typical enterprise web app change.

## 1) Start the session (auto-route)

Copy/paste:

```text
Use workflow (read skills/workflow/SKILL.md).

Task: Add a “pause subscription” endpoint that pauses billing immediately, emits an event, and is reversible by support.
Constraints: Multi-tenant. Must be auditable. No PII in logs.
```

## 2) What a “good” run looks like

The agent should (roughly) follow:

1. **Define**
   - For non-trivial work, produce an executable plan with verification (`plan`).
   - Write/update a spec bundle with acceptance scenarios and failure-mode expectations (`spec`).
   - If this crosses services (billing + subscriptions + notifications), pick a minimal system pattern (`architecture`).
2. **Standardize**
   - If multiple services need the same auth/error/timeout/telemetry policy, propose a shared primitive (`platform`).
   - If TypeScript, apply the systemic safety rules while implementing (`typescript`).
3. **Harden**
   - Make outbound calls time-bounded and retry/idempotency-safe (`resilience`).
   - Apply authn/authz, input validation, injection safety, and SSRF/logging guardrails (`security`).
   - Add correlated logs/traces/metrics with a stable field contract and local verification steps (`observability`).
4. **Verify**
   - Add consumer-visible tests that pin the contract and failure semantics (`testing`).
   - Run a definition-of-done pass and report verification (`finish`).
   - If a code pattern is needed for a clearer seam (e.g., a Proxy wrapper), see the `design` skill's pattern references.

## 3) Sample output (abbreviated)

A good run produces a report like this (shortened for illustration):

```text
## Skills applied

- plan: scoped the work to one service (subscriptions); produced 6-task plan with acceptance checks.
- spec: wrote apps/subscriptions/spec/spec.md with 4 acceptance scenarios (pause, already-paused, unpause by support, audit trail). Updated contracts/ with POST /subscriptions/:id/pause and SubscriptionPaused event schema.
- resilience: added 3s timeout + 1 retry (idempotent via pauseRequestId) on billing-service call.
- security: added tenant-scoped authz check; validated :id as UUID; stripped PII from log fields.
- observability: added span subscription.pause with op, tenantId, outcome; RED metrics on the route.
- testing: 5 tests — happy path, already-paused idempotency, billing-timeout fallback, authz rejection, event schema compliance.
- finish: all checks pass (see below).

## What changed

- New endpoint: POST /subscriptions/:id/pause (pauses billing, emits SubscriptionPaused event, reversible).
- Contract: added to apps/subscriptions/spec/contracts/subscriptions.openapi.yaml.
- Failure semantics: billing timeout → 503 with Retry-After; already-paused → 200 (idempotent); wrong tenant → 403.

## Verification

  npm test             # 5/5 pass
  npm run typecheck    # clean
  npm run lint         # clean

## Follow-ups

- [ ] Add consumer-contract test for SubscriptionPaused event listeners (notifications service).
```

## 4) What to look for

At minimum the response should include:

- Skills applied (and why).
- What changed (behavior + contract impacts).
- Verification commands run (or why not) + results.
- Follow-ups (only if necessary).

## If you’re not using TypeScript

Most of the playbook is language-agnostic (contracts, boundaries, time budgets, idempotency, telemetry, tests). Translate the “TypeScript” parts into your stack’s equivalents (e.g., typed validation/decoders, explicit dependency wiring, explicit lifetimes).
