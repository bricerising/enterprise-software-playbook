# The atlas read-out

`atlas.html` is one self-contained file: data inlined, d3 from cdnjs, light/dark themes, sticky tabs. Open a tab directly with a hash: `atlas.html#pipeline`. Every view is built from `atlas-data/*.json`, so to change what a view says, change config/review and rerun derive. Don't edit the data.

Audience: architects and tech leads first, executives second. Every panel answers one question in its title, and the sentence under the title states the answer with a number, e.g. "**/api/admin** has **17** distinct chains". Keep that standard if you extend a view.

## Tabs

| Tab | Panel | Question it answers | Source dataset | Looks wrong when… |
|---|---|---|---|---|
| Overview | KPIs + System context (sankey actor → component → system) | Who uses this, and what do they end up depending on? | `summary`, `context_flow` | One actor or component holds most of the width (actors/components too coarse); junk systems on the right |
| Findings | Verified findings (cards, fix order) and What was checked (every lens: candidates, findings, accepted, dismissed, reasons) | What's wrong, how far does it reach, what do we fix first, and what did we check that came back clean? | `findings`, `finding_journeys`, `lens_coverage` (built from `findings.json` and `lenses.json` by `build-atlas.mjs`) | Empty: write `findings.json` (step 6) and run the lenses, then rebuild |
| User impact | Service blueprint | For one real task, what does the person do, what does each step wait on, what happens after, how can it fail? | `blueprint` (from `review.tasks`) | Empty: no tasks written yet |
| | Moments that matter | Which journeys cost most when they fail? (criticality × fragility) | `moments` | Top rows aren't the money/customer paths; check `moneyTables`, `customerActors` |
| | What users see when it fails · Generic errors | Where can a user get an unexplained 500? | `error_experience`, `generic_errors` | Startup/config errors listed (see verification.md) |
| | Usability heuristics | Double-submit protection, after-response failures nobody re-drives, clear error statuses, by area | `heuristics` | |
| Structure | Layer map | Which components call up against the layering? | `components` | Everything in one layer; set `components[].layer` |
| | Dependency matrix | Who calls whom; red below the diagonal = upward; outlined = cycle | `dsm` | |
| | Convergence points | Which functions do many separate paths flow through? A change there reaches all of them | `convergence`, `convergence_mix` | |
| Request pipeline | Control coverage by area | Sign-in, permission, validation, rate limit — in middleware vs in handler | `pipeline_coverage` | A whole area at 0 sign-in that you know is authenticated: middleware kind misclassified or pipeline not configured |
| | Chain consistency | How many different middleware chains each area uses; rate-limit-after-sign-in chains in red | `chain_variants` | |
| | Middleware inventory | Every middleware, its kind, reach, where applied | `middleware` | |
| | Routes without sign-in | Each open route with a verdict | `open_routes` (from `review.openRoutes`) | Many "Unreviewed" rows: do step 5 |
| Data ownership | Entity lifecycle | Which component creates/reads/updates/deletes each table; tables written by many components | `crud` | |
| Async & jobs | Event flow · Job cadence · Background pressure | What runs off the request path, how often, and which systems it hits | `event_flow`, `jobs` | Jobs with no cadence: `review.jobs[].every_seconds` |
| Resilience | Posture by external system | Timeout/retry/idempotency/breaker coverage and recovery verdict per system | `resilience` (from `review.systems`) | "Unknown" recovery: do step 5 |
| Resilience | Practices by component (heat map) | Where are controls applied and risk patterns (swallowed errors, fire-and-forget) concentrated? | `practices` (from `derived.json` concepts, built by `build-atlas.mjs`) | One component dominates every column: components too coarse |
| Change risk | Change hotspots · Change impact | Files that are touched often *and* reach many journeys; type a file to see its blast radius | `hotspots`, `impact_files` | Empty: no git history in the window (`churnDays`) |
| Journey explorer | Journey anatomy | One journey end to end: pipeline, handler, logic, tables, systems, events, after-response work | `anatomy`, `journeys_index` | |

## Curating blueprints (the most-read view)

Blueprints are where non-engineers get it. Pick tasks that:

1. **Move money or serve a customer** — checkout, pay, refund, book.
2. **Cross actors** — the customer orders, staff confirm, the system notifies. The handoff between actors is where failures hide.
3. **Are the busiest staff workflow** — what someone does a hundred times a shift.
4. **Cover every actor.** At least one task per actor with user journeys: owners setting things up, ops onboarding a customer, support handling a ticket, not only the customer's purchase. A first pass that stops at the money paths leaves most of the system unread. Derive's review queue lists `actors_without_blueprint`; clear it or record why in `review.json` → `blueprintSkips`.
5. **Run through the risky parts.** A task that passes through a verified finding or a newly added integration puts that risk in front of the people who own the workflow.

Write steps as the person would say them ("Place and pay", not "POST /api/orders"). 4–9 steps. Use real journey ids from `atlas-data/journeys_index.json` (the queue lists any that don't exist as `blueprint_unknown_journeys`). Include the jobs a flow depends on as steps (`JOB settle-payments` after "Close the till"); background work is where blueprints show "no recovery". If a step has no single journey (it's client-side only), leave it out. Typical count: 5–9 tasks.

## Publishing

- Local: open `.journey-atlas/atlas.html`. Nothing leaves the machine.
- claude.ai Artifact: `build-atlas.mjs --fragment` writes `atlas-artifact.html` (no `<html>`/`<head>` wrapper); publish that with the Artifact tool, icon `map`. Artifacts start private. The file is ~1–4 MB for a large repo (limit 16 MB). Big repos: if it's too large, the biggest dataset is usually `anatomy`.
- Republishing after a rerun: publish the same file path again to update the same URL.

## Writing the findings summary

After the atlas, give the user 3–6 findings, most consequential first. Each: one sentence of what, the number, why it matters, and where to see it. Example shape:

> **Email and file-storage failures are never retried.** 17 journeys send email and nothing re-drives a failed send (Resilience tab). Receipts and password resets silently don't arrive.

If you loaded `findings.json` (`references/findings.md`), follow with what linking the findings showed: the false assumption shared by several findings, the fix order from `fix-amplifies` edges, where fixes converge, and any finding whose reach and severity disagree. That's often the most useful paragraph.

Then one line on coverage limits (what static analysis can't see in this repo), and links: `atlas.html`, the Neo4j browser URL from `neo4j.env`, the Artifact if published.
