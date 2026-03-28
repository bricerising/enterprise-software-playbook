# Creational Patterns (Implementation Guide)

## Overview

Create objects without hard-coding concrete classes into callers. Use these patterns to isolate construction, support multiple variants, and keep object creation testable.

A note on scope: these guidelines assume **systemic** TypeScript (long-lived apps/services). For short-lived scripts, you can simplify (inline construction, fewer layers) as long as tests and change-cost stay acceptable.

## Workflow

1. Decide "scriptic vs systemic" and set policies (boundary decoding, error semantics, ownership/lifetimes).
2. Identify the creation pressure: variant explosion, complex setup, environment wiring, or lifecycle constraints.
3. Decide what must be stable for callers (interface and invariants), and what may vary (implementation, configuration, dependencies).
4. Pick the smallest creational pattern that matches the pressure (see chooser).
5. Implement with DI-friendly constructors or factory functions; keep creation as pure as possible.
6. Add tests that assert:
   - correct type selection for each variant
   - invariants validated during creation
   - callers depend only on interfaces/abstractions

## Chooser

- **Factory Method**: subclasses/modules decide which product to create for a common interface.
- **Abstract Factory**: select a "family" (e.g., platform/vendor) and create compatible products together.
- **Builder**: stepwise construction with validation; many optional parts or multiple representations.
- **Prototype**: clone existing instances to avoid complex constructors; preserve runtime types.
- **Singleton** (caution): one instance truly required; prefer passing dependencies explicitly or container-managed singletons.

## Clarifying Questions

- What makes object construction complex (variants, environment wiring, lifecycle constraints)?
- How many concrete types exist today, and how often do new ones get added?
- Who owns the decision of which concrete type to create (caller, config, runtime context)?
- Is testability a primary driver (need to inject fakes/stubs)?
- Are there lifecycle constraints (resources that need explicit shutdown/dispose)?

## Implementation Checklist

- Make factories return interfaces/abstract types; hide concrete constructors in one place.
- Keep variant selection logic near configuration boundaries (composition root).
- Avoid "stringly-typed factories"; use typed keys (`as const` maps / unions) where possible.
- Validate invariants at creation time; fail fast with actionable errors.
- Avoid import-time wiring in systemic code; create/wire dependencies in a composition root so lifetimes are explicit.
- If created objects own resources, make lifetimes explicit (`start/stop/dispose`) and define ownership (who shuts it down).
- Keep object graphs shallow in tests by injecting fakes/mocks (avoid global state).

## Guardrails

- Don't use Factory for a single concrete type: if there's only one implementation and no foreseeable variant, use a plain constructor.
- Don't use Singleton for testability: prefer explicit dependency injection. Container-managed singletons are acceptable; module-level globals are not.
- Don't use Builder when a simple options object suffices: Builder adds value when construction has ordering constraints or validation between steps.
- Don't hide variant selection behind string keys: use typed discriminants (`as const` maps, unions) so the compiler catches missing cases.
- Don't let factories accumulate unrelated creation logic: one factory per product family.

## Snippets (optional)

- TypeScript: [`snippets/typescript.md`](snippets/typescript.md) (Creational Patterns section)
- React: [`snippets/react.md`](snippets/react.md) (Creational Patterns section)

## References

Read the relevant reference file before implementing or refactoring toward the pattern:

- [`creational/factory-method.md`](creational/factory-method.md)
- [`creational/abstract-factory.md`](creational/abstract-factory.md)
- [`creational/builder.md`](creational/builder.md)
- [`creational/prototype.md`](creational/prototype.md)
- [`creational/singleton.md`](creational/singleton.md)

Each reference includes: selection cues, minimal structure, pitfalls, and test ideas.

## Output Template

When applying a creational pattern, return:

- The creation pressure (variants/complex setup/lifecycle constraints) and what must stay stable for callers.
- The chosen pattern and the proposed seam (factory/builder/prototype) + wiring point (composition root).
- Verification steps (tests for variant selection, invariant validation, and lifetime ownership).
