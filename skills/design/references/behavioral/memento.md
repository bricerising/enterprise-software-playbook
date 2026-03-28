# Memento

## Intent

Capture and restore an object’s internal state without exposing implementation details (often for undo/redo).

## Use When

- You need undo/redo or rollback of in-memory state.
- You want to keep snapshots opaque to caretakers (no peeking into internals).
- State restoration must preserve invariants and encapsulation.

## Prefer Something Else When

- You need durable history, auditing, or cross-process restore (consider event sourcing or explicit persistence formats).
- State is too large or changes too frequently (snapshots become costly).

## Minimal Structure

- `Originator` creates/restores mementos
- `Memento` holds captured state (opaque to caretaker)
- `Caretaker` stores mementos/history and decides when to restore

## Implementation Steps

1. Decide snapshot granularity (full state vs incremental diffs).
2. Implement memento creation so it captures only what’s needed to restore invariants.
3. Ensure mementos are immutable and not mutated by caretakers.
4. Manage history size (cap, compress, or prune).

## Pitfalls

- **Memory blowup**: store too many snapshots; cap history or store diffs.
- **Leaking internals**: avoid exposing raw state through the caretaker API.
- **External side effects**: mementos only cover in-memory state unless you explicitly model side effects.
- **Persistence/serialization**: if you persist mementos, define a versioned wire format; don’t rely on JSON round-trips of classes.

## Testing Checklist

- Restore returns object to exact previous behavior/state for representative transitions.
- Multiple-level undo/redo sequences work (not just single-step).
- History size limits behave as expected.

