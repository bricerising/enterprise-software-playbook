# Behavioral Patterns (Implementation Guide)

## Overview

Manage algorithms and collaboration without turning your code into nested conditionals and tight coupling. Behavioral patterns help you route requests, encapsulate actions, and swap behavior safely.

A note on scope: these guidelines assume **systemic** TypeScript (long-lived apps/services). For short-lived scripts, you can often simplify (fewer abstractions, more `throw`) as long as the blast radius stays small.

## Workflow

1. Decide "scriptic vs systemic" and set policies (error semantics, boundary validation, ownership/lifetimes).
2. Identify the interaction pressure: pipelines, events, undo, state machines, or algorithm selection.
3. Draw a quick responsibility map: who triggers actions, who owns state, who receives outcomes?
4. Pick a pattern that makes responsibilities explicit (interfaces + concrete behaviors).
5. Implement with clear contracts and tests for ordering, error semantics (Result vs throw), and lifetimes (unsubscribe/shutdown).

## Chooser

- **Chain of Responsibility**: configurable pipeline; each handler may handle or pass along.
- **Command**: represent actions as objects; queue/schedule/undo/retry.
- **Iterator**: traverse collections/graphs without exposing representation.
- **Mediator**: central coordinator to reduce many-to-many coupling.
- **Memento**: snapshot/restore object state; undo/redo without leaking internals.
- **Observer**: pub/sub updates; multiple listeners react to events.
- **State**: state machine; behavior varies by state; transitions are explicit.
- **Strategy**: swap algorithms behind a stable interface (runtime/config selection).
- **Template Method**: stable algorithm skeleton with overridable steps (often via hooks; use inheritance only when it already fits).
- **Visitor**: add new operations across a stable object structure without changing element classes.

## Clarifying Questions

- What is the interaction pressure: pluggable algorithms, event/listener, state machine, middleware pipeline, or undo/redo?
- How many behaviors/handlers exist today, and how often do new ones get added?
- What are the error semantics: should failures stop the chain, skip, or accumulate?
- Is ordering important (pipeline/chain) or unordered (pub/sub)?
- For async patterns: what are the cancellation and backpressure requirements?

## Implementation Checklist

- Make ordering explicit for pipelines and observers; define error semantics (what's expected vs unknown).
- For expected failures, prefer typed unions/`Result`; reserve `throw` for unknown/unrecoverable and catch/convert at boundaries.
- Treat boundary inputs as `unknown` (events/requests) and validate/decode once near the edge.
- For async observers/pipelines, make ownership explicit: unsubscribe/shutdown, backpressure/queueing, and cancellation (`AbortSignal`).
- Keep strategies/states small and pure when possible; inject dependencies via context.
- Prefer composition for Strategy/State; reserve Template Method for cases where inheritance is already a fit.
- For Command/Memento: define serialization and persistence needs early (in-memory vs durable; versioned formats).

## Guardrails

- Don't use Strategy for a single algorithm: if there's only one implementation with no foreseeable variant, a plain function is simpler.
- Don't use Observer when a direct function call suffices: pub/sub adds indirection; use it when the publisher genuinely shouldn't know its subscribers.
- Don't ignore error semantics in chains/pipelines: define whether failures stop, skip, or accumulate before implementing.
- Don't use State when a simple `if`/`switch` covers all transitions: State machines add value when transitions have side effects or the state graph is complex.
- Don't use Command for fire-and-forget actions: Command's value is undo/redo, queuing, or serialization. If you don't need those, call the function directly.

## Snippets (optional)

- TypeScript: [`snippets/typescript.md`](snippets/typescript.md) (Behavioral Patterns section)
- React: [`snippets/react.md`](snippets/react.md) (Behavioral Patterns section)

## References

Read the relevant reference file before implementing or refactoring toward the pattern:

- [`behavioral/chain-of-responsibility.md`](behavioral/chain-of-responsibility.md)
- [`behavioral/command.md`](behavioral/command.md)
- [`behavioral/iterator.md`](behavioral/iterator.md)
- [`behavioral/mediator.md`](behavioral/mediator.md)
- [`behavioral/memento.md`](behavioral/memento.md)
- [`behavioral/observer.md`](behavioral/observer.md)
- [`behavioral/state.md`](behavioral/state.md)
- [`behavioral/strategy.md`](behavioral/strategy.md)
- [`behavioral/template-method.md`](behavioral/template-method.md)
- [`behavioral/visitor.md`](behavioral/visitor.md)

Each reference includes: selection cues, minimal structure, pitfalls, and test ideas.

## Output Template

When applying a behavioral pattern, return:

- The pressure you're addressing (pipeline/eventing/undo/state/algorithm selection) and why this pattern fits.
- The proposed seam (interfaces/contracts) and who owns state and lifetimes (subscribe/unsubscribe, start/stop).
- Verification steps (tests for ordering, expected failures, and shutdown/cancellation).
