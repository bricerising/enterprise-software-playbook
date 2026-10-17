---
name: journey-atlas
description: "Map a codebase's user journeys end to end — every entry point (HTTP routes, WebSocket actions, jobs, queue consumers) through middleware, business logic, tables and events to the external systems it depends on — load the graph into Neo4j, review it through the playbook skills' lenses, and build an HTML architecture atlas (service blueprints, layer map, dependency matrix, request-pipeline coverage, resilience posture, change risk, journey explorer, verified findings). Use when you need to understand how a repo hangs together, trace call paths to third parties, audit auth/middleware coverage across routes, assess blast radius, or produce an architecture read-out for architects or executives. NOT for coupling, co-change and boundary-health metrics from git history (use archobs); NOT for choosing a target architecture (use architecture); NOT for reviewing a diff or PR (use review)."
metadata: {"stage":"Define","tags":["user-journeys","journey-mapping","call-graph","code-knowledge-graph","neo4j","architecture-readout","service-blueprint","middleware-coverage","auth-coverage","blast-radius","external-dependencies","resilience-posture"],"aliases":["journey-atlas","atlas","architecture-atlas","journey-map","system-map","code-graph"]}
---

# Journey Atlas

## Overview

Turn a git repo into (1) a graph of its user journeys and what each one ultimately touches, (2) a Neo4j database you can query, and (3) a self-contained HTML atlas an architect can read in ten minutes.

The scripts do the mechanical work. Your job is the part they can't do: understand the repo well enough to configure them, iterate until coverage is honest, **check the findings against the source** before anyone sees them, and say what matters.

Everything lives in `<repo>/.journey-atlas/` (excluded from git via `.git/info/exclude`, never `.gitignore`):

| File | Who writes it | What it is |
|---|---|---|
| `config.json` | you | how to read this repo (entries, externals, actors, components) |
| `graph.json` | analyzer | raw facts: functions, calls, journeys, middleware, externals, signals |
| `review.json` | you | verdicts you confirmed by reading code (recovery, open routes, blueprint tasks) |
| `lenses.json` | `lenses.mjs` | candidates from the playbook-skill lenses, with your verdicts applied |
| `findings.json` | you | verified findings with their probes, anchored to graph ids (step 6) |
| `derived.json`, `atlas-data/` | `derive.mjs` | reachability and every atlas dataset |
| `review-queue.json` | `derive.mjs` | what still needs your judgment |
| `neo4j.env` | `neo4j-up.sh` | connection (chmod 600) |
| `atlas.html` | `build-atlas.mjs` | the read-out |

Scripts are in `scripts/` next to this file; call them by absolute path. `scripts/run.sh <repo>` runs the whole pipeline once you have a config. Requirements: Node.js 18+ and the repo's own dependencies installed (TypeScript/JavaScript), or Python 3.10+ (Python repos); Docker only if no Neo4j is available (optional).

Success looks like: journey counts that match the routers, every external system named, every "No guard" and recovery verdict backed by a note from the code, findings verified in the source and anchored to graph ids, and an atlas whose blueprints cover every actor.

## Chooser

