---
name: archobs
description: "Run architecture observability analysis on a git repository to measure coupling, boundary health, risk hotspots, and temporal drift. Use when you need empirical data about code structure before making architecture or refactoring decisions, or to validate that changes improved boundary discipline. NOT for choosing architecture patterns (use architecture); NOT for choosing code patterns (use design); NOT for adversarial code review (use review)."
metadata: {"stage":"Define","tags":["architecture-observability","coupling","boundary-health","risk-hotspots","refactoring","graph-analysis","clustering","drift","code-structure"],"aliases":["archobs","architecture-analysis","coupling-analysis","boundary-analysis","code-health"]}
---

# Archobs (Architecture Observability)

## Overview

Measure the actual coupling structure of a codebase using three signals: git co-change history, import/dependency edges, and semantic similarity. These signals are fused into a weighted graph, clustered into logical subsystems, and scored for boundary health, risk, and temporal stability.

Use this skill to ground architecture and refactoring decisions in empirical data rather than intuition. The output feeds directly into `architecture`, `design`, `plan`, and `review` as evidence.

Success looks like: numbered risk hotspots, measured boundary leakage, and prioritized suggestions with concrete scope.

## Chooser (Analysis Mode)

- **Full report** (default): Run the complete pipeline and generate an HTML report with suggestions. Use for initial analysis or periodic health checks.
- **Targeted stage**: Run a single pipeline stage (inventory, git, deps, embed, build-graph, cluster) when you only need one artifact updated.
- **Suggestion loop**: Run analysis, apply one suggestion, re-analyze, repeat until convergence. Use for automated refactoring passes.
- **Regression check**: Compare current metrics against a previous run. Use in `finish` to verify architecture health did not degrade.

## Workflow

1. **Check prerequisites**:
   - Install codanna: `brew install codanna` (macOS) or `curl -fsSL --proto '=https' --tlsv1.2 https://install.codanna.sh | sh` (Linux)
   - Install `archobs` from the bundled tool: `pip install -e 'tools/archobs[full]'`
   - Verify the target repo has git history (`git log` must succeed)

2. **Initialize workspace** (first run only):
   ```bash
   archobs init --repo <path> --out .archobs
   ```
   Skip if running `report` directly — it initializes the workspace automatically. Only run `init` separately if you need to edit `config.json` before the first analysis.

   Then ensure archobs-related paths are in the project's `.gitignore` — these are generated artifacts, caches, and bundled assets that should not be committed:
   ```bash
   for entry in .archobs/ .codanna/ .codannaignore .fastembed_cache lib/; do
     grep -qxF "$entry" .gitignore 2>/dev/null || echo "$entry" >> .gitignore
   done
   ```

3. **Run full analysis (blocking — wait for completion)**:
   ```bash
   archobs report --repo <path> --out .archobs --suggestions-provider rules
   ```
   Use `--suggestions-provider rules` (the default) when running inside a skill — the rule-based engine is fast, deterministic, and produces structured suggestions that the current session can interpret directly.

   **Do not proceed to step 4 until the report command has finished.** Steps 4–6 depend on the artifacts produced by this command. If the command is run in the background, wait for it to complete before continuing.

4. **Read results** — use `archobs show` to extract metrics (no ad-hoc Python or Parquet libraries needed).

   All `show` subcommands read from Parquet artifacts independently — **run them in parallel** when calling from an agent. This avoids sequential round-trips and is 5-6x faster.

   ```bash
   # All metrics in one shot (preferred — includes velocity and top-cluster edges):
   archobs show all --top 0 --format json

   # Or query individual sections (run these in parallel):
   archobs show risks --top 10 --format json
   archobs show clusters --sort leakage --format json
   archobs show drift --format json
   archobs show summary --format json
   archobs show files --format json            # complete file-to-cluster mapping
   archobs show cluster-files <id> --format json  # files in a specific cluster

   # Development velocity and cluster relationships:
   archobs show velocity --window 30 --format json            # per-cluster commit activity
   archobs show velocity --window 30 --compare --format json  # with acceleration vs prior window
   archobs show velocity --window 30 --compare --include-added-paths --format json  # with recently added file paths
   archobs show edges <cluster_id> --format json              # cross-cluster edge relationships
   ```
   Use `--format table` (default) for human-readable output, `--format json` for structured agent consumption, or `--format csv` for piping.

   To discover column names for any artifact: `archobs schema file_metrics`

