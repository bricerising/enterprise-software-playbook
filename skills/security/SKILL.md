---
name: security
description: "Apply security guardrails (authentication, authorization, input validation, SQL/XSS/command injection prevention, secrets management, SSRF protection, secure logging, dependency auditing). Use when adding/changing endpoints, auth flows, data access, file/network I/O, or handling user input and sensitive data. NOT for resilience/fault-tolerance patterns (use resilience); NOT for observability instrumentation (use observability)."
metadata: {"stage":"Harden","tags":["authn","authz","input-validation","injection-prevention","ssrf","csrf","cors","secrets-management","dependency-audit"],"aliases":["auth","authentication","authorization","injection","xss","sql-injection","secrets","hardening"]}
---

# Security

## Overview

Security is boundary discipline: authenticate, authorize, validate inputs, avoid data leakage, and make unsafe classes of bugs hard to write.

This is not a full security audit. If the change is high-risk (auth overhaul, multi-tenant isolation, crypto, payments, regulated data), escalate to a security review.

## Inputs / Outputs

**Inputs**: Attack surface inventory (inbound/outbound/state/operational boundaries); data sensitivity classification (credentials, PII, multi-tenant identifiers).
**Outputs**: Hardened code with baseline controls applied (authn, authz, validation, injection safety, secrets safety); verification tests. Consumed by `testing` and `finish`.

## Workflow

1. Identify what changed (the *attack surface*):
   - inbound boundaries: HTTP/gRPC/GraphQL/WS handlers, webhooks
   - outbound boundaries: HTTP/gRPC/SDK clients, redirects, proxying, fetch-by-URL
   - state boundaries: DB queries, object storage, caches, queues
   - operational boundaries: logs/telemetry, admin endpoints, config/secrets
2. Classify data sensitivity:
   - credentials/secrets, session tokens, API keys
   - PII and regulated data
   - multi-tenant identifiers and access scopes
3. Apply baseline controls:
   1. **Authn**: verify identity and token validity (issuer/audience/expiry).
   2. **Authz**: check permissions *per action* (and per tenant/resource).
   3. **Input validation**: treat external inputs as `unknown`; decode/validate at the edge.
   4. **Injection safety**: parameterize queries; avoid string-built interpreters (SQL, shell, template injection).
   5. **Secrets safety**: keep secrets out of logs, error messages, and client responses.
> **GATE**: All 5 baseline controls (authn, authz, input validation, injection safety, secrets safety) must be addressed before proceeding. For each control, either apply it or document why it does not apply to this change.

4. Harden outbound calls:
   - SSRF controls (allowlist hosts; block link-local/metadata IPs; disable redirect-follow where unsafe)
   - TLS verification and timeouts/cancellation (see `resilience`)
5. Verify:
   - add/extend consumer-visible tests for authz and validation (`testing`)
   - run any available dependency scanning / linters in the target repo
   - sanity-check logs/metrics do not include sensitive fields (`observability`)

## Minimum viable execution

When context or time is constrained, these are the load-bearing steps:

1. **Identify attack surface** (step 1) — what boundaries changed.
2. **Classify data sensitivity** (step 2) — credentials, PII, multi-tenant identifiers.
3. **Apply 5 baseline controls in order** (step 3) — authn → authz → validation → injection safety → secrets safety.
4. **Verify** (step 5) — consumer-visible tests for authz and validation.

Steps that can be cut under pressure: outbound SSRF hardening (step 4) if no outbound calls changed, dependency scanning.

## Chooser (What To Apply Where)

- **New/changed HTTP endpoint**: authn + authz + input validation + safe error responses + rate limiting (if public).
- **Auth flow change**: token validation, session settings, CSRF, re-auth for sensitive actions, scope/tenant checks.
- **Database / data access change**: parameterized queries, least-privilege DB user, tenant scoping, existence-leak prevention.
- **File upload / user-provided URLs**: size/type limits, SSRF controls (allowlist hosts, block metadata IPs), path traversal prevention.
- **Outbound fetch / proxy**: SSRF controls, TLS verification, redirect policy, timeout/cancellation.
- **Secrets / config change**: no secrets in source, rotation plan, no secrets in logs/errors, short-lived credentials.
- **Dependency update / addition**: lockfile integrity, unused dep removal, license/policy check.

## Clarifying Questions

- What boundaries changed (inbound handlers, outbound calls, data access, config/secrets)?
- What data sensitivity is involved (credentials, PII, regulated data, multi-tenant identifiers)?
- Is this a multi-tenant system? How is tenant isolation enforced?
- Is this a public-facing endpoint or internal-only?
- Are there existing auth/authz patterns in the codebase to follow?

## Checklist (High-Signal)

- Authn: token validation, session/cookie settings, CSRF (if cookie-based), re-auth for sensitive actions.
- Authz: resource/tenant checks at every entrypoint; no “UI-only” authorization.
- Inputs: strict decoding; file uploads have size/type limits; URLs are parsed and validated.
- DB: parameterized queries; least-privilege DB user; no leaking of existence via error detail (where relevant).
- Secrets: never log credentials; rotate/expire tokens; store secrets in secret manager/env (not source).
- Telemetry: logs redact/omit PII; metrics have bounded labels; traces avoid raw payloads.
- Dependencies: pin and update; remove unused; verify integrity/lockfiles.

## Guardrails

- Don’t build your own crypto; use well-reviewed libraries and platform primitives.
- Don’t weaken authz “temporarily”; if you must, add explicit expiry and a follow-up task.
- Don’t log raw request bodies/headers by default; explicitly whitelist safe fields.
- Don’t accept user-provided URLs for server-side fetch without SSRF controls.

## Common failure modes

- Pattern-matches OWASP checklists without reading the actual code — produces generic findings that don't apply to the specific change.
- Adds input validation at internal boundaries between trusted components — validation belongs at system boundaries (user input, external APIs), not between your own modules.
- Focuses heavily on authentication while missing authorization — verifying identity is not the same as checking permissions per action and per resource.
- Misses SSRF in outbound calls — any endpoint that fetches a user-provided URL needs allowlist/blocklist controls.

## References

- Deeper checklist: [`references/checklists.md`](references/checklists.md)
- TypeScript boundary snippets: [`references/snippets/typescript.md`](references/snippets/typescript.md)
- Related patterns: [`Access token`](../architecture/references/access-token.md)
- Boundary resiliency: [`resilience`](../resilience/SKILL.md)
- Telemetry privacy: [`observability`](../observability/SKILL.md)
- Consumer-visible verification: [`testing`](../testing/SKILL.md)
- Shared auth/config primitives (when 2+ services need the same guardrails): [`platform`](../platform/SKILL.md)

## Output Template

When applying this skill, return:

- What changed (attack surface) and what data is sensitive.
- The controls applied (authn/authz/validation/injection/SSRF/logging).
- Verification steps (tests + local checks) and any follow-ups needing a dedicated security review.