- **Full atlas** (default): steps 1–9. First run on a repo, or an architecture read-out.
- **Refresh after code changes**: `scripts/run.sh <repo>`; review only what the queue and lenses show as new, re-check finding anchors.
- **Review-only**: `scripts/run.sh <repo> --skip-analyze` after editing `review.json`, `findings.json` or derive-level config.
- **Question-driven**: the user wants one answer ("what calls Stripe?", "which routes have no auth?"). Run steps 1–4, answer from Neo4j or `atlas-data/`, skip blueprints and findings unless asked.
- **Unsupported stack** (Go, Java/Kotlin, C#, Ruby): write a small analyzer that emits `graph.json` (`references/other-stacks.md`); everything from step 4 on is unchanged.

## Inputs / Outputs

**Inputs**: a git repo (dependencies installed for TS/JS), optionally an existing `.journey-atlas/` from a previous run and a Neo4j instance.
**Outputs**: `.journey-atlas/` with `graph.json`, `review.json`, `lenses.json`, `findings.json`, `atlas.html`; a Neo4j project graph; a write-up of 3–6 verified findings with fix order. Findings carry the playbook skill that fixes them, so they feed `architecture`, `resilience`, `security`, `observability`, `platform` and `design`; `plan` can sequence the fixes, and `archobs` adds history-based coupling data to the same areas.

## Workflow

### 1. Recon (5 minutes, no scripts yet)

Read enough to answer: what language and framework(s)? Where do requests enter (app bootstrap, router files, controllers, WebSocket server, schedulers, queue consumers)? What database and ORM? Which SDKs and HTTP clients reach the outside world? Who are the users (route prefixes like `/admin`, `/portal`, `/api/customer` usually say)? Look at `package.json`/lockfiles, the bootstrap file, the routes folder, the ORM schema, and `git log --oneline | head`.

If the repo is **Python**, use `scripts/python/analyze.py` (stdlib only; typer CLI entries, subprocess and file-store externals, type-light call resolution) and set `"analyzer": "python"` in config; extend it for FastAPI/Flask/Django/Celery entries when you meet them. For any **other** stack, read `references/other-stacks.md` now — you'll write a small analyzer that emits `graph.json`, then everything from step 4 on is identical. Either way, read the Python/CLI notes there: a CLI tool's "journeys" are its commands and its "database" is often a folder of files.

### 2. Config

Write `.journey-atlas/config.json`. Start minimal — `name`, `include`/`exclude`, and `actors` — and let the analyzer tell you what it missed. Full reference with examples: `references/config.md`. The analyzer auto-detects Express (including factory-built routers and helper functions that receive the app), NestJS decorators, Fastify, Next.js API routes, cron/BullMQ/Kafka/AMQP/Agenda consumers, Prisma/TypeORM/Mongoose models and ~80 SDKs. Config is for what is project-specific: handler registries (`entries.registries`), scheduler conventions (`entries.functions`), WebSocket per-message pipelines (`pipelines`), in-house HTTP wrappers (`externals.fileFallbacks`, `externals.clientFactories`), custom event buses (`events`).

### 3. Analyze, then iterate on coverage

```bash
node --max-old-space-size=8192 <skill>/scripts/ts/analyze.mjs --repo <repo> --config <repo>/.journey-atlas/config.json --out <repo>/.journey-atlas/graph.json
```

**Dependencies must be installed in the repo** — route, ORM and SDK detection reads types from `node_modules`, and without them most entries and systems silently disappear (the analyzer warns). If they're missing, ask before installing; prefer `npm ci --ignore-scripts` (or the pnpm/yarn equivalent) so no package scripts run, then generate ORM clients the repo relies on (`npx prisma generate`). The analyzer uses the repo's own `typescript`; if the repo has none, run `npm install` once in `<skill>/scripts/`. It prints a coverage summary. Treat that summary as a test you're trying to pass:

- **Journey counts by kind** should match your recon. Grep the router files for `.get(`/`.post(` (or decorators) and compare. A big gap means unmounted routers — usually a factory or a mount the analyzer can't follow; fix with config, or fix the analyzer if the pattern is general.
- **`unresolved_http`** lists outbound HTTP calls with no known host. Each one is an external system you'd otherwise miss: add a `fileFallbacks` rule or a host mapping.
- **`journeys_without_handler`** means an entry was found but its handler wasn't resolved.
- **Externals list**: does every SDK from recon appear? Are there junk systems (doc URLs, hosts from comments)? Real systems only.
- **Warnings**: read all of them.
- **Unreached functions** (the Python analyzer prints them; for others, compute reachability from `entries` over `calls`): each one is an entry point, an interface/Protocol stub, dead code, or a resolution gap. Grep a few callers. A gap you can name (unannotated returns, lambdas, Protocol dispatch) is a fix to the analyzer; dead code is a finding.

Two or three rounds is normal. Don't move on with a known hole — every view downstream inherits it.

> **GATE**: journey counts by kind match a grep of the routers/decorators, `unresolved_http` is empty or explained, and every SDK from recon appears as a system.

### 4. Derive

```bash
node <skill>/scripts/derive.mjs --dir <repo>/.journey-atlas
```

This computes reachability (sync vs after-response), components and layers, the dependency matrix, convergence points, hotspots, pipeline coverage, resilience posture, error experience and blueprints, and prints a **review queue**. Look at the component list in `atlas-data/components.json`: if names are too coarse (one giant `services`) or too fine, add `components` rules to config and rerun derive (seconds; no re-analysis needed).

### 5. Verify findings in the code — the step that makes the atlas trustworthy

Static signals are evidence, not proof. Before anything goes into the read-out, open the source for each item in the review queue and record a verdict in `review.json` (`references/config.md#reviewjson`):

- **systems_needing_recovery_verdict** — for each side-effecting external system, is there a job/outbox/retry path that re-drives failures? `"Scheduled job"`, `"Partial"`, `"None"`, or `sideEffecting: false` for read-only systems.
- **open_routes_unreviewed** — routes with no sign-in middleware. Read each handler: does it verify a signature/token/code itself (`Verified in handler`), is it public content (`Public content`), or is there genuinely nothing (`No guard`)? This is the highest-stakes judgment in the atlas; be precise and write the reason in `note`.
- **jobs_without_cadence** — read the schedule constant and set `every_seconds`.
- **tasks** — write blueprint tasks: real things a user does, as an ordered list of journeys. These are the most-read view, so cover the system, not just the headline: every money path, the busiest workflow of each staff actor, onboarding/setup, and any flow that crosses a finding or a new integration. Aim for at least one task per actor in your config (typically 5–9 tasks), and include the jobs a flow depends on as steps (`JOB …`). Derive's review queue lists `actors_without_blueprint` and `blueprint_unknown_journeys`. Clear both, or record a deliberate skip in `review.json` → `blueprintSkips` (`{ "<actor>": "why" }`). Look up ids in `atlas-data/journeys_index.json` before writing a step (`references/readout.md#curating-blueprints-the-most-read-view`).

Then run the **skill lenses**: `node <skill>/scripts/lenses.mjs --dir <repo>/.journey-atlas`. Each lens is one check from a playbook skill: architecture (non-atomic actions, shared writers, implicit data contracts, missing adapters, fan-out waits, lossy event transports), resilience (timeouts, including mixed controls that need one wrapper; repeat-unsafe writes; persisted or destructive error handling), observability, security and design (upward/cyclic dependencies; `unused-seam` is experimental). Missing timeouts and retries without idempotency are reviewed here, not in the review queue. Mark notification systems `bestEffort` in `review.json` (email, SMS, push and chat are by default). Each candidate cites the skill's reference files and asks one `verify` question. Read the code, then record `finding <id>`, `dismissed` or `accepted` with a note under `review.json` → `lenses`. Lenses surface what the review queue doesn't: on archobs, an artifact with two writers of different shapes. `references/lenses.md` lists the lenses, how to judge them, and how to handle hundreds of candidates in a large repo (ranked lists, inventory lenses, lens-wide verdicts).

`references/verification.md` lists the false positives seen in practice (detached promises counted as waits, nested-helper transaction effects, validators counted as auth, logo URLs counted as SSRF, config errors counted as generic 500s…). Read it before you sign off on any red cell.

Rerun derive after editing `review.json`.

> **GATE**: no "No guard", recovery or finding verdict without a note naming what you read in the code. A wrong red cell costs more trust than ten missed findings.

### 6. Structure the findings

Write each verified finding into `findings.json`, give it the playbook `skill` that fixes it and the `lenses` candidate ids it came from, and add short answers to five probes: the assumptions it breaks, its second-order effects and pre-mortem, any feedback loop, the opportunity cost, and the control that would have caught it. Anchor it to exact function/system/table ids from `graph.json`, and record how findings interact (a naive fix to one worsening another, one masking another). Then load it (step 7). The queries show what a list can't: one false assumption under several findings, functions where fixes converge, reach versus severity, fix order. Linking findings often surfaces a new one; verify it in the source like the rest. Contract, writing guidance and how to read the results: `references/findings.md`.

### 7. Neo4j

```bash
bash <skill>/scripts/neo4j-up.sh <repo>/.journey-atlas && node <skill>/scripts/load-neo4j.mjs --dir <repo>/.journey-atlas
```

`neo4j-up.sh` reuses, in order: a previous `neo4j.env`; `NEO4J_URL`/`NEO4J_USER`/`NEO4J_PASSWORD` from the environment; a `journey-atlas-neo4j` container; otherwise it starts `neo4j:5` in Docker on 7474/7687 (or 17474/17687 if taken) with a random password. It never touches other containers. If the user already runs Neo4j, ask for or export its credentials rather than starting a second one. If Docker isn't available, skip this step and say so — the atlas doesn't need Neo4j.

The load replaces only nodes with this project's `project` property, so several repos can share one database. Then load the findings, which prints the cross-finding queries:

```bash
node <skill>/scripts/load-findings.mjs --dir <repo>/.journey-atlas
```

Schema and useful Cypher: `references/graph-schema.md#neo4j` and `references/findings.md#graph-schema`.

### 8. Build the atlas

```bash
node <skill>/scripts/build-atlas.mjs --dir <repo>/.journey-atlas            # → atlas.html (open in a browser)
node <skill>/scripts/build-atlas.mjs --dir <repo>/.journey-atlas --fragment # → atlas-artifact.html (for the Artifact tool)
```

Build the atlas last: it reads `findings.json` and `lenses.json` for the Findings tab and the finding marks on blueprints and journeys. Open `atlas.html` and look at it — every tab. If you can render headlessly (e.g. Chrome `--headless=new --screenshot=… "file://…/atlas.html#structure"`), do, and read the screenshots. Empty panels, a single giant component, or an actor called "Other" for half the journeys are config problems; go back to step 2/4. `references/readout.md` describes each tab, what a healthy one looks like, and how to curate it.

If the user wants it shareable, publish `atlas-artifact.html` with the Artifact tool (it is private until they share it).

### 9. Write up what matters

Don't make the user dig. In the reply, give 3–6 findings an architect would act on, each with its evidence and the atlas tab that shows it — e.g. "8 device-management routes have no guard at any level (Request pipeline → Routes without sign-in); `account_id` comes from the query string." Lead with what moves money or exposes data. Then add what the findings graph showed: the shared false assumption, where fixes converge, the fix order from `fix-amplifies` edges, and any finding whose reach and severity disagree. Group the fixes by playbook skill (which skill to apply first, and which references to read), and say which lenses ran clean. Name emergent findings as such. Mention coverage limits honestly (what the analyzer can't see: dynamic dispatch, env-built URLs, reflection, untyped receivers). Point to `atlas.html`, the Neo4j browser URL, and offer the Artifact.

