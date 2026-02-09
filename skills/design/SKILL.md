---
name: design
description: "Pick the right in-process code pattern for a refactoring or extensibility need (GoF creational/structural/behavioral). Use as a decision workflow when unsure which pattern family fits — routes to patterns-creational, patterns-structural, or patterns-behavioral for implementation. NOT for multi-service/distributed architecture (use architecture); NOT for applying a known specific pattern (use patterns-creational, patterns-structural, or patterns-behavioral directly)."
metadata: {"stage":"Define","tags":["code-patterns","refactoring","extensibility","decoupling","testability","gof","in-process"],"aliases":["design-patterns","GoF","refactor","pattern-chooser","code-structure"]}
---

# Design (Choose Code Pattern)

## Overview

Pick the simplest design that fits, then map it to a code pattern only if it buys you clear leverage (change isolation, testability, reuse, or performance).

In TypeScript systems, also watch for “complications” that patterns can accidentally amplify (hidden lifetimes, implicit `throw`, unchecked boundary data, cyclic deps). Prefer patterns that keep boundaries and ownership explicit.

If the main pressure is *system-level* (multiple services/processes, partial failures, retries/idempotency, sagas, event-driven architecture, domain boundaries), use `architecture` first; then come back here to pick any code patterns needed for the in-process implementation.

If you’re standardizing cross-cutting boundary behavior across multiple services, consider extracting the primitive into a shared package (see `platform`) so the pattern becomes a consistent “golden path” instead of copy/paste.

## Workflow

1. Decide whether the context is **scriptic vs systemic** (short-lived script vs long-lived system). Set policies for boundary validation, error semantics, and ownership/lifetimes.
2. Restate the problem as: **what varies** and **what must stay stable** (API, data model, timing, performance).
3. Identify the main pressure:
   - **Creation** pressure: hard-to-test construction, many variants, environment-specific families.
   - **Structure** pressure: wrapping/combining objects, incompatible interfaces, indirection, memory sharing.
   - **Behavior** pressure: pluggable algorithms, eventing, pipelines, undo, state-dependent behavior.
4. Pick 1 primary pattern (avoid “pattern soup”). Add a 2nd only if it addresses a different pressure.
5. Validate with 2 examples: a “happy path” and a likely future change.
6. Confirm the choice reduces coupling and increases testability (or has a clear perf win).

## Clarifying Questions

- Is this **scriptic** (one-off) or **systemic** (long-lived)? Who owns startup/shutdown?
- What is the stable API/contract we must preserve?
- What changes most often: **implementations**, **algorithms**, **steps**, **object graphs**, **external systems**?
- Are we at an IO boundary (HTTP/DB/fs/events/env)? What is `unknown` and how will it be decoded?
- What are the **expected failures** vs truly **unknown** failures? Should errors be signified (`Result`/tagged unions)?
- Do we need cancellation/backpressure/timeouts (`AbortSignal`) or long-running “agents”?
- Do we need undo/redo, queuing, retries, caching, auth, logging, or other cross-cutting concerns?
- Are there many similar objects (memory pressure) or many collaborators (dependency explosion)?

## Pattern Chooser (Cheat Sheet)

### Creational

- **Factory Method**: callers want an interface; subclasses/modules choose which concrete product to create.
- **Abstract Factory**: pick an “environment” (e.g., OS/vendor) and create a *compatible family* of products.
- **Builder**: object has many optional parts or multiple representations; construction must be stepwise/validated.
- **Prototype**: cloning is cheaper/cleaner than constructing; you must define copy semantics explicitly.
- **Singleton** (use sparingly): exactly one instance is required; prefer DI/container-managed lifetimes instead.

### Structural

- **Adapter**: translate one interface to another to integrate a legacy/third-party API.
- **Bridge**: split abstraction from implementation so each can vary independently (two axes of change).
- **Composite**: treat individual objects and object trees uniformly.
- **Decorator**: add optional behavior by wrapping (stackable features).
- **Facade**: hide a complex subsystem behind a small, stable API.
- **Flyweight**: lots of similar objects; separate intrinsic vs extrinsic state to reduce memory.
- **Proxy**: stand-in that controls access (lazy load, cache, auth, remote boundary, rate limit).

### Behavioral

- **Chain of Responsibility**: request flows through a configurable pipeline of handlers.
- **Command**: represent an action/request as an object (queue, schedule, undo).
- **Iterator**: traverse a structure without exposing representation; support multiple traversal strategies.
- **Mediator**: reduce many-to-many coupling; centralize coordination rules.
- **Memento**: snapshot/restore state (undo/redo) without exposing internals.
- **Observer**: publish/subscribe updates; multiple listeners react to events.
- **State**: behavior changes as state changes; states own transitions/behaviors.
- **Strategy**: swap algorithms behind a stable interface; choose at runtime/config.
- **Template Method**: stable algorithm skeleton with overridable steps (often via hooks; use inheritance only when it already fits).
- **Visitor**: add new operations over a stable object structure without changing the element classes.

## Common Confusions

- **Decorator vs Proxy vs Adapter vs Facade**:
  - Decorator adds behavior; Proxy controls access; Adapter converts interface; Facade simplifies a subsystem.
- **Strategy vs State vs Template Method**:
  - Strategy chooses an algorithm; State changes behavior based on internal state; Template Method fixes skeleton + overrides steps.
- **Factory Method vs Abstract Factory vs Builder**:
  - Factory Method picks a product; Abstract Factory picks a compatible family; Builder controls stepwise construction.

## Guardrails

- Prefer simpler refactors first: extract functions, introduce interfaces, compose objects, use DI.
- Avoid patterns that force inheritance when composition would do (especially Template Method/Singleton).
- Remember Template Method can be implemented without inheritance in TS (template function + step hooks); don’t default to base classes.
- Keep “pattern seams” small: a tiny interface plus focused implementations.
- In systemic code, avoid top-level side effects; wire dependencies in a composition root and keep lifetimes explicit.
- If the change axis is unclear, prototype with a simple interface + two implementations before formalizing.

## References

- If the pressure is cross-service/system-level: [`architecture`](../architecture/SKILL.md)
- If you need a concrete implementation guide: [`patterns-creational`](../patterns-creational/SKILL.md), [`patterns-structural`](../patterns-structural/SKILL.md), [`patterns-behavioral`](../patterns-behavioral/SKILL.md)
- If the seam should be shared across services: [`platform`](../platform/SKILL.md)
- If you’re in TypeScript and hitting systemic constraints (boundaries/lifetimes/errors): [`typescript`](../typescript/SKILL.md)

## Output Template

When recommending a pattern, return:

- 1–2 sentences: pattern + why it fits this problem (what changes, what stays stable).
- Trade-offs and 1 alternative (“no pattern” option included).
- A minimal implementation plan (roles/interfaces, wiring point, tests).
- If implementing: small skeleton + one example call site.
