# Template Method

## Intent

Define the skeleton of an algorithm once and let callers override specific steps (“hooks”) without changing the overall structure.

## Use When

- You already have an inheritance hierarchy and want to standardize the flow while allowing step customization.
- You need consistent ordering and invariants enforced by the skeleton.
- “Hooks” are enough for extension and you don’t need runtime swapping.
- You want to standardize noisy boundary handlers (HTTP/gRPC/jobs) so each handler reads like “decode → call service → map response” while timing/logging/metrics/error mapping stay consistent.

## Prefer Something Else When

- You want runtime swappability or composition (Strategy/Decorator).
- Inheritance would create tight coupling or deep hierarchies.

## Minimal Structure

- **TypeScript-friendly (preferred)**: a `run(template, input)` function that calls `template.read/parse/validate/write` step functions (some optional with defaults).
- **Classic code pattern (GoF Template Method)**: a base class `templateMethod()` calls overridable `step1()`, `step2()`, ... and subclasses override selected steps.

## Implementation Steps

1. Extract the stable algorithm skeleton into one place (a function or a base class).
2. Define step contracts (inputs/outputs/errors). For expected failures, prefer typed `Result`/tagged unions over `throw`.
3. Keep invariants enforced in the skeleton (validate before/after steps).
4. Avoid exposing too many steps; keep the extension surface small and testable.

## Pitfalls

- **Inheritance coupling**: changes to base can ripple through subclasses.
- **Fragile base class**: too many hooks makes behavior unpredictable.
- **Hard to combine features**: inheritance doesn’t compose like decorators/strategies.
- **Contract drift**: wrappers must preserve externally visible response shapes and error semantics; don’t “helpfully” add/remove fields at the boundary.
- **Metric/name drift**: if you record metrics/logs by operation name, make the name explicit in the skeleton (don’t depend on reflection or framework casing quirks).

## Testing Checklist

- Base flow test: steps are invoked in correct order.
- Override/hook tests: overriding a step changes behavior without breaking invariants.
- Default-hook tests for implementations that don’t supply optional steps.