5. **Interpret key metrics** (see [`references/interpreting-metrics.md`](references/interpreting-metrics.md)):

   **File-level risk** (`archobs show risks`):
   | Signal | Threshold | Meaning |
   |--------|-----------|---------|
   | `risk` | > 0.5 | High combined risk — prioritize for refactoring |
   | `xnbr` | > 0.35 | Cross-boundary neighbor ratio — file bridges multiple concerns |
   | `hubness` | > 0.45 | High fan-in — changes here have wide blast radius |
   | `volatility` | relative | High churn rate compared to peers |

   Filter directly: `archobs show risks --min-risk 0.5 --format json` or `--min-xnbr 0.35` or `--min-hubness 0.45`.

   **Cluster-level health** (`archobs show clusters`):
   | Signal | Threshold | Meaning |
   |--------|-----------|---------|
   | `leakage` | > 0.20 | Boundary is porous — responsibilities bleed across |
   | `cohesion` | < 0.30 | Weak internal connectivity — cluster may be artificial |
   | `conductance` | relative | Cross-boundary edge fraction (lower is healthier) |

   **Drift** (`archobs show drift`):
   | Signal | Threshold | Meaning |
   |--------|-----------|---------|
   | `ari_prev` | < 0.50 | Architecture is unstable — subsystem map is reshuffling |
   | `modularity` | declining | Boundaries are weakening over time |

   **Drift trend interpretation** — the trend across windows matters more than any single value:
   | Pattern | Interpretation |
   |---------|---------------|
   | ARI rising toward 1.0 | Stabilizing — architecture is settling after upheaval |
   | ARI falling across windows | Degrading — boundaries are being broken |
   | ARI oscillating | Volatile — team is experimenting with structure |
   | Modularity declining while ARI rises | New cross-cutting features are landing in a stable structure |

   When reporting drift, always examine the ARI trend (last 2+ windows) rather than applying a single threshold. A codebase with ARI 1.0 → 0.38 → 0.58 → 0.77 is stabilizing, not unstable.

6. **Route findings to the right skill**:
   - High leakage between clusters: `architecture` (boundary redesign) or `patterns-structural` (Facade)
   - High-risk file with mixed concerns: `design` (pattern selection) then `patterns-*` (implementation)
   - Multiple high-risk areas needing sequencing: `plan` (prioritize refactoring order)
   - Development momentum and feature prediction: `trajectory` (which clusters are active, what features are likely next). When running trajectory in the same session, archobs artifacts are already available — the trajectory skill can read directly from `.archobs/` without re-extraction.
     **Quick trajectory in the same session** (no skill switch needed): run `archobs show velocity --window 30 --compare --include-added-paths --format json`, check `git branch -r --sort=-committerdate | head -20`, and apply feature adjacency heuristics from the trajectory skill. For full trajectory analysis with commit message themes and detailed interpretation, invoke the `trajectory` skill.
   - Pre-merge health check: `finish` (verify metrics did not regress)
   - Thorough assessment of structural findings: `review` (type: architecture)

7. **Read suggestions** (if generated):
   ```bash
   archobs prompts --out .archobs
   ```
   Each suggestion includes: priority, title, why (evidence), change (action), scope (affected files).
   Suggestions are also included in `archobs show all --format json` under the `"suggestions"` key.

## Clarifying Questions

- What is the target repository path?
- Is this a first analysis or a follow-up? (Previous `.archobs/` artifacts will be overwritten.)
- Should suggestions use an LLM provider (claude/codex) or rule-based only?
- Is there a specific area of concern, or should we analyze the full codebase?
- What languages are in the repo? (Supports Python, TypeScript, JavaScript, Java.)

## Guardrails

- Do not run on repos with fewer than ~10 tracked source files — the graph needs sufficient signal.
- Do not treat cluster assignments as ground truth — they are statistical groupings that approximate logical subsystems.
- Do not skip interpreting metrics before routing to other skills — raw numbers without context lead to wrong decisions.
- Do not use the suggestion loop without human review of each applied change.
- Do not commit archobs artifacts to the repository — `.archobs/`, `.codanna/`, `.codannaignore`, `.fastembed_cache`, and `lib/` must all be in `.gitignore`.
- If `leidenalg` is not installed, the tool falls back to greedy modularity (lower-quality clustering) — note this in output.

## Map To Existing Skills

- Boundary redesign from leakage data: [`architecture`](../architecture/SKILL.md)
- In-process pattern selection from coupling data: [`design`](../design/SKILL.md)
- Refactoring prioritization from risk scores: [`plan`](../plan/SKILL.md)
- Development trajectory and feature prediction from cluster activity: [`trajectory`](../trajectory/SKILL.md)
- Architecture health regression gate: [`finish`](../finish/SKILL.md)
- Architecture-type adversarial review: [`review`](../review/SKILL.md)
- Facade/Adapter for porous boundaries: [`patterns-structural`](../patterns-structural/SKILL.md)
- Mediator for high-hubness coordination files: [`patterns-behavioral`](../patterns-behavioral/SKILL.md)

## References

- Interpreting archobs metrics: [`references/interpreting-metrics.md`](references/interpreting-metrics.md)
- Running archobs locally: [`references/running-archobs.md`](references/running-archobs.md)
- Tool source and standalone docs: [`tools/archobs/README.md`](../../tools/archobs/README.md)

## Output Template

When reporting analysis results:

- **Summary**: cluster count, edge count, embedding provider, modularity score.
- **Top risk files** (3-5): path, risk score, primary signal (xnbr/hubness/volatility), recommended action.
- **Leakiest clusters** (1-3): cluster ID, leakage %, strongest outward pull, boundary recommendation.
- **Drift assessment**: stable / degrading / improving (with ARI values).
- **Suggestions** (if generated): priority-ordered list with scope and evidence.
- **Next skill**: which skill to invoke based on the dominant finding pattern.
