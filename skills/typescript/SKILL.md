---
name: typescript
description: "Write, review, and refactor TypeScript for readability, type safety, and runtime correctness (Node.js/React/shared libs). Use when creating TS modules, modeling domain types, handling errors (Result/Either), validating external inputs (Zod/io-ts), organizing imports, or preventing cyclic dependencies. NOT for choosing design patterns (use design); NOT for shared platform library design (use platform)."
metadata: {"stage":"Standardize","tags":["typescript","runtime-safety","module-structure","error-handling","type-modeling","zod","result-type","throwless"],"aliases":["ts","type-safety","style-guide","coding-standards","eslint","prettier"]}
---

# TypeScript (Style Guide)

## Overview

Produce TypeScript that is easy to read, easy to change, and safe at runtime—by treating the codebase as a *system*: explicit boundaries, explicit dependencies, explicit errors, and explicit lifetimes.

Most of the principles here translate to other languages; the TypeScript-specific parts are mainly about how to enforce them with TS tooling and types.

Default objectives:

- **Consistency**: prefer automated formatting and linting (Prettier + ESLint) to eliminate style drift.
- **Readability**: reduce cognitive load with clear naming, shallow control flow, and explicit types.
- **Maintainability**: keep modules cohesive and dependencies/lifetimes explicit so change stays local.

A note on scope: these guidelines are optimized for **systemic** TypeScript (long‑lived apps/services/libraries where ownership, I/O boundaries, and runtime behavior matter). For short‑lived scripts, you can relax some constraints (e.g. more `throw`, fewer abstractions) as long as the blast radius stays small.

Definitions:

- **Scriptic**: short‑lived scripts/one‑offs; optimize for speed and simplicity; `throw` is usually fine.
- **Systemic**: long‑lived apps/services/libraries; optimize for explicit boundaries, typed failures, and explicit lifetimes.

## Chooser

- Use **typescript** when: creating new TS modules, modeling domain types, applying the Throwless Pact (Result/Either), validating external inputs (Zod/io-ts), organizing imports, or preventing cyclic dependencies.
- Do NOT use typescript when: choosing which design pattern to apply (use `design`); designing shared platform libraries (use `platform`).
- Relax for scriptic code: short-lived scripts don't need full boundary discipline or explicit lifetimes.

## Inputs / Outputs

**Inputs**: TypeScript source files to create, review, or refactor.
**Outputs**: Modified/created TypeScript source files following style guide principles. Applied inline during implementation; no downstream skill consumes output directly.

## Workflow

1. Decide “scriptic vs systemic” and set policies (error strategy, boundary validation, ownership/lifetimes).
2. Separate pure logic from side effects (I/O, time, randomness, global state).
3. Identify boundaries (HTTP/DB/fs/env) and treat their inputs as `unknown`.
4. Model the domain with types (discriminated unions) and keep data as plain objects (serializable).
5. Apply the *Throwless Pact*: make known failures explicit in types; reserve `throw` for unknown/unrecoverable; catch and convert at boundaries.
6. Keep dependencies explicit via parameters/factories; centralize wiring in a composition root.
7. Keep the module graph acyclic; enforce a dependency direction; prefer `import type` for type-only imports.
8. Make lifetimes explicit (create/start/stop/dispose); don’t rely on GC or hidden ownership.
9. For long‑running work (pollers, consumers, schedulers), model explicit “agents” with typed inputs/state and explicit shutdown.
10. Test at seams (pure functions, decoders/validators, adapters).
11. At I/O boundaries, make timeouts/retries/idempotency explicit (`resilience`) and keep telemetry consistent (`observability`); if 2+ services need the same boundary primitive, extract it (see `platform`).

## Minimum viable execution

When context or time is constrained, these are the load-bearing steps:

1. **Read existing code** — understand the current error strategy, boundary patterns, and module structure before changing anything.
2. **Apply boundary discipline** (steps 3, 5) — treat external inputs as `unknown`, validate at edges, make known failures explicit in types.
3. **Keep module graph acyclic** (step 7) — enforce dependency direction; prefer `import type` for type-only.
4. **Typecheck** (step 10) — verify no type errors introduced.

Steps that can be cut under pressure: explicit lifetime modeling (step 8), agent patterns for long-running work (step 9), full composition root wiring (step 6).

