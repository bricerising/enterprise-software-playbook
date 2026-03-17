# Decision 015: Vendor archobs tool into playbook monorepo

**Date**: 2026-03-11
**Status**: Accepted

## Context

The playbook already includes an `archobs` skill (`skills/archobs/SKILL.md`) that describes the workflow and metric interpretation for architecture observability analysis. The implementation — a Python CLI called `archobs` — lived in a separate `architecture-observability` repository.

- **Goal**: Eliminate doc-to-implementation drift, simplify adoption for consumers who vendor the playbook, and establish a pattern for bundling tool subprojects.
- **Constraints**: The tool has heavier Python dependencies (NumPy, Pandas, PyArrow) than the playbook's existing CI. Both the tool and the playbook are Apache-2.0 licensed.
- **Anti-goals**: Converting the playbook into a monolithic Python package. Forcing all playbook consumers to install Python dependencies.
- **Boundary + time horizon**: This decision applies to tool subprojects under `tools/`. Review in 6 months to see if more tools follow this pattern.
- **Actors + incentives**: Playbook maintainers want a single source of truth; app teams vendoring the playbook want the tool included without managing a second dependency.

## Options considered

| Option | Optimizes for | Knowingly worsens | Reversibility |
| --- | --- | --- | --- |
| A: Vendor into `tools/archobs/` (monorepo) | Single repo, no submodule friction, consumers get tool for free | Repo size, CI complexity | High — can extract back to separate repo |
| B: Git submodule | Separation of concerns, independent versioning | Consumer UX (submodule init/update), doc drift risk | Medium — submodule removal is clean but disruptive |
| C: Cross-link only (no code move) | No migration work | Doc-to-code drift persists, adoption friction unchanged | N/A (no change) |

## Decision

Option A: vendor the archobs tool into `tools/archobs/` as a self-contained Python subproject with its own `pyproject.toml`, Apache-2.0 license, and tests. The playbook skill docs reference the bundled tool as the preferred install path.

Rationale:
- The playbook already recommends vendoring itself into app repos; including the tool makes that path complete.
- The tool's `pyproject.toml` keeps it installable independently — no coupling to playbook structure.
- Same license as the playbook (Apache-2.0) — no license compatibility concerns.

## Kill criteria / reversal trigger

- If more than 2 tool subprojects accumulate and CI times exceed 5 minutes, consider extracting tools into a separate repo or monorepo tooling (e.g., Turborepo, Nx).
- If the tool's release cadence diverges significantly from the playbook's, re-evaluate independent packaging.

## Measurement + review ritual

- **Leading indicators (early)**: CI pass rate for archobs-tool job; consumer feedback on install friction.
- **Lagging outcomes**: Reduction in issues about doc-to-tool version mismatch.
- **Instrumentation source**: GitHub Actions workflow logs; issue tracker.
- **Owner + cadence + action trigger**: Playbook maintainers; review at next major playbook release.

## Consequences

- Positive: single clone gives consumers everything; docs and tool evolve together; CODEOWNERS can gate tool changes.
- Trade-offs: repo is larger; CI needs a Python job for tool tests; contributors must understand the `tools/` convention.
- Compatibility: no breaking change to existing skill docs or manifest; new `tools/` directory is additive.

## Review date

2026-09-11
