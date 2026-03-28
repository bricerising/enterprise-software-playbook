# Command

## Intent

Encapsulate an action as an object so it can be queued, logged, retried, composed, or undone.

## Use When

- You need to schedule/queue operations (jobs, tasks, UI actions).
- You want undo/redo or operation history.
- You want to decouple “invoker” from “receiver” and make operations first-class.

## Prefer Something Else When

- You just need to choose an algorithm (Strategy).
- Actions are simple and don’t need queuing/history (a function callback may suffice).

## Minimal Structure

- `Command` interface: `execute()` (optional `undo()`)
- `ConcreteCommand` holds receiver + parameters needed to execute
- `Invoker` triggers commands and may record history
- `Receiver` performs the actual work

## Implementation Steps

1. Define command boundaries and idempotency expectations (important for retries).
2. Store only the necessary data on the command (inputs, receiver ref, metadata).
3. If undo is required, decide:
   - inverse operation (`undo()`), or
   - Memento-based state restore, or
   - event sourcing / durable log
4. Centralize execution policies (retry, tracing, auth) in the invoker/executor.

## Pitfalls

- **Commands become anemic DTOs**: keep invariants and validation at creation time.
- **Undo complexity**: undo isn’t free; define what “undo” means for side effects (payments, emails).
- **Serialization**: if commands persist, version them and test migrations (and don’t assume JSON round-trips preserve types/prototypes).

## Testing Checklist

- `execute()` calls receiver with correct parameters.
- Retry/idempotency behavior is correct under failure.
- Undo/redo correctness for representative commands (if implemented).

