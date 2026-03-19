# Theme coherence rubric: enterprise-software-playbook

This repository is a tongue-in-cheek set of **agent skills** meant to teach code assistants to write what humans tend to consider **clean code**: readable, maintainable, testable, and safe to change.

Skills should be small, self-contained playbooks (workflow + checklists + minimal examples). When in doubt, prefer **actionable guidance** over essays.

## Core principles (cross-language / cross-framework)

- **Clarity over cleverness**: optimize for the next reader; avoid surprising abstractions.
- **Make boundaries explicit**: treat external inputs as untrusted; validate/parse at the edges.
- **Keep dependencies explicit**: avoid hidden globals; inject dependencies via params/factories; centralize wiring.
- **Make failures explicit**: treat expected failures as data; reserve exceptions/panics for unexpected/unrecoverable; catch/convert at boundaries.
- **Make lifetimes explicit**: start/stop/dispose explicitly; don’t rely on “eventually cleaned up”.
- **Use patterns as vocabulary**: choose the simplest code pattern that fits; don't introduce patterns as decoration.
- **Test at seams**: prefer consumer-facing tests; avoid asserting implementation details.

## Consistency across languages

When introducing or updating a style guide for a new stack, preserve the above stance using the native idioms:

- **Errors**
  - TypeScript: typed `Result`/tagged unions for known errors; `throw` only for unknown/unrecoverable and convert at boundaries.
  - Go: explicit `error` returns; avoid panic for expected failure paths.
  - Rust: `Result` for expected failures; avoid `panic!` outside unrecoverable programmer errors.
  - Python/Java/etc.: exceptions may be idiomatic, but still distinguish expected vs unexpected failures and avoid using exceptions as routine branching in domain logic; convert/normalize at boundaries.
- **Boundaries and validation**: decode/validate once at the edge; keep core logic “pure” and easy to test.
- **Dependencies**: favor explicit constructors/factories/params; avoid magical global containers.

## What the check should flag

- Changes unrelated to the repo’s mission (agent skills for clean code).
- New guidance that contradicts the core principles (especially around explicit boundaries/errors/dependencies) without a strong, explicit rationale.
- New top-level skill folders that don’t include a `SKILL.md` with frontmatter `name` + `description`.
- Large, essay-like additions without a workflow/checklist or without reusable snippets/templates.

