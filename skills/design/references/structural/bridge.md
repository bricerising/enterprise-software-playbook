# Bridge

## Intent

Split an abstraction from its implementation so both can vary independently (two axes of change without subclass explosion).

## Use When

- You have a concept with multiple independent dimensions (e.g., “Document” x “Storage”, “Renderer” x “Shape”).
- You want to swap implementations at runtime or wire them differently per environment.
- Inheritance is producing a combinatorial explosion of subclasses.

## Prefer Something Else When

- You only need to swap algorithms (Strategy is often simpler).
- You only need to wrap an API (Adapter/Facade).

## Minimal Structure

- `Abstraction`: the high-level API clients use
- `Implementor`: interface for the implementation side
- `RefinedAbstraction`: variants of the high-level API (optional)
- `ConcreteImplementorX`: implementations
- `Abstraction` holds a reference to `Implementor` and delegates work

## Implementation Steps

1. Identify the two axes that change independently.
2. Extract the implementation axis into an `Implementor` interface.
3. Make `Abstraction` compose an `Implementor` (inject via constructor).
4. Ensure adding a new abstraction variant doesn’t require touching implementors and vice versa.

## Pitfalls

- **Over-abstracting**: if the second axis is hypothetical, keep it simple.
- **Leaky delegation**: don’t let clients reach into the implementor; keep the bridge internal.
- **Confusing with Strategy**: Strategy is usually “swap an algorithm”; Bridge is “separate hierarchies/axes”.

## Testing Checklist

- Unit-test each implementor independently.
- Unit-test abstraction behavior with a fake implementor (assert delegation).
- Integration tests for a few representative abstraction+implementor pairings.

