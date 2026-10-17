# Other stacks: writing an analyzer that emits graph.json

Everything after `graph.json` (derive, Neo4j, the atlas) is stack-agnostic. For a non-TypeScript repo, write an analyzer that produces the contract in `graph-schema.md`, then continue at step 4 of the workflow.

## Approach

1. **Use the language's real compiler or type-aware tooling.** Call resolution decides the quality of everything downstream. Regex call graphs inflate fan-out and invent paths, so avoid them.
2. **Build in this order, checking counts against grep at each step:**
   1. `functions` and `calls`
   2. `journeys` and `entries`
   3. `externals` and `externalCalls`
   4. `modelQueries`
   5. events
   6. middleware
   7. signals and throws

   Run derive and look at the atlas after step 4. Overview, Structure, Data ownership and Explorer already work at that point.
3. **Reuse the catalog.** `scripts/lib/catalog.mjs` maps package names to systems (most SDKs share names across languages, e.g. `stripe`, `twilio`, `boto3`/`aws-sdk`). Add regexes for your ecosystem's package names to `PACKAGES` and `HOSTS` rather than inventing names, so systems are named the same way across repos.
4. **Put the analyzer where it can be reused.** Use `<skill>/scripts/<lang>/analyze.*` if it's general, or `<repo>/.journey-atlas/analyzer/` if it's a one-off. Read the same `config.json` keys where they apply (`include`, `exclude`, `externals`, `actors`, `components`).
5. **Be honest in `meta`.** Put what you couldn't resolve in `warnings` and `unresolved_http`. Say in the write-up which enrichment arrays you skipped.

Detached work matters in every language. Mark calls that run after the response as `kind: "detached"`: goroutines, `asyncio.create_task`, `@Async`, `Task.Run` without await, `perform_later`, thread pools, background tasks. Otherwise the atlas reports them as waits.

## Python

`scripts/python/analyze.py` is a working starting point (stdlib only; first used on archobs, a typer CLI). It handles typer entries, subprocess and file-store externals, swallowed-error and timeout signals, and exception categories. Extend it for the web/job entries below rather than starting over.

- **Tooling:**
  - The `ast` module plus a resolver. The bundled one is type-light and was enough for a 7.5k-line package (263 of 295 functions reached; the rest were entry points, Protocol stubs and dead code). For heavier dynamic code, add `jedi` (`Script.infer`/`goto`) or `pyright --outputjson`.
  - For large codebases, `pycg` or `scalpel` give call graphs directly.
  - Resolve imports through the package layout (`src/` layout: set `pythonRoot`). Record function-local imports too (`from x import y` inside a function is common for lazy loading) and follow re-exports through `__init__.py`.
- **Resolution gaps that matter in practice** (each one hid a whole pipeline stage on archobs):
  - *Unannotated methods that return a cached attribute* (`if self._x is None: self._x = build(); return self._x`). Infer the return type from `return` expressions and `self.attr = <typed expr>` assignments in the same function.
  - *`typing.Protocol` dispatch.* Implementations don't subclass the protocol, so match structurally: every class that has all the protocol's public methods. Emit `kind: "dispatch"`.
  - *Calls inside lambdas* (`sorted(..., key=lambda e: helper(e))`). Attribute them to the enclosing function; don't skip lambda bodies.
  - *Ternaries* (`x = a if a is not None else self.build()`): type from either branch.
  - *Function references* passed as values (`executor.submit(fn, …)`, dispatch tables of `(name, fn)` tuples): emit `kind: "ref"`.
  - *Properties*: an attribute load that hits a `@property` is a call.
- **Entries:**
  - FastAPI: `@app.get`, `APIRouter` and `include_router(prefix=…)`.
  - Flask: `@bp.route` and `register_blueprint(url_prefix=…)`.
  - Django: `urls.py` `path()`/`re_path()` → views; DRF `ViewSet` + router actions.
  - Jobs: Celery `@shared_task`/`@app.task` (consumers) and `beat_schedule` (cadence); APScheduler; RQ; Dramatiq; Kafka/aio-pika consumers.
  - CLIs (bundled for typer): `@app.command()`, sub-apps via `add_typer(sub, name=…)`, `@app.callback()` as app-scope middleware. Journey `kind: "cli"`, id `CLI <prog> <group> <command>`, with a `command` field; derive groups areas by the first word of `command`. Click (`@click.group`/`@grp.command`/`add_command`) and argparse subparsers follow the same shape.
- **Middleware:**
  - Django `MIDDLEWARE` setting (app scope).
  - FastAPI `Depends()` in route signatures (route scope; `get_current_user` → authentication) and `app.add_middleware`.
  - Flask `before_request`.
  - DRF `permission_classes`/`authentication_classes`/`throttle_classes`.