## Guidelines

For the full set of guidelines, see [`references/guidelines.md`](references/guidelines.md). Key highlights:

- **Systemic constraints**: types are erased at runtime, `throw` is untyped, serialization is not bijective, no deterministic destructors, cyclic deps break systems.
- **Throwless Pact**: known failures as typed `Result` / tagged unions; reserve `throw` for unknown/unrecoverable; catch at boundaries.
- **Boundaries**: treat external inputs as `unknown`; validate/parse once at the edge; keep "wire" shapes separate from domain types.
- **Lifetimes**: make resource ownership explicit (create/start/stop/dispose); prefer `AbortSignal` for cancellation.
- **Modules**: prevent cyclic imports; use a composition root; one feature per file; avoid barrel exports across layers.

## Clarifying Questions

- Is this scriptic (short-lived script) or systemic (long-lived app/service/library)?
- What runtime: Node.js, browser, or both?
- Is there an existing error strategy (throw vs Result/Either)?
- Are there existing lint/format configs (ESLint, Prettier) to follow?
- Does this module sit at an I/O boundary (HTTP, DB, filesystem)?

## Guardrails

- Don't apply systemic rigor to scriptic code: short-lived scripts don't need Result types, composition roots, or explicit lifetimes.
- Don't scatter validation across layers: decode `unknown` once at boundaries, then trust typed values internally.
- Don't use barrel exports (`index.ts`) across layer boundaries: they hide cyclic dependencies and bloat bundles.
- Don't leave resource ownership implicit: if you create a connection/handle, define who calls `close`/`dispose`.
- Don't use `any` as a shortcut: prefer `unknown` + narrowing at boundaries, or generics for reusable code.

## Common failure modes

- Over-types — adds unnecessary generics, utility types, or type gymnastics where simple concrete types would be clearer and more maintainable.
- Adds type annotations or refactors to code that wasn't changed — the skill should apply to the code being worked on, not adjacent unchanged code.
- Wraps every error in Result/Either even for internal code — the Throwless Pact applies at boundaries; internal pure functions can use simpler patterns.
- Applies systemic rigor to scriptic code — short-lived scripts don't need composition roots, explicit lifetimes, or Result types.

## References

- Glossary for common terms: [`GLOSSARY.md`](../../GLOSSARY.md)
- Specs/contracts as sources of truth: [`spec`](../spec/SKILL.md)
- Boundary time budgets and idempotency: [`resilience`](../resilience/SKILL.md)
- Telemetry consistency: [`observability`](../observability/SKILL.md)
- Shared “golden path” primitives: [`platform`](../platform/SKILL.md)

## Review checklist

Use this list when reviewing/refactoring TypeScript:

- Names are precise; no mystery abbreviations or misleading types.
- Formatting/imports follow the formatter (Prettier/ESLint); import order is stable.
- Functions are small, single-purpose, and mostly pure; few parameters; no boolean flags.
- Control flow is readable: shallow indentation, no nested ternaries, and no “clever” one-liners.
- Discriminated unions are handled exhaustively; missing variants fail fast at compile time.
- No accidental `any`; `unknown` is narrowed/decoded before use.
- External input is validated/decoded at boundaries; no unsafe `as` casts from JSON/env/network input.
- JSON/env/DB “wire” shapes are kept separate from domain types; round-trips don’t silently lose meaning.
- Expected failures are signified (tagged unions / `Result`); no sentinel returns; internal code is effectively “throwless”.
- Boundary code catches unknown throws and converts them to known error variants.
- Errors aren’t logged repeatedly across layers; logging happens at boundaries with enough context.
- Side effects are isolated; module dependencies are explicit and acyclic.
- No top-level side effects; composition root owns startup/shutdown.
- Resource ownership/cleanup is explicit; no “leaky” lifetimes; cancellation is threaded via `AbortSignal`.
- Long-running loops are explicit agents with shutdown/await paths.
- Tests cover pure logic and boundary adapters (decoders, repositories, clients).

## Output Template

When asked to apply this guide, respond with:

- Start with the highest-leverage changes (usually around boundaries, error signifiers, and lifetimes/ownership).
- Concrete refactors (diffs or patch-sized snippets).
- Any trade-offs and clarifying questions (scriptic vs systemic scope, domain boundaries, lifetime/agent ownership, error policy).
