# config.json and review.json

Both live in `<repo>/.journey-atlas/`. All `match`/`file`/pattern values are JavaScript regex strings (escape backslashes for JSON: `"\\.ts$"`). Paths are repo-relative with forward slashes. Every key is optional.

## Contents
- [config.json: analyzer keys](#analyzer-keys) — what to read and how to find entries/externals
- [config.json: derive keys](#derive-keys) — actors, components, thresholds
- [review.json](#reviewjson) — verdicts from reading the code
- [A worked example](#worked-example)

## Analyzer keys

| Key | Type | Default | Use |
|---|---|---|---|
| `name` | string | repo folder name | Project title in the atlas and the Neo4j `project` property |
| `tsconfig` | string \| string[] | `tsconfig.json` | One entry per TS project (monorepos: list each app/package tsconfig) |
| `include` | regex[] | everything | Only files matching one of these are analyzed, e.g. `["^src/"]` |
| `exclude` | regex[] | tests, `.d.ts`, `dist`, `build`, generated dirs | Added to the defaults |
| `database` | string | from `schema.prisma` provider, else `"Database"` | Name of the primary DB system |
| `prismaClientPaths` | string[] | standard locations | Extra paths of a custom-output Prisma client |

### `externals`

```jsonc
"externals": {
  // npm package → system (checked before the built-in catalog of ~80 SDKs)
  "packages": [{ "match": "^@acme/billing-sdk$", "name": "Acme Billing", "kind": "payments" }],
  // hostname in a string literal → system (checked before the built-in host list)
  "hosts": [{ "match": "api\\.acme\\.io$", "name": "Acme API", "kind": "http-api" },
            { "match": "^github\\.com$", "ignore": true }],  // a host that only appears in a User-Agent, link or message
  // a file that makes HTTP calls but whose URL is built at runtime (env, config): name the system by file
  "fileFallbacks": [{ "match": "billing-client", "name": "Billing API" }],
  // functions that construct a client (wrappers around an SDK): calls on what they return count as that system
  "clientFactories": [{ "factory": "^create(Required|Optional)RedisClient$", "name": "Redis", "kind": "cache" }]
}
```

`kind` is one of `database`, `cache`, `observability` (these three are "core infrastructure", hidden by default in the system-context view), `http-api`, `payments`, `email`, `sms`, `chat`, `notifications`, `storage`, `compute`, `queue`, `search`, `ai`, `auth`, `cloud`, `secrets`. Unknown hosts become a system named after the hostname — fine as a starting point, rename with `hosts`.

When to use what: `unresolved_http` in the analyzer summary lists files with HTTP calls but no host → `fileFallbacks`. An SDK the catalog doesn't know → `packages`. A typed wrapper (`RedisService`, `createS3()`) whose calls don't link to the SDK → `clientFactories`.

### `events`

```jsonc
"events": {
  "emitterInit": "EventEmitter|createEventEmitter|mitt\\(|Emittery",  // initializer text that marks an emitter variable
  "transports": [{ "match": "RedisEventEmitter", "transport": "pubsub" }], // classify emitters by their initializer
  "registries": [{ "file": "-wakeup\\.service\\.ts$", "register": "^register", "notify": "^notify", "transport": "in-process" }]
}
```

`registries` handles hand-rolled observer modules: in a file matching `file`, functions named like `register*` add listeners and `notify*` fire them; the analyzer links each notify to every registered listener as an event.

### `entries`

Express, NestJS, Fastify, Next.js routes and common job/queue libraries are found automatically. Use these for the rest:

```jsonc
"entries": {
  // routers the analyzer finds but can't trace to app.use (it warns): give their mount prefix
  "express": { "roots": [{ "file": "src/legacy/router.ts", "prefix": "/legacy" }] },
  // object literals typed as a handler map → one journey per property
  "registries": [{ "typePattern": "ActionRegistry", "kind": "websocket", "prefix": "WS" }],
  // exported functions that start something (scheduler init, server init) → one journey per file
  "functions": [{
    "file": "^src/schedulers/.+\\.scheduler\\.ts$", "export": "^initialize",
    "kind": "scheduled", "prefix": "JOB",
    "strip": "\\.scheduler$",        // trimmed from the file basename to make the name
    "nameFrom": "file"               // or "function" to use the function name
  }]
}
```

`kind` values the atlas understands: `http`, `websocket`, `scheduled`, `consumer`, `websocket-server`. Others work but get a generic area name.

### `pipelines`

For a WebSocket (or similar) server where every message passes through checks before dispatch:

```jsonc
"pipelines": [{
  "file": "src/websocket/server.ts",
  "connect": "handleConnection",   // function whose calls become 'connect' stage middleware
  "message": "handleMessage",      // function whose calls before dispatch become 'per-message' middleware
  "registryVar": "actionRegistry", // the handler map it indexes into
  "appliesTo": "websocket"         // journey kind that inherits this chain
}]
```

### `errors`

`"errors": { "classes": { "PaymentDeclinedError": 402 } }` maps error classes to HTTP status when the analyzer can't infer it from `super(…, 4xx)`, `new HttpException(msg, 404)` or the class name.

### Python analyzer keys

`scripts/python/analyze.py` reads `name`, `include`, `exclude`, `errors.classes` and these:

```jsonc
"analyzer": "python",            // run.sh picks the analyzer from this ("ts" | "python")
"pythonRoot": "src",             // package root for module names (src layout)
"cli": { "prog": "archobs",      // journey ids: "CLI archobs show risks"
         "callbackNames": { "_app_callback": "Dependency preflight" },   // @app.callback → middleware name
         "callbackKinds": { "_app_callback": "other" } },
"externals": {
  "commands":  [{ "match": "^git$", "name": "Git CLI", "kind": "compute" }],     // subprocess argv[0] → system
  "fileReads": [{ "match": "src/pkg/(deps|inventory)\\.py$", "name": "Target repo source files", "kind": "storage" }]
},
"artifactStore": {               // local files acting as the database
  "name": "Artifact store (.archobs)",
  "functions": "^(write|read|put|get)_(parquet|json|df)$|^(parquet|json)_path$",   // helpers whose string-literal arg names an artifact
  "fileLiteral": "^[\\w.-]+\\.(parquet|json|npy|html)$",                          // optional: base / "name.ext" paths
  "ignore": ["suggestions.json"]                                                  // temp files that aren't artifacts
}
```

## Derive keys

| Key | Default | Use |
|---|---|---|
| `actors` | by journey kind | `[{ "match": "<regex on journey id>", "name": "Store Owner (Admin console)" }]`, first match wins. Journey ids look like `HTTP POST /api/orders`, `WS payments.capture`, `JOB auto-batch`. Name people by role, not by route |
| `components` | folder-based | `[{ "match": "<regex on file>", "component"?: "name", "layer": "entry" }]`. Layers: `entry`, `middleware`, `domain`, `shared`, `events`, `platform`, `foundation`. Omit `component` to keep folder-derived names (`services/billing`, `shared/notifications`) but set the layer |
| `minComponentFunctions` | 25 | Smaller folders fold into `<parent>/(small)` |
| `publicRoutes` | health/ready/metrics/docs/robots… | Regex on journey id; routes treated as public content |
| `moneyTables` | payment\|charge\|order\|invoice… | Regex on table names that make a journey "money moves" |
| `valueTables` | names ending in payment(s), charge(s), transaction(s), ledger(s), balance(s), credit(s), wallet(s)… | Regex on tables whose rows *are* value, not configuration about money (`payment_methods` is not). Used by `repeat-unsafe-write` |
| `bestEffortKinds` | `["email","sms","notifications","chat"]` | System kinds where a lost or repeated message is acceptable; lenses don't ask for compensation, idempotency or loud failure on them. Override per system with `review.json` `systems.<name>.bestEffort` |
| `experimentalLenses` | `false` | Run experimental lenses (`unused-seam`); same as `lenses.mjs --experimental` |
| `customerActors` | customer\|guest\|public… | Regex on actor names that count as "a customer is waiting" |
| `timeoutExemptKinds` | `["cache"]` | System kinds where a missing timeout isn't flagged |
| `playbook` | skills next to this one | Path to the playbook's `skills/` dir, for lens references (`references/lenses.md`) |
| `churnDays` | 90 | Git history window for hotspots. Raise it for quiet repos, or every file sits at zero commits |

Getting actors right matters more than anything else in derive: they color the whole atlas. Aim for 4–9 actors that a product person would recognize, and check that `Other`/fallback actors cover few journeys.

## review.json

Written by you after reading the code. Derive reads it and the review queue shrinks.

```jsonc
{
  "systems": {
    "Payments":   { "recovery": "Scheduled job" },  // "Scheduled job" | "Partial" | "None" | free text
    "Media CDN":  { "sideEffecting": false },        // read-only: no recovery needed
    "Email":      { "bestEffort": true }            // notifications: no compensation/idempotency asked (default for email/sms/chat/push kinds)
  },
  "openRoutes": {
    "HTTP POST /api/integrations/twilio/status": { "verdict": "Verified in handler", "note": "Twilio signature checked" },
    "HTTP GET /api/devices":                    { "verdict": "No guard", "note": "account_id read from the query string" }
    // verdicts: "No guard" | "Verified in handler" | "Pre-sign-in, rate limited" | "Public content"
  },
  "lenses": {                                          // verdicts on lens candidates (references/lenses.md)
    "shared-writer:graph_edges": { "verdict": "finding F8", "note": "two writers, different columns" },
    "hot-dependency-without-breaker:Git CLI": { "verdict": "dismissed", "note": "local process" }   // or "accepted"
  },
  "jobs": { "JOB invoice-sync": { "purpose": "Push approved invoices to accounting", "every_seconds": 900 } },
  "blueprintSkips": { "Mobile Customer": "the app orders through the web API; covered by 'Order for pickup'" },   // actors deliberately without a task
  "tasks": [{
    "task": "Order for pickup",
    "steps": [["Browse the catalog", "HTTP GET /api/catalog"], ["Place and pay", "HTTP POST /api/orders"], ["Store confirms", "WS orders.confirm"]]
  }]
}
```

- **Recovery**: derive auto-detects jobs named like recover/retry/reconcile/resolve that reach a system; everything else is `Unknown` until you decide. "Partial" means some call paths are re-driven and others aren't.
- **`No guard` is only ever set by you.** Derive never claims a route is unguarded on its own; it marks it `Unreviewed`.
- **Tasks** become service blueprints. Each step is a real journey id (copy from `atlas-data/journeys_index.json`). 5–9 steps, spanning actors when the real task does (customer orders → staff confirms). Order follows the product flow, which only you can know.

## Worked example

An illustrative config for an Express + WebSocket + scheduler API serving shoppers, store staff and admins:

```json
{
  "name": "Shop API",
  "include": ["^src/"],
  "exclude": ["^src/test/", "^src/generated/"],
  "externals": {
    "fileFallbacks": [{ "match": "billing-client", "name": "Billing API" }, { "match": "storefront-revalidate", "name": "Storefront (revalidation)" }],
    "clientFactories": [{ "factory": "^create(Required|Optional)RedisClient$", "name": "Redis", "kind": "cache" }]
  },
  "events": {
    "transports": [{ "match": "createEventBus", "transport": "pubsub" }],
    "registries": [{ "file": "-wakeup\\.ts$", "transport": "pg-notify" }]
  },
  "entries": {
    "registries": [{ "typePattern": "ActionRegistry", "kind": "websocket", "prefix": "WS" }],
    "functions": [{ "file": "^src/jobs/.+\\.job\\.ts$", "export": "^start", "kind": "scheduled", "prefix": "JOB", "strip": "\\.job$" }]
  },
  "pipelines": [{ "file": "src/ws/server.ts", "connect": "onConnection", "message": "onMessage", "registryVar": "actionRegistry" }],
  "actors": [
    { "match": "^(WS |HTTP \\S+ /api/store\\b)", "name": "Store Staff" },
    { "match": "^HTTP \\S+ /api/admin\\b", "name": "Admin" },
    { "match": "^HTTP \\S+ /api/(shop|orders|account)\\b", "name": "Shopper" },
    { "match": "^HTTP \\S+ /(health|docs)\\b", "name": "Platform / Infra" }
  ],
  "components": [
    { "match": "^src/(routes|controllers)/", "layer": "entry" },
    { "match": "^src/middleware/", "component": "middleware", "layer": "middleware" },
    { "match": "^src/services/shared/", "layer": "shared" },
    { "match": "^src/services/", "layer": "domain" },
    { "match": "^src/lib/events/", "component": "lib/events", "layer": "events" },
    { "match": "^src/lib/", "component": "lib", "layer": "platform" },
    { "match": "^src/(utils|config|schemas|types)/", "layer": "foundation" }
  ],
  "customerActors": "Shopper"
}
```
