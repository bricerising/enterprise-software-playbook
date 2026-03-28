# Flyweight

## Intent

Support large numbers of fine-grained objects efficiently by sharing common (intrinsic) state and externalizing varying (extrinsic) state.

## Use When

- You have *many* similar objects and memory or allocation cost is a problem.
- Objects can be split into:
  - **intrinsic** state: shareable, mostly immutable
  - **extrinsic** state: supplied at call time (position, context, owner)

## Prefer Something Else When

- The count isn’t high enough to justify complexity.
- Objects carry lots of mutable unique state (sharing won’t help).

## Minimal Structure

- `Flyweight` object holding intrinsic state
- `FlyweightFactory` caching and reusing flyweights by a key
- Client supplies extrinsic state when invoking operations

## Implementation Steps

1. Measure/confirm the memory or allocation pressure (don’t guess).
2. Define a stable key for intrinsic state (string/tuple/enum).
3. Make flyweights effectively immutable and safe to share.
4. Move extrinsic data to the call site (method parameters) or a separate context object.

## Pitfalls

- **Accidental mutation**: shared objects must not hold per-instance mutable state.
- **Cache growth**: define eviction or bound the key space if unbounded.
- **Thread safety**: shared caches and flyweights must be safe under concurrency.

## Testing Checklist

- Factory returns the same instance for the same intrinsic key.
- Behavior is correct when extrinsic state changes across calls.
- If you add eviction/bounds, test cache policies explicitly.