## Minimum viable execution

When time or context is short, these steps must still run:

1. Analyze and close the coverage gaps (step 3 gate).
2. Review open routes and side-effecting systems in the code (step 5): these are the verdicts people act on.
3. Verify each finding you report in the source and anchor it (steps 5–6).
4. Build the atlas and report (steps 8–9).

Nice to have under pressure: Neo4j (step 7), the full lens review (sample the top candidates and record lens-wide verdicts instead), more than one blueprint per actor.

## Output template

```markdown
## Atlas: <project> (<commit>)
- Coverage: <journeys by kind>, <N> external systems, <N> tables; known gaps: <what the analyzer can't see>
- Files: .journey-atlas/atlas.html · Neo4j <browser URL> · Artifact <offer>

## Findings (verified in the source)
1. <title> (<severity>, <reach: N journeys, actors>) — <evidence with file:line>; atlas tab: <tab>
2. …

## What the findings graph showed
- Shared assumptions / where fixes converge / reach vs severity disagreements / emergent findings
- Fix order: <F#> → <F#> (why)

## By playbook skill
- <skill>: <findings> — read <references>

## Checked and clean
- <lenses that ran clean; lenses sampled rather than fully reviewed>
```

## Re-running

After code changes: `scripts/run.sh <repo>` (analyze → derive → lenses → neo4j → findings → atlas; the analyzer comes from config `analyzer`, else Python when the repo has no `package.json`). Re-check `findings.json` anchors after code changes: the loader warns on ids that no longer exist. After only editing `review.json` or derive-level config: `scripts/run.sh <repo> --skip-analyze`. Review verdicts persist; the queue shows only what's new.

