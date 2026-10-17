# Decision 018: Add journey-atlas skill with its scripts inside the skill folder

**Date**: 2026-10-17
**Status**: Accepted

## Context

The Define stage has one data-source skill about code structure: `archobs`, which measures coupling, boundary health and drift from git history, imports and embeddings. It does not answer the questions architects ask first about a service: what each user journey runs through end to end, which external systems it waits on, which routes lack sign-in or validation, and what breaks when a dependency fails.

`journey-atlas` answers those. It builds a graph of every entry point (HTTP routes, WebSocket actions, jobs, consumers), its middleware, logic, tables, events and external systems, loads it into Neo4j, reads it through lenses taken from the playbook skills (architecture, resilience, observability, security, platform, design), and builds a self-contained HTML atlas with verified findings.

- **Goal**: give the playbook an end-to-end journey graph and an architecture read-out whose findings route to the skills that fix them.
- **Constraints**: the analyzers need only Node.js (with the target repo's own `typescript`) or Python 3 stdlib; Neo4j is optional and started in Docker only when none is available.
- **Anti-goals**: replacing `archobs` (history-based coupling stays there); making the playbook depend on Neo4j or Docker.
- **Boundary + time horizon**: this decision covers adding the skill and where its scripts live. Review after it has been used on three or more repos.
- **Actors + incentives**: playbook users want one install; maintainers want the lenses and the skills they cite to stay in sync.

## Options considered

| Option | Optimizes for | Knowingly worsens | Reversibility |
| --- | --- | --- | --- |
| A: Scripts inside `skills/journey-atlas/scripts/` | One folder to install; the skill calls its scripts by path relative to itself; lenses find sibling skills at `skills/<name>` | Skill folder is larger than a docs-only skill (~0.5 MB, no dependencies vendored) | High: can move to `tools/` later |
| B: Vendor as `tools/journey-atlas/` like `archobs` (decision 015) | Same layout as archobs; independent tests and packaging | Two paths to install and keep in sync; the skill must locate the tool; no package manager benefit (no install step exists) | High |
| C: Separate repository | Independent release cadence | Lens references drift from the skills they cite | Medium |

## Decision

Option A. The skill contract (spec 002) allows `scripts/` and `assets/` in a skill folder. Unlike `archobs`, these scripts are not an installable package: they need no `pip`/`npm` install beyond `typescript` from the analyzed repo, and they are the skill's own procedure. The lenses resolve playbook references relative to the skill's parent folder, so keeping the skill under `skills/` lets them link and check the cited reference files.

The skill is project-agnostic: project knowledge lives in each analyzed repo's `.journey-atlas/config.json` and `review.json`, never in the skill.

## Kill criteria / reversal trigger

- If the scripts grow dependencies that need an install step or their own test suite in CI, move them to `tools/journey-atlas/` following decision 015.
- If lens references to other skills break repeatedly when skills change, add a consistency check that runs `lenses.mjs` reference validation.

## Measurement + review ritual

- **Leading indicators (early)**: `lenses.mjs` warns "references not found in the playbook" (reference drift); share of lens candidates promoted vs dismissed on new repos.
- **Lagging outcomes**: findings from atlases routed to and fixed through the cited skills.
- **Instrumentation source**: lens output and `findings.json` of analyzed repos.
- **Owner + cadence + action trigger**: playbook maintainers; review when a skill reference file is renamed or after three new repos.

## Consequences

- Positive: an end-to-end journey graph and read-out in the Define stage; findings carry the playbook skill and references that fix them.
- Trade-offs: the largest skill folder in the repo (JavaScript, a Python analyzer and HTML assets); `overhead` is `significant` in the manifest.
- Compatibility: additive. `archobs` gains a "NOT for … (use journey-atlas)" clause and a manifest `related` entry; no renames.

## Review date

2027-04-17
