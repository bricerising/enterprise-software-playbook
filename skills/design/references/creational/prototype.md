# Prototype

## Intent

Create new objects by cloning existing ones so creation doesn’t depend on concrete classes or complex constructors.

## Use When

- You need copies of objects with runtime-specific concrete types.
- Construction is expensive or complicated, but copies are relatively cheap.
- You want to avoid “deep constructor trees” and keep object creation flexible.

## Prefer Something Else When

- Copy semantics are ambiguous or dangerous (lots of shared mutable state).
- You mostly create from primitives/config and can express creation directly (Builder/Factory is clearer).

## Minimal Structure

- `Prototype` interface with `clone(): Prototype` (or language idioms like copy constructors)
- Concrete prototypes implement clone semantics (deep vs shallow) explicitly
- Optional `PrototypeRegistry` mapping keys to prototype instances

## Implementation Steps

1. Decide and document copy semantics for each field:
   - immutable primitives/value types (copy)
   - shared references (share) vs “owned” references (deep copy)
2. Implement `clone()` with explicit rules; handle cycles if your graph can be cyclic.
3. If you use a registry, keep keys typed (enum/ADT) and register at startup.

## Pitfalls

- **Shallow copy bugs**: clones unintentionally share mutable children.
- **Identity confusion**: clones that must have new IDs/timestamps; define what resets on clone.
- **Versioning**: if objects evolve, update clone logic and tests.

## Testing Checklist

- Modifying a clone does not mutate the original (for fields meant to be copied).
- “Reset-on-clone” fields behave correctly (IDs, timestamps, caches).
- Registry returns the expected concrete type for each key.

