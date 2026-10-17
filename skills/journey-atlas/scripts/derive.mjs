// journey-atlas: derive reachability, practice checks and every atlas dataset from graph.json.
// Stack-agnostic: works on any graph.json that follows references/graph-schema.md.
//
// Usage: node derive.mjs --dir <repo>/.journey-atlas [--repo <repo>]
//   reads  graph.json, config.json, review.json (optional)
//   writes derived.json (for Neo4j) and atlas-data/*.json (for the read-out), prints a review queue
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { CORE_KINDS } from './lib/catalog.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const dir = path.resolve(arg('dir', '.journey-atlas'))
const repo = path.resolve(arg('repo', path.dirname(dir)))
const readJson = (f, d) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : d)
const g = readJson('graph.json')
if (!g) { console.error(`No graph.json in ${dir}. Run the analyzer first.`); process.exit(2) }
const config = readJson('config.json', {})
const review = readJson('review.json', {})
const outDir = path.join(dir, 'atlas-data')
fs.mkdirSync(outDir, { recursive: true })
const rx = (s) => new RegExp(s)
const w = (n, d) => { fs.writeFileSync(path.join(outDir, `${n}.json`), JSON.stringify(d)); return d }
const fileOf = (id) => id.split('#')[0]
// single-journey rows are noise in a big API but are the whole API in a small one
const bigEnough = (rows) => (rows.length > 12 ? rows.filter((r) => r.journeys >= 2) : rows)
for (const k of ['functions', 'calls', 'externals', 'externalCalls', 'modelQueries', 'events', 'emits', 'handles', 'journeys', 'entries', 'middleware', 'mwPasses', 'throws', 'signals', 'txCalls']) g[k] ??= []

// ---------------- actors, areas, components, layers ----------------
const actorRules = (config.actors ?? []).map((r) => ({ re: rx(r.match), name: r.name }))
const titleCase = (s) => s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
function areaOf(j) {
  if (j.kind === 'cli') return 'CLI ' + ((j.command ?? j.name ?? '').split(' ')[0] || '(default)')
  if (j.kind !== 'http') return { websocket: 'WebSocket actions', scheduled: 'Scheduled jobs', consumer: 'Queue consumers', 'websocket-server': 'Realtime servers', mcp: 'MCP tools' }[j.kind] ?? titleCase(j.kind)
  const segs = (j.path ?? '/').split('/').filter((s) => s && !s.startsWith(':'))
  const n = segs[0] === 'api' || /^v\d+$/.test(segs[0] ?? '') ? (/^v\d+$/.test(segs[1] ?? '') ? 3 : 2) : 1
  return '/' + segs.slice(0, n).join('/')
}
function actorOf(j) {
  for (const r of actorRules) if (r.re.test(j.id)) return r.name
  if (j.kind === 'scheduled') return 'System scheduler'
  if (j.kind === 'consumer') return 'Queue consumers'
  if (j.kind === 'websocket') return 'WebSocket clients'
  if (j.kind === 'websocket-server') return 'Realtime clients'
  if (j.kind === 'cli') return 'CLI operator'
  if (j.kind === 'mcp') return 'AI agent (MCP client)'
  const a = areaOf(j).split('/').filter(Boolean)
  return a.length ? `${titleCase(a[a.length - 1])} callers` : 'API callers'
}
const J = new Map(g.journeys.map((j) => [j.id, { ...j, actor: actorOf(j), area: areaOf(j) }]))
const componentRules = (config.components ?? []).map((r) => ({ re: rx(r.match), component: r.component, layer: r.layer }))
const SOURCE_ROOT = /^(?:(?:apps|packages|services|libs)\/[^/]+\/)?(?:src\/)?/
const CONTAINERS = new Set(['services', 'modules', 'features', 'domains', 'domain', 'controllers', 'routes', 'api', 'handlers', 'shared', 'lib', 'libs', 'app'])
const LAYER_WORDS = [
  ['entry', /(^|\/)(routes?|controllers?|handlers?|api|pages|app|resolvers?|gateways?|websocket|ws|cli|commands?|jobs?|schedulers?|workers?|consumers?|cron)(\/|$)|\.(controller|route|routes|handler|resolver|gateway|job|worker|consumer)\./],
  ['middleware', /(^|\/)(middlewares?|guards?|interceptors?|pipes?|filters?|plugins?)(\/|$)|\.(middleware|guard|interceptor|pipe)\./],
  ['events', /(^|\/)(events?|listeners?|subscribers?|handlers\/events?)(\/|$)|\.(listener|subscriber)\./],
  ['shared', /(^|\/)(shared|common|core)(\/|$)/],
  ['domain', /(^|\/)(services?|domain|domains|modules?|features?|usecases?|use-cases|application)(\/|$)|\.service\./],
  ['platform', /(^|\/)(lib|libs|infra|infrastructure|clients?|adapters?|db|database|repositor(y|ies)|persistence|integrations?|providers?)(\/|$)|\.(repository|client|adapter)\./],
  ['foundation', /(^|\/)(utils?|helpers?|config|configs|constants?|types?|schemas?|models?|dto|errors?)(\/|$)/],
]
const LAYERS = [['entry', 6], ['middleware', 5], ['domain', 4], ['shared', 3], ['events', 2], ['platform', 1], ['foundation', 0], ['other', 4]]
const rank = Object.fromEntries(LAYERS)
const compCache = new Map()
function componentOf(file) {
  if (compCache.has(file)) return compCache.get(file)
  let out
  const rest = file.replace(SOURCE_ROOT, ''), segs = rest.split('/')
  // services/shared/x → shared/x; services/x → services/x; lib → lib
  const dflt = segs.length <= 1 ? '(root)' : CONTAINERS.has(segs[0]) && CONTAINERS.has(segs[1]) && segs.length > 3 ? `${segs[1]}/${segs[2]}` : CONTAINERS.has(segs[0]) && segs.length > 2 ? `${segs[0]}/${segs[1]}` : segs[0]
  for (const r of componentRules) if (r.re.test(file)) { out = { component: r.component ?? dflt, layer: r.layer }; break }
  if (!out) {
    const component = dflt
    let layer = 'other'
    for (const [l, re] of LAYER_WORDS) if (re.test(rest)) { layer = l; break }
    out = { component, layer }
  }
  compCache.set(file, out)
  return out
}
// fold tiny components so matrices stay readable
const fnCount = new Map()
for (const f of g.functions) { const c = componentOf(f.file).component; fnCount.set(c, (fnCount.get(c) ?? 0) + 1) }
const MIN_FNS = config.minComponentFunctions ?? 25
const comp = (file) => { const { component, layer } = componentOf(file); const top = component.split('/')[0]; return (fnCount.get(component) ?? 0) < MIN_FNS && component.includes('/') ? `${top}/(small)` : component }
const layerOfComp = new Map()
for (const f of g.functions) { const c = comp(f.file), l = componentOf(f.file).layer; const m = layerOfComp.get(c) ?? new Map(); m.set(l, (m.get(l) ?? 0) + 1); layerOfComp.set(c, m) }
const layerOf = (c) => [...(layerOfComp.get(c) ?? new Map([['other', 1]]))].sort((a, b) => b[1] - a[1])[0][0]

