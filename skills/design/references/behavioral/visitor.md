# Visitor

## Intent

Add new operations to a stable object structure without modifying the element classes by using double dispatch (elements “accept” visitors).

## Use When

- The set of element types is stable, but you frequently add new operations (formatting, exporting, analysis).
- You want to keep operations together rather than spreading them across many classes.
- You need type-specific behavior per element without massive `switch` statements.

## Prefer Something Else When

- You add new element types frequently (Visitor makes that expensive: every visitor must be updated).
- Operations are simple and belong naturally on the elements.

## Minimal Structure

- `Visitor` interface: `visitElementTypeA(a)`, `visitElementTypeB(b)`, ...
- `Element` interface: `accept(visitor)`
- Concrete elements call back into visitor with `visitor.visitX(this)`

## Implementation Steps

1. Confirm element types are relatively stable (Visitor optimizes for adding operations).
2. Define `accept()` on the element interface/base.
3. Implement visitors per operation; keep them stateless or inject dependencies explicitly.
4. Decide how to handle “default” behavior (base visitor, fallback method, or exhaustive handling).

## Pitfalls

- **Element churn**: adding a new element type requires updates to all visitors.
- **Encapsulation leaks**: visitors may need access to element internals; prefer query methods over exposing raw fields.
- **Cross-cutting return types**: define a consistent return type strategy (void, result object, generic visitor).

## Testing Checklist

- Each visitor handles each element type as expected (exhaustive tests for stable structures).
- Adding a new operation (new visitor) does not require element changes beyond `accept()`.

