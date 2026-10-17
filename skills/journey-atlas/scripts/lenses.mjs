// journey-atlas: read the graph through the playbook skills' lenses (architecture, resilience, observability,
// security, platform, design). Each lens turns one skill's guidance into a check over graph.json + derived.json
// and emits candidates to verify in the code — never findings. See references/lenses.md.
//
// Usage: node lenses.mjs --dir <repo>/.journey-atlas [--playbook <skills dir>]
//   reads  graph.json, derived.json, config.json, review.json (lenses verdicts), atlas-data/{crud,dsm,convergence}.json
//   writes lenses.json, prints open candidates by skill and the lenses that ran clean
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE_KINDS } from './lib/catalog.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const dir = path.resolve(arg('dir', '.journey-atlas'))
const readJson = (f, d) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : d)
const g = readJson('graph.json'), d = readJson('derived.json')
if (!g || !d) { console.error(`Need graph.json and derived.json in ${dir}. Run the analyzer and derive.mjs first.`); process.exit(2) }
const config = readJson('config.json', {}), review = readJson('review.json', {})
const crud = readJson('atlas-data/crud.json', []), dsm = readJson('atlas-data/dsm.json', []), hotspots = readJson('atlas-data/hotspots.json', [])
for (const k of ['functions', 'calls', 'externals', 'externalCalls', 'modelQueries', 'events', 'emits', 'handles', 'journeys', 'entries', 'middleware', 'mwPasses', 'throws', 'signals', 'txCalls', 'envReads']) g[k] ??= []

// the playbook: config, env, or the skills installed next to this one (~/.claude/skills/<name>)
const playbook = [arg('playbook'), config.playbook, process.env.JOURNEY_ATLAS_PLAYBOOK, path.resolve(HERE, '../..')]
  .filter(Boolean).map((p) => path.resolve(p.replace(/^~/, process.env.HOME))).find((p) => fs.existsSync(path.join(p, 'architecture', 'SKILL.md')))
