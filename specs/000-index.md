# Specs Index

This folder is the stable “source of truth” for how **enterprise-software-playbook** is organized and evolved.

Use it to prevent taxonomy drift and to make multi-agent iteration converge.

## How To Use These Specs

- Before adding/renaming a skill, changing terminology, or changing the default workflow, update/add a spec (and usually a decision record).
- Keep specs aligned with `README.md` and `PROMPTS.md`.

## Documents

- [`specs/001-skill-library.md`](001-skill-library.md): Charter for what this repo is for (goals, non-goals, constitution, acceptance).
- [`specs/002-skill-contract.md`](002-skill-contract.md): What a “skill” is in this repo (folder format, metadata, compatibility, validation/packaging).
- [`specs/003-taxonomy-and-workflow.md`](003-taxonomy-and-workflow.md): The workflow-stage taxonomy (Define/Standardize/Harden/Verify/Mechanics) and how it maps to skills.
- [`specs/004-change-process.md`](004-change-process.md): How to evolve this repo without breaking prompting compatibility or bloating context.
- [`specs/005-application-integration.md`](005-application-integration.md): How to integrate this library into a target app repo so agents auto-apply the workflow.
- [`specs/006-intelligence-tool.md`](006-intelligence-tool.md): Spec for the intelligence tool (`tools/intelligence/`) — lightweight SQLite-backed collector and query engine for tech/AI/AWS signals.
- [`specs/007-intelligence-forecast-module.md`](007-intelligence-forecast-module.md): Spec for the forecast module (`tools/intelligence/src/queries/forecast.ts`) — lifecycle positioning, chain detection with statistical rigor, transitive chains, scenario projection, and multiscale convergence.
- [`specs/skills-manifest.json`](skills-manifest.json): Machine-readable stage/tag index for retrieval and routing.
- [`specs/tasks.md`](tasks.md): Backlog of work with acceptance criteria.
- [`specs/quickstart.md`](quickstart.md): Copy/paste commands to validate/package skills locally.
- [`specs/009-archobs-agent-ergonomics.md`](009-archobs-agent-ergonomics.md): CLI ergonomics for agent workflows — cluster file inspection, full file-to-cluster JSON, auto-generated labels.
- [`specs/010-archobs-velocity-edges-suggestions.md`](010-archobs-velocity-edges-suggestions.md): Velocity queries, boundary edge inspection, and suggestion improvements for archobs.
- [`specs/011-archobs-trajectory-feedback.md`](011-archobs-trajectory-feedback.md): Feedback-driven improvements — velocity compare, drift trend, monolith labels, trajectory fast path.
- [`specs/012-skill-consolidation-and-cross-domain-integration.md`](012-skill-consolidation-and-cross-domain-integration.md): Merge trajectory→forecast and brief→intel; add cross-domain integration (archobs × forecast) to architecture, plan, design, and spec skills.
- [`specs/decisions/`](decisions/): ADR-style decision records (see [`specs/decisions/000-template.md`](decisions/000-template.md)):
  - [`001`](decisions/001-workflow-stage-taxonomy.md): Workflow-stage taxonomy
  - [`002`](decisions/002-code-vs-system-pattern-terms.md): Code vs system pattern terms
  - [`003`](decisions/003-repo-name-enterprise-software-playbook.md): Repo name → enterprise-software-playbook
  - [`004`](decisions/004-triage-boundary-wrappers-decision-tree.md): Triage boundary wrappers / decision tree
  - [`005`](decisions/005-add-security-hardening-skill.md): Add security hardening skill
  - [`006`](decisions/006-review-protocol-for-code-reviews.md): Review protocol for code reviews
  - [`009`](decisions/009-v2-skill-names-and-navigation.md): V2 skill names and navigation
  - [`010`](decisions/010-move-skills-under-skills-folder.md): Move skills under skills/ folder
  - [`011`](decisions/011-explicit-system-model-and-feedback-discipline.md): Explicit system model and feedback discipline
  - [`012`](decisions/012-build-guardrails-for-validation-and-packaging.md): Build guardrails for validation and packaging
  - [`013`](decisions/013-metadata-index-and-scaffolding.md): Metadata index and scaffolding
  - [`014`](decisions/014-structured-thinking-probes-for-core-skills.md): Structured-thinking probes for core skills
  - [`015`](decisions/015-vendor-archobs-tool.md): Vendor archobs tool
- [`specs/templates/`](templates/README.md): Copy/paste templates for app-repo integration, CI quality gates, and service spec bundles.
