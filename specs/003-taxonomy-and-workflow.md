# Spec 003: Taxonomy and Default Workflow

## Overview

Skills are grouped by **how agents execute work** (workflow stage), not by whether a pattern is “code” vs “system”.

This reduces decision friction: an agent can follow a reliable loop without debating taxonomy.

## Workflow-Stage Taxonomy

### Define (what are we building?)

Intent and boundaries:

- Auto-routing across this library in conversational mode (`workflow`)
- Turn intent into an executable task list (`plan`)
- Specs and contracts (`spec`)
- System-pattern selection for cross-service pressures (`architecture`)
- Code-pattern selection for in-process pressures (`design`)

### Standardize (make it consistent)

Make the “golden path” boring and reusable:

- Shared platform primitives (`platform`)
- Language conventions for safety and maintainability (`typescript`)

### Harden (make it survive reality)

Make partial failure and production debugging predictable:

- Timeouts, retries, idempotency, breakers, bulkheads (`resilience`)
- Practical security guardrails (authn/authz, input validation, injection safety, secrets, SSRF) (`security`)
- Logs/metrics/traces correlation + verification steps (`observability`)
- Debug loop (log → trace → metrics) triage workflows (`debug`)

### Verify (prove behavior)

Pin behavior at the boundary:

- Consumer-centric tests and characterization (`testing`)
- Adversarial code review debate for provable findings (`review`)
- Definition-of-done pass (verification + crisp summary) (`finish`)

### Mechanics (in-process building blocks)

Apply classic in-process patterns when implementation needs structure:

- Creation (`patterns-creational`)
- Wrapping/indirection (`patterns-structural`)
- Pipelines/eventing/state machines (`patterns-behavioral`)

## Canonical Stage Values (Metadata + Index)

Use these exact stage values in skill metadata and `specs/skills-manifest.json`:

- `Define`
- `Standardize`
- `Harden`
- `Verify`
- `Mechanics`

## Terminology (Scope Words, Not Navigation)

- **Code patterns**: in-process patterns (classic GoF + adjacent).
- **System patterns**: cross-process patterns (architecture/distributed-systems).
- **Operational patterns**: repeatable workflows/policies that make delivery + operations predictable.

These terms describe *scope*, but the repo groups skills by *workflow stage*.

## Default Sequence (Enterprise Web Apps)

Unless you have a strong reason to deviate:

1. `plan` (for non-trivial work)
2. `spec` (when boundary contracts/semantics change)
3. `architecture` (if cross-service/system pressure exists)
4. `platform` (if multiple services need the same boundary behavior)
5. `typescript` (or the relevant language style guide)
6. `resilience`
7. `security`
8. `observability`
9. `testing`
10. `finish`

In-process pattern application (`apply-*-patterns`) is usually a supporting step during implementation, not the starting point.

## Acceptance

This taxonomy is applied when:

- `README.md` and `PROMPTS.md` list skills under Define/Standardize/Harden/Verify/Mechanics.
- Prompt recipes use the default sequence for enterprise web apps.
- New skills are assigned a workflow stage and documented accordingly.
- `specs/skills-manifest.json` stage mapping and each skill’s frontmatter `metadata.stage` stay aligned.
