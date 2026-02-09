# TypeScript Guidelines (Reference)

### Systemic constraints (avoid "complications")

- **Types are erased at runtime**: validate external data; never "trust" `as X` on JSON/env/network input.
- **`throw` is untyped control flow**: don't use it for expected failures; keep domain/application code effectively "throwless".
- **Serialization is not bijective**: JSON/env/DB rows lose information (`Date`, `BigInt`, `undefined`, prototypes); decode/encode explicitly at boundaries.
- **Classes don't serialize**: JSON round-trips strip prototypes; avoid using classes as data and avoid `JSON.parse(...) as MyClass`.
- **No deterministic destructors**: make cleanup explicit (`dispose()` / `close()`), and enforce it via `try/finally` (or `using` / `await using` where supported) at ownership boundaries.
- **Module initialization hides lifetimes**: avoid top-level side effects; create/start resources in a composition root so you can also stop them.
- **Cyclic dependencies break systems**: enforce an import direction and refactor cycles early.
- **Strings scale easily**: avoid representing large/structured data as long strings unless you've measured the cost.

### Naming

- Prefer precise, searchable names; avoid abbreviations and "mental mapping".
- Avoid redundant context in names; let modules and types provide the scope.
- Use `verbNoun` for functions (`parseUser`, `loadConfig`); use `is/has/can/should` for booleans (`isReady`, `shouldRetry`).
- Use a consistent vocabulary; don't alternate synonyms (`fetch/get/load`) unless you mean different semantics.
- Avoid vague names like `data`, `value`, `handle`, `handler`; prefer names with domain meaning.
- Avoid prefixing interfaces with `I` (prefer `User`, not `IUser`) and avoid leading/trailing underscores (use access modifiers instead).
- Avoid Hungarian notation and redundant suffixes/prefixes (`FooClass`, `UserInterface`); types and scope already communicate that.
- Avoid single-letter names outside small scopes (trivial lambdas, simple indices).
- Use consistent casing:
  - `camelCase` for values, variables, and functions
  - `PascalCase` for types and exported components
  - `UPPER_SNAKE_CASE` for hard constants
- Prefer stable file/module names; avoid deeply nested folder trees.

### Variables

- Use `const` by default; use `let` only when reassigned; avoid `var`.
- Avoid magic numbers/strings and sentinel values; introduce named constants.
- Keep scopes tight; declare variables close to where they're used.
- Use explanatory variables for complex conditions instead of repeating deep property access.

### Types and data

- Prefer `unknown` over `any`; narrow with type guards or runtime validators.
- Avoid unchecked assertions (`as X`) for untrusted data (JSON, env, network); decode/validate at the boundary.
- Prefer discriminated unions over boolean flags or "stringly-typed" states.
- For discriminated unions, enforce exhaustiveness (`never` checks) instead of a catch-all `default` that hides missing variants.
- Keep "data" serializable and prototype-free (plain objects); don't rely on class instances surviving JSON.
- Keep "wire" shapes (JSON/env/DB rows) separate from domain types; decode/encode explicitly so round-trips don't silently lose meaning.
- Use the narrowest useful types (`'asc' | 'desc'`, `UserId` brand) to reduce invalid states.
- Default to immutability (`readonly`, `ReadonlyArray`) unless mutation is a measured need.
- For "closed sets", prefer literal unions or `as const` objects; use `enum` only when you explicitly want a runtime object.
- Prefer `satisfies` to validate object literals without widening inference.
- Prefer built-in utility types (`Pick`, `Omit`, `Partial`, `Required`, `ReturnType`, `Parameters`, `Awaited`) over duplicating shapes by hand.
- Keep advanced types readable: split complex conditional/mapped types into named parts; avoid "type gymnastics" that obscures intent.

### Functions

- Keep functions small (ideally one screen / ~20-30 lines) and do one thing; name them after their single responsibility.
- Minimize parameters; group related parameters into an options object; avoid boolean flags.
- Prefer object parameters + destructuring for "named parameters" at the callsite.
- Prefer default parameters or nullish coalescing (`x ?? default`) over "falsy" fallbacks (`x || default`) when `0`, `''`, or `false` are valid.
- Prefer optional chaining (`?.`) over manual `&&` chains or deep `if` ladders when values may be missing.
- Avoid hidden dependencies (global singletons, module state); pass dependencies in.
- Prefer early returns; keep indentation shallow; extract helpers instead of nesting.
- Avoid side effects in domain logic; isolate them in adapters (DB/HTTP/fs/clock).

### Readability

- Avoid deep nesting (>2-3 levels); prefer guard clauses (`return` / `continue`) and helper functions to flatten.
- Prefer one statement per line; avoid comma operators and "packed" multi-statement lines.
- Use ternaries only for simple expressions; avoid nested ternaries and avoid side effects in ternaries.
- Use blank lines to separate logical phases (setup -> core logic -> return); avoid excessive blank lines.
- Keep complexity low; if a function has many branches/paths, split it or model cases as a discriminated union.
- Remove obvious duplication (DRY), but don't over-abstract; optimize for clarity and allow divergence when semantics differ.

### Errors (known vs unknown)

- Treat expected failures as values, not exceptions (*Throwless Pact*):
  - **Known errors**: return a typed `Result<T, E>` / tagged union with stable **signifiers** (e.g. `{ type: 'NotFound'; ... }`).
  - **Unknown errors**: `throw` `Error` and catch at the boundary to log/convert to a known error.
