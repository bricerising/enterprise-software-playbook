# Structuring findings: findings.json and the findings graph

A list of findings answers "what's wrong". Loaded into the graph next to the code, with the reasoning behind each one, it answers what a list can't: which problems share a cause, where fixes concentrate, which fix makes another finding worse, and how far each one reaches. Linking findings is also how new ones turn up. On archobs, connecting "failed queries are cached" with "the index is rebuilt every run" exposed a third finding: the cache key ignores the index, so cached results are never invalidated when the code changes. Neither finding showed that alone.

Do this after step 5 (only findings you verified in the source) and before writing up.

## Contents
- [The probes](#the-probes)
- [findings.json](#findingsjson)
- [Writing good entries](#writing-good-entries)
- [Graph schema](#graph-schema)
- [Reading the results](#reading-the-results)

## The probes

Each finding carries short answers to five decision probes (the same ones the enterprise-software-playbook uses in its `plan`/`architecture`/`finish` skills):

| # | Probe | Fields | The question |
|---|---|---|---|
| 1 | Assumptions | `assumptions[]` → shared `Assumption` nodes with `status` | What did the code's author believe that turns out false (or unverified)? |
| 2 | Second-order effects + pre-mortem | `near_term`, `long_term`, `deferred_cost_owner`, `pre_mortem` | What happens next, then later, and who pays? Write the pre-mortem as "N months on, X happened; root cause: this". |
| 3 | Feedback loops | `loop {type, delay, steps[[text, fnId\|null]]}` | Does the problem feed itself (reinforcing), correct itself (balancing), or neither (`null`)? |
| 4 | Opportunity cost | `opportunity_cost` | What does leaving it unfixed cost beyond the defect itself? |
| 5 | Learning loop | `next_control`, `control_owner` | What check would have caught it, and who owns it? |

Keep each answer to one or two sentences. If a probe doesn't apply, leave it out (`loop: null`); don't write "n/a".

## findings.json

`<repo>/.journey-atlas/findings.json`:

```jsonc
{
  "assumptions": [
    { "id": "A-visible", "text": "If something goes wrong, the operator sees it", "status": "false",   // false | unverified | true
      "evidence": "graph.py:240 turns CalledProcessError into {}" }
  ],
  "findings": [{
    "id": "F1", "title": "Failed Codanna queries are cached as 'no neighbours'", "severity": "high",   // high | medium | low
    "skill": "resilience",                    // the playbook skill whose guidance fixes it
    "lenses": ["persisted-silent-failure:src/x/graph.py#invoke@237"],   // lens candidates it came from (references/lenses.md)
    "refs": ["resilience/references/checklists.md#idempotency-checklist"], // optional extra playbook references
    "summary": "…one or two sentences with file:line…",
    "emergent": false,                        // true when you found it by linking other findings
    "assumptions": ["A-visible", "A-cache-fresh"],
    "anchors": {                              // exact ids from graph.json; the loader warns on misses
      "functions": ["src/x/graph.py#build_edges@273"], "systems": ["Codanna CLI"],
      "models": ["semantic_cache"], "components": ["graph-build"], "journeys": []
    },
    "near_term": "…", "long_term": "…", "deferred_cost_owner": "…", "pre_mortem": "…",
    "loop": { "type": "reinforcing", "delay": "until someone deletes the cache file",   // reinforcing | balancing | chain
              "steps": [["query fails", "src/x/graph.py#run@161"], ["the operator kills the run", null]] },
    "opportunity_cost": "…", "next_control": "…", "control_owner": "…"
  }],
  "interactions": [
    { "from": "F2", "to": "F1", "kind": "fix-amplifies", "how": "the obvious F2 fix would widen F1 because…" }
    // kinds: fix-amplifies (fixing `from` naively worsens `to`), compounds, masks (`from` hides `to`), shares-fix, causes
  ]
}
```

Load it with `node <skill>/scripts/load-findings.mjs --dir <repo>/.journey-atlas`. It also prints the cross-finding queries; `--query-only` reprints them without reloading. `run.sh` reloads findings automatically after `load-neo4j.mjs`, which clears the project.

## Writing good entries

- **Assumptions are shared nodes; reuse ids.** The most useful query result is one false assumption sitting under several findings. Phrase it as the belief, not the bug: "If something goes wrong, the operator sees it", not "errors are swallowed in invoke()". Write general assumptions (visibility, freshness, read-only, promptness, one-home-for-names) once and link them from every finding they explain.
- **Anchor on the functions where the fix goes**, not every function on the path. Reach is computed from these, so over-anchoring inflates it.
- **Loop steps should point at code** where a step runs in code; `null` for human or process steps ("the operator kills the run", "new code copies the nearby pattern"). Only call a loop reinforcing if you can name the step where it feeds back. If you can't, it's a `chain` or `null`.
- **Check every pair of findings that share an anchor for an interaction.** Ask: would the obvious fix for one make the other worse (`fix-amplifies`)? Does one hide the other (`masks`)? Do they share a fix site (`shares-fix`)? Write `how` concretely enough to change the fix order.
- **Verify emergent findings in the source** like any other, then mark them `emergent: true`.

## Graph schema

```
(:Finding {project,id,title,severity,skill,summary,emergent,near_term,long_term,deferred_cost_owner,pre_mortem,
           opportunity_cost,next_control,control_owner,loop_type,loop_delay})
(:Assumption {project,id,text,status,evidence})
(:LoopStep {project,finding,order,text})
(Finding)-[:RESTS_ON]->(Assumption)
(Finding)-[:ANCHORED_AT {kind}]->(Function|ExternalDependency|DataModel|Component|Journey)
(Finding)-[:LOOP]->(LoopStep)-[:NEXT]->(LoopStep)        // closes back on step 0 unless type 'chain'
(LoopStep)-[:AT]->(Function)
(Finding)-[:INTERACTS {kind,how}]->(Finding)
// playbook (from lenses.json + finding.skill/refs)
(:Skill {project,name,path}) (:Reference {project,ref,title,path,exists})-[:PART_OF]->(Skill)
(:Lens {project,id,skill,question,candidates})-[:OF]->(Skill), (Lens)-[:CITES]->(Reference), (Lens)-[:RAISED]->(LensCandidate)
(:LensCandidate {project,id,lens,skill,title,evidence,status,verdict,note})-[:ANCHORED_AT]->(code), -[:CITES]->(Reference), -[:PROMOTED_TO]->(Finding)
(Finding)-[:FIXED_BY]->(Skill), (Finding)-[:CITES]->(Reference)
```

Draw everything: `MATCH (x:Finding {project:$p})-[r]->(n) RETURN x,r,n`.

## Reading the results

The loader prints eight tables. What to look for, in the order to present it:

1. **Reach vs severity.** Severity is how bad it is when it happens; reach is how many journeys and which actors run through it. When they disagree, say so. High severity with low reach usually means damage that persists or compounds, not frequent damage. Medium severity with high reach is what users and CI actually trip over.
2. **Shared assumptions.** One false belief under three or more findings is a design principle being violated, and a single rule fixes all of them. Lead with it.
3. **Convergent functions and per-component counts.** Where findings meet is where one change fixes several. Recommend fixing them together.
4. **Interactions.** `fix-amplifies` edges set the fix order: fix the target first, or fix both together. A `masks` edge explains why a problem went unnoticed.
5. **Loops.** A reinforcing loop with a delay like "until someone deletes the cache" or "grows with workspace age" means the cost keeps rising while unfixed. Use it to justify priority.
6. **Emergent findings.** Name them as such; they're the evidence that structuring the findings was worth it.
7. **By playbook skill.** Which skill fixes the most findings or reaches the most journeys, and which references to read before starting. This turns the findings into a plan: "apply `resilience` first (F1, F2, F7, 7 journeys); read the idempotency and timeout checklists".
8. **Lens coverage.** Every lens that ran: clean, promoted to which findings, or dismissed and why. Report the clean ones briefly ("no dual writes, no unvalidated writes, no shell invocation"); they're evidence too.

`build-atlas.mjs` also reads `findings.json` and `lenses.json` when they exist. The **Findings** tab lists each finding with its severity, reach (computed from `graph.json` the same way as the Neo4j reach query: journeys whose call path reaches an anchor function, plus journeys anchored directly), assumptions, consequences, control, loop, interactions and references. It also shows a fix order (severity, then reach, with `fix-amplifies` targets moved first) and a "what was checked" table of every lens. Findings also appear as a row on each blueprint step and on the journey explorer's selected path. Anchor findings on the functions where the fix goes: a finding anchored on a helper that every request calls (a token verifier) lights up nearly every journey.
