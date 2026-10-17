# Skill lenses: reading the graph through the playbook

`scripts/lenses.mjs` turns guidance from the enterprise-software-playbook skills (architecture, resilience, observability, security, platform, design) into checks over `graph.json` and `derived.json`. Each check is a **lens**: one question a skill asks, in that skill's words, plus the references that answer it. A lens produces **candidates**, never findings. You verify each candidate in the code, then either promote it to a finding or dismiss it with a reason.

Lenses find what the atlas tabs don't put in front of you. On archobs, the `shared-writer` lens found that `graph_edges` has two writers with different columns, so `build-graph` after `report` breaks `show edges`. Nothing in the coverage tabs pointed at it.

## Contents
- [Running](#running)
- [The lenses](#the-lenses)
- [Reviewing candidates](#reviewing-candidates)
- [Promoting to findings](#promoting-to-findings)
- [Adding a lens](#adding-a-lens)

## Running

```bash
node <skill>/scripts/lenses.mjs --dir <repo>/.journey-atlas [--playbook <skills dir>]
```

`run.sh` runs it after derive. It writes `lenses.json` and prints open candidates grouped by skill. It also prints the lenses that ran clean: "checked, nothing found" belongs in the write-up too.

**Finding the playbook.** It checks `--playbook`, then config `playbook`, then `JOURNEY_ATLAS_PLAYBOOK`, then the skills installed next to this one (`~/.claude/skills/<name>`, where the playbook installs its skills). Without a playbook, lenses still run; references are listed but not linked or checked. With one, every reference path is checked to exist, and missing ones are warned about. That catches drift when the playbook renames a file.

## The lenses

| Skill | Lens | Fires when | Cites |
|---|---|---|---|
| architecture | `non-atomic-action` (replaces `dual-write`, `multi-step-side-effects`) | journeys that change local tables and a state-changing system, or 2+ state-changing systems, with no outbox table; one candidate per set of systems. Best-effort legs don't count | transactional-outbox, polling-publisher, saga |
| architecture | `shared-writer` | a table/artifact is written from 2+ components (writers through unreached code are marked); anchors one writer per component | aggregate, shared-database |
| architecture | `implicit-data-contract` | one writer, read directly by 2+ other components | shared-database, `spec` |
| architecture | `no-single-adapter` (replaces `direct-integration`, `domain-calls-infrastructure`) | one candidate per external system called from 2+ components or 3+ files, or from domain-layer files that also write tables or call another system; notes uneven timeouts | anti-corruption-layer, hexagonal (DDD section), design structural patterns |
| architecture | `fan-out-wait` | a journey waits on 3+ non-core systems during the request | api-composition, resilience checklists |
| architecture | `event-without-handler` | an emitted event has no handler in the repo | domain-event |
| architecture | `lossy-event-transport` | an emitter on a cross-instance transport (`pubsub`, `pg-notify`, …) has handlers; ranked by downstream writes, with any scheduled job that reaches the same work listed as a possible backstop | messaging, transactional-outbox, idempotent-consumer |
| architecture | `no-health-check` | HTTP routes exist but no health/readiness route | health-check-api |
| resilience | `unbounded-wait` (replaces `inconsistent-boundary-controls`) | sync call sites with no timeout, per boundary (`via`, else system; exempt kinds excluded). Tagged **mixed** (fix skill: platform, one wrapper) when other sites of the same boundary in 2+ files set a timeout | resilience checklists, decision-tree, platform boundary-wrappers |
| resilience | `retry-without-idempotency` | retry evidence, no idempotency, state-changing (not best-effort) system | resilience checklists, decision-tree |
| resilience | `persisted-silent-failure` | an error from a non-best-effort system is swallowed within 2 calls of the call, and a caller within 2 hops persists results | resilience + observability checklists |
| resilience | `repeat-unsafe-write` (replaces `non-idempotent-value-write`, `consumer-without-idempotency`) | no idempotency signal in reach and: a user journey (WS, HTTP POST/PUT/PATCH) increments a value field (`value-increment`, counters like `version` excluded) or creates rows in a value table (`valueTables`); or a consumer, job or event handler writes anything. Tagged with the trigger; value increments rank first | resilience checklists, idempotent-consumer |
| resilience | `destructive-error-handling` | a `clears-data-in-catch` signal on a known table: an error path deletes rows or blanks every field it writes; unconditional first | resilience checklists, security § secrets |
| resilience | `hot-dependency-without-breaker` | ≥5 (or ≥20%) of user journeys wait on a system with no breaker | circuit-breaker |
| observability | `silent-failure-near-effects` | an error is swallowed with no log within 4 calls of a state-changing system or a write, and no earlier lens (persisted, destructive) raised the site | observability checklists, exception-tracking |
| observability | `churn-with-quiet-failures` (inventory) | a file in `hotspots.json` with commits ≥ max(10, p75) and ≥5 error-swallowing sites | observability checklists, exception-tracking |
| observability | `no-edge-error-handler` | journeys that can end in a generic error have no error-handling middleware | observability checklists, exception-tracking |
| observability | `no-boundary-telemetry` | journeys with no tracing/metrics middleware that reach no telemetry system | observability checklists, application-metrics, distributed-tracing |
| security | `shell-invocation` | a `shell-invocation` signal (Python analyzer: `shell=True`, `os.system`, `os.popen`; TS doesn't emit it yet) | security checklists § injection |
| security | `unvalidated-writes` | HTTP routes that write with no validation in the pipeline or the handler | security checklists § input validation, typescript guidelines |
| security | `shared-secret-purpose` | a secret env key (`envReads`) feeds crypto functions for 2+ different things: the noun after `encrypt`/`decrypt`/`hash`/…, or after `sign`/`verify`/`issue` when it names a token. API credentials don't qualify | security § secrets, externalized-configuration |
| design | `upward-or-cyclic-dependency` (inventory) | upward or cyclic component edges, listing the function pairs and flagging cycles caused only by unreached code | design guardrails, structural patterns |
| design | `unused-seam` (inventory, **experimental**) | functions with no callers, not entries or dispatch targets. Skipped unless `--experimental` or config `experimentalLenses`: the TS analyzer doesn't resolve calls through exported service instances yet, so most candidates are live code | design guardrails |

**Best-effort systems.** Email, SMS, push and chat (config `bestEffortKinds`) are side effects for recovery purposes, but a lost or repeated message is tolerable by design. So `non-atomic-action`, `retry-without-idempotency`, `persisted-silent-failure` and `silent-failure-near-effects` ignore them. Override per system with `review.json` → `systems.<name>.bestEffort`.

**Merged lenses keep old verdicts.** A merged lens looks up a candidate's verdict under its own id, then under its `aliases` (the ids it had in the lenses it replaced), then lens-wide `<lens>:*` and `<old lens>:*`. When several aliases have verdicts, the strongest wins (finding > accepted > dismissed > deferred), and `verdictFrom` in `lenses.json` names the source. `load-findings.mjs` resolves a finding's old candidate ids the same way. Stale verdicts are only those matching neither an id nor an alias.

**One site, one review.** Each candidate in `lenses.json` lists `alsoRaisedBy`: candidates in other lenses anchored on the same function (first 3 anchors). For open candidates, the printout shows those with their verdicts, so a site judged once doesn't have to be re-derived.

Open-route, SSRF and in-transaction checks stay in derive's review queue. Missing timeouts and retries without idempotency are reviewed only here (`unbounded-wait`, `retry-without-idempotency`), not in the queue.

**Graph inputs that improve lenses.** `externalCalls[].via` (`subprocess`, `http`, `file`, …) lets `unbounded-wait` group different systems reached the same way. The Python analyzer sets it; the TS analyzer doesn't yet, so TS groups by system. A `shell-invocation` signal comes from the Python analyzer (`shell=True`, `os.system`, `os.popen`). `value-increment`, `write-in-catch`/`clears-data-in-catch` and `envReads` come from the TS analyzer only; on Python repos those three lenses run clean by construction, so say so in the write-up. `lossy-event-transport` depends on `events[].transport`: an emitter built by a factory (`createEventEmitter(…)`) is `in-process` unless `events.transports` in config says otherwise. Check the transport split after analysis.

**What to expect from the newer lenses.** `destructive-error-handling` and `shared-secret-purpose` tend to be high-precision: a handful of candidates, often half real. `repeat-unsafe-write` is noisier: many writes are guarded by a row lock followed by a count or status check inside the transaction, which the graph can't see, so read the transaction before promoting. `lossy-event-transport` rarely yields a finding directly; its value is an explicit answer per emitter to "what re-drives this when a publish is lost?" (a sweep job, a revision check, a cache TTL, or nothing).

## Reviewing candidates

Each candidate prints its evidence and a `verify` question. Open the code, answer the question, and record a verdict in `review.json` under `lenses`, keyed by candidate id:

```jsonc
"lenses": {
  "shared-writer:graph_edges": { "verdict": "finding F8", "note": "graph.py:112 fused edges vs pipeline.py:378 annotated edges" },
  "hot-dependency-without-breaker:Git CLI": { "verdict": "dismissed", "note": "Local process; timeouts are the right control" },
  "no-boundary-telemetry:journeys": { "verdict": "accepted", "note": "CLI; revisit if it runs unattended in CI" }
}
```

Verdicts: `finding <id>` (promoted), `dismissed` (false positive or not applicable; say why), `accepted` (real, consciously not fixed; say when to revisit), `deferred` (not reviewed yet; stays visible as deferred, not as reviewed).

**Volume.** A small repo yields tens of candidates; a large one, hundreds (a large service: several hundred). Candidates are ranked within each lens: shared writers by writer count, then money tables; cycles before plain upward calls, by call count; persisted failures by how many callers save. Only the top 10 per lens are printed (`--show N` for more). Inventory-tier lenses (`upward-or-cyclic-dependency`, `churn-with-quiet-failures`, and `unused-seam` when run): print 3, sample them, then record one lens-wide verdict. For review-tier lenses in a large repo, verify the top 3–5 of each, starting with lenses that touch money or customer journeys. Then record a lens-wide verdict for the rest:

```jsonc
"unused-seam:*": { "verdict": "deferred", "note": "sampled 3 of 189 (all dead); bulk cleanup is a separate task" },
"upward-or-cyclic-dependency:*": { "verdict": "accepted", "note": "top 3 reviewed: api↔services/orders is the known WebSocket dispatcher; others follow" }
```

A per-candidate verdict always wins over `<lens>:*`. Say in the write-up which lenses were sampled rather than fully reviewed. Rerun `lenses.mjs`: reviewed candidates drop out of the open list. Verdicts for candidates that no longer appear are listed as stale.

How to judge the common ones:
- **Lens thresholds are generic.** A breaker for a local CLI, or an outbox for a rebuildable cache, is noise. Dismiss with the reason. The dismissals are part of the record ("considered, not applicable").
- **Several candidates often share one cause.** On archobs, 11 candidates from 4 lenses were all F4 (artifact names scattered, store bypassed). Promote them all to the same finding. The count shows how far the cause reaches.
- **Cycles "only via unreached code"** mean dead code is closing the cycle. Deleting it is the fix.
- **A lens candidate can be a new finding or extend an existing one.** Check the code before deciding; the graph_edges candidate looked like F4 until reading `display.py` showed a reader guard for a real failure.

## Promoting to findings

In `findings.json`, give each finding:
- `skill`: the playbook skill whose guidance fixes it.
- `lenses`: the candidate ids it came from. The loader links them and inherits their references.
- Optional `refs`: extra reference paths (`resilience/references/checklists.md#idempotency-checklist`) for findings that didn't come from a lens.

`load-findings.mjs` then creates `Skill`, `Reference`, `Lens` and `LensCandidate` nodes and prints two more tables: findings and reach **by playbook skill** (which skill to apply first, and what to read), and **lens coverage** (each lens: clean, promoted to which findings, or dismissed and why). Schema: `findings.md#graph-schema`.

## Adding a lens

Add an entry to `LENSES` in `scripts/lenses.mjs`: `id`, `skill`, `refs` (paths under the playbook's skills dir, optional `#anchor`), `question` (quote the skill), and `run()` returning candidates `{ key, title, evidence, anchors, verify }`. Use only `graph.json`/`derived.json`/`atlas-data` so it works for every stack. Keep keys stable (system name, table, file, journey), because verdicts are keyed on them. Write `verify` as the question you would ask while reading the code. Before keeping a lens, run it on a real repo and check that its candidates survive review at a useful rate.
