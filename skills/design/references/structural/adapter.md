# Adapter

## Intent

Translate one interface into another so existing code can use a new/legacy/third-party component without changing call sites.

## Use When

- A third-party/legacy API is “almost” what you need, but the interface or data shapes don’t match.
- You want to isolate vendor/library churn behind a stable internal interface.
- You are migrating between two APIs and need a compatibility layer.

## Prefer Something Else When

- You’re trying to simplify a whole subsystem (Facade may fit better).
- You’re adding behavior without changing interface (Decorator/Proxy may fit better).

## Minimal Structure

- `Target`: interface your code expects
- `Adaptee`: the incompatible class/library
- `Adapter`: implements `Target`, wraps `Adaptee`, and translates calls/data
- Client depends only on `Target`

## Implementation Steps

1. Define/confirm a small `Target` interface that reflects *your* domain language.
2. Implement an adapter that:
   - maps method names and argument shapes
   - translates error types into your error model
   - converts units/timezones/encoding as needed
3. Keep the adapter near the boundary (module edge), not in core domain code.

## Pitfalls

- **Leaking adaptee types**: if callers need to downcast to `Adaptee`, you didn’t finish the abstraction.
- **Too much mapping logic**: split into helper mappers if conversions grow large.
- **Adapter becomes a facade**: if you wrap many classes and orchestrate multiple calls, consider a Facade.

## Testing Checklist

- Golden tests for input/output mapping and error translation.
- Edge cases: null/empty, missing fields, unit conversions, retries/timeouts (if applicable).
- Contract tests against a fake adaptee (or recorded fixtures) to lock in boundary behavior.