const refInfo = (ref) => {
  const [file, anchor] = ref.split('#'), abs = playbook && path.join(playbook, file)
  if (!abs || !fs.existsSync(abs)) return { ref, exists: false }
  const title = fs.readFileSync(abs, 'utf8').split('\n').find((l) => /^#\s/.test(l))?.replace(/^#\s+/, '') ?? file
  return { ref, exists: true, title: anchor ? `${title} § ${anchor.replace(/-/g, ' ')}` : title, path: abs }
}

// ---------------- shared facts ----------------
const fnById = new Map(g.functions.map((f) => [f.id, f]))
const fileOf = (id) => id.split('#')[0]
const nameOf = (id) => fnById.get(id)?.name ?? id.split('#')[1]?.replace(/@\d+$/, '') ?? id
const compOf = new Map((d.functionComponents ?? []).map((r) => [r.fn, r.component]))
const layerOf = new Map((d.components ?? []).map((c) => [c.component, c.layer]))
const extKind = new Map(g.externals.map((e) => [e.name, e.kind]))
const isCore = (s) => CORE_KINDS.has(extKind.get(s))
const sideEffecting = (s) => review.systems?.[s]?.sideEffecting ?? !['database', 'cache', 'observability', 'search', 'secrets', 'auth'].includes(extKind.get(s))
const adj = new Map(), radj = new Map()
for (const c of g.calls) { (adj.get(c.from) ?? adj.set(c.from, []).get(c.from)).push(c.to); (radj.get(c.to) ?? radj.set(c.to, []).get(c.to)).push(c.from) }
const within = (start, graph, hops) => { const seen = new Map([[start, 0]]), q = [start]; while (q.length) { const f = q.shift(), h = seen.get(f); if (h >= hops) continue; for (const t of graph.get(f) ?? []) if (!seen.has(t)) { seen.set(t, h + 1); q.push(t) } } return seen }
const sig = new Map(); for (const s of g.signals) (sig.get(s.fn) ?? sig.set(s.fn, new Map()).get(s.fn)).set(s.signal, s)
const has = (fn, s) => sig.get(fn)?.has(s) ?? false
const extByFn = new Map(); for (const e of g.externalCalls) (extByFn.get(e.from) ?? extByFn.set(e.from, []).get(e.from)).push(e)
const WRITE = /create|update|upsert|delete|save|insert|remove|destroy/i
const writesByFn = new Map(); for (const m of g.modelQueries) if (m.ops.some((o) => WRITE.test(o))) (writesByFn.get(m.from) ?? writesByFn.set(m.from, new Set()).get(m.from)).add(m.model)
const journeys = new Map(g.journeys.map((j) => [j.id, j]))
const userKinds = new Set(['http', 'websocket', 'cli', 'mcp'])
const syncDeps = new Map(), syncWrites = new Map()
for (const r of d.dependsOn ?? []) if (!r.async) (syncDeps.get(r.journey) ?? syncDeps.set(r.journey, new Set()).get(r.journey)).add(r.dep)
for (const r of d.touches ?? []) if (!r.async && r.writes) (syncWrites.get(r.journey) ?? syncWrites.set(r.journey, new Set()).get(r.journey)).add(r.model)
// per-journey sync reach (needed to anchor candidates on the functions that matter)
const entriesOf = new Map(); for (const e of g.entries) (entriesOf.get(e.journey) ?? entriesOf.set(e.journey, []).get(e.journey)).push(e.fn)
const detached = new Set(g.calls.filter((c) => c.kind === 'detached').map((c) => c.from + '|' + c.to))
const reachSync = new Map()
for (const j of g.journeys) {
  const seen = new Set(entriesOf.get(j.id) ?? []), q = [...seen]
  while (q.length) { const f = q.shift(); for (const t of adj.get(f) ?? []) if (!seen.has(t) && !detached.has(f + '|' + t)) { seen.add(t); q.push(t) } }
  reachSync.set(j.id, seen)
}
const reachedAny = new Set([...reachSync.values()].flatMap((s) => [...s]))
const mwKinds = new Map(g.middleware.map((m) => [m.name, m.kind]))
const chainKinds = (jid) => new Set(g.mwPasses.filter((p) => p.journey === jid).map((p) => mwKinds.get(p.mw)))
const callersOf = (dep) => [...new Set(g.externalCalls.filter((e) => e.dep === dep).map((e) => e.from))]
const cap = (xs, n = 12) => (xs.length > n ? [...xs.slice(0, n), `…+${xs.length - n}`] : xs)
const MONEY = config.moneyTables ? new RegExp(config.moneyTables) : /payment|charge|order|invoice|refund|transaction|ledger|balance|payout|subscription|credit|wallet/i
// tables whose rows ARE value (a ledger entry, a payment, a balance), not configuration about money
const VALUE_TABLES = config.valueTables ? new RegExp(config.valueTables) : /(^|_)(payments?|charges?|invoices?|refunds?|transactions?|ledgers?|balances?|payouts?|credits?|wallets?)$/i
// fields that count or version rows rather than hold value
const COUNTER_FIELD = /version|revision|attempt|count|seq|retries|generation|epoch|_used$/i
const idemGuard = (f) => has(f, 'idempotency-key') || has(f, 'idempotent-write')
const samplesOf = (fn, s) => [...(sig.get(fn)?.get(s)?.samples ?? [])]
// scheduled journeys: a job that reaches the same writes as an event handler re-drives what a lost event would have done
const jobReach = g.journeys.filter((j) => j.kind === 'scheduled').map((j) => [j.id, reachSync.get(j.id) ?? new Set()])
// best-effort systems: a lost or repeated message is tolerable by design (notifications). They still count as
// side effects for recovery, but not as a leg that needs compensation, idempotency or loud failure.
// review.json systems.<name>.bestEffort overrides the kind default.
const BEST_EFFORT_KINDS = new Set(config.bestEffortKinds ?? ['email', 'sms', 'notifications', 'chat'])
const bestEffort = (s) => review.systems?.[s]?.bestEffort ?? BEST_EFFORT_KINDS.has(extKind.get(s))
const stateChanging = (s) => !isCore(s) && sideEffecting(s) && !bestEffort(s)
const timeoutExempt = new Set(['cache', ...(config.timeoutExemptKinds ?? [])])
// functions already raised by an earlier lens (filled as lenses run), so a later lens can skip the same site
const raised = new Map()

// ---------------- lenses ----------------
// Each: id, skill, refs (paths under the playbook's skills dir), question (the skill's own words), run() → candidates
// candidate: { key, title, evidence, anchors: {functions, systems, models, components, journeys}, verify }
const LENSES = [
  // ---- architecture
  { id: 'non-atomic-action', skill: 'architecture', aliases: ['dual-write', 'multi-step-side-effects'],
    refs: ['architecture/references/transactional-outbox.md', 'architecture/references/polling-publisher.md', 'architecture/references/saga.md'],
    question: 'Does one action change state in two places (local tables and an external system, or two external systems) with no shared transaction, outbox or compensation?',
    run() {
      // one candidate per set of state-changing systems; best-effort legs (email, SMS, push, chat) don't count.
      // A journey that writes locally is a dual write (outbox); one with 2+ external legs is a saga question.
      const groups = new Map()
      for (const [jid, deps] of syncDeps) {
        const effects = [...deps].filter(stateChanging).sort(), writes = [...(syncWrites.get(jid) ?? [])]
        if (writes.some((m) => /outbox|event_log|pending_event/i.test(m))) continue
        if (!(effects.length >= 2 || (effects.length && writes.length))) continue
        const key = effects.join('+')
        const gr = groups.get(key) ?? groups.set(key, { effects, writes: new Set(), journeys: [], local: false }).get(key)
        writes.forEach((w) => gr.writes.add(w)); gr.journeys.push(jid); if (writes.length) gr.local = true
      }
      return [...groups].map(([key, gr]) => {
        // verdicts recorded under the old lenses: dual-write keyed by the full effect set (best-effort legs included,
        // so any superset), multi-step keyed by journey
        const aliases = [...(review.lenses ? Object.keys(review.lenses) : [])].filter((id) => (id.startsWith('dual-write:') && id.slice(11).split('+').filter((s) => !bestEffort(s)).sort().join('+') === key) || (id.startsWith('multi-step-side-effects:') && gr.journeys.includes(id.slice(24))))
        const kind = gr.effects.length >= 2 ? `${gr.local ? 'local tables and ' : ''}${gr.effects.join(' and ')}` : `local tables and ${gr.effects[0]}`
        return { key, aliases, rank: -gr.effects.length * 100 - gr.journeys.length, title: `${gr.journeys.length} journey(s) change ${kind} with no outbox or compensation`,
          evidence: `${gr.writes.size ? `writes ${cap([...gr.writes], 6).join(', ')}; ` : ''}journeys ${cap(gr.journeys, 4).join(', ')}`,
          anchors: { systems: gr.effects, models: cap([...gr.writes], 8), journeys: gr.journeys, functions: cap(gr.effects.flatMap(callersOf), 10) },
          verify: 'If one leg fails after another succeeded, what state is left? Is there a transaction, an outbox, a re-driving job or a compensation for each leg?' }
      })
    } },
  { id: 'shared-writer', skill: 'architecture', refs: ['architecture/references/aggregate.md', 'architecture/references/shared-database.md'],
    question: 'Who owns each piece of data? Is the source of truth written by one component?',
    run() {
      // writers per table from the code, split by whether any journey reaches the writing function
      const w = new Map()
      for (const [fn, models] of writesByFn) for (const m of models) { const t = w.get(m) ?? w.set(m, new Map()).get(m); const c = compOf.get(fn); const e = t.get(c) ?? t.set(c, { live: [], dead: [] }).get(c); (reachedAny.has(fn) ? e.live : e.dead).push(fn) }
      const money = MONEY
      return [...w].filter(([, cs]) => cs.size > 1).sort(([a, x], [b, y]) => y.size - x.size || money.test(b) - money.test(a)).map(([table, cs]) => {
        const live = [...cs].filter(([, e]) => e.live.length).map(([c]) => c), deadOnly = [...cs].filter(([, e]) => !e.live.length).map(([c]) => c)
        return { key: table, title: `${table} is written by ${cs.size} components${deadOnly.length ? ` (${deadOnly.join(', ')} only via unreached code)` : ''}`,
          evidence: [...cs].map(([c, e]) => `${c}: ${[...e.live, ...e.dead].map((f) => nameOf(f) + (e.live.includes(f) ? '' : ' (unreached)')).join(', ')}`).join('; '),
          // anchor one live writer per component (where an owner would take over), not every writer
          anchors: { models: [table], components: [...cs.keys()], functions: [...cs.values()].map((e) => e.live[0] ?? e.dead[0]).filter(Boolean) },
          verify: live.length > 1 ? 'Do the writers enforce the same invariants? Should one component (aggregate) own every write?' : 'Only one live writer: is the unreached writer dead code that should go?' }
      })
    } },
  { id: 'implicit-data-contract', skill: 'architecture', refs: ['architecture/references/shared-database.md', 'spec/SKILL.md'],
    question: 'Is data read across component boundaries through a defined contract, or by reaching into storage?',
    run() {
      const by = new Map(); for (const r of crud) { const t = by.get(r.table) ?? by.set(r.table, { w: [], r: [] }).get(r.table); if (r.C || r.U || r.D) t.w.push(r.component); else if (r.R) t.r.push(r.component) }
      return [...by].filter(([, t]) => t.w.length === 1 && t.r.filter((c) => c !== t.w[0]).length >= 2).map(([table, t]) => ({ key: table,
        title: `${table} is written by ${t.w[0]} and read directly by ${t.r.length} other components`, evidence: `readers: ${t.r.join(', ')}`,
        anchors: { models: [table], components: [...t.w, ...t.r] }, verify: 'Is the table/artifact name and shape defined in one place the readers import, or repeated in each reader? Would a rename break readers silently?' }))
    } },
  { id: 'no-single-adapter', skill: 'architecture', aliases: ['direct-integration', 'domain-calls-infrastructure'],
    refs: ['architecture/references/anti-corruption-layer.md', 'architecture/SKILL.md#domain-driven-design-ddd', 'design/references/patterns-structural.md'],
    question: 'Is each external system reached through one adapter (anti-corruption layer / port), or from several places, some of them mixed with domain work?',
    run() {
      // one candidate per system, combining the three symptoms of a missing adapter: call sites spread over
      // files/components, domain-layer files that mix the call with table writes or another system, and call
      // sites that apply different controls (timeouts)
      const byFile = new Map()
      for (const f of g.functions) { const r = byFile.get(f.file) ?? byFile.set(f.file, { systems: new Set(), writes: new Set() }).get(f.file); for (const m of writesByFn.get(f.id) ?? []) r.writes.add(m); for (const e of extByFn.get(f.id) ?? []) if (!isCore(e.dep)) r.systems.add(e.dep) }
      return g.externals.filter((e) => !isCore(e.name)).map((e) => {
        const fns = callersOf(e.name), files = [...new Set(fns.map(fileOf))], comps = [...new Set(fns.map((f) => compOf.get(f)))]
        const mixed = files.filter((file) => { const r = byFile.get(file); const c = compOf.get(fns.find((f) => fileOf(f) === file)); return r && ['domain', 'entry', 'shared', 'middleware'].includes(layerOf.get(c)) && (r.systems.size > 1 || r.writes.size) })
        const sites = (d.callSites ?? []).filter((c) => c.dep === e.name && !timeoutExempt.has(extKind.get(e.name))), uneven = sites.some((c) => c.timeout) && sites.some((c) => !c.timeout)
        return { e, fns, files, comps, mixed, uneven }
      }).filter((x) => x.comps.length >= 2 || x.files.length >= 3 || (x.mixed.length && x.files.length >= 2)).map(({ e, fns, files, comps, mixed, uneven }) => ({ key: e.name,
        aliases: [`direct-integration:${e.name}`, ...comps.map((c) => `domain-calls-infrastructure:${c} → ${e.name}`)],
        rank: -(files.length + 2 * mixed.length + (uneven ? 3 : 0)),
        title: `${e.name} is called from ${files.length} files in ${comps.length} components${mixed.length ? `; ${mixed.length} also do domain work` : ''}${uneven ? '; call sites apply different timeouts' : ''}`,
        evidence: cap(files.map((f) => f + (mixed.includes(f) ? ' (mixed)' : '')), 6).join(', '),
        anchors: { systems: [e.name], functions: cap(fns, 10), components: comps },
        verify: 'Do the call sites translate the external model the same way (errors, retries, types, timeouts)? Can the domain code be tested without the system? Would one adapter (port + adapter file) remove the duplication?' }))
    } },
  { id: 'fan-out-wait', skill: 'architecture', refs: ['architecture/references/api-composition.md', 'resilience/references/checklists.md'],
    question: 'Does a single request wait on several systems in sequence? Is there a time budget and a partial-result plan?',
    run() {
      return [...syncDeps].map(([jid, deps]) => [jid, [...deps].filter((s) => !isCore(s))]).filter(([, s]) => s.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 15)
        .map(([jid, s]) => ({ key: jid, title: `${jid} waits on ${s.length} systems`, evidence: s.join(', '), anchors: { journeys: [jid], systems: s, functions: s.flatMap(callersOf).filter((f) => reachSync.get(jid)?.has(f)) },
          verify: 'Are the waits sequential or parallel? Is there an overall time budget? What does the user get if one of them fails?' }))
    } },
  { id: 'event-without-handler', skill: 'architecture', refs: ['architecture/references/domain-event.md'],
    question: 'Is every published domain event consumed by someone?',
    run() {
      const handled = new Set(g.handles.map((h) => h.event))
      return g.events.filter((e) => !handled.has(e.id)).map((e) => ({ key: e.id, title: `event ${e.name} has no handler in this repo`, evidence: `emitted by ${g.emits.filter((x) => x.event === e.id).map((x) => nameOf(x.from)).join(', ') || '?'}`,
        anchors: { functions: g.emits.filter((x) => x.event === e.id).map((x) => x.from) }, verify: 'Is it consumed by another repo/service, or dead?' }))
    } },
  { id: 'lossy-event-transport', skill: 'architecture', refs: ['architecture/references/messaging.md', 'architecture/references/transactional-outbox.md', 'architecture/references/idempotent-consumer.md'],
    question: 'Are events that cross process boundaries delivered at-least-once, or is there a pull-based backstop when one is lost?',
    run() {
      // events on a transport other than in-process (pub/sub, NOTIFY, broker) reach other instances; fire-and-forget
      // delivery loses them when the publish fails or a subscriber is disconnected. One candidate per emitter.
      const by = new Map()
      for (const e of g.events.filter((x) => x.transport && x.transport !== 'in-process')) {
        const r = by.get(e.emitter) ?? by.set(e.emitter, { transport: e.transport, events: [], writers: new Set(), handlers: new Set(), backstops: new Set(), emitters: new Set() }).get(e.emitter)
        r.events.push(e.name)
        for (const x of g.emits.filter((m) => m.event === e.id)) r.emitters.add(x.from)
        for (const h of g.handles.filter((x) => x.event === e.id)) {
          r.handlers.add(h.to)
          const reach = within(h.to, adj, 6), writes = [...reach.keys()].filter((f) => writesByFn.has(f) || (extByFn.get(f) ?? []).some((x) => !isCore(x.dep) && sideEffecting(x.dep)))
          writes.forEach((f) => r.writers.add(f))
          for (const [jid, jr] of jobReach) if (jr.has(h.to) || writes.some((f) => jr.has(f))) r.backstops.add(jid)
        }
      }
      return [...by].filter(([, r]) => r.handlers.size).map(([emitter, r]) => ({ key: emitter, rank: (r.backstops.size ? 0 : -1000) - r.writers.size - r.handlers.size,
        title: `${emitter} (${r.transport}): ${r.events.length} event(s), ${r.handlers.size} handler(s)${r.writers.size ? `, ${r.writers.size} writing function(s) downstream` : ''}${r.backstops.size ? '' : ', no job reaches the same work'}`,
        evidence: `events ${cap(r.events, 8).join(', ')}${r.backstops.size ? `; possible backstop: ${cap([...r.backstops], 3).join(', ')}` : ''}`,
        anchors: { functions: [...r.emitters, ...r.handlers], journeys: [...r.backstops] },
        verify: 'If one publish is lost (broker down, subscriber reconnecting), what stays wrong and for how long? Is there a durable record (outbox, the rows themselves) and something that re-reads it (a sweep, a revision check, a cache TTL)?' }))
    } },
  { id: 'no-health-check', skill: 'architecture', refs: ['architecture/references/health-check-api.md'],
    question: 'Does the service expose liveness/readiness for orchestration?',
    run() {
      const http = g.journeys.filter((j) => j.kind === 'http')
      return http.length && !http.some((j) => /\/(health|healthz|ready|readyz|live|livez|ping|status)\b/i.test(j.path ?? j.id)) ? [{ key: 'service', title: `${http.length} HTTP routes and no health/readiness route`, evidence: '', anchors: {}, verify: 'Is health served elsewhere (framework, sidecar, load balancer)?' }] : []
    } },
  // ---- resilience
  { id: 'unbounded-wait', skill: 'resilience', aliases: ['inconsistent-boundary-controls'],
    refs: ['resilience/references/checklists.md', 'architecture/references/decision-tree.md', 'platform/references/boundary-wrappers.md'],
    question: 'Every outbound call has a timeout (unbounded timeouts: requests pile up, saturate pools). Where some call sites have one and others do not, one wrapper should apply it everywhere.',
    run() {
      // per boundary (`via` when the analyzer sets it, else the system). "mixed": some sites of the same boundary
      // already set a timeout across 2+ files, so the fix is a shared wrapper (platform), not per-call timeouts.
      const groups = new Map()
      for (const c of d.callSites ?? []) { if (timeoutExempt.has(extKind.get(c.dep))) continue; const e = g.externalCalls.find((x) => x.from === c.fn && x.dep === c.dep); const k = e?.via ?? c.dep; (groups.get(k) ?? groups.set(k, []).get(k)).push(c) }
      return [...groups].map(([k, cs]) => ({ k, cs, missing: cs.filter((c) => c.sync && !c.timeout) })).filter((x) => x.missing.length).map(({ k, cs, missing }) => {
        const mixed = cs.some((c) => c.timeout) && new Set(cs.map((c) => c.file)).size >= 2
        return { key: k, aliases: [`inconsistent-boundary-controls:${k}`], skill: mixed ? 'platform' : undefined, rank: -(mixed ? 1000 : 0) - missing.length,
          title: `${k}: ${missing.length} call site(s) with no timeout${mixed ? `; ${cs.filter((c) => c.timeout).length} of ${cs.length} sites elsewhere set one (mixed)` : ''}`,
          evidence: mixed ? cs.map((c) => `${nameOf(c.fn)}${c.timeout ? ' ✓' : ' ✗'}`).join(', ') : missing.map((c) => nameOf(c.fn)).join(', '),
          anchors: { systems: [...new Set(cs.map((c) => c.dep))], functions: missing.map((c) => c.fn) },
          verify: mixed ? 'Does the client set a default timeout elsewhere (constructor, instance, env)? Would one wrapper (timeouts, error mapping, logging) used by every call site remove the inconsistency?'
            : 'Does the client set a default timeout elsewhere (constructor, instance, env)? Can the call hang forever?' }
      })
    } },
  { id: 'retry-without-idempotency', skill: 'resilience', refs: ['resilience/references/checklists.md', 'architecture/references/decision-tree.md'],
    question: 'Retries without idempotency: never.',
    // a repeated notification is the accepted cost of retrying a best-effort system
    run() { return (d.callSites ?? []).filter((c) => c.retry_without_idempotency && !bestEffort(c.dep)).map((c) => ({ key: `${c.dep}@${c.fn}`, title: `${nameOf(c.fn)} retries ${c.dep} without an idempotency key`, evidence: `retry evidence: ${c.retry}`, anchors: { systems: [c.dep], functions: [c.fn] }, verify: 'Can a retried request apply twice server-side?' })) } },
  { id: 'persisted-silent-failure', skill: 'resilience', refs: ['resilience/references/checklists.md', 'observability/references/checklists.md'],
    question: 'Is a failed external call turned into an ordinary result and then saved, so the failure outlives the run?',
    run() {
      // the swallow sits on the external call (itself or a direct callee); a caller within 2 hops then saves the
      // returned value: it writes a table, or calls a cache/persist/save helper (file-backed stores have no ORM verbs)
      const PERSIST = /cache|persist|save/i
      return g.signals.filter((s) => /swallowed/.test(s.signal) && s.signal !== 'error-reported-and-swallowed').flatMap((s) => {
        // swallowing a best-effort send is the design; only failures of systems whose answer matters can be saved
        const down = [...within(s.fn, adj, 1).keys()].flatMap((f) => (extByFn.get(f) ?? []).filter((e) => !isCore(e.dep) && !bestEffort(e.dep)).map((e) => e.dep))
        if (!down.length) return []
        const ups = [...within(s.fn, radj, 2).keys()].filter((u) => u !== s.fn)
        const persisters = [...new Set(ups.flatMap((u) => [u, ...(adj.get(u) ?? []).filter((t) => t !== s.fn && !within(s.fn, radj, 2).has(t))]).filter((f) => writesByFn.has(f) || PERSIST.test(nameOf(f).split('.').pop())))]
        if (!persisters.length) return []
        return [{ key: s.fn, rank: -persisters.length, title: `${nameOf(s.fn)} swallows ${[...new Set(down)].join(', ')} failures; a caller then saves results`, evidence: `${s.samples?.[0] ?? fileOf(s.fn)}; saved by ${cap(persisters.map(nameOf), 4).join(', ')}`,
          anchors: { functions: [s.fn, ...new Set(persisters)], systems: [...new Set(down)] }, verify: 'Is the failure distinguishable from an empty/negative result by the time it is saved? Does a later run trust the saved value?' }]
      })
    } },
  { id: 'repeat-unsafe-write', skill: 'resilience', aliases: ['non-idempotent-value-write', 'consumer-without-idempotency'],
    refs: ['resilience/references/checklists.md', 'architecture/references/idempotent-consumer.md'],
    question: 'If the same request, message, event or job run arrives twice, can it apply its effect twice?',
    run() {
      // one question for every trigger. What is written decides severity: value (an increment of a balance-like
      // field, or a new row in a value table) ranks first. User actions are raised only for value writes (any
      // other user write is usually an idempotent edit); consumers, jobs and event handlers for any write, since
      // at-least-once delivery and re-runs are their normal mode.
      const valueInc = (f) => samplesOf(f, 'value-increment').filter((s) => { const [, dir, field = ''] = s.split(' '); return /increment|\$inc/.test(dir ?? s) && !COUNTER_FIELD.test(field) })
      const valueCreates = (f) => g.modelQueries.filter((m) => m.from === f && VALUE_TABLES.test(m.model) && m.ops.some((o) => /^(create|insert|save)/.test(o))).map((m) => m.model)
      const writes = (f) => writesByFn.has(f) || (extByFn.get(f) ?? []).some((e) => stateChanging(e.dep))
      const out = []
      const consider = (key, trigger, reach, extra) => {
        if ([...reach].some(idemGuard)) return
        const inc = [...reach].filter((f) => valueInc(f).length), creates = [...reach].filter((f) => valueCreates(f).length)
        const value = inc.length + creates.length > 0, other = trigger === 'user' ? [] : [...reach].filter(writes)
        if (!value && !other.length) return
        const tables = [...new Set([...inc.flatMap((f) => valueInc(f).map((s) => s.split('.')[0])), ...creates.flatMap(valueCreates)])]
        out.push({ key, aliases: [`non-idempotent-value-write:${key}`, `consumer-without-idempotency:${key}`],
          rank: -(inc.length ? 2000 : 0) - (value ? 1000 : 0) - inc.length * 10 - creates.length,
          title: `${extra?.title ?? key} (${trigger}) ${inc.length ? `increments ${cap(tables, 3).join(', ')}` : value ? `creates ${cap(tables, 3).join(', ')}` : 'writes'} with no idempotency guard`,
          evidence: [inc.length ? `increments: ${cap(inc.flatMap((f) => valueInc(f).map((s) => `${nameOf(f)} (${s})`)), 3).join(', ')}` : '', creates.length ? `creates: ${cap(creates.map(nameOf), 4).join(', ')}` : '', !value ? `writes: ${cap(other.map(nameOf), 5).join(', ')}` : ''].filter(Boolean).join('; '),
          anchors: { journeys: extra?.journeys ?? [key], functions: cap([...(extra?.fns ?? []), ...(value ? [...inc, ...creates] : other)], 10), models: tables },
          verify: trigger === 'user' ? 'If the same request arrives twice (double click, retry after a lost response), what stops the second one? A unique key, a state check under a row lock, or nothing?'
            : trigger === 'event' ? 'Can this event be delivered twice (retries, replays, several emitters or replicas)? What makes the second delivery a no-op?'
            : 'What happens when the same message or run is processed twice (overlapping runs, a crash before commit)?' })
      }
      for (const j of g.journeys) {
        if (j.kind === 'websocket' || (j.kind === 'http' && /POST|PUT|PATCH|\*/.test(j.method ?? ''))) consider(j.id, 'user', reachSync.get(j.id) ?? new Set())
        else if (['consumer', 'scheduled'].includes(j.kind)) consider(j.id, j.kind === 'consumer' ? 'consumer' : 'job', reachSync.get(j.id) ?? new Set())
      }
      for (const h of g.handles) consider(`${h.event}→${h.to}`, 'event', new Set(within(h.to, adj, 6).keys()), { title: `handler of ${h.event}`, journeys: [], fns: [h.to] })
      return out
    } },
  { id: 'destructive-error-handling', skill: 'resilience', refs: ['resilience/references/checklists.md', 'security/references/checklists.md#secrets-and-sensitive-data'],
    question: 'Does an error path erase or blank persisted data, so a transient or self-inflicted failure (config, key, deploy) destroys good state?',
    run() {
      // only writes to stored data: the receiver must be a table/model the graph knows (not a Map, cache or stream)
      const models = new Set(g.modelQueries.map((m) => m.model))
      return g.signals.filter((s) => s.signal === 'clears-data-in-catch').map((s) => ({ ...s, samples: (s.samples ?? []).filter((x) => models.has(x.split('.')[0]) || /^\$executeRaw/.test(x.split('.')[1] ?? '')) })).filter((s) => s.samples.length).map((s) => {
        const samples = s.samples, unconditional = samples.filter((x) => !/\(conditional\)/.test(x))
        return { key: s.fn, rank: -(unconditional.length ? 100 : 0) - s.count, title: `${nameOf(s.fn)} ${unconditional.length ? 'blanks or deletes data on any error' : 'blanks or deletes data on some errors'}`,
          evidence: samples.join(', '), anchors: { functions: [s.fn], models: [...(writesByFn.get(s.fn) ?? [])] },
          verify: 'Which errors reach this branch? Can any come from our side (missing/rotated key, config, a dependency outage) rather than truly bad data? If so, the write destroys good state: return/flag instead of erasing.' }
      })
    } },
  { id: 'hot-dependency-without-breaker', skill: 'resilience', refs: ['architecture/references/circuit-breaker.md', 'resilience/references/checklists.md'],
    question: 'When a dependency many journeys wait on is down, do callers fail fast or pile up?',
    run() {
      const users = g.journeys.filter((j) => userKinds.has(j.kind)).length, cnt = new Map()
      for (const [jid, deps] of syncDeps) if (userKinds.has(journeys.get(jid)?.kind)) for (const s of deps) if (!isCore(s)) cnt.set(s, (cnt.get(s) ?? 0) + 1)
      return [...cnt].filter(([s, n]) => n >= Math.max(5, users * 0.2) && !(d.callSites ?? []).some((c) => c.dep === s && c.circuit_breaker)).map(([s, n]) => ({ key: s, title: `${n} user journeys wait on ${s} with no circuit breaker`, evidence: `${Math.round((100 * n) / users)}% of user journeys`,
        anchors: { systems: [s], functions: callersOf(s) }, verify: 'Is this a remote dependency that can be slow/down for minutes? If local or always-up, dismiss.' }))
    } },
  // ---- observability
  { id: 'silent-failure-near-effects', skill: 'observability', refs: ['observability/references/checklists.md', 'architecture/references/exception-tracking.md'],
    question: 'What can degrade without obvious alerts? (errors swallowed with no log near side effects or writes)',
    run() {
      // the visibility question only: a swallow that persisted-silent-failure or destructive-error-handling already
      // raised has a worse consequence and is reviewed there. Best-effort sends near the swallow don't count.
      const already = new Set([...(raised.get('persisted-silent-failure') ?? []), ...(raised.get('destructive-error-handling') ?? [])])
      return g.signals.filter((s) => s.signal === 'error-silently-swallowed' && !already.has(s.fn)).flatMap((s) => {
        const near = [...within(s.fn, adj, 4).keys()], effects = [...new Set(near.flatMap((f) => (extByFn.get(f) ?? []).filter((e) => stateChanging(e.dep)).map((e) => e.dep)))], writes = [...new Set(near.flatMap((f) => [...(writesByFn.get(f) ?? [])]))]
        return effects.length || writes.length ? [{ key: s.fn, title: `${nameOf(s.fn)} swallows errors with no log`, evidence: `${(s.samples ?? [fileOf(s.fn)]).join('; ')}${effects.length ? `; near ${effects.join(', ')}` : ''}${writes.length ? `; writes ${cap(writes, 3).join(', ')}` : ''}`, anchors: { functions: [s.fn], systems: effects, models: cap(writes, 6) }, verify: 'Is the swallowed error expected and harmless (e.g. optional file), or does it hide lost work?' }] : []
      })
    } },
  { id: 'churn-with-quiet-failures', skill: 'observability', tier: 'inventory', refs: ['observability/references/checklists.md', 'architecture/references/exception-tracking.md'],
    question: 'Where does frequent change meet errors that are handled out of sight? (the places a regression ships unnoticed)',
    run() {
      // hotspots.json: commits in the churn window and swallow sites per file; thresholds scale with the repo
      const commits = hotspots.map((h) => h.commits_90d ?? 0).sort((a, b) => a - b), p75 = commits[Math.floor(commits.length * 0.75)] ?? 0
      return hotspots.filter((h) => (h.commits_90d ?? 0) >= Math.max(10, p75) && (h.quiet_gaps ?? 0) >= 5).map((h) => ({ key: h.file, rank: -(h.commits_90d * h.quiet_gaps),
        title: `${h.file}: ${h.commits_90d} commits in the churn window, ${h.quiet_gaps} error-swallowing sites, ${h.journeys} journeys`,
        evidence: `${h.component}; ${h.user_types} user type(s)`, anchors: { functions: g.functions.filter((f) => f.file === h.file && (has(f.id, 'error-silently-swallowed') || has(f.id, 'error-logged-and-swallowed'))).map((f) => f.id) },
        verify: 'Would a regression in this file show up anywhere (alert, error tracker, metric), or only as quietly wrong data? Which swallow sites deserve a counter or an error report?' }))
    } },
  { id: 'no-edge-error-handler', skill: 'observability', refs: ['observability/references/checklists.md', 'architecture/references/exception-tracking.md'],
    question: 'One high-quality error log per request at the edge — is there an edge handler for unexpected errors?',
    run() {
      const by = new Map()
      for (const j of g.journeys.filter((x) => userKinds.has(x.kind))) {
        if (chainKinds(j.id).has('error-handling')) continue
        const fns = [...(reachSync.get(j.id) ?? [])].filter((f) => g.throws.some((t) => t.fn === f && t.category === 'generic 500'))
        if (fns.length) { const a = d.journeys?.find((x) => x.id === j.id)?.area ?? j.kind; const r = by.get(a) ?? by.set(a, { js: [], fns: new Set() }).get(a); r.js.push(j.id); fns.forEach((f) => r.fns.add(f)) }
      }
      return [...by].map(([area, r]) => ({ key: area, title: `${area}: ${r.js.length} journey(s) can end in an unhandled error with no edge handler`, evidence: cap([...r.fns].map(nameOf), 5).join(', '), anchors: { journeys: r.js, functions: cap([...r.fns], 10) }, verify: 'Does a framework default handler log/map these (Express default, typer traceback)? Is the output useful to the operator?' }))
    } },
  { id: 'no-boundary-telemetry', skill: 'observability', refs: ['observability/references/checklists.md', 'architecture/references/application-metrics.md', 'architecture/references/distributed-tracing.md'],
    question: 'For each boundary: is there a span, RED metrics and a correlated log?',
    run() {
      const obsSystems = new Set(g.externals.filter((e) => e.kind === 'observability').map((e) => e.name))
      const bare = g.journeys.filter((j) => userKinds.has(j.kind) || ['consumer', 'scheduled'].includes(j.kind)).filter((j) => !chainKinds(j.id).has('observability') && ![...(syncDeps.get(j.id) ?? [])].some((s) => obsSystems.has(s)))
      return bare.length ? [{ key: 'journeys', title: `${bare.length} of ${g.journeys.length} journeys have no tracing/metrics middleware and reach no telemetry system`, evidence: cap(bare.map((j) => j.id), 6).join(', '), anchors: { journeys: bare.map((j) => j.id) }, verify: 'Is telemetry injected outside the code (agent, mesh, auto-instrumentation)? For a CLI, is run duration/outcome recorded anywhere?' }] : []
    } },
  // ---- security
  { id: 'shell-invocation', skill: 'security', refs: ['security/references/checklists.md#injection-and-interpreter-boundaries'],
    question: 'Shell: avoid invoking a shell; pass arguments as an array.',
    run() { return g.signals.filter((s) => s.signal === 'shell-invocation').map((s) => ({ key: s.fn, title: `${nameOf(s.fn)} invokes a shell`, evidence: (s.samples ?? []).join('; '), anchors: { functions: [s.fn] }, verify: 'Can any part of the command string come from input?' })) } },
  { id: 'unvalidated-writes', skill: 'security', refs: ['security/references/checklists.md#input-validation', 'typescript/references/guidelines.md'],
    question: 'Treat all external inputs as unknown and decode once at the edge.',
    run() {
      const bad = (d.posture ?? []).filter((p) => journeys.get(p.journey)?.kind === 'http' && !p.validationPipeline && !p.validationHandler && syncWrites.has(p.journey))
      const by = new Map(); for (const p of bad) { const a = d.journeys?.find((x) => x.id === p.journey)?.area ?? '?'; (by.get(a) ?? by.set(a, []).get(a)).push(p.journey) }
      return [...by].map(([area, js]) => ({ key: area, title: `${area}: ${js.length} writing route(s) with no input validation found`, evidence: cap(js, 5).join(', '), anchors: { journeys: js }, verify: 'Is the body decoded by a schema the analyzer missed (custom validator, ORM-level types)?' }))
    } },
  { id: 'shared-secret-purpose', skill: 'security', refs: ['security/references/checklists.md#secrets-and-sensitive-data', 'architecture/references/externalized-configuration.md'],
    question: 'Does each secret protect one thing, so it can be rotated or revoked without breaking unrelated features?',
    run() {
      // a purpose is what the key signs or encrypts: the noun in the crypto function that uses it (encryptGbpToken →
      // ApiToken, signSessionToken → SessionToken). API credentials (no crypto verb) are one purpose by nature.
      const SECRET = /(KEY|SECRET|PASSPHRASE|SALT|PRIVATE)/, NOT_SECRET = /(PUBLIC|_URL$|_ID$|_SID$|_HOST$|_PORT$|_TTL|_MS$|_SECONDS$|_MINUTES$|_COUNT$|_LIMIT$|_SIZE$|_ENABLED$|API_KEY$|ACCESS_KEY|SERVICE_KEY)/
      // encrypt/hash verbs always use the key; sign/verify/issue only when the object is a token-like thing
      // (signIn, verifySite are not crypto)
      const CRYPTO = /^(encrypt|decrypt|sign|verify|hash|hmac|cipher|decipher|seal|unseal|derive|issue|mint)(?=[A-Z_]|$)/i
      const TOKENISH = /^(|Token|\w*(Token|Jwt|Signature|State|Cookie|Session|Link|Url))$/
      const purposeOf = (f) => { const n = nameOf(f), m = n.split('.').pop(); if (!CRYPTO.test(m)) return null; const noun = m.replace(CRYPTO, '').replace(/^_/, ''); if (/^(sign|verify|issue|mint)/i.test(m) && !TOKENISH.test(noun)) return null; return noun && !/^(Token|Jwt|Data|Value|Payload|With\w*)$/i.test(noun) ? noun : `${n.includes('.') ? n.split('.')[0].replace(/Service$/, '') : fileOf(f).split('/').pop().replace(/\.\w+$/, '')}:${noun || m}` }
      const readers = new Map(); for (const r of g.envReads) if (SECRET.test(r.key) && !NOT_SECRET.test(r.key)) (readers.get(r.key) ?? readers.set(r.key, new Set()).get(r.key)).add(r.fn)
      return [...readers].map(([key, fns]) => {
        const purposes = new Map()
        // the reader itself, or a caller up to 2 hops away (key getter → encryptX → caller)
        for (const f of fns) for (const [u] of within(f, radj, 2)) { const p = purposeOf(u); if (p) (purposes.get(p) ?? purposes.set(p, new Set()).get(p)).add(u) }
        return { key, fns: [...fns], purposes }
      }).filter((x) => x.purposes.size >= 2).map(({ key, fns, purposes }) => ({ key, rank: -purposes.size,
        title: `${key} protects ${purposes.size} different things: ${cap([...purposes.keys()], 5).join(', ')}`,
        evidence: `read in ${cap(fns.map(nameOf), 4).join(', ')}; used by ${[...purposes].map(([p, us]) => `${p} (${cap([...us].map(nameOf), 2).join(', ')})`).join('; ')}`,
        anchors: { functions: [...fns, ...[...purposes.values()].flatMap((s) => [...s])], components: [...new Set([...purposes.values()].flatMap((s) => [...s].map((f) => compOf.get(f))).filter(Boolean))] },
        verify: 'Are these the same purpose (one token audience, one data class) or unrelated ones? If unrelated, can the secret be rotated without breaking one of them? Does decryption accept a previous key during rotation?' }))
    } },
  // ---- platform: mixed boundary controls are raised by unbounded-wait (skill: platform on those candidates)
  // ---- design
  { id: 'upward-or-cyclic-dependency', skill: 'design', tier: 'inventory', refs: ['design/SKILL.md#guardrails', 'design/references/patterns-structural.md'],
    question: 'Do calls point down the layering, and are component cycles intentional?',
    run() {
      return dsm.filter((r) => r.direction === 'up' || r.cycle).map((r) => {
        const pairs = g.calls.filter((c) => compOf.get(c.from) === r.from && compOf.get(c.to) === r.to), dead = pairs.filter((c) => !reachedAny.has(c.from))
        return { key: `${r.from}→${r.to}`, rank: -(r.cycle ? 1000 : 0) - r.calls, title: `${r.from} → ${r.to} (${r.direction}${r.cycle ? ', cycle' : ''}, ${r.calls} calls)${dead.length === pairs.length && pairs.length ? ' — only via unreached code' : ''}`,
          evidence: cap(pairs.map((c) => `${nameOf(c.from)}→${nameOf(c.to)}${reachedAny.has(c.from) ? '' : ' (unreached)'}`), 6).join(', '), anchors: { components: [r.from, r.to], functions: [...new Set(pairs.map((c) => c.from))] },
          verify: 'Is the upward call a missing abstraction (interface/port, Facade) or misplaced code? If only unreached code causes it, delete or move that code.' }
      })
    } },
  // experimental: needs call resolution through exported instances (`userService.x()`), which the TS analyzer
  // misses; until then most candidates are live code. Runs with --experimental or config experimentalLenses.
  { id: 'unused-seam', skill: 'design', tier: 'inventory', experimental: 'calls through exported service instances are not resolved yet, so most candidates are live code', refs: ['design/SKILL.md#guardrails'],
    question: 'Keep pattern seams small: are there wrappers/methods nobody calls?',
    run() {
      const dispatched = new Set(g.calls.filter((c) => c.kind === 'dispatch').map((c) => nameOf(c.to).split('.').pop()))
      const dead = g.functions.filter((f) => !f.id.endsWith('#<module>') && !reachedAny.has(f.id) && !(radj.get(f.id) ?? []).length && !/^(main|__\w+__)$/.test(f.name.split('.').pop()) && !dispatched.has(f.name.split('.').pop()))
      const by = new Map(); for (const f of dead) (by.get(f.file) ?? by.set(f.file, []).get(f.file)).push(f)
      return [...by].sort((a, b) => b[1].length - a[1].length).map(([file, fs]) => ({ key: file, title: `${file}: ${fs.length} function(s) with no callers in analyzed code`, evidence: cap(fs.map((f) => f.name), 8).join(', '), anchors: { functions: fs.map((f) => f.id) }, verify: 'Called only from tests, dynamically, or by external users of a library API? Otherwise remove.' }))
    } },
]

// ---------------- run ----------------
// verdicts: per candidate, or lens-wide with "<lens>:*" (after sampling a high-volume lens)
// Merged lenses keep the verdicts recorded under the lenses they replaced: a candidate also answers to its
// `aliases` (old candidate ids) and to `<old lens>:<same key>`. When several apply, the strongest wins
// (finding > accepted > dismissed > deferred) and `verdictFrom` says which id it came from.
const verdicts = review.lenses ?? {}
const statusOf = (v) => (!v ? 'open' : /^finding\b/i.test(v.verdict) ? 'promoted' : /^accepted\b/i.test(v.verdict) ? 'accepted' : /^deferred\b/i.test(v.verdict) ? 'deferred' : 'dismissed')
const STRENGTH = { promoted: 4, accepted: 3, dismissed: 2, deferred: 1, open: 0 }
const runExperimental = process.argv.includes('--experimental') || config.experimentalLenses === true
const results = LENSES.map((l) => {
  if (l.experimental && !runExperimental) return { id: l.id, skill: l.skill, tier: l.tier ?? 'review', question: l.question, refs: l.refs.map(refInfo), skipped: l.experimental, candidates: [] }
  let cands = []
  try { cands = l.run() } catch (e) { console.warn(`lens ${l.id} failed: ${e.message}`) }
  cands = cands.map((c, i) => ({ ...c, rank: c.rank ?? i })).sort((a, b) => a.rank - b.rank).map((c) => {
    const id = `${l.id}:${c.key}`
    const aliasIds = [...new Set([...(c.aliases ?? []), ...(l.aliases ?? []).map((a) => `${a}:${c.key}`)])].filter((a) => a !== id)
    const direct = verdicts[id] ? [[id, verdicts[id]]] : aliasIds.filter((a) => verdicts[a]).map((a) => [a, verdicts[a]]).sort((x, y) => STRENGTH[statusOf(y[1])] - STRENGTH[statusOf(x[1])])
    const wide = [`${l.id}:*`, ...(l.aliases ?? []).map((a) => `${a}:*`)].find((k) => verdicts[k])
    const [from, v] = direct[0] ?? (wide ? [wide, verdicts[wide]] : [])
    const anchors = Object.fromEntries(Object.entries(c.anchors ?? {}).map(([k, v]) => [k, [...new Set(v)].filter((x) => typeof x === 'string' && !x.startsWith('…'))]))
    return { id, lens: l.id, skill: c.skill ?? l.skill, title: c.title, evidence: c.evidence, verify: c.verify, anchors, aliases: aliasIds, status: statusOf(v), verdict: v?.verdict, note: v?.note, ...(from && from !== id ? { verdictFrom: from } : {}) }
  })
  // the site each candidate is about (its first anchor function), for later lenses that should not repeat it
  raised.set(l.id, new Set(cands.map((c) => c.anchors.functions?.[0]).filter(Boolean)))
  return { id: l.id, skill: l.skill, tier: l.tier ?? 'review', question: l.question, refs: l.refs.map(refInfo), ...(l.aliases ? { replaces: l.aliases } : {}), candidates: cands }
})
// the same site raised by two lenses: link them, so a verdict on one informs the other
const bySite = new Map()
for (const r of results.filter((x) => x.tier !== 'inventory')) for (const c of r.candidates) for (const f of (c.anchors.functions ?? []).slice(0, 3)) (bySite.get(f) ?? bySite.set(f, new Set()).get(f)).add(c)
for (const r of results) for (const c of r.candidates) {
  const others = [...new Set((c.anchors.functions ?? []).slice(0, 3).flatMap((f) => [...(bySite.get(f) ?? [])]))].filter((o) => o.lens !== c.lens)
  if (others.length) c.alsoRaisedBy = others.map((o) => o.id)
}
const knownIds = new Set(results.flatMap((r) => r.candidates.flatMap((c) => [c.id, ...c.aliases])))
const skippedLenses = new Set(results.filter((r) => r.skipped).flatMap((r) => [r.id, ...(LENSES.find((l) => l.id === r.id)?.aliases ?? [])]))
const stale = Object.keys(verdicts).filter((k) => !k.endsWith(':*') && !knownIds.has(k) && !skippedLenses.has(k.split(':')[0]))
fs.writeFileSync(path.join(dir, 'lenses.json'), JSON.stringify({ playbook: playbook ?? null, lenses: results, staleVerdicts: stale }, null, 1))

console.log(playbook ? `playbook: ${playbook}` : 'playbook: not found (pass --playbook <skills dir>); references are listed but not linked')
const missingRefs = results.flatMap((r) => r.refs.filter((x) => playbook && !x.exists).map((x) => x.ref))
if (missingRefs.length) console.warn(`WARN references not found in the playbook: ${[...new Set(missingRefs)].join(', ')}`)
for (const skill of [...new Set(LENSES.map((l) => l.skill))]) {
  const rs = results.filter((r) => r.skill === skill)
  console.log(`\n## ${skill}`)
  for (const r of rs) {
    const open = r.candidates.filter((c) => c.status === 'open'), done = r.candidates.length - open.length
    if (r.skipped) { console.log(`  – ${r.id}: skipped (experimental: ${r.skipped}; --experimental to run)`); continue }
    if (!r.candidates.length) { console.log(`  ✓ ${r.id}: clean`); continue }
    console.log(`  ${open.length ? '•' : '✓'} ${r.id}: ${open.length} open${done ? `, ${done} reviewed` : ''}  (${r.refs.map((x) => x.ref).join(', ')})`)
    const SHOW = r.tier === 'inventory' ? Math.min(3, Number(arg('show', 10))) : Number(arg('show', 10))
    if (r.tier === 'inventory' && open.length) console.log(`      (inventory lens: sample the top few, then record "${r.id}:*" for the rest)`)
    const allById = new Map(results.flatMap((x) => x.candidates).map((c) => [c.id, c]))
    for (const c of open.slice(0, SHOW)) {
      console.log(`      ${c.id}${c.skill !== r.skill ? `  [fix: ${c.skill}]` : ''}\n        ${c.title}\n        evidence: ${c.evidence}\n        verify: ${c.verify}`)
      const seen = (c.alsoRaisedBy ?? []).map((o) => allById.get(o)).filter(Boolean)
      if (seen.length) console.log(`        also raised by: ${seen.map((o) => `${o.id}${o.verdict ? ` (${o.verdict}${o.note ? `: ${o.note.slice(0, 80)}` : ''})` : ''}`).join('; ')}`)
    }
    if (open.length > SHOW) console.log(`      …${open.length - SHOW} more in lenses.json (ranked; --show N to print more)`)
  }
}
if (stale.length) console.log(`\nverdicts for candidates that no longer appear (code changed?): ${stale.join(', ')}`)
const total = results.flatMap((r) => r.candidates), open = total.filter((c) => c.status === 'open').length
const openReview = results.filter((r) => r.tier !== 'inventory').flatMap((r) => r.candidates).filter((c) => c.status === 'open').length
console.log(`\n${total.length} candidates from ${LENSES.length} lenses: ${open} open (${openReview} to review, ${open - openReview} inventory), ${total.filter((c) => c.status === 'promoted').length} promoted to findings, ${total.filter((c) => c.status === 'accepted').length} accepted, ${total.filter((c) => c.status === 'deferred').length} deferred, ${total.filter((c) => c.status === 'dismissed').length} dismissed`)
