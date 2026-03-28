# Builder

## Intent

Construct complex objects step-by-step while keeping creation readable, validated, and able to produce different representations.

## Use When

- The target object has many optional fields/parts and multiple valid configurations.
- Construction requires validation, ordering, defaults, or derived fields.
- You need multiple “views” of the same construction process (e.g., different output representations).

## Prefer Something Else When

- The object is small and has a clear constructor (keep it simple).
- Variants are about choosing concrete implementations (Factory Method/Abstract Factory is a better fit).

## Minimal Structure

- `Builder` with step methods + `build()`
- Optional `Director` that sequences steps (often unnecessary in modern code)
- `Product` (the built object), ideally immutable after `build()`

## Implementation Steps

1. Define required vs optional inputs; decide where defaults live.
2. Design a builder API that makes invalid states hard to represent (typed steps, required parameters, or validation at `build()`).
3. Keep `build()` as the single place that enforces invariants.
4. Prefer immutable products; avoid exposing partially-built product instances.

## Pitfalls

- **Leaking partial state**: returning a mutable product before validation.
- **God builder**: builder that knows too much; split into sub-builders if it aggregates unrelated concerns.
- **Chaining for everything**: fluent APIs are nice, but keep readability and error messages in mind.

## Testing Checklist

- `build()` rejects missing required inputs and invalid combinations.
- Defaulting and derived fields behave as expected.
- If you have multiple representations, verify each representation from the same construction steps.