- **Data:**
  - Django ORM `Model.objects.filter/create/update/delete` → model table (`Meta.db_table` or `app_model`).
  - SQLAlchemy `session.query(Model)`, `select(Model)`, `session.add`.
  - Database from `DATABASES`/the URL scheme.
- **Externals:** `requests`/`httpx`/`aiohttp` with string-literal URLs; `boto3.client('s3')` → AWS S3 (the service name is the argument); `stripe.*`, `twilio.rest.Client`.
  - `subprocess.run/Popen/check_output` → the system named by the executable: the first element of the argv list, following a module constant (`LOG_FORMAT = ["git", …]`) or a variable assigned from `shutil.which("codex")`. Op = the subcommand literal. Configure names with `externals.commands`.
  - Raw reads of the analyzed input (`Path.read_text`, `open`) in specific modules: `externals.fileReads`.
- **Signals:**
  - `timeout=` kwarg present (requests has no default, so a missing timeout is a true finding)
  - `tenacity`/`backoff` decorators (retry)
  - `transaction.atomic`/`session.begin()` (db-transaction)
  - Pydantic/marshmallow/DRF serializers (input-validation)
  - `except` without a re-raise: silently swallowed; logged-and-swallowed if the body prints/warns/logs; reported if it appends to an errors list
  - `ThreadPoolExecutor(max_workers=…)` (concurrency-limit)
- **Throws:** CLIs have no status codes. The bundled analyzer maps `typer.Exit`/`SystemExit(1)` → `exit 1 (message printed)`, `FileNotFoundError` → `404 not found`, `ValueError`/`BadParameter` → `400 invalid input`, and anything else → `generic 500`, meaning an uncaught traceback. Say so in the write-up, since the atlas labels are HTTP-shaped.

### CLI tools and batch pipelines

These have no users signing in and often no database server. What changes:
- **Actors** are roles by command group: whoever runs the pipeline, whoever (or whichever agent) reads results, CI gates.
- **The database is a folder of files** (`.archobs/*.parquet`, a cache JSON, an output HTML). Model it with `artifactStore`: a store name, a regex of the reader/writer helper functions whose string-literal argument names the artifact, and `fileLiteral` for `base / "name.parquet"` paths. Each artifact then becomes a table, and Data ownership shows who writes what. This surfaced archobs's main structural finding: 24 of 25 artifacts were named outside the store class meant to own them.
- **Local executables are external systems** (git, an indexer, LLM CLIs). Missing timeouts on them are real findings; `timeoutExemptKinds: ["storage"]` keeps plain file reads out of the timeout list.
- **Open routes, sign-in and rate limits don't apply**; those panels read zero, and that's expected.
- **Quiet repos:** if nothing changed in the 90-day churn window, the hotspot chart collapses onto zero; raise `churnDays`.
- **Throws:** `HTTPException(status_code=…)`, `Http404`, DRF `ValidationError` → 400, `PermissionDenied` → 403.

## Go

- **Tooling:** `golang.org/x/tools/go/packages` to load with types, then `go/callgraph/vta` (or `cha` for speed) on SSA. This is the most precise option of any stack here. Function id: `pkg/path/file.go#(*Type).Method@line`.
- **Entries:**
  - net/http: `HandleFunc`/`Handle` and `http.NewServeMux`.
  - chi: `r.Route`/`r.Mount`/`r.Get`.
  - gin: `r.Group(prefix)`/`GET`.
  - echo, gorilla/mux: `PathPrefix().Subrouter()`.
  - gRPC: `Register<Svc>Server` → one journey per RPC method, `GRPC Svc/Method`.
  - Jobs and consumers: `robfig/cron` `AddFunc` (has cadence), Kafka/NATS/SQS consumer loops.
- **Middleware:**
  - chi/gin `Use()` at router or group scope, and `With()` at route scope.
  - gRPC `UnaryInterceptor` chains.
- **Data:** `database/sql` with SQL strings (parse table names from literals: `FROM x`, `INSERT INTO x`), sqlc-generated query functions, gorm `db.Model(&T{})`/`Create`, ent.
- **Externals:** `http.Client` with literal URLs; SDK packages (`github.com/stripe/stripe-go`, `aws-sdk-go-v2/service/s3`).
- **Signals:**
  - `context.WithTimeout` or `http.Client{Timeout:}` (the default client has no timeout, which is a real finding)
  - `retry-go`, `cenkalti/backoff` (retry)
  - `sony/gobreaker` (circuit breaker)
  - `errgroup.SetLimit` and semaphore (concurrency limit)
- **Detached:** every `go f()` is a detached call.

## Java / Kotlin