// ---------------- systems ----------------
const extKind = new Map(g.externals.map((e) => [e.name, e.kind]))
const isCore = (s) => CORE_KINDS.has(extKind.get(s))
const sideEffecting = (s) => (review.systems?.[s]?.sideEffecting ?? !['database', 'cache', 'observability', 'search', 'secrets', 'auth'].includes(extKind.get(s)))
const NON_RECOVERY = new Set(['database', 'cache', 'observability', 'search', 'secrets'])

// ---------------- reachability ----------------
const adj = new Map(), detachedEdge = new Set()
for (const c of g.calls) { (adj.get(c.from) ?? adj.set(c.from, []).get(c.from)).push(c.to); if (c.kind === 'detached') detachedEdge.add(c.from + '|' + c.to) }
const handlersOf = new Map(); for (const h of g.handles) (handlersOf.get(h.event) ?? handlersOf.set(h.event, []).get(h.event)).push(h.to)
const emitsBy = new Map(); for (const e of g.emits) (emitsBy.get(e.from) ?? emitsBy.set(e.from, []).get(e.from)).push(e.event)
const entriesOf = new Map(); for (const e of g.entries) (entriesOf.get(e.journey) ?? entriesOf.set(e.journey, []).get(e.journey)).push(e)
const extByFn = new Map(); for (const e of g.externalCalls) (extByFn.get(e.from) ?? extByFn.set(e.from, []).get(e.from)).push(e)
const modelsByFn = new Map(); for (const m of g.modelQueries) (modelsByFn.get(m.from) ?? modelsByFn.set(m.from, []).get(m.from)).push(m)
const fnById = new Map(g.functions.map((f) => [f.id, f]))
const reach = new Map() // journey -> Map(fn -> {depth, async, mw})
for (const j of g.journeys) {
  const m = new Map(), q = []
  for (const e of entriesOf.get(j.id) ?? []) { const st = { depth: 0, async: false, mw: e.role === 'middleware' }; const cur = m.get(e.fn); if (!cur || (cur.mw && !st.mw)) { m.set(e.fn, st); q.push(e.fn) } }
  while (q.length) {
    const f = q.shift(), s = m.get(f)
    const next = (adj.get(f) ?? []).map((t) => [t, detachedEdge.has(f + '|' + t)]).concat((emitsBy.get(f) ?? []).flatMap((ev) => (handlersOf.get(ev) ?? []).map((h) => [h, true])))
    for (const [t, isAsync] of next) {
      const ns = { depth: s.depth + 1, async: s.async || isAsync, mw: s.mw }, cur = m.get(t)
      if (!cur || (cur.async && !ns.async) || (cur.mw && !ns.mw && cur.async === ns.async)) { m.set(t, ns); q.push(t) }
    }
  }
  reach.set(j.id, m)
}
const dependsOn = [], touches = [], triggers = []
for (const j of g.journeys) {
  const dep = new Map(), mod = new Map(), evs = new Map()
  const merge = (map, key, st, ops, isAsync) => { const cur = map.get(key); if (!cur) map.set(key, { dist: st.depth + 1, async: isAsync, mwOnly: st.mw, ops: new Set(ops) }); else { cur.dist = Math.min(cur.dist, st.depth + 1); cur.async &&= isAsync; cur.mwOnly &&= st.mw; ops.forEach((o) => cur.ops.add(o)) } }
  for (const [fn, st] of reach.get(j.id)) {
    for (const e of extByFn.get(fn) ?? []) merge(dep, e.dep, st, e.ops, st.async || e.sync === false)
    for (const m of modelsByFn.get(fn) ?? []) merge(mod, m.model, st, m.ops, st.async)
    for (const ev of emitsBy.get(fn) ?? []) merge(evs, ev, st, [], st.async)
  }
  for (const [k, v] of dep) dependsOn.push({ journey: j.id, dep: k, distance: v.dist, async: v.async, viaMiddlewareOnly: v.mwOnly, ops: [...v.ops].sort().slice(0, 100) })
  for (const [k, v] of mod) touches.push({ journey: j.id, model: k, distance: v.dist, async: v.async, viaMiddlewareOnly: v.mwOnly, ops: [...v.ops].sort(), writes: [...v.ops].some((o) => /create|update|upsert|delete|save|insert|remove|destroy/i.test(o)) })
  for (const [k, v] of evs) triggers.push({ journey: j.id, event: k, distance: v.dist, async: v.async })
}

