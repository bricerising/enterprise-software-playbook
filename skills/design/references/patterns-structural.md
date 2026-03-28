# Structural Patterns (Implementation Guide)

## Overview

Shape object relationships to reduce coupling without rewriting everything. Use structural patterns to compose behavior, hide complexity, and add indirection at boundaries.

A note on scope: these guidelines assume **systemic** TypeScript (long-lived apps/services). In scripts, you may not need full wrapper stacks; prefer the simplest boundary that keeps callers clean.

## Workflow

1. Decide "scriptic vs systemic" and set policies (boundary decoding, error semantics, ownership/lifetimes).
2. Identify the boundary: what do callers want to depend on, and what do you want to hide?
3. Decide if you're changing:
   - **interface** (Adapter)
   - **abstraction vs implementation axes** (Bridge)
   - **object graph shape** (Composite)
   - **optional behavior stacking** (Decorator)
   - **subsystem surface area** (Facade)
   - **memory footprint** (Flyweight)
   - **access policy/indirection** (Proxy)
4. Keep the public surface small: one interface + a few implementations/wrappers.
5. Add tests around the boundary (callers see stable behavior even as internals change).

## Chooser

- **Adapter**: make incompatible APIs work together (often at third-party/legacy boundaries).
- **Bridge**: two axes vary independently (e.g., "shape" x "renderer", "transport" x "codec").
- **Composite**: treat leaf and container uniformly; tree recursion + operations over nodes.
- **Decorator**: add optional responsibilities without subclass explosion; wrappers are stackable.
- **Facade**: shrink a subsystem to a simple, stable API; hide orchestration.
- **Flyweight**: many similar objects; split intrinsic state (shared) vs extrinsic (supplied).
- **Proxy**: control access (lazy init, cache, auth, throttling, remote boundary, logging).

## Clarifying Questions

- Are you wrapping an external dependency, or restructuring internal code?
- Is the goal interface translation (Adapter), behavior stacking (Decorator), simplification (Facade), or access control (Proxy)?
- Does the wrapped subject have a lifetime (close/dispose) that needs forwarding?
- How many layers of wrapping are expected -- one, or a composable stack?
- Is the real implementation available now, or will it be swapped later (Bridge)?

## Implementation Checklist

- Prefer composition; wrappers should delegate almost everything and add one focused concern.
- Make wrappers transparent where appropriate (don't leak internals via type checks).
- Put facades and adapters at module boundaries; keep core domain clean.
- Translate boundary concerns explicitly: `unknown` inputs -> decoded domain types; SDK errors -> your error model.
- For proxies: define caching/invalidation, concurrency semantics, and cancellation/timeouts (`AbortSignal`) where applicable.
- If the real subject has a lifetime (`close`/`dispose`), expose and forward it; keep ownership/shutdown explicit.
- For flyweights: prove the memory win and define ownership/lifetime of shared state.

## Guardrails

- Don't wrap what you can change directly: if you own both sides, change the interface instead of adding an Adapter.
- Don't stack Decorators beyond 2-3 layers without a clear composition model: deep stacks become hard to debug and order-dependent.
- Don't use Facade to hide necessary complexity: if callers need fine-grained control, a Facade that papers over it creates workarounds.
- Don't forget lifetime forwarding: if the real subject has `close`/`dispose`, the Proxy/Decorator must forward it.
- Don't use Composite when leaf and branch behaviors diverge significantly: Composite works best when operations are genuinely uniform across the tree.

## Snippets (optional)

- TypeScript: [`snippets/typescript.md`](snippets/typescript.md) (Structural Patterns section)
- React: [`snippets/react.md`](snippets/react.md) (Structural Patterns section)

## References

Read the relevant reference file before implementing or refactoring toward the pattern:

- [`structural/adapter.md`](structural/adapter.md)
- [`structural/bridge.md`](structural/bridge.md)
- [`structural/composite.md`](structural/composite.md)
- [`structural/decorator.md`](structural/decorator.md)
- [`structural/facade.md`](structural/facade.md)
- [`structural/flyweight.md`](structural/flyweight.md)
- [`structural/proxy.md`](structural/proxy.md)

Each reference includes: selection cues, minimal structure, pitfalls, and test ideas.

## Output Template

When applying a structural pattern, return:

- The boundary you're shaping (callers vs hidden subsystem) and what stays stable.
- The chosen pattern (Adapter/Facade/Proxy/etc.) and the minimal surface area (interface + implementations/wrappers).
- Verification steps (tests at the boundary seam; lifetime/timeout/cancellation behavior where applicable).