- **Tooling:**
  - Spring apps: JavaParser with its SymbolSolver, or Spoon. Kotlin needs the Kotlin compiler's PSI, or detekt's type resolution.
  - Compiled projects: run `sootup`/WALA on the class files for a call graph, then map back to source lines.
- **Entries:**
  - Spring `@RestController` + `@RequestMapping` (class prefix) + `@GetMapping`…
  - JAX-RS `@Path`
  - Ktor `routing { route("/x") { get { } } }`
  - `@Scheduled(cron|fixedRate)` (cadence included)
  - `@KafkaListener`, `@RabbitListener`, `@SqsListener` (consumers)
- **Middleware:**
  - Spring Security `SecurityFilterChain` (`.requestMatchers(...).authenticated()/permitAll()`). This gives open-route verdict hints directly.
  - `@PreAuthorize` (authorization, handler level)
  - `HandlerInterceptor`, servlet `Filter`
  - `@Valid` on parameters (validation)
- **Data:** JPA `@Entity` + `@Table(name)`, Spring Data repository methods (`save`, `findBy…`, `delete…` → ops), jOOQ table references, MyBatis mappers.
- **Externals:** `RestTemplate`/`WebClient`/`RestClient`/Feign `@FeignClient(url=…)`/OkHttp; AWS SDK v2 service clients.
- **Signals:** Resilience4j `@Retry`/`@CircuitBreaker`/`@Bulkhead`/`@TimeLimiter` (these are explicit, so they are high-confidence), `@Transactional`, timeouts on client builders.
- **Detached:** `@Async`, `CompletableFuture.runAsync`, `executor.submit`, `@TransactionalEventListener` handlers.

## C# / .NET

- **Tooling:** Roslyn (`MSBuildWorkspace` → `SemanticModel.GetSymbolInfo` on invocations). This gives full type resolution.
- **Entries:**
  - Controllers with `[Route]` + `[HttpGet]`…
  - Minimal APIs `app.MapGet`/`MapGroup(prefix)`
  - SignalR hub methods
  - Hosted services (`BackgroundService`), Hangfire `RecurringJob.AddOrUpdate` (cadence)
  - MassTransit/NServiceBus consumers
- **Middleware:**
  - `app.Use…` order in `Program.cs`
  - `[Authorize]`/`[AllowAnonymous]` (class/method)
  - `.RequireAuthorization()` on groups
  - Action filters
  - FluentValidation
- **Data:** EF Core `DbSet<T>` usage (`Add`, `Where`, `Remove`, `SaveChanges`), table from `[Table]` or `ToTable`; Dapper SQL literals.
- **Externals:** `HttpClient` via `IHttpClientFactory` named clients (`AddHttpClient("x", c => c.BaseAddress = …)` gives you the host), and the AWS/Azure SDKs.
- **Signals:** Polly policies (`AddStandardResilienceHandler`, `WaitAndRetry`, `CircuitBreaker`, `Timeout`), `HttpClient.Timeout`, `TransactionScope`/`BeginTransaction`.

## Ruby / Rails

- **Tooling:** Prism (`Prism.parse`) for the AST. Ruby has no static types, so resolve calls by constant paths and Rails conventions, and accept lower precision. For routes, run `bin/rails routes --format=json` (Rails ≥ 7.1) or parse `bin/rails routes` output. It is authoritative and beats parsing `routes.rb`.
- **Entries:**
  - Routes → `controller#action` (the handler function is `app/controllers/x_controller.rb#XController#action`).
  - ActiveJob/Sidekiq `perform` (consumers); `sidekiq-cron`/`whenever` schedules (cadence).
  - ActionCable channel methods (websocket).
- **Middleware:**
  - `before_action` callbacks with `only:`/`except:` (route scope); `authenticate_user!` → authentication.
  - Pundit `authorize` (handler authorization).
  - Rack middleware stack from `config/application.rb` (app scope).
  - `rack-attack` (rate limit).
- **Data:** ActiveRecord: the model's class name gives the table (`self.table_name` overrides). Map `create/update/destroy/where/find` to ops.
- **Externals:** `Faraday`/`Net::HTTP`/`HTTParty` with literal URLs, gems (`stripe`, `twilio-ruby`, `aws-sdk-s3`).
- **Detached:** `perform_later`, `deliver_later`, `Thread.new`.

## Polyglot repos

Run one analyzer per language into separate graph files, then merge them. Concatenate the arrays, keep one `meta`, and union `frameworks`. Ids are file-prefixed, so they don't collide. Cross-language edges (a TS frontend calling a Go API) appear naturally if you name the internal API as an external system in one graph and as journeys in the other. Note that link in the write-up; derive won't connect them.
