# Observer

## Intent

Define a subscription mechanism so multiple observers can react to events or state changes from a subject.

## Use When

- One-to-many event notification is needed without hard-coded dependencies.
- You need extensibility: new listeners can be added without changing the publisher.
- You want to integrate analytics, caching, UI updates, or side effects in a decoupled way.

## Prefer Something Else When

- You need a single coordinator that decides who talks to whom (Mediator).
- You need a pipeline where exactly one handler produces the result (Chain of Responsibility).

## Minimal Structure

- `Subject` supports `subscribe`, `unsubscribe`, `notify`
- `Observer` interface: `update(event)`
- Event type is explicit (prefer typed events over generic maps)

## Implementation Steps

1. Define event payloads (type, data, ordering guarantees).
2. Choose delivery model:
   - synchronous (simple, but observers can block)
   - async (needs queueing/backpressure, explicit shutdown/cancellation, and error handling)
3. Define error semantics (one observer fails: does it stop the rest?).
4. Ensure unsubscribe and lifecycle management to prevent leaks (and stop/abort async delivery when the owner shuts down).

## Pitfalls

- **Memory leaks**: subjects holding references to observers that should be GC’d.
- **Reentrancy/loops**: observers triggering changes that re-trigger notifications; guard against cycles.
- **Unbounded fanout**: too many observers can hurt latency; consider async buffering.

## Testing Checklist

- Subscribe/unsubscribe behavior.
- Notification order guarantees (if any) and error isolation.
- Reentrancy/cycle protections for representative flows.

