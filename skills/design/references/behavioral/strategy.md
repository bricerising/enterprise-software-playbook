# Strategy

## Intent

Define a family of interchangeable algorithms behind a stable interface so the algorithm can be selected at runtime or configuration time.

## Use When

- You have multiple ways to do the same thing (pricing rules, sorting, serialization, retry policies).
- You want to add new algorithms without changing clients.
- You want to unit-test algorithms independently of the context.

## Prefer Something Else When

- Behavior changes based on internal state transitions (State).
- The algorithm skeleton is stable but steps vary by subclass and inheritance is already in play (Template Method).

## Minimal Structure

- `Strategy` interface
- `ConcreteStrategyX` implementations
- `Context` holds a `strategy` and delegates to it

## Implementation Steps

1. Extract the stable algorithm contract (inputs/outputs/errors).
2. Implement strategies as small units with clear dependencies (inject what they need).
3. Choose a selection mechanism:
   - caller passes strategy
   - config maps keys to strategies
   - context chooses based on runtime conditions (keep selection logic separate from algorithms)

## Pitfalls

- **Over-engineering**: if only two variants exist and won’t grow, a simple conditional may be fine.
- **Leaky context**: avoid strategies that need to know too much about context internals.

## Testing Checklist

- Unit tests per strategy (including edge cases).
- Selection logic tests (correct strategy chosen per condition/config).
- Contract tests to ensure strategies are interchangeable (same semantics).

