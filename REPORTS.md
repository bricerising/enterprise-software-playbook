# Reports

Reports you can generate with the playbook's skills and tools. Each entry includes a ready-to-use prompt.

> **Prerequisite**: Several reports depend on architecture observability data. If a prompt says "load archobs", run `archobs report` on the target repo first. Many skills will do this automatically, but calling it out here so you know what to expect.

## Quick Reference

| I want to... | Report |
|---|---|
| let the playbook decide what to run | [Workflow auto-route](#start-here) |
| assess codebase coupling and risk | [Architecture health report](#codebase-health--architecture) |
| gate a PR on structural fitness | [Fitness check](#codebase-health--architecture) |
| get a thorough code review | [Adversarial code review](#codebase-health--architecture) |
| understand a technology trend | [Intelligence brief](#intelligence--forecasting) |
| get a daily signal summary | [Daily digest](#intelligence--forecasting) |
| see what's spiking in feeds | [Trend scan](#intelligence--forecasting) |
| predict external technology shifts | [External technology forecast](#intelligence--forecasting) |
| see where dev momentum is going | [Internal development trajectory](#intelligence--forecasting) |
| get full situational awareness | [Combined forecast](#intelligence--forecasting) |
| plan the highest-priority improvement | [Implementation plan](#planning--design) |
| spec the weakest contract boundary | [Service specification](#planning--design) |
| get an architecture pattern recommendation | [Architecture pattern recommendation](#planning--design) |
| reduce the worst coupling hotspot | [Design pattern recommendation](#planning--design) |
| find platform extraction candidates | [Platform extraction assessment](#planning--design) |
| audit security of this service | [Security assessment](#hardening) |
| harden all I/O boundaries | [Resilience assessment](#hardening) |
| instrument with observability | [Observability instrumentation plan](#hardening) |
| diagnose a production issue | [Incident diagnosis](#diagnostics) |
| pin consumer-facing behavior with tests | [Test suite report](#verification--ship) |
| do a final check before merging | [Definition-of-done report](#verification--ship) |
| stress-test the riskiest boundary design | [Technical design review](#decision-deep-dives) |
| compare top suggested improvements | [Trade-off analysis](#decision-deep-dives) |
| set multi-quarter direction | [Strategic roadmap](#decision-deep-dives) |
| capture learnings from delivery/incident | [Retrospective / postmortem](#decision-deep-dives) |
| frame a recommendation for async review | [Recommendation brief](#decision-deep-dives) |

---

## Start Here

- **Workflow auto-route** — assess this repo and let the playbook select and sequence the right skills for the highest-impact next action. Classifies scope (tiny/normal/big) and applies proportional overhead.

  ```text
  Use workflow (read skills/workflow/SKILL.md).

  Assess this repo. Based on structural health (run archobs), development
  momentum, and code quality signals, recommend the highest-impact next
  action and sequence the skills needed to execute it.
  ```

---

## Codebase Health & Architecture

- **Architecture health report** — coupling, boundary leakage, risk hotspots, drift trends, velocity/churn, and team bus-factor metrics. Use before refactoring decisions, sprint planning, or when onboarding to an unfamiliar codebase.

  ```text
  Use archobs (read skills/archobs/SKILL.md).

  Target repo: .
  Question: Where are the riskiest coupling points and leakiest boundaries?

  Run the full analysis and report:
  - Top risk files (flag anything with risk > 0.5, xnbr > 0.35, or hubness > 0.45)
  - Leakiest clusters (leakage > 20%)
  - Drift assessment (ARI trend across windows, not single value)
  - Velocity and churn (growth ratio, acceleration, file additions)
  - Team metrics (bus factor per cluster, knowledge concentration)
  - Actionable suggestions with the next skill to invoke based on dominant finding
  ```

- **Fitness check** — CI-gatable pass/fail health evaluation against configurable thresholds. Use in PR checks or before merging to verify structural fitness hasn't regressed.

  ```text
  Use archobs (read skills/archobs/SKILL.md).

  Target repo: .
  Run `archobs check` against baseline thresholds. Report pass/fail per
  metric, flag any regressions, and surface the specific files or clusters
  responsible for any failures.
  ```

- **Adversarial code review** — four-phase debate (critique, defense, rebuttal, verdict) producing findings classified as CONFIRMED/DISMISSED/CONTESTED, fix priorities (P0-P2), and systemic risk notes.

  ```text
  Use review (read skills/review/SKILL.md).

  Review type: general
  Scope: changes on the current branch vs main

  Load archobs data first (archobs show all --format json), then run
  the full 4-phase protocol. Every finding must include file+line evidence
  and a concrete 1-line fix direction.
  ```

## Intelligence & Forecasting

- **Intelligence brief** — ranked signals from collected feeds (RSS, HackerNews, EDGAR), shaped for a specific audience and decision context. Derives topics from the repo's technology stack.

  Audience options and what they produce:
  - `practitioner`: ranked signals, trend context, gaps, so-what
  - `executive`: 3-5 bullet TL;DR, implications, risk flags, recommended action
  - `engineering`: signals by stack relevance, migration/deprecation watch, security advisories
  - `decision`: evidence mapped to options, confidence level, recommendation
  - `architecture decision`: structural context + ecosystem context, options matrix

  ```text
  Use intel (read skills/intel/SKILL.md).

  Audience: engineering
  Time window: last 7 days

  Check data freshness with `intel stats` first. Identify the primary
  technologies and frameworks used in this repo (from dependency manifests,
  imports, and config files), then gather signals for each via search,
  trends, and topics in parallel. Synthesize through the engineering output
  template. Include source citations.
  ```

- **Daily digest** — top 5 signals with one-line commentary and a "one thing to watch" highlight.

  ```text
  Use intel (read skills/intel/SKILL.md).

  Audience: daily digest

  Check data freshness first. Produce the digest with source health note.
  ```

- **Trend scan** — landscape overview of what's spiking, what's new, and coverage gaps.

  ```text
  Use intel (read skills/intel/SKILL.md).

  Content type: trend scan
  Run `intel trends` and `intel sources` in parallel. Report what topics
  are spiking, what's newly appearing, and where we have collection gaps.
  ```

- **External technology forecast** — ranked scenarios with relative confidence scores, CUSUM change-point detection, transitive chains, and preparation recommendations.

  ```text
  Use forecast (read skills/forecast/SKILL.md).

  Mode: external
  Question: What technology shifts should we prepare for?

  Check intel data freshness first. For every CUSUM structural break, search
  for at least 2 alternative mechanisms before naming the cause — do not
  anchor on the obvious narrative from event titles. Present scenario scores
  as relative rankings, not probabilities. Flag chains with support < 3 as
  lower confidence.
  ```

- **Internal development trajectory** — momentum analysis, active clusters, feature adjacency predictions, and architectural pressure points from git history.

  ```text
  Use forecast (read skills/forecast/SKILL.md).

  Mode: internal
  Target repo: .
  Question: Where is development momentum concentrated and what's likely next?

  Run archobs first, then forecast in internal mode. Report: development
  focus ranking, active cluster details with velocity, thematic patterns,
  feature adjacency reasoning, and recommended next actions.
  ```

- **Full situational awareness** — combined internal trajectory + external forecast + compound risk analysis. Use for quarterly planning or major architecture decisions.

  ```text
  Use forecast (read skills/forecast/SKILL.md).

  Mode: combined
  Target repo: .
  Question: What should we prioritize given both internal momentum and external shifts?

  Run archobs, then forecast in combined mode. Report: development momentum
  (internal), ecosystem signals (external), cross-domain alignment/conflicts,
  compound risks, and recommended priorities.
  ```

## Planning & Design

- **Implementation plan** — objective function, system sketch, decision table, ordered tasks with acceptance criteria, risk flags, and measurement ladder. Targets the highest-priority structural improvement from archobs.

  ```text
  Use plan (read skills/plan/SKILL.md).

  Load archobs data first (archobs show all --format json). Identify the
  highest-priority structural improvement from archobs suggestions (worst
  risk score, highest leakage, or most critical bus-factor gap). Plan that
  improvement: produce an objective function, decision table if 2+ viable
  approaches exist, ordered task list with acceptance criteria, and a
  measurement ladder with leading/lagging indicators.
  Cross-reference with forecast data if available — amplify risk on tasks
  touching areas where archobs signals and forecast lifecycle phases conflict.
  ```

- **Service specification** — acceptance scenarios (Given/When/Then), API contracts (OpenAPI/proto/WebSocket), data models, NFRs, and task list. Targets the boundary with the weakest contract coverage.

  ```text
  Use spec (read skills/spec/SKILL.md).

  Load archobs data first. Identify the service boundary with the weakest
  contract coverage (highest leakage, missing or implicit contracts, or
  the boundary most frequently involved in cross-cluster changes). Write
  acceptance scenarios (Given/When/Then including edge cases and failure
  modes), then lock down contracts (schemas, error codes, versioning,
  idempotency keys). Include NFRs (latency, concurrency, durability), a
  decision table with kill criteria, and a task breakdown with acceptance
  per task.
  ```

- **Architecture pattern recommendation** — pattern selection grounded in empirical coupling data, with failure propagation analysis, dynamics check, and implementation tactics.

  ```text
  Use architecture (read skills/architecture/SKILL.md).

  Load archobs data first — identify the dominant architecture pressure
  from the data (reliability, consistency, domain complexity, coordination,
  migration, streaming, or ML lifecycle). Ground boundary decisions in
  measured coupling, not intuition. Produce a decision table (2-3 options
  including a no-pattern baseline) and stress-test via: happy path, failure
  path, ops path, blast-radius path. Include a pre-mortem ("if this fails
  in 6 months, why?") and map the organizational cascade (who absorbs
  downside).
  ```

- **Design pattern recommendation** — GoF pattern selection framed by the problem (not the pattern name), with trade-offs, implementation sketch, and two validation examples. Targets the highest-risk coupling point.

  ```text
  Use design (read skills/design/SKILL.md).

  Load archobs risks and clusters first. Identify the file or cluster with
  the strongest coupling signal (highest xnbr, hubness, or leakage) and
  frame the problem in terms of what varies vs what stays stable. Pick one
  pattern to address it, not multiple. Validate with two examples: happy
  path + a likely future change that the pattern should absorb cleanly.
  ```

- **Platform extraction assessment** — identify shared logic duplicated across services and evaluate it for extraction into a shared platform package, with maturity track (V0/V1/V2) and migration guidance.

  ```text
  Use platform (read skills/platform/SKILL.md).

  Load archobs data — scan for clusters with high leakage or files with
  high xnbr that appear across service boundaries. Identify duplicated
  patterns (auth wrappers, HTTP/gRPC helpers, config, telemetry, retry
  logic, lifecycle hooks). For each candidate that meets the two-consumer
  rule (2+ services duplicating the logic), produce: API surface, maturity
  track assignment (V0/V1/V2), migration path from inline to shared, and
  seam test strategy.
  ```

## Hardening

- **Security assessment** — attack surface inventory, data sensitivity classification, application of the 5 baseline controls (authn, authz, input validation, injection safety, secrets management), and verification tests.

  ```text
  Use security (read skills/security/SKILL.md).

  Audit the full attack surface of this service. Inventory all boundaries:
  inbound handlers, outbound clients, state stores, logs, admin endpoints.
  Classify data sensitivity (credentials, PII, multi-tenant IDs, regulated
  data) for each boundary. Apply all 5 baseline controls in order —
  document each as applied or explain why it doesn't apply:
  1. Authentication (verify identity)
  2. Authorization (check permissions per action and per resource/tenant)
  3. Input validation (treat external inputs as unknown)
  4. Injection safety (parameterized queries, no string-built interpreters)
  5. Secrets safety (no secrets in logs, errors, or client responses)
  If there are outbound calls, add SSRF hardening (allowlist, block metadata IPs).
  ```

- **Resilience assessment** — failure model, pattern implementations (timeouts, retries, circuit breakers, bulkheads, idempotency), and verification including local failure simulation.

  ```text
  Use resilience (read skills/resilience/SKILL.md).

  Assess all outbound I/O boundaries in this service (HTTP clients, gRPC
  clients, databases, caches, queues, external APIs). For each boundary,
  apply patterns in this order:
  1. Timeouts + cancellation propagation (mandatory)
  2. If retries needed: address idempotency FIRST, then add bounded retries
     with backoff + jitter
  3. Circuit breaker (only for genuinely flakey dependencies, not every call)
  4. Bulkheads / concurrency limits
  Define degradation behavior per boundary (fail fast, return stale data,
  or partial results). Add observability for retry counts, breaker state,
  and error classification.
  ```

- **Observability instrumentation plan** — telemetry field contracts, span/metric/log placement, correlation verification, and an operating ritual defining who reviews what and when.

  ```text
  Use observability (read skills/observability/SKILL.md).

  Instrument all consumer-facing boundaries in this service (HTTP handlers,
  gRPC handlers, event consumers, background jobs). Derive the service name
  from the repo. Every metric must map to a named decision — no "add metrics
  for coverage." Define the unit of work (one trace = one request/job/message).
  Declare a stable field contract (service, env, traceId, spanId, requestId,
  op, etc.). Enforce: low-cardinality metric labels only, log-once at
  boundary, no PII in trace attributes. Verify correlation: given a failure,
  can you follow log -> trace -> metric? Define review ritual (owner, cadence,
  action trigger).
  ```

## Diagnostics

- **Incident diagnosis** — systematic log-trace-metric investigation producing root cause with evidence, failure propagation map, mitigation, fix plan, and learning capture. Provide: the symptom, affected environment, time window, and one exemplar (traceId, requestId, or log timestamp).

  ```text
  Use debug (read skills/debug/SKILL.md).

  Follow the sequence strictly: logs (find exemplar, extract correlation IDs)
  -> traces (confirm root span, find slowest/first-error child) -> metrics
  (widespread or isolated? new regression or gradual?). Map failure propagation
  (what breaks next, what breaks silently, organizational cascade) BEFORE
  deciding on mitigation. Capture learning: telemetry gaps, runbook updates,
  tests to add.
  ```

## Verification & Ship

- **Test suite report** — consumer-visible behavior tests organized by entrypoint, with coverage results, gap identification, and follow-ups.

  ```text
  Use testing (read skills/testing/SKILL.md).

  Identify all consumer-facing entrypoints in this service (HTTP handlers,
  gRPC methods, event consumers, exported functions, job runners). Test both
  success and failure paths for each (invalid input, downstream failures,
  permission denied, timeouts). Mock infrastructure boundaries (DB, cache,
  network), not domain logic. Target 80% coverage of consumer-facing
  behavior. If specs exist, trace each test back to a spec requirement.
  ```

- **Definition-of-done report** — executive packet (for decision-makers), engineer packet (for implementers), and learning loop. Use before merging non-trivial work.

  ```text
  Use finish (read skills/finish/SKILL.md).

  Scope: normal
  Target: changes on the current branch vs main

  Actually run all verification commands and capture output (do not claim
  "tests pass" without evidence). Run archobs regression check against
  baseline. Produce:
  - Executive packet: goal, decision/bet, primary trade-off, success/failure
    signals with review ritual, kill criteria, next step
  - Engineer packet: what changed (3-7 bullets), files touched, verification
    results, risks/follow-ups, rollout watchpoints
  - Learning loop: outcome vs expectation, key assumption confirmed or
    updated (always, even when things went well), process change if diverged
  ```

## Decision Deep-Dives

Use these when standard skill output isn't enough: 3+ options with no clear winner, multiple stakeholders must align, or high ambiguity.

- **Technical design review** — deep stress-test of an architecture decision with assumptions, feedback loops, and second-order effects analysis. Targets the boundary with the highest archobs risk score.

  ```text
  Use architecture (read skills/architecture/SKILL.md).

  Load archobs data first. Identify the boundary or cluster with the
  highest risk score and run the standard architecture workflow for it,
  then additionally run the Technical Design Review template (see
  skills/references/structured-thinking-templates.md) to stress-test:
  assumptions (which are facts vs beliefs?), feedback loops (what
  reinforces or dampens over time?), second-order effects (what changes
  because this changes?).
  ```

- **Trade-off analysis** — structured comparison of options with opportunity cost, kill criteria, and explicit assumptions. Compares the top archobs-suggested improvements.

  ```text
  Use plan (read skills/plan/SKILL.md).

  Load archobs data first. Take the top 2-3 suggestions from archobs and
  compare them using the Trade-Off / Project Decision template (see
  skills/references/structured-thinking-templates.md). Always include the
  status quo as an option. For each: what does it optimize, what does it
  worsen, what assumption would make you abandon it (kill criteria), and
  what's the opportunity cost of choosing it over the alternatives?
  ```

- **Strategic roadmap** — multi-quarter direction setting with initiative portfolio, scenario analysis, and pre-mortem.

  ```text
  Use plan (read skills/plan/SKILL.md).

  Load archobs data for current structural reality. Run forecast in combined
  mode for development momentum + ecosystem signals. Then run the Strategic
  Planning / Roadmap template (see skills/references/structured-thinking-templates.md):
  scenario analysis (best/worst/most-likely), system map (what moves together),
  initiative prioritization with sequencing rationale, and pre-mortem (if this
  roadmap fails in 6 months, what went wrong?).
  ```

- **Retrospective / postmortem** — formal learning capture with outcome-vs-expectation analysis and owner-backed actions. Provide: what happened (delivery, incident, or rollback), the outcome vs expectation, and a timeline of key events.

  ```text
  Use finish (read skills/finish/SKILL.md) for delivery learning,
   or debug (read skills/debug/SKILL.md) for incident triage.

  Run the Retrospective / Postmortem template (see
  skills/references/structured-thinking-templates.md). Focus on:
  - What assumption was wrong or what was learned?
  - One owner-backed action to reduce repeat risk (name the owner)
  - Telemetry or process gaps that made diagnosis harder
  ```

- **Recommendation brief** — structured async review framing with evidence, counterpoints, and explicit next steps. Use for PRs, ADRs, or proposals that need stakeholder sign-off. Provide: the recommendation, who will review it, and key evidence.

  ```text
  Use finish (read skills/finish/SKILL.md).

  Run the Recommendation Brief template (see
  skills/references/structured-thinking-templates.md). Include: the strongest
  counterpoint to the recommendation and why you still recommend it, explicit
  owner for next step, and what "no decision" costs (status quo risk).
  ```
