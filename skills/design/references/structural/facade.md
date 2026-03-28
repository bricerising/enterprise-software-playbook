# Facade

## Intent

Provide a simplified, stable interface to a complex subsystem.

## Use When

- Callers are forced to understand many subsystem classes and call sequences.
- You want to isolate “orchestration” logic and expose a smaller surface area.
- You are integrating a library/framework but want to keep it out of your core domain.

## Prefer Something Else When

- You’re only translating one interface to another (Adapter).
- You need to add optional features to a single object (Decorator).

## Minimal Structure

- `Facade` exposing a small API aligned to your use cases
- Subsystem classes remain internal; facade composes them and coordinates calls

## Implementation Steps

1. Identify the top-level use cases callers need (not subsystem primitives).
2. Create facade methods that perform the full orchestration for each use case.
3. Keep subsystem types out of public method signatures.
4. Keep facade focused: split facades by use-case area if it grows too large.

## Pitfalls

- **Facade as god object**: if it owns too many concerns, split by domain/use-case.
- **Leaking internals**: exposing subsystem classes in the facade API defeats the goal.

## Testing Checklist

- Contract tests that verify the facade API for each use case.
- Integration tests with subsystem fakes to assert orchestration (ordering, error handling).

