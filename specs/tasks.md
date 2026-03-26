# Tasks (Skill Library Backlog)

This is the repo’s backlog of work to improve agent effectiveness.

Keep tasks small, orderable, and testable. Prefer “acceptance” that is observable (commands, file outputs, prompt success criteria).

## T001: Add `specs/` system spec bundle

- **Status**: Done (2026-01-31)
- **Acceptance**:
  - `specs/000-index.md` exists and links to the key specs.
  - Specs define taxonomy, skill contract, and change process.
  - `README.md` and `PROMPTS.md` remain aligned with the taxonomy spec.

## T002: Add a “decision record” template to `spec`

- **Status**: Done (2026-01-31)
- **Acceptance**:
  - `spec` references decision records as a first-class artifact (system-level).
  - A reusable ADR template exists and is referenced from the skill.

## T006: Add conversational auto-skill routing (adoption path)

- **Status**: Done (2026-01-31)
- **Acceptance**:
  - Router skill exists (`workflow`).
  - `PROMPTS.md` includes a conversational bootstrap prompt.
  - An app-repo `AGENTS.md` template exists under `specs/templates/`.
  - `specs/005-application-integration.md` documents adoption.

## T003: Add an “observability triage” skill (debug loop)

- **Status**: Done (2026-02-01)
- **Acceptance**:
  - New skill focuses on production/local triage workflows (log → trace → metrics), not instrumentation.
  - Includes copy/paste commands/checklists for common enterprise web app stacks (HTTP + gRPC + async consumers).

## T004: Add a “boundary wrapper” shared-primitive guide

- **Status**: Done (2026-02-01)
- **Acceptance**:
  - Either extend `platform` or create a dedicated skill for “golden path” boundary wrappers (HTTP/gRPC/job/consumer).
  - Includes required contracts: error envelope, retry/idempotency policy, telemetry field contract.

## T005: Add a system-pattern decision tree

- **Status**: Done (2026-02-01)
- **Acceptance**:
  - Extend `architecture` with a compact decision tree (pressure → candidate patterns → risks).
  - Includes anti-pattern guardrails (e.g., saga misuse, event sourcing misuse, retries without idempotency).

## T007: Add a security hardening skill

- **Status**: Done (2026-02-01)
- **Acceptance**:
  - New skill exists: `security`.
  - Taxonomy and default sequence include it (`specs/003-taxonomy-and-workflow.md`).
  - `README.md`, `PROMPTS.md`, and `workflow` mention it.

## T008: Add onboarding docs (glossary + walkthrough)

- **Status**: Done (2026-02-01)
- **Acceptance**:
  - `GLOSSARY.md` exists and is linked from `README.md`.
  - `TUTORIAL.md` exists and is linked from `README.md`.

## T009: Add a lightweight feedback mechanism

- **Status**: Done (2026-02-01)
- **Acceptance**:
  - `.github/ISSUE_TEMPLATE/` exists with at least a bug-report and feature-request template.
  - `README.md` and/or `CONTRIBUTING.md` points users at Issues for feedback.

## T010: Add optional external references (progressive disclosure)

- **Status**: Done (2026-02-01)
- **Acceptance**:
  - Select `*/references/*.md` files include a short “Optional external reading” section.
  - `SKILL.md` files remain concise; depth stays in `references/`.

## T011: Make system-model and feedback-loop artifacts explicit

- **Status**: Done (2026-02-06)
- **Acceptance**:
  - Non-trivial workflows require objective function + compact system sketch.
  - Decision records/templates include options, trade-offs, kill criteria, and review ritual.
  - Skills/templates/prompts include measurement ladder and blast-radius/dynamics checks.
  - Finish reporting supports executive + engineer packet outputs.

## T012: Add build guardrails for skill validation and docs drift

- **Status**: Done (2026-02-06)
- **Acceptance**:
  - Packaging command in specs/quickstart is executable (`package_skill.py` exists).
  - Skill validation enforces folder-name/frontmatter-name consistency.
  - CI runs skill validation + repo consistency checks on PRs.

## T013: Add machine-readable skill metadata/index and execution templates

- **Status**: Done (2026-02-08)
- **Acceptance**:
  - Every `skills/*/SKILL.md` includes machine-readable metadata (`stage`, `tags`).
  - `specs/skills-manifest.json` exists and maps stage/tag/path for every skill.
  - Repo consistency checks fail on manifest/frontmatter drift.
  - Concrete copy-first templates exist for CI quality gates and service spec bundles.

## T014: Add intelligence, forecast, and archobs tools and skills

- **Status**: Done (2026-03-16)
- **Acceptance**:
  - `tools/intelligence/` and `tools/archobs/` are vendored and functional.
  - Skills exist: `intel`, `forecast`, `archobs` (with internal + external engines for forecast).
  - Specs 006–007, 009–012 document tool and skill design.
  - Manifest includes all new skills with correct stage/tag/related mappings.

## T015: Add classifier training data workflow and team/fitness analysis

- **Status**: Done (2026-03-26)
- **Acceptance**:
  - Specs 013–019 document topic strategy, confidence gates, collection quality, decision journal, team analysis, fitness check, and classifier training.
  - `archobs show team`, `archobs check`, and classifier training CLI commands are implemented.
  - `forecast` skill includes confidence gates and temporal artifact guardrails.

## T016: Consolidate trajectory into forecast and brief into intel

- **Status**: Done (2026-03-16)
- **Acceptance**:
  - `trajectory` skill merged into `forecast` (internal engine).
  - `brief` skill merged into `intel` (audience-aware output).
  - Spec 012 documents the consolidation rationale and cross-domain integration.
  - Cross-references in architecture, plan, design, and spec skills updated.

## T017: Add SHOULD-level contract sections to remaining skills

- **Status**: Pending
- **Acceptance**:
  - Missing Chooser sections added to `workflow`, `plan`, `typescript`.
  - Missing Clarifying Questions added to `workflow`, `plan`, `typescript`, `patterns-creational`, `patterns-structural`, `patterns-behavioral`.
  - Missing Guardrails added to `typescript`, `patterns-creational`, `patterns-structural`, `patterns-behavioral`.
  - Monolith boundary edge case (design vs architecture) documented.
