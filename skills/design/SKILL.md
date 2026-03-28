---
name: design
description: "Pick the right in-process code pattern for a refactoring or extensibility need (GoF creational/structural/behavioral), and access implementation guides for specific patterns. Use as a decision workflow when unsure which pattern family fits, or go directly to pattern references when you already know. NOT for multi-service/distributed architecture (use architecture)."
metadata: {"stage":"Define","tags":["code-patterns","refactoring","extensibility","decoupling","testability","gof","in-process","creational-patterns","structural-patterns","behavioral-patterns","factory","builder","adapter","facade","strategy","observer","state-machine","decorator","proxy","singleton"],"aliases":["design-patterns","GoF","refactor","pattern-chooser","code-structure","patterns-creational","patterns-structural","patterns-behavioral","factory","builder","singleton","prototype","abstract-factory","object-creation","DI","dependency-injection","adapter","decorator","facade","proxy","wrapper","composite","bridge","flyweight","strategy","observer","state-machine","command","middleware","pub-sub","event-system","pipeline","undo-redo"]}
---

# Design (Choose Code Pattern)

## Overview

Pick the simplest design that fits, then map it to a code pattern only if it buys you clear leverage (change isolation, testability, reuse, or performance).

In TypeScript systems, also watch for “complications” that patterns can accidentally amplify (hidden lifetimes, implicit `throw`, unchecked boundary data, cyclic deps). Prefer patterns that keep boundaries and ownership explicit.

If the main pressure is *system-level* (multiple services/processes, partial failures, retries/idempotency, sagas, event-driven architecture, domain boundaries), use `architecture` first; then come back here to pick any code patterns needed for the in-process implementation.

If you’re standardizing cross-cutting boundary behavior across multiple services, consider extracting the primitive into a shared package (see `platform`) so the pattern becomes a consistent “golden path” instead of copy/paste.

**Monolith edge case**: In a monolith, use `design` to isolate modules *within* the process (Facade for subsystem boundaries, Adapter for third-party libs, Strategy for swappable implementations). If the goal is *decomposing* the monolith into separate deployable units or defining service boundaries, start with `architecture` — then return here for the in-process patterns each new service needs.

## Inputs / Outputs

**Inputs**: Archobs JSON — file coupling (xnbr, hubness), cluster leakage (required); architecture output (if exists); forecast lifecycle data (if wrapping external dep).
**Outputs**: Pattern selection with rationale, implementation sketch, trade-offs. Consumed by `testing` (test strategy), `finish` (verification).

## Workflow

0. **Load archobs data** (required): Run `archobs show risks --format json` and `archobs show clusters --format json` to get risk scores and coupling signals for the files under consideration. Use `xnbr` to identify files bridging multiple concerns, `hubness` to find fan-in bottlenecks, and cluster `leakage` to see where boundaries are porous. This data helps narrow the pattern choice — e.g., high xnbr suggests Facade or Strategy; high hubness suggests Mediator. If the artifacts do not exist, run `archobs report --repo <path> --out .archobs --suggestions-provider rules` and **wait for it to complete** before continuing.

