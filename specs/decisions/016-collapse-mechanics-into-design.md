# Decision 016: Collapse Mechanics Stage Into Design

**Date**: 2026-03-28
**Status**: Accepted
**Amends**: [ADR 001](001-workflow-stage-taxonomy.md) (removes Mechanics stage from the 5-stage taxonomy)

## Context

The Mechanics stage contains three skills (`patterns-creational`, `patterns-structural`, `patterns-behavioral`) — GoF implementation guides organized by pattern family. The `design` skill already contains a Pattern Chooser cheat sheet covering all 22 GoF patterns and routes users to the pattern skills for implementation detail. In practice:

- Spec 003 says "in-process pattern application is usually a supporting step during implementation, not the starting point."
- The workflow skill's proportionality table skips `patterns-*` for tiny and normal scope changes.
- An LLM implementing code doesn't need a separate skill invocation to implement the Builder pattern — it needs the *decision framework* for when to use Builder vs Factory, which lives in `design`.

The Mechanics stage is the only stage that is "usually not the starting point" — a stage that isn't a starting point shouldn't be a stage.

- **Goal**: Simplify the taxonomy from 5 stages to 4; make pattern references accessible through `design` via progressive disclosure.
- **Constraints**: Must not lose any pattern reference content; must preserve discoverability; `design` SKILL.md must stay under 500 lines.
- **Anti-goals**: Making patterns a mandatory part of the design workflow; making references harder to find.
- **Boundary + time horizon**: Affects all documentation, validation scripts, and the manifest. One-time migration.
- **Actors + incentives**: Agent consumers benefit from a simpler loop and fewer routing decisions. Contributors benefit from fewer skill directories to maintain.

## Options considered

| Option | Optimizes for | Knowingly worsens | Reversibility |
|---|---|---|---|
| A. Keep Mechanics but make it implicit in docs | Zero migration effort | Doesn't fix the routing overhead or taxonomy noise | Immediate (no change) |
| B. Collapse pattern content into `design/references/` | Simpler taxonomy (4 stages); pattern content preserved as progressive disclosure; fewer routing decisions | Longer reference chain (design → references/patterns-*.md → individual pattern .md); breaks prompts referencing `patterns-*` directly | High (restore skill directories from git history) |
| C. Delete pattern skills entirely (content lives in LLM training data) | Maximum simplification | Loses curated implementation checklists, guardrails, and enterprise-specific guidance that LLM training data doesn't have | Low (content lost, must be re-written) |

## Decision

Choose **Option B**: collapse `patterns-creational`, `patterns-structural`, and `patterns-behavioral` into `skills/design/references/` as progressive disclosure reference material. The `design` skill absorbs their descriptions, tags, and aliases for discoverability.

### Resulting taxonomy

| Stage | Skills |
|---|---|
| **Define** | workflow, plan, spec, architecture, design, archobs, intel, forecast |
| **Standardize** | typescript, platform |
| **Harden** | resilience, security, observability, debug |
| **Verify** | testing, review, finish |

17 skills across 4 stages, down from 20 across 5.

### Reference structure under design

```
skills/design/
  SKILL.md                           # decision workflow (unchanged core)
  references/
    patterns-creational.md           # consolidated from SKILL.md body
    patterns-structural.md           # consolidated from SKILL.md body
    patterns-behavioral.md           # consolidated from SKILL.md body
    creational/                      # individual pattern refs (moved)
      factory-method.md, abstract-factory.md, builder.md, prototype.md, singleton.md
    structural/                      # individual pattern refs (moved)
      adapter.md, bridge.md, composite.md, decorator.md, facade.md, flyweight.md, proxy.md
    behavioral/                      # individual pattern refs (moved)
      chain-of-responsibility.md, command.md, iterator.md, mediator.md, memento.md,
      observer.md, state.md, strategy.md, template-method.md, visitor.md
    snippets/
      typescript.md                  # merged from 3 sources
      react.md                       # merged from 3 sources
```

## Kill criteria / reversal trigger

Reverse this decision if:

- Agents consistently fail to find pattern implementation guidance when asked for a specific pattern (e.g., "implement the Builder pattern") — indicating that the reference chain through `design` is too long or the aliases aren't working.
- Pattern implementation quality degrades because agents skip the implementation checklists and guardrails that were in the former SKILL.md files — indicating that reference material doesn't get the same attention as skill-level content.

If triggered: restore `patterns-*` as standalone skills (recoverable from git history) and add them back to a Mechanics stage or as unstaged reference skills.

## Measurement + review ritual

- **Owner**: repo maintainers
- **Cadence**: check at next monthly review after implementation
- **Leading indicator**: agents invoke `design` with pattern-specific queries and find the right reference within one hop
- **Lagging indicator**: no user-reported difficulty finding pattern implementation guides
- **Action trigger**: if kill criteria are observed in 2+ consecutive sessions, propose a follow-up ADR

## Consequences

- **Positive**: Simpler 4-stage loop; fewer skills to route through; pattern content fully preserved as references; `design` becomes the single entry point for all in-process pattern work.
- **Trade-off**: Longer reference chain from design to individual patterns (design SKILL.md → references/patterns-creational.md → creational/builder.md). Two hops instead of one for users who previously went directly to `patterns-creational`.
- **Compatibility**: Breaking change for prompts referencing `patterns-*` skill names directly. Mitigated by merging aliases into `design`'s metadata so the old names still route correctly. Historical ADRs (009) and tasks.md references preserved as-is.

## Review date

2026-04-30
