# Mediator

## Intent

Centralize communication and coordination between objects to reduce many-to-many coupling.

## Use When

- Many objects talk to many others and dependencies are hard to follow.
- Coordination rules keep changing and are scattered across collaborators.
- You want collaborators to be reusable in different coordination contexts.

## Prefer Something Else When

- Updates are one-to-many notifications (Observer).
- A shared “service” object already exists and collaborators are simple (don’t invent a mediator for its own sake).

## Minimal Structure

- `Mediator` interface with coordination methods/events
- `ConcreteMediator` implements coordination logic
- `Colleague` objects hold reference to mediator and notify it instead of talking directly

## Implementation Steps

1. Identify the communication hotspots and extract them into mediator responsibilities.
2. Define events/commands colleagues send to mediator (typed and explicit).
3. Keep colleagues simple; they should not need references to other colleagues.
4. If mediator grows too large, split by domain flow or use multiple mediators.

## Pitfalls

- **Mediator becomes a god object**: avoid dumping unrelated workflows into one mediator.
- **Too much indirection**: if coupling is low, simpler direct calls may be better.

## Testing Checklist

- Colleagues do not communicate directly (can be checked via dependency direction).
- Mediator rules tests: given events from colleagues, mediator triggers correct outcomes.
- Integration tests for representative interaction flows.

