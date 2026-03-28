# State

## Intent

Let an object change behavior when its internal state changes by delegating state-specific behavior to state objects.

## Use When

- You have a state machine with state-dependent behavior and complex transition rules.
- Conditionals over `state` are spreading across methods and becoming hard to maintain.
- You want transitions and per-state behavior to be explicit and testable.

## Prefer Something Else When

- State logic is tiny and stable (an enum + switch may be simpler).
- You’re choosing among algorithms independent of internal state (Strategy).

## Minimal Structure

- `Context` holds `state: State`
- `State` interface defines operations
- `ConcreteStateX` implements behavior and may initiate transitions

## Implementation Steps

1. List states and valid transitions; define invariants per state.
2. Extract behavior per state into state classes or functions.
3. Decide where transitions live:
   - inside states (states decide next)
   - inside context (central transition rules)
4. Ensure context delegates behavior to the current state.

## Pitfalls

- **State explosion**: too many micro-states; consider grouping or using data-driven tables.
- **Hidden transitions**: keep transition rules discoverable; log/trace transitions.
- **Shared state instances**: only safe if states are immutable or hold no per-context data.

## Testing Checklist

- Per-state behavior tests.
- Transition tests (valid and invalid transitions).
- Invariant tests: context remains consistent after sequences of actions.