// ---------------- practice checks ----------------
const sig = new Map(); for (const s of g.signals) (sig.get(s.fn) ?? sig.set(s.fn, new Map()).get(s.fn)).set(s.signal, s)
const has = (fn, s) => sig.get(fn)?.has(s) ?? false
const radj = new Map(); for (const c of g.calls) (radj.get(c.to) ?? radj.set(c.to, []).get(c.to)).push(c.from)
const fnsByFile = new Map(); for (const f of g.functions) (fnsByFile.get(f.file) ?? fnsByFile.set(f.file, []).get(f.file)).push(f.id)
const depCallers = new Map(); for (const e of g.externalCalls) (depCallers.get(e.dep) ?? depCallers.set(e.dep, new Set()).get(e.dep)).add(e.from)
// file-level evidence only from module code (client set-up) or other functions calling the same system,
// so an axios timeout doesn't vouch for a Stripe call in the same file
const callsOtherSystem = (f, dep) => [...depCallers].some(([d, fs]) => d !== dep && !CORE_KINDS.has(extKind.get(d)) && fs.has(f))
// functions working for one system: its callers plus their same-file helpers that don't call another system
const depHelpers = new Map([...depCallers].map(([d, fs]) => [d, new Set([...fs, ...[...fs].flatMap((f) => (adj.get(f) ?? []).filter((t) => fileOf(t) === fileOf(f) && !callsOtherSystem(t, d)))])]))
const fileHas = (file, s, dep) => (fnsByFile.get(file) ?? []).some((f) => has(f, s) && (f.endsWith('#<module>') || depHelpers.get(dep)?.has(f)))
// perCall: a control that belongs to each call (idempotency keys) — no credit from elsewhere in the file
function evidence(fn, signals, dep, perCall = false) {
  const any = (f) => signals.some((s) => has(f, s))
  if (any(fn)) return 'function'
  if ((radj.get(fn) ?? []).filter((c) => !perCall || !callsOtherSystem(c, dep)).some(any)) return 'caller'
  // a direct callee that doesn't call another system is a wrapper serving this call (withRetry, withBreaker…), wherever it lives
  if ((adj.get(fn) ?? []).filter((t) => !callsOtherSystem(t, dep)).some(any)) return 'callee'
  if (!perCall && signals.some((s) => fileHas(fileOf(fn), s, dep))) return 'file'
  return null
}
const callSites = g.externalCalls.filter((e) => !['database', 'observability'].includes(extKind.get(e.dep))).map((e) => {
  const r = { fn: e.from, dep: e.dep, file: fileOf(e.from), sync: e.sync !== false, timeout: evidence(e.from, ['timeout'], e.dep), retry: evidence(e.from, ['retry'], e.dep), idempotency: evidence(e.from, ['idempotency-key', 'idempotent-write'], e.dep, true), circuit_breaker: evidence(e.from, ['circuit-breaker'], e.dep), concurrency_limit: evidence(e.from, ['concurrency-limit'], e.dep) }
  r.retry_without_idempotency = !!(r.retry && !r.idempotency && sideEffecting(e.dep))
  return r
})
const timeoutExempt = new Set(['cache', ...(config.timeoutExemptKinds ?? [])])
const CONCEPTS = [
  ['timeout', 'resilience', 'control'], ['retry', 'resilience', 'control'], ['idempotency', 'resilience', 'control'], ['circuit-breaker', 'resilience', 'control'], ['concurrency-limit', 'resilience', 'control'], ['distributed-lock', 'resilience', 'control'],
  ['input-validation', 'security', 'control'], ['ssrf-control', 'security', 'control'], ['side-effect-in-transaction', 'architecture', 'risk'], ['fire-and-forget', 'observability', 'risk'], ['error-swallowed', 'observability', 'risk'], ['exception-tracking', 'observability', 'control'],
].map(([name, skill, polarity]) => ({ name, skill, polarity }))
const conceptOf = (s) => ({ 'idempotency-key': 'idempotency', 'idempotent-write': 'idempotency', 'error-silently-swallowed': 'error-swallowed', 'error-logged-and-swallowed': 'error-swallowed', 'error-reported-and-swallowed': 'exception-tracking' })[s] ?? s
const functionConcepts = g.signals.map((s) => ({ fn: s.fn, concept: conceptOf(s.signal), signal: s.signal, count: s.count, samples: s.samples })).filter((r) => CONCEPTS.some((c) => c.name === r.concept))
// silent paths: places that hide failures within four calls of a side-effecting system
const effectsMemo = new Map()
function effectsOf(start, maxDepth = 4) {
  const key = start + '|' + maxDepth
  if (effectsMemo.has(key)) return effectsMemo.get(key)
  const out = new Set(), seen = new Map([[start, 0]]), q = [start]
  while (q.length) { const f = q.shift(), d = seen.get(f); for (const e of extByFn.get(f) ?? []) if (sideEffecting(e.dep)) out.add(e.dep); if (d >= maxDepth) continue; for (const t of adj.get(f) ?? []) if (!seen.has(t)) { seen.set(t, d + 1); q.push(t) } }
  effectsMemo.set(key, out); return out
}
const silent = g.signals.filter((s) => ['fire-and-forget', 'error-silently-swallowed', 'error-logged-and-swallowed'].includes(s.signal)).map((s) => ({ fn: s.fn, signal: s.signal, effects: [...effectsOf(s.fn)] })).filter((s) => s.effects.length)
const quietSites = new Map(); for (const s of silent) for (const e of s.effects) quietSites.set(e, (quietSites.get(e) ?? new Set()).add(s.fn))

// ---------------- middleware view ----------------
const mwMeta = new Map(g.middleware.map((m) => [m.name, m]))
const passesBy = new Map(); for (const p of g.mwPasses) (passesBy.get(p.journey) ?? passesBy.set(p.journey, []).get(p.journey)).push(p)
for (const v of passesBy.values()) v.sort((a, b) => a.order - b.order)
const kindsOf = (jid) => new Set((passesBy.get(jid) ?? []).map((p) => mwMeta.get(p.mw)?.kind))
const userJourneys = g.journeys.filter((j) => ['http', 'websocket', 'cli', 'mcp'].includes(j.kind))
const AUTHZ = /permission|authoriz|requireRole|require\w*Access|resolve\w*Access|verify\w*Access|assert\w*Access|canAccess|ensure\w*(Owner|Access)|scopeTo|tenantScope|policy|ability|checkRole/i
const posture = new Map()
for (const j of userJourneys) {
  const m = reach.get(j.id), names = [...m].filter(([, st]) => !st.async && st.depth <= 8).map(([f]) => fnById.get(f)?.name ?? '')
  const k = kindsOf(j.id)
  posture.set(j.id, { authn: k.has('authentication'), authzPipeline: k.has('authorization'), authzHandler: names.some((n) => AUTHZ.test(n)), validationPipeline: k.has('validation'), validationHandler: [...m].some(([f, st]) => !st.async && st.depth <= 4 && has(f, 'input-validation')), rateLimit: k.has('rate-limit') })
}
const PUBLIC = rx(config.publicRoutes ?? '^HTTP \\S+ /(health|healthz|ready|readyz|live|livez|ping|metrics|status|version|docs|swagger|openapi(\\.json)?|favicon\\.ico|robots\\.txt)(/|$)')
const openReview = review.openRoutes ?? {}

