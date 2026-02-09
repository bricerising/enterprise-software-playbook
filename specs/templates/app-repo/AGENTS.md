# Agent Instructions (Enterprise Web App)

This repository is intended to be developed with **enterprise-software-playbook**.

Users will be conversational and often will **not** name skills explicitly. You must choose and apply the appropriate skills automatically.

## Skill Location

Prefer one of:

1. Vendored into the repo (recommended): `tools/enterprise-software-playbook/` (submodule or copy)
2. Installed in your assistant environment (e.g., Codex CLI skills directory)

If skills are vendored, read the relevant `SKILL.md` files from:

- `tools/enterprise-software-playbook/skills/<skill>/SKILL.md`

## Skill Routing

For fast skill selection, read the machine-readable index first:

- Vendored: `tools/enterprise-software-playbook/specs/skills-manifest.json`
- Installed: `skills-manifest.json` in your skills directory

The manifest contains per-skill `trigger` hints, `related` skill cross-references, `overhead` ratings, and `tags` — use these to pick the right skill(s) without reading every SKILL.md.

## Default Workflow (Auto)

Follow this loop for all non-trivial work:

**Define → Standardize → Harden → Verify → Mechanics**

If your agent supports skills, you can treat `workflow` as the router that selects the rest.

## High-Signal Rules

- Keep overhead proportional: tiny changes should not spawn big spec work.
- If you change a boundary contract or semantics (HTTP/gRPC/events/WS), update specs/contracts first and pin behavior with tests.
- If work is cross-service (reliability/consistency/integration seams), use a system-pattern chooser first.
- If the same boundary behavior repeats across services, extract a small shared “golden path” primitive (avoid copy/paste drift).
- Always harden I/O boundaries with explicit timeouts/cancellation; do not add retries without idempotency/dedupe.
- Always apply security guardrails at boundaries: authn/authz checks, strict input validation, safe logging (no secrets/PII), and SSRF/injection protections where applicable.
- Always make the change observable: logs/trace/metrics correlate via stable IDs/fields; avoid high-cardinality metric labels.

## Specs (Recommended)

- System-level: `specs/` (cross-service constraints, decisions, and tasks)
- Service-level: `apps/<service>/spec/` (spec.md, contracts/, plan.md, tasks.md, quickstart.md)

## Verification

- Run the repo’s test/lint/build commands when provided.
- If commands are not provided, ask once for the preferred verification commands, then proceed.
