# graph.json contract and Neo4j schema

`graph.json` is the only thing `derive.mjs`, `load-neo4j.mjs` and the atlas need from an analyzer. Any language can produce it (see `other-stacks.md`). Arrays you can't fill may be empty or omitted — derive defaults them — but the views that read them will be empty too.

## Contents
- [Identifiers](#identifiers)
- [meta](#meta)
- [Arrays: required core](#required-core)
- [Arrays: enrichments](#enrichments)
- [Enumerations](#enumerations)
- [Neo4j](#neo4j) — labels, relationships, queries

## Identifiers

- **Function id**: `<repo-relative file>#<qualified name>@<line>`, e.g. `src/services/orders.ts#OrderService.place@42`. Module top-level code is `<file>#<module>`. Anonymous callbacks get a descriptive name: `src/routes/a.ts#router.get('/x') callback@L16@16`. Derive takes the component from the part before `#`, so the file must be accurate.
- **Journey id**: `<PREFIX> <name>` — `HTTP GET /api/orders/:id`, `WS payments.capture`, `JOB auto-batch`, `CONSUMER order-created`, `WSS customer-server`. Path params normalized to `:name`. Actor rules match on this string.
- **Event id**: `<emitter>:<event name>`.

## meta

```json
{ "schema": 1, "analyzer": "journey-atlas/ts", "project": "Shop API", "root": "/abs/path",
  "commit": "b1a1dbdba", "branch": "main", "generated_at": "2026-10-17T17:49:24Z",
  "database": "PostgreSQL", "frameworks": ["express", "schedulers"],
  "warnings": [], "unresolved_http": [], "journeys_without_handler": [] }
```

`warnings`, `unresolved_http` (files with outbound HTTP but no identified host) and `journeys_without_handler` feed the review queue — fill them honestly; they're how coverage gaps surface.

## Required core

Without these, there is no atlas.

| Array | Record | Notes |
|---|---|---|
| `functions` | `{id, name, file, line}` | Every function, method, and named callback in scope |
| `calls` | `{from, to, kind}` | Resolved function → function edges. `kind` below. Unresolved calls are dropped, not guessed |
| `journeys` | `{id, kind, name, method?, path?, action?, schedule?, source}` | `source` = `file:line` of the registration |
| `entries` | `{journey, fn, role, order}` | `role`: `handler` (the business entry) or `middleware`. Several handlers per journey are allowed |
| `externals` | `{name, kind}` | One per external system, named for humans ("Stripe", not "stripe-node") |
| `externalCalls` | `{from, dep, ops[], sync, via?}` | A function that calls a system. `sync: false` if the call is detached from the request (fire-and-forget). Optional `via` (`subprocess`, `http`, `file`…) groups call sites of the same boundary kind for the platform lens |
| `modelQueries` | `{from, model, ops[]}` | `ops` from `create`, `read`, `update`, `delete`, `upsert` (ORM verbs are normalized: `findMany`→`read`) |

## Enrichments

Each one lights up specific views; skip what your stack makes hard and say so.

| Array | Record | Lights up |
|---|---|---|
| `events` | `{id, emitter, name, transport}` | Event flow, async reach |
| `emits` | `{from, event}` | |
| `handles` | `{event, to}` | `to` is the listener function id |
| `middleware` | `{name, impl?, package?, kind}` | Request pipeline tab. `impl` = function id when it's local |
| `mwPasses` | `{journey, mw, order, scope, config?}` | Ordered chain per journey. `scope`: `app`, `router`, `route`, `connect`, `per-message`. `config` = the call-site arguments as text (e.g. `{requireAccountAccess:true}`) |
| `throws` | `{fn, cls, category, message?}` | Error experience. `category` like `404 not found` or `generic 500`; also emit direct replies (`res.status(422)`) with `cls: "status(422)"` |
| `signals` | `{fn, signal, count, samples[]}` | Resilience and security posture; one record per function per signal |
| `txCalls` | `{from, to, line}` | Calls made inside a DB transaction callback (side effects in transactions) |
| `envReads` | `{fn, key}` | Environment variables each function reads (`env.X`, `process.env.X`, `process.env['X']`). Feeds the `shared-secret-purpose` lens |

## Enumerations

- **call kind**: `call` (direct), `new` (constructor), `callback` (function passed as an argument and invoked by the callee), `ref` (function reference stored/returned), `dispatch` (interface/abstract call resolved to implementations), `detached` (`void p`, floating promise, `setTimeout`/`setImmediate` — work that runs after the response; derive treats everything reached through it as async).
- **journey kind**: `http`, `websocket`, `scheduled`, `consumer`, `websocket-server`, `cli` (with `command`, e.g. `"show risks"`; area = first word), `mcp` (others allowed).
- **middleware kind**: `authentication`, `authorization`, `validation`, `rate-limit`, `replay-protection`, `observability`, `security-headers`, `cors`, `body-parsing`, `error-handling`, `other`. Classification drives the coverage matrix — be conservative: a request validator is `validation`, not `authentication`.
- **signal**: `timeout`, `retry`, `idempotency-key`, `idempotent-write`, `circuit-breaker`, `concurrency-limit`, `distributed-lock`, `ssrf-control`, `input-validation`, `db-transaction`, `fire-and-forget`, `error-logged-and-swallowed`, `error-silently-swallowed`, `error-reported-and-swallowed`, `value-increment` (a relative write; sample `model.op increment|decrement field`, one per field), `write-in-catch` (a write on an error path, i.e. a catch block or a promise `.catch` handler; sample `model.op`, suffixed ` (conditional)` when behind an `if`/`switch`/ternary), `clears-data-in-catch` (the subset that deletes rows or sets every non-timestamp field to `''`/`null`/`[]`/`new Date(0)`). Derive credits a signal to an external call site when it appears in the calling function, a direct caller, a same-file callee, or anywhere in the same file (in that order; the atlas records which). So emit signals on the function where the code actually is; don't spread them.
- **external kind**: see `config.md#externals`. `database`, `cache`, `observability` are core infrastructure.

## Neo4j

Every node has `project`. A load deletes `MATCH (n {project:$p})` first, so reloading is idempotent and other projects are untouched.

**Nodes**: `Function {id,name,file,line}` (+`ConvergencePoint` label with `convergenceJourneys`, `incomingPaths`), `Component {name,layer,functions,journeys,instability}`, `Journey {id,kind,name,method,path,schedule,actor,area,reachedFunctions, authn, authzPipeline, authzHandler, validationPipeline, validationHandler, rateLimit, openRouteVerdict, openRouteNote}`, `Actor {name}`, `Feature {key}` (API area), `Middleware {name,kind,package}`, `ExternalDependency {name,kind}`, `DataModel {name}`, `Event {id,emitter,name,transport}`, `Concept {name,skill,polarity}`.

**Relationships**:

```
(Actor)-[:USES]->(Feature)-[:INCLUDES]->(Journey)<-[:PERFORMS]-(Actor)
(Journey)-[:ENTERS {role,order}]->(Function)-[:CALLS {kind,inTransaction}]->(Function)
(Journey)-[:PASSES_THROUGH {order,scope,config}]->(Middleware)-[:IMPLEMENTED_BY]->(Function)
(Function)-[:CALLS_EXTERNAL {ops,sync,timeout,retry,idempotency,circuitBreaker}]->(ExternalDependency)
(Function)-[:QUERIES {ops}]->(DataModel)-[:STORED_IN]->(ExternalDependency)
(Function)-[:EMITS]->(Event)-[:HANDLED_BY]->(Function)
(Function)-[:BELONGS_TO]->(Component)
(Function)-[:APPLIES|EXHIBITS {signals,count,samples}]->(Concept)      // good practice | risk
-- derived shortcuts (precomputed reachability) --
(Journey)-[:DEPENDS_ON {distance,async,viaMiddlewareOnly,ops}]->(ExternalDependency)
(Journey)-[:TOUCHES {distance,async,writes,ops}]->(DataModel)
(Journey)-[:TRIGGERS {distance,async}]->(Event)
(Journey)-[:CONVERGES_AT {via}]->(Function:ConvergencePoint)
(Journey {kind:'scheduled'})-[:BALANCES]->(ExternalDependency)          // recovery job for that system
```

Findings and lenses (from `findings.json` and `lenses.json`, loaded by `load-findings.mjs`) add `Finding`, `Assumption`, `LoopStep`, `Skill`, `Reference`, `Lens` and `LensCandidate` nodes with `RESTS_ON`, `ANCHORED_AT`, `LOOP`/`NEXT`/`AT` and `INTERACTS` relationships; see `findings.md#graph-schema`.

Useful queries (replace `$p` with the project name or pass it as a parameter):

```cypher
// What does one journey wait on during the request?
MATCH (j:Journey {project:$p, id:'HTTP POST /api/orders'})-[d:DEPENDS_ON {async:false}]->(e) RETURN e.name, d.distance ORDER BY d.distance

// Blast radius of an external outage, by actor
MATCH (a:Actor {project:$p})-[:PERFORMS]->(j)-[:DEPENDS_ON {async:false}]->(:ExternalDependency {name:'Stripe'})
RETURN a.name, count(j) ORDER BY count(j) DESC

// Side-effecting systems with no recovery job
MATCH (e:ExternalDependency {project:$p}) WHERE NOT e.kind IN ['database','cache','observability'] AND NOT ()-[:BALANCES]->(e) RETURN e.name

// Who writes a table?
MATCH (j:Journey {project:$p})-[t:TOUCHES {writes:true}]->(:DataModel {name:'payments'}) RETURN j.actor, collect(j.id)

// Routes without sign-in
MATCH (j:Journey {project:$p, kind:'http'}) WHERE j.authn = false RETURN j.id, j.openRouteVerdict, j.openRouteNote

// Shortest call path from a journey to a system
MATCH (j:Journey {project:$p, id:$jid})-[:ENTERS]->(f), (e:ExternalDependency {project:$p, name:$sys})
MATCH path = shortestPath((f)-[:CALLS*..15]->(g)) WHERE (g)-[:CALLS_EXTERNAL]->(e) RETURN path LIMIT 1
```