// ---------------- datasets ----------------
const components = new Map()
for (const f of g.functions) { const c = comp(f.file); const s = components.get(c) ?? { component: c, functions: 0, files: new Set(), journeys: new Set() }; s.functions++; s.files.add(f.file); components.set(c, s) }
for (const [jid, m] of reach) for (const [f, st] of m) if (!st.mw) components.get(comp(fileOf(f)))?.journeys.add(jid)
const dsmMap = new Map()
for (const c of g.calls) { const a = comp(fileOf(c.from)), b = comp(fileOf(c.to)); if (a !== b) dsmMap.set(a + '|' + b, (dsmMap.get(a + '|' + b) ?? 0) + 1) }
const dsm = [...dsmMap].map(([k, calls]) => { const [from, to] = k.split('|'), d = rank[layerOf(from)] - rank[layerOf(to)]; return { from, to, calls, direction: d > 0 ? 'down' : d < 0 ? 'up' : 'lateral', cycle: dsmMap.has(to + '|' + from) } })
const compRows = [...components.values()].map((s) => {
  const layer = layerOf(s.component), cin = dsm.filter((d) => d.to === s.component).reduce((a, d) => a + d.calls, 0), cout = dsm.filter((d) => d.from === s.component).reduce((a, d) => a + d.calls, 0)
  return { component: s.component, layer, layer_rank: rank[layer], functions: s.functions, files: s.files.size, journeys: s.journeys.size, calls_in: cin, calls_out: cout, instability: cin + cout ? +(cout / (cin + cout)).toFixed(2) : 0 }
}).sort((a, b) => b.layer_rank - a.layer_rank || b.functions - a.functions)
w('components', compRows); w('dsm', dsm)

const ctx = new Map()
for (const [jid, m] of reach) {
  const actor = J.get(jid).actor, seen = new Set()
  for (const [f, st] of m) { if (st.mw) continue; for (const e of extByFn.get(f) ?? []) { const k = `${actor}|${comp(fileOf(f))}|${e.dep}`; if (seen.has(k)) continue; seen.add(k); const r = ctx.get(k) ?? { actor, component: comp(fileOf(f)), system: e.dep, journeys: 0, async_journeys: 0 }; r.journeys++; if (st.async || e.sync === false) r.async_journeys++; ctx.set(k, r) } }
}
w('context_flow', [...ctx.values()])

const opClass = (op) => /^(create\w*|insert\w*|save|bulkCreate)$/.test(op) ? ['C'] : /^upsert$/.test(op) ? ['C', 'U'] : /^(update\w*|replaceOne|restore)$/.test(op) ? ['U'] : /^(delete\w*|remove|destroy|softDelete)$/.test(op) ? ['D'] : ['R']
const crudMap = new Map()
for (const mq of g.modelQueries) { const c = comp(fileOf(mq.from)), k = mq.model + '|' + c, r = crudMap.get(k) ?? { table: mq.model, component: c, C: 0, R: 0, U: 0, D: 0 }; for (const op of mq.ops) for (const x of opClass(op)) r[x]++; crudMap.set(k, r) }
const writersPer = new Map(); for (const r of crudMap.values()) if (r.C + r.U + r.D) writersPer.set(r.table, (writersPer.get(r.table) ?? 0) + 1)
const topTables = new Set([...writersPer].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([t]) => t))
w('crud', [...crudMap.values()].filter((r) => topTables.has(r.table)))

const evMeta = new Map(g.events.map((e) => [e.id, e]))
const evFlow = new Map()
for (const e of g.emits) {
  const ev = evMeta.get(e.event); if (!ev) continue
  for (const h of handlersOf.get(e.event) ?? []) {
    const eff = new Set(), seen = new Set([h]), q = [h]
    while (q.length && seen.size < 400) { const f = q.shift(); for (const x of extByFn.get(f) ?? []) if (!['database', 'observability'].includes(extKind.get(x.dep))) eff.add(x.dep); for (const t of adj.get(f) ?? []) if (!seen.has(t)) { seen.add(t); q.push(t) } }
    for (const x of eff.size ? eff : ['In-app only']) { const k = `${comp(fileOf(e.from))}|${e.event}|${x}`; const r = evFlow.get(k) ?? { emitter: comp(fileOf(e.from)), event: e.event, transport: ev.transport ?? 'in-process', effect: x, links: 0 }; r.links++; evFlow.set(k, r) }
  }
}
w('event_flow', [...evFlow.values()])

