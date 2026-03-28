# Abstract Factory

## Intent

Create *families* of related objects through a common factory interface so the client can switch “environment/vendor/platform” without changing product usage code.

## Use When

- You must create multiple related products that must be compatible (e.g., UI widgets, cloud providers, payment providers).
- The choice of “family” happens at startup/configuration and should be swappable.
- You want to prevent mixing products from different families accidentally.

## Prefer Something Else When

- You only need one product type (Factory Method or DI is simpler).
- You add new product types frequently; Abstract Factory makes adding a new product type expensive (must update all factories).

## Minimal Structure

- `AbstractFactory` with `createA()`, `createB()`, ...
- `ConcreteFactoryFamily1`, `ConcreteFactoryFamily2`, ...
- Product interfaces: `ProductA`, `ProductB`, ...
- Concrete products per family: `Family1ProductA`, `Family2ProductA`, ...
- Client depends only on factory + product interfaces.

## Implementation Steps

1. Identify the product family boundary (what must vary together).
2. Define product interfaces and ensure they’re cohesive and small.
3. Define the factory interface returning those product interfaces.
4. Implement one concrete factory per family and keep family selection at the composition root.

## Pitfalls

- **Factory interface bloat**: too many product methods makes families hard to maintain.
- **Hidden coupling**: don’t let clients downcast products to concrete types.
- **Family mixing via globals**: avoid global singletons for factories; inject them.

## Testing Checklist

- Contract tests: a suite that runs against each concrete factory to ensure consistent behavior.
- Verify family selection swaps *all* related products together.
- Ensure client code can run with a fake factory producing test doubles.

