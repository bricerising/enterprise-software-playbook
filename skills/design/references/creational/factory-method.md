# Factory Method

## Intent

Delegate object creation to subclasses/modules so callers depend on a stable product interface rather than concrete types.

## Use When

- A base workflow needs a `Product` interface, but the concrete product varies by environment, feature flag, or subtype.
- You want to keep callers stable while adding new product implementations over time.
- Construction logic must stay testable (swap a fake product in tests).

## Prefer Something Else When

- There’s only one concrete type and no realistic plan for variants (a plain constructor or function is simpler).
- Selection is pure configuration and can live in a composition root (DI/container may be enough).

## Minimal Structure

- `Product` (interface/abstract type)
- `Creator` (base type with `factoryMethod(): Product`)
- `ConcreteCreatorX` overrides `factoryMethod` to return `ConcreteProductX`
- `Creator.operation()` calls `factoryMethod` and works only with `Product`

## Implementation Steps

1. Extract a `Product` interface from what callers actually need.
2. Move “new + wiring” into a single `factoryMethod()` seam.
3. Ensure `Creator` code never mentions concrete products.
4. Keep selection logic near configuration boundaries (module wiring, DI).

## Pitfalls

- **Factory method becomes a switch**: if you keep adding `if/else` inside the factory, consider a registry or Abstract Factory.
- **Leaky abstractions**: callers should not type-check concrete products to get work done.

## Testing Checklist

- For each concrete creator, assert it returns the expected concrete product (or behavior).
- Unit-test `Creator.operation()` with a test creator that returns a fake product.
- Add a “new variant” test that demonstrates adding a product does not require changing callers.