- Avoid "sentinel" error signals (`null`, `false`, `-1`) and avoid using free-form strings as program logic; prefer structured error variants with context fields.
- Never `throw` strings; throw `Error` (or subclasses) and attach context (use `cause` when wrapping).
- Don't swallow errors; handle, transform, or rethrow with context.
- Log and translate errors at boundaries; avoid logging the same error repeatedly across layers (log once, then propagate as typed failure).
- In `catch`, treat the value as `unknown` and narrow before reading `message/stack`.

Minimal `Result` pattern:

```ts
export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });
```

Example known-error union (signified variants):

```ts
export type GetUserError =
  | { type: 'NotFound'; userId: string }
  | { type: 'DbUnavailable' };

export async function getUser(
  userId: string,
): Promise<Result<{ id: string; name: string }, GetUserError>> {
  /* ... */
}
```

### Boundaries and validation

- Treat all external inputs as `unknown` (HTTP, DB rows, env vars, JSON files).
- Validate/parse once at the boundary; after that, internal code should accept well-typed values.
- Keep parsing separate from effects: `decode(input) -> Result<Domain, DecodeError>`, then `apply(domain)`.
- Treat `JSON.parse` output as `unknown` (TS types it as `any`); validate before use.
- Prefer paired **decoders/encoders** at system edges so "wire" shapes and domain types don't drift (especially around `Date`, `BigInt`, and optional fields).
- Prefer a schema/decoder library (or hand-rolled decoders) for boundary validation; keep decoders pure and test them directly.

### Async, resources, and lifetimes

- Avoid doing real work in constructors; prefer `createX()` factories for async setup.
- Make lifetimes explicit (start/stop, connect/disconnect); don't hide resource ownership.
- Ensure cleanup is guaranteed where ownership lives (typically via `try/finally`).
- Prefer explicit parent -> child ownership: whoever creates a resource/agent is responsible for stopping it (and awaiting its termination).
- Prefer `AbortSignal` for cancellation and timeouts at boundaries.
- Avoid "detached" promises and background loops without an owner (they're leaks with no shutdown path).

### Concurrency and agents

Use explicit "agents" for long-running work (pollers, consumers, schedulers) instead of ad-hoc module state.

- Give each agent a single entrypoint that takes an `AbortSignal`.
- Keep state private to the agent; communicate via typed messages or function calls at boundaries.
- Supervise agents from a parent that can stop them and await completion.

A minimal shape:

```ts
export type Agent = {
  run(signal: AbortSignal): Promise<void>;
};
```

### Classes vs factory functions

- Prefer factory functions/closures for most modules; they avoid `this`/unbound-method pitfalls, make dependencies explicit, and fit async setup/lifetimes cleanly.
- Use classes when you need framework integration, `instanceof`, or polymorphism; if you do:
  - avoid inheritance; prefer composition
  - avoid passing unbound instance methods as callbacks
  - don't use classes as DTOs; keep boundary data as plain objects

### Modules and dependencies

- Prevent cyclic imports; refactor toward a clear dependency direction (domain -> application -> infrastructure).
- Keep composition/wiring in one place (composition root); avoid cross-cutting "magic" imports.
- Prefer one feature/module per file; avoid catch-all `utils.ts` that mixes unrelated responsibilities.
- Keep files small and cohesive (a few hundred lines max); split when responsibilities diverge or the file stops fitting in your head.
- Separate concerns by layer (data access vs domain logic vs presentation) and depend on contracts (types/interfaces) rather than concrete implementations.
- Prefer readable imports (path aliases) over deep relative paths.
- If you hit a cycle, break it by extracting shared *types* to a leaf module, inverting a dependency, or moving wiring to the composition root.
- Be cautious with barrel exports (`index.ts`) across layers; they can hide dependencies and make cycles harder to spot.

### Tooling defaults (if you control config)

- Enforce consistency with tooling: Prettier for formatting; ESLint (+ typescript-eslint) for correctness/style; run them in CI.
- Turn on TS strictness (`strict`); if you can't yet, at least enable `noImplicitAny` and `strictNullChecks` and migrate incrementally.
- Add `@typescript-eslint/no-explicit-any` (with a small allowlist) so `any` stays a last resort.
- Turn on additional correctness flags like `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, and `noFallthroughCasesInSwitch` to keep the codebase honest.
- Prefer type-only imports via config (`verbatimModuleSyntax`) + linting (`consistent-type-imports`) to keep runtime dependencies explicit.
- Add lint rules that prevent async footguns (`no-floating-promises`, `no-misused-promises`) and add cycle detection in larger repos.

### Formatting

- Follow the project's formatter/linter (often Prettier + ESLint); prefer automation over "style debates".
- If there's no established house style, default to: 2-space indentation (no tabs), 1TBS braces for all control flow (even single statements), semicolons (avoid ASI surprises), trailing commas in multiline (clean diffs), and a ~100-120 character line limit (or the project's formatter `printWidth`).
- Default to single quotes in TS and double quotes in JSON (unless the project's formatter says otherwise).
- Keep imports grouped and sorted: built-ins -> third-party -> internal; blank lines between groups; alphabetize within groups; prefer named imports and avoid `import * as X` unless the library expects it.
- Use consistent whitespace (space after commas, around operators, and after `:` in types/object entries); avoid trailing spaces.
- Keep related code close: group by feature, keep callers/callees near, and keep files focused.
- Keep type-only imports explicit via `import type` when configured.

### Comments and documentation

- Comment the "why" (constraints, trade-offs), not the "what".
- Avoid redundant comments; delete/update comments when code changes.
- Keep public APIs self-documenting via naming/types; use JSDoc/TSDoc only where it improves usage (constraints, examples, edge cases).