## When to extend the scripts

If a pattern is project-specific, use config. If it's a general idiom of a framework (a router style, an ORM, a queue library) that the analyzer misses, fix `scripts/ts/analyze.mjs`, `scripts/python/analyze.py` or `scripts/lib/catalog.mjs` so the next repo benefits — keep the `graph.json` contract unchanged.

## Guardrails

- Never mark a route "No guard", a system "None", or promote a finding without reading the handler or call site; write what you read in `note`.
- Keep `.journey-atlas/` out of version control with `.git/info/exclude`, never `.gitignore`; `neo4j.env` holds credentials (chmod 600).
- Ask before installing the repo's dependencies, and prefer installs that run no package scripts (`npm ci --ignore-scripts`).
- Don't start a second Neo4j when the user already runs one; reuse its credentials.
- Keep project-specific knowledge in the repo's `config.json` and `review.json`; change the scripts only for general framework idioms, keeping the `graph.json` contract.
- Anchor findings on the functions where the fix goes; anchoring on a helper every request calls inflates reach.

## Common failure modes

- **Reporting the analyzer's coverage as the system's shape.** Unmounted routers, env-built URLs or a missed event transport make whole areas vanish; the gate in step 3 exists because every view inherits the hole.
- **Promoting lens candidates without reading the code.** Lenses produce candidates; guards like a row lock plus a count check, SDK default timeouts, or a recovery job are invisible to the graph.
- **Blueprints only for the money path.** Stopping at two or three tasks leaves most actors unread; clear `actors_without_blueprint` or record a skip.
- **A wall of candidates instead of findings.** The write-up leads with 3–6 verified findings and fix order, not lens counts.
- **Silent coverage limits.** Not saying what the analyzer can't see (dynamic dispatch, reflection, untyped receivers) makes "clean" read as "safe".

## References

- `references/config.md`: config keys, `review.json` verdicts, blueprint tasks and skips, a worked example.
- `references/verification.md`: false positives seen in practice; read before signing off a red cell.
- `references/lenses.md`: the playbook lenses, how to judge and record candidates, verdict carry-over.
- `references/findings.md`: `findings.json` contract, the five probes, the findings graph and how to read it.
- `references/readout.md`: each atlas tab, what healthy looks like, curating blueprints, publishing.
- `references/graph-schema.md`: the `graph.json` contract and Neo4j schema with useful Cypher.
- `references/other-stacks.md`: writing an analyzer for Go, Java/Kotlin, C#, Ruby; Python/CLI notes.
