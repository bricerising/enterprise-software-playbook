# Composite

## Intent

Compose objects into tree structures and treat individual objects and compositions uniformly through a shared interface.

## Use When

- Your domain is naturally hierarchical (files/folders, UI trees, org charts, expression trees).
- Callers want to run the same operation on a leaf and on a group of leaves.
- You need recursive traversal and aggregation.

## Prefer Something Else When

- Your structure is not a tree (graph with cycles) unless you can enforce acyclicity.
- You only need traversal (Iterator may be enough).

## Minimal Structure

- `Component` interface (the operations clients use)
- `Leaf` implements `Component`
- `Composite` implements `Component` and stores `children: List<Component>`
- Optional: `add/remove` on `Composite` only (preferred), or on `Component` with no-op or a typed error result for leaf

## Implementation Steps

1. Define the smallest `Component` interface that both leaves and composites can support.
2. Ensure composites delegate the operation to children and aggregate results if needed.
3. Decide ownership rules: who can add/remove children and when?
4. If cycles are possible, enforce acyclic graphs or add visited-set guards.

## Pitfalls

- **Unsafe child mutation**: expose only the operations you need; keep children collection encapsulated.
- **Leaf API pollution**: don’t force leaves to implement meaningless `add/remove` unless your language ecosystem expects it.
- **Performance**: deep recursion may need iterative traversal or caching.

## Testing Checklist

- Operations behave the same for leaf vs composite.
- Composite aggregation works across nested trees.
- Mutation rules are enforced (e.g., cannot add child where it’s invalid).

