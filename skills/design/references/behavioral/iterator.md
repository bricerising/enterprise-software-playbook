# Iterator

## Intent

Traverse elements of a collection/structure without exposing its internal representation, and support multiple traversal strategies.

## Use When

- You have a custom collection/tree/graph and want a stable traversal API.
- You need multiple traversals (DFS/BFS, filtered views) without bloating the collection interface.
- You want to decouple traversal logic from the collection.

## Prefer Something Else When

- The language/runtime already provides idiomatic iteration; implement the idiom rather than a custom iterator type.
- You need to apply operations over a stable object structure (Visitor may fit better).

## Minimal Structure

- `Iterator` interface: `hasNext()` / `next()` (or language equivalents)
- `Aggregate`/collection provides `iterator()` methods for traversal variants
- Concrete iterators capture traversal state

## Implementation Steps

1. Decide traversal semantics: snapshot vs live view under mutation.
2. Implement iterator state (stack/queue/index) without exposing internals.
3. Provide multiple iterators when needed (e.g., `iterator()`, `reverseIterator()`).

## Pitfalls

- **Concurrent modification**: define what happens if the collection changes while iterating.
- **Leaking representation**: avoid exposing nodes or internal pointers unless required.

## Testing Checklist

- Order tests for each traversal variant.
- Mutation semantics tests (fail-fast, snapshot, or defined behavior).
- Boundary tests: empty collection, single element, deep nesting.

