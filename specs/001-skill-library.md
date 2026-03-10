# Spec 001: Skill Library Charter

## Overview

This repo is an opinionated library of **agent skills** designed to make AI-assisted engineering converge on cohesive, high-quality **enterprise web applications**.

Skills are not essays: they are playbooks that turn intent into repeatable actions (specs → plans → code → verification).

## Goals

- Provide a reliable “default workflow” that produces cohesive solutions (not isolated code snippets).
- Standardize how agents handle **boundaries**: validation, error semantics, time budgets, idempotency, and telemetry.
- Make cross-cutting behavior shareable via a shared platform library (avoid copy/paste drift).
- Bias toward consumer-visible correctness (contracts + tests) over internal aesthetics.
- Keep skills concise and composable (progressive disclosure via `references/`).

## Non-goals

- Being a comprehensive encyclopedia of patterns or all possible stacks.
- Replacing team/domain knowledge (product decisions, compliance, org-specific policies).
- Mandating a specific cloud provider, framework, or runtime.
- Shipping large amounts of boilerplate code in this repo.

## Definitions

- **Skill**: a folder containing a `SKILL.md` playbook (and optional resources) that can be invoked explicitly in prompts.
- **Code pattern**: an in-process design pattern (classic creational/structural/behavioral; mostly GoF).
- **System pattern**: a cross-process pattern (architecture/distributed-systems/ops) dealing with failure, consistency, and integration seams.
- **Operational pattern**: a repeatable workflow/policy that makes delivery + operations predictable (spec bundles, shared primitives, tests, observability, resilience).

## Requirements

### Functional

- **R-001**: The repo MUST provide skills that cover the full delivery loop:
  - Define (specs + pattern selection)
  - Standardize (shared platform + style)
  - Harden (resilience + security + observability)
  - Verify (consumer tests)
  - Mechanics (in-process pattern application)
- **R-002**: Each skill MUST include an explicit workflow and a “done when” style output template.
- **R-003**: Skills MUST cross-link rather than duplicate (e.g., resilience references observability; system patterns map to code patterns).
- **R-004**: The repo MUST include prompt recipes (`PROMPTS.md`) that demonstrate a reliable default sequence for enterprise web apps.
- **R-005**: The repo MUST include an adoption path that enables auto-skill usage in conversational mode (router skill + app-repo instructions template).
- **R-006**: For non-trivial work, skills SHOULD externalize a system model (objective function + boundary/time horizon + actors/flows), explicit option trade-offs, and measurement ritual.
- **R-007**: For non-trivial decisions, core workflow skills SHOULD run compact structured-thinking probes (first-principles assumptions, second-order effects, feedback loops, opportunity cost, and bias checks).

### Non-functional

- **NFR-001 (Concise)**: Skills SHOULD stay short; move depth into `references/` files.
- **NFR-002 (Trigger precision)**: Skill frontmatter `description` MUST be narrow enough to avoid accidental triggering.
- **NFR-003 (Offline)**: The repo SHOULD be usable without network access; avoid instructions that require browsing.
- **NFR-004 (Compatibility)**: Skill names are API; avoid breaking renames without a migration story (see Spec 002).

## Invariants (“Constitution”)

These are non-negotiable defaults for enterprise web apps that this repo should drive:

- External inputs are treated as `unknown` and decoded/validated at boundaries.
- Expected failures are modeled explicitly (typed results / stable error envelopes); `throw` is reserved for truly unexpected failures and is caught/converted at boundaries.
- No hidden I/O at import time in systemic code; lifetimes are explicit (start/stop/dispose).
- Time budgets and cancellation propagate across calls; retries are bounded and only used when safe.
- Idempotency/deduplication exists wherever retries or at-least-once delivery exists.
- Telemetry is consistent: logs, traces, and metrics correlate via stable IDs/fields; avoid high-cardinality metric labels.
- No metric exists without a named decision, owner, and review cadence.
- Non-trivial decisions include explicit assumptions, second-order effects, feedback-loop notes, and opportunity cost/bias checks.
- Significant changes document reversibility (kill criteria / reversal trigger).
- Shared libraries contain cross-cutting concerns only (no domain/business logic); follow the “two consumers” rule.
- Verification is mandatory: consumer-visible tests for behavior; local smoke steps for operability (log → trace → metrics, failure-mode simulation).

## Observability (Repo Expectations)

This repo should cause agents to produce *observable* changes in target apps:

- A boundary change SHOULD come with telemetry expectations and local verification steps.
- Skills that modify boundaries MUST include “how to verify” steps (tests + local checks).

## Resilience (Repo Expectations)

This repo should cause agents to design for partial failure:

- All outbound calls have explicit timeouts.
- Retries are classified and bounded; idempotency is defined if retries exist.
- System pattern recommendations include failure-mode assumptions and trade-offs.

## Security / Privacy

- Skills MUST discourage logging secrets/PII and MUST call out safe logging/labeling practices.
- Skills MUST not embed real credentials, tokens, or private URLs.

## Acceptance

This repo satisfies this spec when:

- `specs/` exists and is maintained as the source of truth for repo organization.
- `README.md` and `PROMPTS.md` reflect the taxonomy and default workflow defined in Spec 003.
- All skill folders validate via `python3 .system/skill-creator/scripts/quick_validate.py skills/<skill>`.
- Each new/changed skill includes an output template and references the other relevant skills rather than duplicating content.