1. Decide whether the context is **scriptic vs systemic** (short-lived script vs long-lived system). Set policies for boundary validation, error semantics, and ownership/lifetimes.
2. Restate the problem as: **what varies** and **what must stay stable** (API, data model, timing, performance).
2b. **Pattern Longevity Check** (conditional — run when the selected pattern wraps or isolates an external dependency):

   ```bash
   intel forecast    # lifecycle phase for the wrapped dependency
   ```

   **Decision mapping**: See [Lifecycle Decision Mapping — Design: Pattern Longevity](../references/lifecycle-decision-mapping.md#design-pattern-longevity) for lifecycle phase → pattern adjustment tables and compound signal (archobs x forecast) implications.

3. Identify the main pressure:
   - **Creation** pressure: hard-to-test construction, many variants, environment-specific families.
   - **Structure** pressure: wrapping/combining objects, incompatible interfaces, indirection, memory sharing.
   - **Behavior** pressure: pluggable algorithms, eventing, pipelines, undo, state-dependent behavior.
4. Pick 1 primary pattern (avoid "pattern soup"). Add a 2nd only if it addresses a different pressure.
5. Stress-test the decision (if 2+ viable approaches exist; skip for single viable approach):
   - **Assumptions**: What are facts vs assumptions? Which assumption is least certain — how will we validate it? Cross-reference with pattern longevity check from step 2b (if applicable). *(include in output trade-offs)*
   - **Second-Order Effects**: What happens next week / next quarter / next year? What new coupling or failure mode does this create? If this pattern choice fails in 6-12 months, what likely caused failure? Cross-reference with pattern longevity check from step 2b (if applicable). *(include in output trade-offs)*
   - **Opportunity Cost**: What are we saying "no" to with this pattern choice? Are we favoring this due to sunk cost, familiarity, or novelty? *(include in output trade-offs)*
   - If probe output already exists from an earlier Define-stage skill in this flow (including `workflow` orchestration), refine it instead of re-running.
6. Validate with 2 examples: a "happy path" and a likely future change.
7. Confirm the choice reduces coupling and increases testability (or has a clear perf win).

## Minimum viable execution

When context or time is constrained, these are the load-bearing steps:

1. **Load archobs data** (step 0) — xnbr and hubness guide pattern choice.
2. **Identify the main pressure** (step 3) — creation, structure, or behavior.
3. **Pick 1 primary pattern** (step 4) — avoid pattern soup.
4. **Validate with 2 examples** (step 6) — happy path and a likely future change.

Steps that can be cut under pressure: pattern longevity check (step 2b), stress-test probes (step 5), scriptic/systemic policy decision (step 1).

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

## Common failure modes

- Applies patterns prematurely — one use case is not enough to justify a pattern. Wait for the second concrete case before formalizing.
- Picks complex patterns when simple composition works — a Factory with one product, a Strategy with one algorithm. Start with the simplest refactor (extract function, introduce interface).
- Confuses code patterns with system patterns — Saga, CQRS, Event Sourcing are system-level (`architecture`), not in-process (`design`).
- Ignores archobs coupling data — picks patterns based on intuition instead of measured xnbr (bridging files → Facade) or hubness (fan-in → Mediator).

## References

- Empirical coupling data to inform pattern choice: [`archobs`](../archobs/SKILL.md)
- If the pressure is cross-service/system-level: [`architecture`](../architecture/SKILL.md)
- If the seam should be shared across services: [`platform`](../platform/SKILL.md)
- If you're in TypeScript and hitting systemic constraints (boundaries/lifetimes/errors): [`typescript`](../typescript/SKILL.md)
- Structured-thinking probes + templates: [`../references/`](../references/) (checklists for inline probes, templates for escalation)

### Pattern Implementation Guides

When you need implementation details for a specific pattern:

- Creational patterns (Factory Method, Abstract Factory, Builder, Prototype, Singleton): [`references/patterns-creational.md`](references/patterns-creational.md)
- Structural patterns (Adapter, Bridge, Composite, Decorator, Facade, Flyweight, Proxy): [`references/patterns-structural.md`](references/patterns-structural.md)
- Behavioral patterns (Chain of Responsibility, Command, Iterator, Mediator, Memento, Observer, State, Strategy, Template Method, Visitor): [`references/patterns-behavioral.md`](references/patterns-behavioral.md)

### Individual Pattern References

- Creational: [`references/creational/`](references/creational/) (factory-method, abstract-factory, builder, prototype, singleton)
- Structural: [`references/structural/`](references/structural/) (adapter, bridge, composite, decorator, facade, flyweight, proxy)
- Behavioral: [`references/behavioral/`](references/behavioral/) (chain-of-responsibility, command, iterator, mediator, memento, observer, state, strategy, template-method, visitor)

### Snippets

- TypeScript: [`references/snippets/typescript.md`](references/snippets/typescript.md)
- React: [`references/snippets/react.md`](references/snippets/react.md)

## Output Template

When recommending a pattern, return:

- 1–2 sentences: pattern + why it fits this problem (what changes, what stays stable).
- Trade-offs and 1 alternative ("no pattern" option included), with assumptions (facts vs assumptions) and opportunity costs if probes were run.
- A minimal implementation plan (roles/interfaces, wiring point, tests).
- If implementing: small skeleton + one example call site.
