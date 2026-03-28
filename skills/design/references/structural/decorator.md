# Decorator

## Intent

Attach additional responsibilities to objects dynamically by wrapping them with objects that share the same interface.

## Use When

- You want optional, composable features (stacking behavior) without subclass explosion.
- You need to add cross-cutting behavior at the object level (formatting, validation, compression, retries).
- You want to keep the core component simple and grow features as wrappers.

## Prefer Something Else When

- You’re controlling access/lifecycle rather than adding features (Proxy may fit better).
- You’re translating one interface to another (Adapter).
- You’re simplifying a subsystem (Facade).

## Minimal Structure

- `Component` interface
- `ConcreteComponent`
- `Decorator` base that holds a `Component` and delegates
- `ConcreteDecoratorX` adds behavior before/after delegation

## Implementation Steps

1. Define a small interface that represents the “core capability”.
2. Implement core behavior in the component.
3. Implement decorators as thin wrappers:
   - add one concern per decorator
   - delegate the rest unchanged
4. Provide a composition/wiring point (factory/builder) that assembles decorator stacks.

## Pitfalls

- **Order sensitivity**: document/encode decorator ordering rules; provide a single assembly function.
- **Debuggability**: long stacks are hard to reason about; keep concerns coarse-grained.
- **Identity/equality**: wrappers can complicate equality checks and type checks; avoid relying on concrete types.

## Testing Checklist

- Each decorator preserves base semantics plus adds its concern.
- Tests cover different stack orderings when order matters.
- Error handling: decorator-added errors compose predictably with underlying errors.

