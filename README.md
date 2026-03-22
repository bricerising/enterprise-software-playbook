# enterprise-software-playbook

An opinionated set of **agent skills** that drive cohesive, high-quality **enterprise software**: readable, maintainable, testable, and safe to change.

Each skill is a small, self-contained playbook (workflow + checklists + examples) stored in a `SKILL.md` file. Most skills are language-agnostic; TypeScript is currently the only language-specific style guide.

## Why this exists

AI coding agents produce inconsistent output without shared guardrails. Copy-paste prompt snippets drift across teams, and ad-hoc instructions don't compose. This playbook gives agents a structured library of composable skills so that code quality stays high regardless of who (or what) writes the code.

## Quick start

1. **Install** the skills (pick one): [Codex CLI](INSTALL.md#codex-cli) | [Claude Code](INSTALL.md#claude-code) | [Antigravity](INSTALL.md#antigravity) | [Vendor via submodule](INSTALL.md#tool-agnostic-vendor-it-into-your-project)
2. **Add agent instructions** to your app repo (start from [`specs/templates/app-repo/AGENTS.md`](specs/templates/app-repo/AGENTS.md)).
3. **Paste the bootstrap prompt** from [`PROMPTS.md`](PROMPTS.md#conversational-bootstrap-auto-route).

You do **not** need to read this repo cover-to-cover. Start with the three steps above, then open the specific `skills/*/SKILL.md` playbook(s) you need as you go.

Minimal "try it now" prompt (run this inside **your app repo**, not this playbook repo):

```text
Use workflow (read skills/workflow/SKILL.md).

Please review this codebase for maintainability and resilience gaps.
```

## What's in here

Skills follow a default workflow: **Define > Standardize > Harden > Verify > Mechanics**.

### Define (what are we building?)

| Skill | Purpose |
|-------|---------|
| [`workflow`](skills/workflow/SKILL.md) | Auto-route work across skills; choose appropriate skills even if the user doesn't name them |
| [`plan`](skills/plan/SKILL.md) | Turn a request into an executable plan (tasks + acceptance + verification) |
| [`spec`](skills/spec/SKILL.md) | Write specs, contracts, plans, and task lists so agents converge on cohesive solutions |
| [`architecture`](skills/architecture/SKILL.md) | Choose the smallest system pattern(s) for cross-service pressures |
| [`design`](skills/design/SKILL.md) | Choose the smallest code pattern(s) for in-process design pressures |
| [`archobs`](skills/archobs/SKILL.md) | Measure coupling, boundary health, and risk hotspots before architecture/refactoring decisions |
| [`intel`](skills/intel/SKILL.md) | Gather and shape intelligence signals from collected feeds into audience-aware output |
| [`forecast`](skills/forecast/SKILL.md) | Predict likely next developments from internal patterns (git, archobs) and external signals (intel) |

### Standardize (make it consistent)

| Skill | Purpose |
|-------|---------|
| [`typescript`](skills/typescript/SKILL.md) | Runtime safety, explicit boundaries, typed errors, and maintainable module structure |
| [`platform`](skills/platform/SKILL.md) | Design shared platform packages (`packages/shared`) without becoming a "utils junk drawer" |

### Harden (make it survive reality)

| Skill | Purpose |
|-------|---------|
| [`resilience`](skills/resilience/SKILL.md) | Timeouts, retries/backoff, idempotency, circuit breakers, bulkheads |
| [`security`](skills/security/SKILL.md) | Authn/authz, input validation, injection safety, secrets, SSRF guardrails |
| [`observability`](skills/observability/SKILL.md) | Logs/metrics/traces correlation, RED metrics, dashboards/alerts |
| [`debug`](skills/debug/SKILL.md) | Debug workflows (log > trace > metrics) for incidents, regressions, and SLO violations |

### Verify (prove behavior)

| Skill | Purpose |
|-------|---------|
| [`testing`](skills/testing/SKILL.md) | Consumer-focused tests that raise coverage without asserting implementation details |
| [`review`](skills/review/SKILL.md) | Adversarial code review debate (critique > defense > rebuttal > verdict) |
| [`finish`](skills/finish/SKILL.md) | Definition-of-done pass (verification + boundary spot-check + crisp summary) |

### Mechanics (in-process building blocks)

| Skill | Purpose |
|-------|---------|
| [`patterns-creational`](skills/patterns-creational/SKILL.md) | Factory Method, Abstract Factory, Builder, Prototype, Singleton |
| [`patterns-structural`](skills/patterns-structural/SKILL.md) | Adapter, Bridge, Composite, Decorator, Facade, Flyweight, Proxy |
| [`patterns-behavioral`](skills/patterns-behavioral/SKILL.md) | Chain of Responsibility, Command, Iterator, Mediator, Memento, Observer, State, Strategy, Template Method, Visitor |

Cross-cutting reference material shared across skills lives in [`skills/references/`](skills/references/).

## Using these skills

Each skill lives under `skills/<name>/SKILL.md`. The primary mode is **conversational**: ask for what you want and let the agent auto-select the right skills. If you want deterministic control, name specific skills explicitly.

For more prompt recipes (including a conversational bootstrap), see [`PROMPTS.md`](PROMPTS.md).

## Install

Detailed per-platform instructions are in [`INSTALL.md`](INSTALL.md).

| Platform | One-line install |
|----------|-----------------|
| **Codex CLI** | `Fetch and follow instructions from https://raw.githubusercontent.com/bricerising/enterprise-software-playbook/refs/heads/main/.codex/INSTALL.md` |
| **Claude Code** | `Fetch and follow instructions from https://raw.githubusercontent.com/bricerising/enterprise-software-playbook/refs/heads/main/.claude/INSTALL.md` |
| **Antigravity** | `Fetch and follow instructions from https://raw.githubusercontent.com/bricerising/enterprise-software-playbook/refs/heads/main/.antigravity/INSTALL.md` |
| **Any tool** | `git submodule add https://github.com/bricerising/enterprise-software-playbook.git tools/enterprise-software-playbook` |

## Scope (and non-goals)

This playbook is optimized for **enterprise web apps**, especially:

- HTTP/gRPC services, background jobs, and event consumers
- Multi-service systems with reliability/consistency pressures

Non-goals:

- A framework-specific "how to build a React app" guide
- A complete performance tuning handbook (use it selectively, case-by-case)

## Philosophy

These skills bias toward practices that make codebases easier for humans to operate over time:

- Prefer clarity over cleverness; optimize for the next reader.
- Make boundaries explicit; validate external inputs at the edges.
- Keep dependencies and lifetimes explicit; avoid hidden globals.
- Treat expected failures as data (typed results) instead of exceptions.
- Use design patterns as names for proven structures, not as goals.

## Bundled tools

- [`tools/archobs/`](tools/archobs/README.md) -- Architecture observability CLI: measures coupling, boundary health, risk hotspots, and drift. Install with `pip install -e 'tools/archobs[full]'`. Powers the [`archobs` skill](skills/archobs/SKILL.md).
- **[Codanna](https://codanna.dev)** -- Companion CLI that generates semantic search embeddings, used by archobs for file similarity. Install with `brew install codanna` (macOS) or see the [archobs README](tools/archobs/README.md).
- [`tools/intelligence/`](tools/intelligence/README.md) -- Intelligence collector and query CLI (`intel`): polls RSS, Hacker News, and SEC EDGAR feeds; stores events in SQLite; exposes trends/search/events via CLI and MCP tools. Install with `cd tools/intelligence && npm install && npm run build && npm link`. Powers the [`intel` skill](skills/intel/SKILL.md).

## Docs

**For users:**

- Prompt recipes: [`PROMPTS.md`](PROMPTS.md)
- Tutorial walkthrough: [`TUTORIAL.md`](TUTORIAL.md)
- Glossary: [`GLOSSARY.md`](GLOSSARY.md)
- Machine-readable skill index: [`specs/skills-manifest.json`](specs/skills-manifest.json)

**For contributors:**

- Repo-level specs (source of truth): [`specs/000-index.md`](specs/000-index.md)
- Agent instructions for this repo: [`AGENTS.md`](AGENTS.md)
- Dev quickstart (validation, packaging): [`specs/quickstart.md`](specs/quickstart.md)
- App-repo integration guide: [`specs/005-application-integration.md`](specs/005-application-integration.md)

**Templates (copy-first):**

- App-repo agent instructions: [`specs/templates/app-repo/AGENTS.md`](specs/templates/app-repo/AGENTS.md)
- Service spec bundle: [`specs/templates/service-spec-bundle/`](specs/templates/service-spec-bundle/README.md)
- CI quality gate: [`specs/templates/ci/github-actions-quality.yml`](specs/templates/ci/github-actions-quality.yml)

## Terminology

- **Code patterns**: in-process patterns (classic creational/structural/behavioral, mostly GoF).
- **System patterns**: cross-process patterns (architecture/distributed-systems/ops) dealing with failure, consistency, and integration seams.
- **Operational patterns**: repeatable workflows and cross-cutting policies for predictable delivery and operations (spec bundles, shared platform primitives, tests, observability, resilience).

The skill list above is grouped by **workflow stage** (Define/Standardize/Harden/Verify/Mechanics), not by scope.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the backlog in [`specs/tasks.md`](specs/tasks.md).

## Feedback

If you try this playbook in a real codebase, feedback is extremely valuable:

- Use GitHub Issues for bugs, confusing docs, and feature requests.
- Include the prompt you used and what you expected vs what happened.

## License

Apache 2.0 -- see [`LICENSE.txt`](LICENSE.txt).
