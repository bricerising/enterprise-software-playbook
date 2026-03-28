# Chain of Responsibility

## Intent

Route a request through a sequence of handlers where each handler can either process the request or pass it along.

## Use When

- You need a configurable pipeline (middleware, validation steps, auth, enrichment, fallback).
- Multiple handlers might handle a request, but you want to avoid hard-coded `if/else` ladders.
- You want to reorder, add, or remove steps without touching the caller.

## Prefer Something Else When

- You must broadcast to *all* listeners (Observer).
- There’s a single “best” handler chosen by rules (Strategy may be simpler).

## Minimal Structure

- `Handler` interface: `setNext(handler)` + `handle(request): result?`
- Concrete handlers implement `handle` and decide to pass to `next`
- Optional terminal handler (default/fallback)

## Implementation Steps

1. Define the request/response contract (including how errors propagate).
2. Implement handlers as single-responsibility units; avoid shared mutable state.
3. Make termination explicit:
   - return a result when handled, or
   - return a typed error/Result for expected failures, or
   - pass to next
4. Assemble the chain in one place (composition root) so ordering is visible.

## Pitfalls

- **Order sensitivity**: behavior can change drastically with ordering; treat ordering as configuration.
- **Silent drops**: ensure unhandled requests have a defined outcome (error or fallback).
- **Debuggability**: add tracing/logging to show which handler processed a request.

## Testing Checklist

- Handler order tests: verify the chain processes steps in the expected order.
- Termination tests: handled requests stop; unhandled requests reach fallback.
- Error propagation tests: a handler failure yields predictable outcomes.

