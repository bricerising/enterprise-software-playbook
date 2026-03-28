# Singleton

## Intent

Guarantee a single instance and provide a global access point.

## Use When (Rare)

- You truly need a single instance for correctness (e.g., a process-wide coordinator) and can’t inject it cleanly.
- The instance is stateless or effectively immutable and is safe to share across threads.

## Prefer Something Else When (Usually)

- You can pass dependencies explicitly (constructor parameters) or use a DI container with controlled lifetimes.
- You want good testability; singletons behave like hidden global state.

## Minimal Structure

- Private constructor
- Static/module-level access method (`getInstance()` or language equivalent)
- Thread-safe initialization if applicable

## Implementation Steps

1. Attempt DI first (composition root picks the instance and injects it).
2. If still necessary, implement singleton with clear lifecycle and concurrency semantics.
3. Avoid storing request/user-specific state on the singleton.

## Pitfalls

- **Hidden dependencies**: code that “reaches out” to the singleton is hard to test and reason about.
- **Global mutable state**: creates flaky tests and spooky action at a distance.
- **Concurrency**: lazy init must be thread-safe; shared state must be protected or immutable.

## Testing Checklist

- Ensure only one instance exists in normal execution.
- Prefer tests that avoid relying on global singleton state; if unavoidable, provide reset hooks only in test builds.

