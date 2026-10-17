# Verifying findings before they ship

The atlas is read by people who will act on it. A single wrong red cell ("payments have no timeout", "this route has no guard") costs more trust than ten missed findings. Every item below was a real false positive in a production codebase; check for each before you sign off.

## How to verify one finding

1. Find the evidence: `atlas-data/anatomy.json` (per-journey lanes), `graph.json` (`externalCalls`, `signals`, `mwPasses`), or Neo4j (`references/graph-schema.md#neo4j`).
2. Open the source at the function id's file and line. Read the caller too.
3. Decide, then record it — `review.json` for verdicts, `config.json` if the analyzer misread a pattern, or a fix in the analyzer if the pattern is general.
4. Rerun derive. Never hand-edit `atlas-data/`; it's regenerated.

## Coverage false negatives (things the atlas misses)

| Symptom | Usual cause | Fix |
|---|---|---|
| Fewer routes than grep finds | Router built by a factory, mounted through a helper that receives `app`, or mounted with a path constant | Analyzer follows these for Express; if not, `entries.express.roots` or extend the analyzer |
| A known SDK isn't a system | Package not in catalog; or reached through a typed wrapper | `externals.packages` / `externals.clientFactories` |
| HTTP client calls with no system | URL built from env/config at runtime | `externals.fileFallbacks` |
| Event listeners not linked | Emitter created by a custom factory, or listeners registered through a wrapper | `events.emitterInit`, `events.registries` |
| WebSocket actions show no auth | Auth happens on connect and per message, not as middleware | `pipelines` |
| Module missing in `node_modules` breaks types | Optional/lambda-only deps not installed | Analyzer falls back to ambient `declare module`; check warnings |

## Practice-check false positives (things the atlas over-claims)

**Waits during the request**
- *Detached work counted as a wait.* `void sendEmail()`, a floating promise, `queueX()` without await, an IIFE inside `void`, `setTimeout(() => …)` all run after the response. These must be `detached` calls so the system shows under "after the response", not "waits on". Spot-check the top moment-that-matters journey by reading its handler.
- *Side effects "in a transaction"* that are really in a nested helper whose own call sits outside the transaction callback. Only calls lexically inside the callback count.

**Timeouts and retries**
- The client may set a default timeout in its constructor, an axios instance, or an env-driven wrapper in another file. If so, the call is covered — fix the signal detection or note it.
- Redis/cache clients usually have connection-level timeouts; that's why `cache` is timeout-exempt by default.
- A "retry without idempotency" on a read-only system is fine — mark the system `sideEffecting: false`.

**Authentication and authorization**
- A request validator (`validateRequest`, `zodValidate`) is not sign-in. Check that the middleware kind is `validation`.
- A route with no sign-in middleware may verify a signature (Stripe/Twilio/Slack webhooks), a one-time code, a signed token in the URL, or an API key inside the handler. Read the handler before saying "No guard".
- Rate limit placed after sign-in means bad credentials aren't counted — a real finding, but confirm the order in the actual `app.use`/router code.
- Permission checks done inside the handler (`assertCanEdit(user, resource)`) count as "Permission (handler)". A pale middleware column is not a finding if the handler column is full.

**SSRF**
- Fetching a constant or config-derived URL (a logo on your own CDN, a fixed partner API) is not SSRF. Only user-influenced URLs matter.

**Errors**
- Errors thrown at startup (missing env var, invalid config) aren't user-facing; they shouldn't count as generic 500s for a journey.
- A caught error that's translated to a clear status upstream is clear, not generic. Check the error handler's mapping.
- Swallowed errors that are logged *and* reported to an error tracker are "reported" — less severe than silent.

**Recovery**
- "Recovery job" is inferred from job names and reachability. A job named `reconcile-payments` that only reads may not re-drive failed side effects. Read it before marking a system "Scheduled job".

**CLI tools**
- "Generic 500" means an uncaught exception that prints a traceback. Check whether the message is still clear ("codanna CLI is not installed") before calling it a bad experience.
- File reads of the analyzed input aren't calls that need timeouts; mark the kind timeout-exempt.
- A read-only external CLI (`git log`) needs no recovery verdict, but check that it really is read-only: an indexer run with `cwd` set to the user's repo writes there.

**Caches**
- A cache that stores the result of a call that can fail: does it distinguish failure from "no result" before persisting? Is the key tied to the input's version (index, commit, file hash)? Either gap makes failures and stale answers permanent, and nothing in the atlas flags it. Read every cache write that sits on an external call path.

**Fixes that interact**
- Before recommending a fix, check findings that share an anchor function. A timeout added naively and caught like the existing errors turned hangs into cached empty results on archobs. Record it as a `fix-amplifies` interaction (`references/findings.md`).

## Sanity checks before you present

- Open the top 3 rows of *Moments that matter* and trace each in the code.
- Pick one journey per actor in the explorer; does its lane layout match what the handler does?
- Every "No guard" verdict has a note saying what you checked.
- The component list reads like the team would describe their system. If not, adjust `components`.
- The external system list contains no hostnames from comments, docs links or test fixtures.