const cadence = (s) => {
  if (!s) return null
  const ms = s.match(/every\s+([\d_]+)\s*ms/); if (ms) return Math.round(Number(ms[1].replace(/_/g, '')) / 1000)
  const c = s.replace(/^['"`]|['"`]$/g, '').trim().split(/\s+/)
  if (c.length === 6) c.shift()
  if (c.length !== 5) return null
  const [mi, h] = c
  if (mi === '*' && h === '*') return 60
  if (/^\*\/\d+$/.test(mi) && h === '*') return Number(mi.slice(2)) * 60
  if (/^\d+$/.test(mi) && h === '*') return 3600
  if (/^\d+$/.test(mi) && /^\*\/\d+$/.test(h)) return Number(h.slice(2)) * 3600
  if (/^\d+$/.test(mi) && /^\d+$/.test(h)) return 86400
  return null
}
const jobs = g.journeys.filter((j) => j.kind === 'scheduled' || j.kind === 'consumer').map((j) => {
  const m = reach.get(j.id), systems = new Set(), writes = new Set()
  for (const f of m.keys()) { for (const e of extByFn.get(f) ?? []) if (!['database', 'observability'].includes(extKind.get(e.dep))) systems.add(e.dep); for (const mq of modelsByFn.get(f) ?? []) if (mq.ops.some((x) => /create|update|upsert|delete|save|insert|remove/i.test(x))) writes.add(mq.model) }
  const every = review.jobs?.[j.id]?.every_seconds ?? cadence(j.schedule)
  return { job: j.name ?? j.id, journey: j.id, kind: j.kind, purpose: review.jobs?.[j.id]?.purpose ?? '', schedule: j.schedule ?? '', every_seconds: every, runs_per_hour: every ? Math.round(3600 / every) : null, systems: [...systems].sort().join(', '), tables_written: writes.size, functions_reached: m.size }
})
w('jobs', jobs)

// recovery: reviewed verdicts win; otherwise a job whose name says it recovers/reconciles and that reaches the system
const RECOVERY_NAME = /recover|retry|resol|reconcil|redeliver|dispatch|sweep|outbox|settle|requeue|replay|backfill/i
const recoveryOf = (s) => review.systems?.[s]?.recovery ?? (NON_RECOVERY.has(extKind.get(s)) || !sideEffecting(s) ? 'Not needed' : jobs.some((jb) => RECOVERY_NAME.test(jb.job) && jb.systems.split(', ').includes(s)) ? 'Scheduled job (auto)' : 'Unknown')
const depJourneys = new Map(); for (const d of g.dependsOn ?? dependsOn) (depJourneys.get(d.dep) ?? depJourneys.set(d.dep, new Set()).get(d.dep)).add(d.journey)
const resMap = new Map()
for (const r of callSites) { const x = resMap.get(r.dep) ?? { system: r.dep, kind: extKind.get(r.dep), call_sites: 0, timeout: 0, retry: 0, idempotency: 0, circuit_breaker: 0, concurrency_limit: 0 }; x.call_sites++; for (const k of ['timeout', 'retry', 'idempotency', 'circuit_breaker', 'concurrency_limit']) if (r[k]) x[k]++; resMap.set(r.dep, x) }
const resilience = w('resilience', [...resMap.values()].map((x) => ({ ...x, journeys: depJourneys.get(x.system)?.size ?? 0, recovery: recoveryOf(x.system), quiet_sites: quietSites.get(x.system)?.size ?? 0, timeout_exempt: timeoutExempt.has(x.kind) })).sort((a, b) => b.journeys - a.journeys))
const noRecovery = new Set(resilience.filter((r) => /^None|^Unknown/.test(r.recovery)).map((r) => r.system))

// hotspots and change impact
let churn = new Map()
try { churn = new Map(execSync(`git log --relative --since="${config.churnDays ?? 90} days ago" --name-only --pretty=format:`, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean).reduce((m, f) => m.set(f, (m.get(f) ?? 0) + 1), new Map())) } catch {}
const fileJourneys = new Map(); for (const [jid, m] of reach) for (const [f, st] of m) if (!st.mw) (fileJourneys.get(fileOf(f)) ?? fileJourneys.set(fileOf(f), new Set()).get(fileOf(f))).add(jid)
const gaps = new Map()
for (const fc of functionConcepts) if (['error-swallowed', 'fire-and-forget'].includes(fc.concept)) gaps.set(fileOf(fc.fn), (gaps.get(fileOf(fc.fn)) ?? 0) + fc.count)
for (const r of callSites) if (!r.timeout && !timeoutExempt.has(extKind.get(r.dep))) gaps.set(r.file, (gaps.get(r.file) ?? 0) + 1)
w('hotspots', [...fileJourneys].filter(([f]) => !/(^|\/)(utils?\/(errors?|logger)|logger|errors?)\.[jt]s$/.test(f)).map(([f, js]) => ({ file: f, component: comp(f), journeys: js.size, user_types: new Set([...js].map((x) => J.get(x).actor)).size, commits_90d: churn.get(f) ?? 0, quiet_gaps: gaps.get(f) ?? 0 })).filter((r) => r.journeys >= 2).sort((a, b) => b.journeys * (b.commits_90d + 1) - a.journeys * (a.commits_90d + 1)).slice(0, 250))
const jIdx = new Map(g.journeys.map((j, i) => [j.id, i]))
w('journeys_index', g.journeys.map((j, i) => ({ idx: i, journey: j.id, actor: J.get(j.id).actor, kind: j.kind, area: J.get(j.id).area })))
w('impact_files', [...fileJourneys].map(([f, js]) => ({ file: f, component: comp(f), journeys: js.size, journey_ids: [...js].map((x) => jIdx.get(x)).sort((a, b) => a - b).join(' ') })).sort((a, b) => a.file.localeCompare(b.file)))

// journey anatomy (pipeline, handler, logic, data, external, events, after response)
const SCOPE_LABEL = { app: 'app', router: 'router', route: 'route', connect: 'on connect', 'per-message': 'per message' }
const NOISE = /(^|\/)(utils?|config|schemas?|types?|constants?)\/|logger|\/errors?\.[jt]s$/
const anatomy = []
for (const j of g.journeys) {
  const m = reach.get(j.id), seen = new Set()
  const push = (lane, item, detail, order) => { const k = lane + '|' + item; if (seen.has(k)) return; seen.add(k); anatomy.push({ journey: j.id, lane, item, detail, order }) }
  for (const p of passesBy.get(j.id) ?? []) push('Pipeline', p.mw, `${SCOPE_LABEL[p.scope] ?? p.scope} · ${mwMeta.get(p.mw)?.kind ?? 'other'}${p.config ? ' · ' + p.config.slice(0, 70) : ''}`, p.order)
  ;(entriesOf.get(j.id) ?? []).filter((e) => e.role === 'handler').forEach((e, i) => push('Handler', fnById.get(e.fn)?.name ?? '?', fnById.get(e.fn)?.file ?? '', i))
  ;[...m].filter(([f, st]) => !st.mw && !st.async && st.depth >= 1 && st.depth <= 4 && !NOISE.test(fileOf(f)) && ['domain', 'shared', 'events', 'platform', 'other'].includes(componentOf(fileOf(f)).layer)).sort((a, b) => a[1].depth - b[1].depth).slice(0, 14)
    .forEach(([f, st], i) => push('Logic', fnById.get(f)?.name ?? '?', `${comp(fileOf(f))} · depth ${st.depth}`, i))
  const tables = new Map()
  for (const [f, st] of m) if (!st.mw) for (const mq of modelsByFn.get(f) ?? []) { const t = tables.get(mq.model) ?? { ops: new Set(), async: true }; mq.ops.forEach((x) => opClass(x).forEach((c) => t.ops.add(c))); t.async &&= st.async; tables.set(mq.model, t) }
  ;[...tables].sort((a, b) => a[0].localeCompare(b[0])).forEach(([t, v], i) => push(v.async ? 'After response' : 'Data', t, ['C', 'R', 'U', 'D'].filter((x) => v.ops.has(x)).join(''), i))
  const exts = new Map()
  for (const [f, st] of m) if (!st.mw) for (const e of extByFn.get(f) ?? []) if (!['database', 'observability'].includes(extKind.get(e.dep))) exts.set(e.dep, (exts.get(e.dep) ?? true) && (st.async || e.sync === false))
  ;[...exts].forEach(([s, a], i) => push(a ? 'After response' : 'External', s, a ? 'after the response' : 'during request', 200 + i))
  for (const [f, st] of m) if (!st.mw) for (const ev of emitsBy.get(f) ?? []) if (evMeta.get(ev)) push('Events', ev, evMeta.get(ev).transport ?? 'in-process', st.depth)
}
w('anatomy', anatomy)

// convergence: functions that gain journeys beyond their busiest single caller
const reachParents = new Map()
for (const j of g.journeys) {
  const parent = new Map(), q = []
  for (const e of entriesOf.get(j.id) ?? []) if (!parent.has(e.fn)) { parent.set(e.fn, 'ENTRY'); q.push(e.fn) }
  while (q.length) { const f = q.shift(); for (const t of adj.get(f) ?? []) if (!parent.has(t)) { parent.set(t, f); q.push(t) } }
  for (const [f, p] of parent) (reachParents.get(f) ?? reachParents.set(f, new Map()).get(f)).set(j.id, p)
}
const convRows = []
for (const [f, jm] of reachParents) {
  const fn = fnById.get(f); if (!fn || fn.name === '<module>' || NOISE.test(fn.file)) continue
  const byCaller = new Map(); for (const p of jm.values()) byCaller.set(p, (byCaller.get(p) ?? 0) + 1)
  const maxCaller = Math.max(0, ...[...byCaller.keys()].map((c) => (c === 'ENTRY' ? 0 : reachParents.get(c)?.size ?? 0)))
  const gain = jm.size - maxCaller
  if (byCaller.size < 2 || gain < Math.max(3, Math.round(g.journeys.length * 0.01))) continue
  const downstream = new Set(), seen = new Set([f]), q = [f]
  while (q.length && seen.size < 600) { const x = q.shift(); for (const e of extByFn.get(x) ?? []) downstream.add(e.dep); for (const t of adj.get(x) ?? []) if (!seen.has(t)) { seen.add(t); q.push(t) } }
  if (!downstream.size && seen.size < 3) continue
  convRows.push({ f, fn, jm, gain, streams: byCaller.size, downstream })
}
convRows.sort((a, b) => b.gain - a.gain || b.jm.size - a.jm.size)
const conv = convRows.slice(0, 30)
w('convergence', conv.slice(0, 12).map((r) => ({ point: r.fn.name, file: r.fn.file, journeys: r.jm.size, merged_journeys: r.gain, incoming_paths: r.streams, user_types: new Set([...r.jm.keys()].map((x) => J.get(x).actor)).size, reaches: [...r.downstream].sort().join(', ') })))
w('convergence_mix', conv.slice(0, 12).flatMap((r) => { const by = new Map(); for (const x of r.jm.keys()) by.set(J.get(x).actor, (by.get(J.get(x).actor) ?? 0) + 1); return [...by].map(([actor, journeys]) => ({ point: r.fn.name, actor, journeys })) }))

// request pipeline views
const cov = new Map()
for (const j of userJourneys) {
  const p = posture.get(j.id), a = J.get(j.id).area, r = cov.get(a) ?? { area: a, journeys: 0, authentication: 0, authorization_pipeline: 0, authorization_handler: 0, validation_pipeline: 0, validation_handler: 0, rate_limit: 0 }
  r.journeys++; if (p.authn) r.authentication++; if (p.authzPipeline) r.authorization_pipeline++; else if (p.authzHandler) r.authorization_handler++; if (p.validationPipeline) r.validation_pipeline++; else if (p.validationHandler) r.validation_handler++; if (p.rateLimit) r.rate_limit++
  cov.set(a, r)
}
w('pipeline_coverage', bigEnough([...cov.values()]).sort((a, b) => b.journeys - a.journeys))
const inv = new Map()
for (const p of g.mwPasses) { const r = inv.get(p.mw) ?? { middleware: p.mw, kind: mwMeta.get(p.mw)?.kind ?? 'other', journeys: new Set(), areas: new Set(), scopes: new Set(), configs: new Set() }; r.journeys.add(p.journey); r.areas.add(J.get(p.journey)?.area); r.scopes.add(SCOPE_LABEL[p.scope] ?? p.scope); if (p.config) r.configs.add(p.config); inv.set(p.mw, r) }
w('middleware', [...inv.values()].map((r) => { const m = mwMeta.get(r.middleware); return { middleware: r.middleware, kind: r.kind, journeys: r.journeys.size, areas: [...r.areas].filter(Boolean).sort().join(', '), scope: [...r.scopes].join(', '), config_variants: r.configs.size, implemented_in: m?.impl ? fileOf(m.impl) : m?.package ? `${m.package} (package)` : '' } }).sort((a, b) => b.journeys - a.journeys))
const fam = new Map()
for (const j of userJourneys) {
  const steps = (passesBy.get(j.id) ?? []).filter((p) => p.scope !== 'app')
  const chain = steps.map((p) => p.mw + (p.config && ['authentication', 'authorization'].includes(mwMeta.get(p.mw)?.kind) ? ` {${p.config.replace(/\/\/[^\n]*/g, '').replace(/[{}\s]/g, '').slice(0, 48)}}` : '')).join(' → ') || '(app-wide stack only)'
  const kinds = steps.map((p) => mwMeta.get(p.mw)?.kind), fa = kinds.indexOf('authentication'), lr = kinds.lastIndexOf('rate-limit')
  const k = J.get(j.id).area + '|' + chain, r = fam.get(k) ?? { area: J.get(j.id).area, chain, journeys: 0, example: j.id, rate_limit_after_auth: fa >= 0 && lr > fa }
  r.journeys++; fam.set(k, r)
}
w('chain_variants', [...fam.values()].sort((a, b) => a.area.localeCompare(b.area) || b.journeys - a.journeys))
const ORDER = ['No guard', 'Unreviewed', 'Verified in handler', 'Pre-sign-in, rate limited', 'Public content']
const openRoutes = w('open_routes', g.journeys.filter((j) => j.kind === 'http' && !kindsOf(j.id).has('authentication')).map((j) => {
  const k = kindsOf(j.id), rv = openReview[j.id]
  const verdict = rv?.verdict ?? (PUBLIC.test(j.id) ? 'Public content' : k.has('rate-limit') ? 'Pre-sign-in, rate limited' : posture.get(j.id)?.authn ? 'Verified in handler' : 'Unreviewed')
  return { journey: j.id, area: J.get(j.id).area, verdict, note: rv?.note ?? '', route_middleware: (passesBy.get(j.id) ?? []).filter((p) => p.scope !== 'app').map((p) => p.mw).join(', ') }
}).sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || a.journey.localeCompare(b.journey)))

// user impact
const CONFIG_ERR = /environment variable|configured|must be set|is required'|\benv\b|missing config|did not export/i
const throwsByFn = new Map(); for (const t of g.throws) { if (t.category === 'generic 500' && CONFIG_ERR.test(t.message)) continue; (throwsByFn.get(t.fn) ?? throwsByFn.set(t.fn, []).get(t.fn)).push(t) }
const callSiteByFn = new Map(); for (const c of callSites) (callSiteByFn.get(c.fn) ?? callSiteByFn.set(c.fn, []).get(c.fn)).push(c)
const silentFns = new Set(silent.map((s) => s.fn))
const idemFns = new Set(functionConcepts.filter((x) => x.concept === 'idempotency').map((x) => x.fn))
const MONEY = rx(config.moneyTables ?? 'payment|charge|invoice|order|transaction|refund|payout|sale|ledger|wallet|subscription|billing')
const CUSTOMER = rx(config.customerActors ?? 'customer|guest|shopper|buyer|public|visitor|patient|member|user')
function profile(jid) {
  const m = reach.get(jid), waits = new Map(), after = new Set(), writes = new Set(), errs = new Map(), comps = new Map()
  let quiet = 0, idem = false, creates = false
  for (const [f, st] of m) {
    if (!st.async) {
      for (const e of extByFn.get(f) ?? []) { if (isCore(e.dep)) continue; if (e.sync === false) { after.add(e.dep); continue } const wv = waits.get(e.dep) ?? { unguarded: 0 }; for (const c of callSiteByFn.get(f) ?? []) if (c.dep === e.dep && !c.timeout && !timeoutExempt.has(extKind.get(e.dep))) wv.unguarded++; waits.set(e.dep, wv) }
      for (const t of throwsByFn.get(f) ?? []) errs.set(t.category, (errs.get(t.category) ?? 0) + 1)
      if (silentFns.has(f) && !st.mw) quiet++
      if (!st.mw) { const c = comp(fileOf(f)); if (['domain', 'shared'].includes(layerOf(c))) comps.set(c, Math.min(comps.get(c) ?? 99, st.depth)) }
      for (const mq of modelsByFn.get(f) ?? []) if (mq.ops.some((x) => /create|update|upsert|delete|save|insert|remove/i.test(x))) { writes.add(mq.model); if (mq.ops.some((x) => /^(create|upsert|insert|save)/.test(x))) creates = true; if (mq.ops.includes('upsert')) idem = true }
    } else for (const e of extByFn.get(f) ?? []) if (!isCore(e.dep)) after.add(e.dep)
    if (idemFns.has(f)) idem = true
  }
  return { waits, after, writes, errs, quiet, idem, creates, comps }
}
const profiles = new Map(userJourneys.map((j) => [j.id, profile(j.id)]))
const moments = userJourneys.map((j) => {
  const p = profiles.get(j.id), actor = J.get(j.id).actor
  const money = [...p.writes].some((t) => MONEY.test(t)) || [...p.waits.keys()].some((s) => extKind.get(s) === 'payments')
  const customer = CUSTOMER.test(actor) && !/admin|staff|ops|internal|employee/i.test(actor)
  const unguarded = [...p.waits.values()].reduce((a, x) => a + x.unguarded, 0)
  const criticality = (money ? 2 : 0) + (customer ? 2 : 0) + (j.kind === 'websocket' ? 1 : 0)
  const fragility = p.waits.size + 2 * unguarded + Math.min(3, p.quiet) + (p.errs.has('generic 500') ? 1 : 0)
  return { journey: j.id, actor, money, customer_facing: customer, waits_on: [...p.waits].map(([s, x]) => s + (x.unguarded ? ' (no timeout)' : '')).join(', '), waits: p.waits.size, unguarded_waits: unguarded, after_response: [...p.after].join(', '), quiet_sites: p.quiet, generic_errors: p.errs.get('generic 500') ?? 0, criticality, fragility, score: Math.max(criticality, 1) * fragility }
}).filter((r) => r.score > 0).sort((a, b) => b.score - a.score || b.fragility - a.fragility).slice(0, 40)
w('moments', moments)
const errRows = new Map(), genericSites = new Map()
for (const j of userJourneys) {
  const p = profiles.get(j.id), a = J.get(j.id).area, r = errRows.get(a) ?? { area: a, journeys: 0, typed_only: 0, can_hit_generic: 0, no_errors_found: 0 }
  r.journeys++; if (!p.errs.size) r.no_errors_found++; else if (p.errs.has('generic 500')) r.can_hit_generic++; else r.typed_only++; errRows.set(a, r)
  for (const [f, st] of reach.get(j.id)) if (!st.async) for (const t of throwsByFn.get(f) ?? []) if (t.category === 'generic 500') { const k = f + '|' + t.message; const gs = genericSites.get(k) ?? { site: `${fnById.get(f)?.name ?? '?'} @ ${fileOf(f)}`, message: t.message, journeys: new Set(), areas: new Set() }; gs.journeys.add(j.id); gs.areas.add(a); genericSites.set(k, gs) }
}
w('error_experience', bigEnough([...errRows.values()]).sort((a, b) => b.journeys - a.journeys))
w('generic_errors', [...genericSites.values()].map((x) => ({ site: x.site, message: x.message, journeys: x.journeys.size, areas: [...x.areas].sort().join(', ') })).sort((a, b) => b.journeys - a.journeys).slice(0, 40))
const heur = new Map()
for (const j of userJourneys) {
  const p = profiles.get(j.id), a = J.get(j.id).area, r = heur.get(a) ?? { area: a, journeys: 0, creating_writes: 0, double_submit_protected: 0, after_response_work: 0, after_response_unrecovered: 0, typed_errors: 0, with_errors: 0 }
  r.journeys++
  if (p.creates && (j.kind === 'websocket' || /POST|PUT|\*/.test(j.method ?? ''))) { r.creating_writes++; if (p.idem) r.double_submit_protected++ }
  if (p.after.size) { r.after_response_work++; if ([...p.after].some((x) => noRecovery.has(x))) r.after_response_unrecovered++ }
  if (p.errs.size) { r.with_errors++; if (!p.errs.has('generic 500')) r.typed_errors++ }
  heur.set(a, r)
}
w('heuristics', bigEnough([...heur.values()]).sort((a, b) => b.journeys - a.journeys))
const blueprint = []
for (const t of review.tasks ?? []) (t.steps ?? []).forEach(([label, jid], i) => {
  const j = J.get(jid); if (!j) { console.error(`blueprint: unknown journey "${jid}" in task "${t.task}"`); return }
  const p = profiles.get(jid) ?? profile(jid)
  const KL = { authentication: 'sign-in', authorization: 'permission', validation: 'validation', 'rate-limit': 'rate limit', 'replay-protection': 'replay protection' }
  const checks = [...new Set((passesBy.get(jid) ?? []).filter((x) => x.scope !== 'app' && KL[mwMeta.get(x.mw)?.kind]).map((x) => (/signature/i.test(x.mw) ? 'signature check' : /^optional/i.test(x.mw) ? 'optional sign-in' : KL[mwMeta.get(x.mw).kind])))]
  const add = (lane, item, flag = '') => blueprint.push({ task: t.task, order: i, step: label, actor: j.actor, journey: jid, lane, item, flag })
  add('User', label); add('Request', jid.replace(/^(HTTP|WS|CLI|MCP) /, ''), j.kind)
  add('Checks', checks.join(' · ') || 'none in middleware')
  add('Logic', [...p.comps].sort((a, b) => a[1] - b[1]).slice(0, 3).map(([c]) => c).join(', ') || '—')
  add('Data written', [...p.writes].sort().slice(0, 4).join(', ') + (p.writes.size > 4 ? ` +${p.writes.size - 4}` : '') || 'read only')
  for (const [s, x] of p.waits) add('Waits on', s, x.unguarded ? 'no-timeout' : '')
  for (const s of p.after) add('After response', s, noRecovery.has(s) ? 'no-recovery' : '')
  add('Can fail with', [...p.errs.keys()].sort().map((e) => e.split(' ')[0]).join(' · ') || '—', p.errs.has('generic 500') ? 'generic' : '')
})
w('blueprint', blueprint)

const upCalls = dsm.filter((d) => d.direction === 'up').reduce((a, d) => a + d.calls, 0)
const summary = w('summary', [{
  journeys: g.journeys.length, components: compRows.length, middleware: inv.size, chain_variants: fam.size,
  unguarded_routes: openRoutes.filter((r) => r.verdict === 'No guard').length, unreviewed_open_routes: openRoutes.filter((r) => r.verdict === 'Unreviewed').length,
  external_systems: g.externals.length, tables: new Set(g.modelQueries.map((m) => m.model)).size, events: g.events.length, scheduled_jobs: jobs.length,
  upward_calls: upCalls, cyclic_component_pairs: new Set(dsm.filter((d) => d.cycle).map((d) => [d.from, d.to].sort().join('|'))).size,
}])
w('meta', [{
  project: g.meta?.project ?? config.name ?? path.basename(repo), commit: g.meta?.commit ?? '', branch: g.meta?.branch ?? '', generated_at: g.meta?.generated_at ?? new Date().toISOString(),
  analyzer: g.meta?.analyzer ?? '', frameworks: (g.meta?.frameworks ?? []).join(', '), core_systems: g.externals.filter((e) => CORE_KINDS.has(e.kind)).map((e) => e.name).join(', '),
  actors: [...new Set([...J.values()].map((j) => j.actor))].join(', '), churn_days: config.churnDays ?? 90, has_blueprints: blueprint.length > 0,
}])

// ---------------- derived.json for Neo4j ----------------
fs.writeFileSync(path.join(dir, 'derived.json'), JSON.stringify({
  journeys: [...J.values()].map((j) => ({ id: j.id, actor: j.actor, area: j.area, reached: reach.get(j.id).size })),
  dependsOn, touches, triggers, concepts: CONCEPTS, functionConcepts, callSites,
  posture: [...posture].map(([journey, p]) => ({ journey, ...p })), openRoutes,
  components: compRows, functionComponents: g.functions.map((f) => ({ fn: f.id, component: comp(f.file) })),
  convergence: conv.map((r) => ({ fn: r.f, journeys: r.jm.size, merged: r.gain, streams: r.streams })),
  arrivals: conv.flatMap((r) => [...r.jm].map(([journey, p]) => ({ journey, fn: r.f, via: p === 'ENTRY' ? null : p }))),
  balances: jobs.filter((jb) => RECOVERY_NAME.test(jb.job)).flatMap((jb) => jb.systems.split(', ').filter(Boolean).map((s) => ({ job: jb.journey, dep: s }))),
  inTransaction: [...new Map(g.txCalls.filter((c) => c.from !== c.to).map((c) => [c.from + '|' + c.to, c])).values()],
}))

// ---------------- review queue: what still needs judgment ----------------
const unknownRecovery = resilience.filter((r) => r.recovery === 'Unknown').map((r) => r.system)
const queue = {
  summary: summary[0],
  systems_needing_recovery_verdict: unknownRecovery,
  open_routes_unreviewed: openRoutes.filter((r) => r.verdict === 'Unreviewed').map((r) => r.journey).slice(0, 60),
  // missing timeouts and retries without idempotency are reviewed once, as lens candidates (lenses.mjs:
  // unbounded-wait, retry-without-idempotency), so they aren't listed here
  side_effects_in_transactions: functionConcepts.filter((x) => x.concept === 'side-effect-in-transaction').map((x) => `${x.fn}: ${x.samples.join('; ')}`).slice(0, 20),
  jobs_without_cadence: jobs.filter((jb) => !jb.every_seconds).map((jb) => `${jb.journey} (${jb.schedule || 'no schedule found'})`),
  journeys_without_handler: g.meta?.journeys_without_handler ?? [],
  unresolved_http: g.meta?.unresolved_http ?? [],
  analyzer_warnings: g.meta?.warnings ?? [],
  blueprints: blueprint.length ? `${new Set(blueprint.map((b) => b.task)).size} tasks` : 'none: add review.tasks',
  // every actor with real user journeys should appear in at least one task, or be skipped on purpose
  // (review.blueprintSkips: { "<actor>": "why" }); infra and the scheduler appear as steps, not as users
  actors_without_blueprint: (() => {
    const covered = new Set(blueprint.map((b) => b.actor)), skips = review.blueprintSkips ?? {}, n = new Map()
    for (const j of userJourneys) n.set(J.get(j.id).actor, (n.get(J.get(j.id).actor) ?? 0) + 1)
    return [...n].filter(([a, c]) => c >= 3 && !covered.has(a) && !skips[a] && !/infra|platform|scheduler|^other$/i.test(a)).sort((x, y) => y[1] - x[1]).map(([a, c]) => `${a} (${c} journeys)`)
  })(),
  blueprint_unknown_journeys: (review.tasks ?? []).flatMap((t) => (t.steps ?? []).filter(([, jid]) => !J.has(jid)).map(([, jid]) => `${t.task}: ${jid}`)),
  actors: [...new Set([...J.values()].map((j) => j.actor))],
}
fs.writeFileSync(path.join(dir, 'review-queue.json'), JSON.stringify(queue, null, 2))
console.log(JSON.stringify(queue, null, 2))
