// journey-atlas: load graph.json + derived.json into Neo4j over the HTTP API.
// Every node carries `project`, so several repos can share one database; a load replaces only its own project.
// Usage: node load-neo4j.mjs --dir <repo>/.journey-atlas   (connection from <dir>/neo4j.env or NEO4J_URL/USER/PASSWORD)
import fs from 'node:fs'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const dir = path.resolve(arg('dir', '.journey-atlas'))
const envFile = path.join(dir, 'neo4j.env')
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) { const m = line.match(/^(\w+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2] }
const URL_ = `${process.env.NEO4J_URL ?? 'http://localhost:7474'}/db/${process.env.NEO4J_DB ?? 'neo4j'}/tx/commit`
const AUTH = 'Basic ' + Buffer.from(`${process.env.NEO4J_USER ?? 'neo4j'}:${process.env.NEO4J_PASSWORD ?? ''}`).toString('base64')
const g = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'))
const d = JSON.parse(fs.readFileSync(path.join(dir, 'derived.json'), 'utf8'))
const P = arg('project', g.meta?.project ?? path.basename(path.dirname(dir)))

async function run(statement, parameters = {}) {
  const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: AUTH }, body: JSON.stringify({ statements: [{ statement, parameters: { p: P, ...parameters } }] }) })
  if (res.status === 401) throw new Error('Neo4j rejected the credentials (401). Check neo4j.env or NEO4J_PASSWORD.')
  const body = await res.json()
  if (body.errors?.length) throw new Error(`${body.errors[0].message}\n${statement.slice(0, 300)}`)
  return body.results[0]
}
async function batched(label, statement, rows, size = 2000) {
  for (let i = 0; i < rows.length; i += size) await run(statement, { rows: rows.slice(i, i + size) })
  console.log(`  ${String(rows.length).padStart(6)}  ${label}`)
}

console.log(`loading project "${P}" into ${URL_.replace(/\/tx\/commit$/, '')}`)
for (const idx of [
  'CREATE INDEX ja_fn IF NOT EXISTS FOR (n:Function) ON (n.id)', 'CREATE INDEX ja_journey IF NOT EXISTS FOR (n:Journey) ON (n.id)',
  'CREATE INDEX ja_ext IF NOT EXISTS FOR (n:ExternalDependency) ON (n.name)', 'CREATE INDEX ja_model IF NOT EXISTS FOR (n:DataModel) ON (n.name)',
  'CREATE INDEX ja_event IF NOT EXISTS FOR (n:Event) ON (n.id)', 'CREATE INDEX ja_mw IF NOT EXISTS FOR (n:Middleware) ON (n.name)',
  'CREATE INDEX ja_comp IF NOT EXISTS FOR (n:Component) ON (n.name)', 'CREATE INDEX ja_project IF NOT EXISTS FOR (n:Function) ON (n.project)',
]) await run(idx)
await run('MATCH (n {project: $p}) CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 5000 ROWS').catch(() => run('MATCH (n {project: $p}) DETACH DELETE n'))

const jMeta = new Map(d.journeys.map((j) => [j.id, j]))
await batched('functions', `UNWIND $rows AS r CREATE (:Function {project: $p, id: r.id, name: r.name, file: r.file, line: r.line})`, g.functions, 5000)
await batched('components', `UNWIND $rows AS r CREATE (:Component {project: $p, name: r.component, layer: r.layer, functions: r.functions, journeys: r.journeys, instability: r.instability})`, d.components)
await batched('function → component', `UNWIND $rows AS r MATCH (f:Function {project: $p, id: r.fn}), (c:Component {project: $p, name: r.component}) CREATE (f)-[:BELONGS_TO]->(c)`, d.functionComponents, 5000)
await batched('external systems', `UNWIND $rows AS r CREATE (:ExternalDependency {project: $p, name: r.name, kind: r.kind})`, g.externals)
const models = [...new Set(g.modelQueries.map((m) => m.model))].map((name) => ({ name }))
await batched('tables', `UNWIND $rows AS r CREATE (m:DataModel {project: $p, name: r.name}) WITH m MATCH (db:ExternalDependency {project: $p, kind: 'database'}) WITH m, db LIMIT 1 CREATE (m)-[:STORED_IN]->(db)`, models)
await batched('events', `UNWIND $rows AS r CREATE (:Event {project: $p, id: r.id, emitter: r.emitter, name: r.name, transport: r.transport})`, g.events)
await batched('journeys', `UNWIND $rows AS r
  MERGE (a:Actor {project: $p, name: r.actor}) MERGE (f:Feature {project: $p, key: r.area})
  MERGE (a)-[:USES]->(f)
  CREATE (j:Journey {project: $p, id: r.id, kind: r.kind, name: r.name, method: r.method, path: r.path, schedule: r.schedule, source: r.source, actor: r.actor, area: r.area, reachedFunctions: r.reached})
  CREATE (a)-[:PERFORMS]->(j) CREATE (f)-[:INCLUDES]->(j)`, g.journeys.map((j) => ({ ...j, ...jMeta.get(j.id), schedule: j.schedule ?? null, source: j.source ?? null, method: j.method ?? null })))
await batched('middleware', `UNWIND $rows AS r CREATE (m:Middleware {project: $p, name: r.name, kind: r.kind, package: r.package})
  WITH m, r WHERE r.impl IS NOT NULL MATCH (f:Function {project: $p, id: r.impl}) CREATE (m)-[:IMPLEMENTED_BY]->(f)`, g.middleware)
await batched('ENTERS', `UNWIND $rows AS r MATCH (j:Journey {project: $p, id: r.journey}), (f:Function {project: $p, id: r.fn}) CREATE (j)-[:ENTERS {role: r.role, order: r.order}]->(f)`, g.entries)
const inTx = new Set(d.inTransaction.map((c) => c.from + '|' + c.to))
await batched('CALLS', `UNWIND $rows AS r MATCH (a:Function {project: $p, id: r.from}), (b:Function {project: $p, id: r.to}) CREATE (a)-[:CALLS {kind: r.kind, inTransaction: r.tx}]->(b)`, g.calls.map((c) => ({ ...c, tx: inTx.has(c.from + '|' + c.to) })), 5000)
const site = new Map(d.callSites.map((c) => [c.fn + '|' + c.dep, c]))
await batched('CALLS_EXTERNAL', `UNWIND $rows AS r MATCH (a:Function {project: $p, id: r.from}), (e:ExternalDependency {project: $p, name: r.dep})
  CREATE (a)-[:CALLS_EXTERNAL {ops: r.ops, sync: r.sync, timeout: r.timeout, retry: r.retry, idempotency: r.idempotency, circuitBreaker: r.circuit_breaker}]->(e)`,
  g.externalCalls.map((e) => { const s = site.get(e.from + '|' + e.dep) ?? {}; return { ...e, sync: e.sync !== false, timeout: s.timeout ?? null, retry: s.retry ?? null, idempotency: s.idempotency ?? null, circuit_breaker: s.circuit_breaker ?? null } }))
await batched('QUERIES', `UNWIND $rows AS r MATCH (a:Function {project: $p, id: r.from}), (m:DataModel {project: $p, name: r.model}) CREATE (a)-[:QUERIES {ops: r.ops}]->(m)`, g.modelQueries)
await batched('EMITS', `UNWIND $rows AS r MATCH (a:Function {project: $p, id: r.from}), (e:Event {project: $p, id: r.event}) CREATE (a)-[:EMITS]->(e)`, g.emits)
await batched('HANDLED_BY', `UNWIND $rows AS r MATCH (e:Event {project: $p, id: r.event}), (f:Function {project: $p, id: r.to}) CREATE (e)-[:HANDLED_BY]->(f)`, g.handles)
await batched('PASSES_THROUGH', `UNWIND $rows AS r MATCH (j:Journey {project: $p, id: r.journey}), (m:Middleware {project: $p, name: r.mw}) CREATE (j)-[:PASSES_THROUGH {order: r.order, scope: r.scope, config: r.config}]->(m)`, g.mwPasses, 5000)
await batched('DEPENDS_ON', `UNWIND $rows AS r MATCH (j:Journey {project: $p, id: r.journey}), (e:ExternalDependency {project: $p, name: r.dep})
  CREATE (j)-[:DEPENDS_ON {distance: r.distance, async: r.async, viaMiddlewareOnly: r.viaMiddlewareOnly, ops: r.ops}]->(e)`, d.dependsOn)
await batched('TOUCHES', `UNWIND $rows AS r MATCH (j:Journey {project: $p, id: r.journey}), (m:DataModel {project: $p, name: r.model})
  CREATE (j)-[:TOUCHES {distance: r.distance, async: r.async, writes: r.writes, ops: r.ops}]->(m)`, d.touches, 5000)
await batched('TRIGGERS', `UNWIND $rows AS r MATCH (j:Journey {project: $p, id: r.journey}), (e:Event {project: $p, id: r.event}) CREATE (j)-[:TRIGGERS {distance: r.distance, async: r.async}]->(e)`, d.triggers)
await batched('concepts', `UNWIND $rows AS r CREATE (:Concept {project: $p, name: r.name, skill: r.skill, polarity: r.polarity})`, d.concepts)
const pol = new Map(d.concepts.map((c) => [c.name, c.polarity]))
for (const rel of ['APPLIES', 'EXHIBITS'])
  await batched(rel, `UNWIND $rows AS r MATCH (f:Function {project: $p, id: r.fn}), (c:Concept {project: $p, name: r.concept})
    MERGE (f)-[x:${rel}]->(c) ON CREATE SET x.signals = [r.signal], x.count = r.count, x.samples = r.samples ON MATCH SET x.signals = x.signals + r.signal, x.count = x.count + r.count`,
    d.functionConcepts.filter((r) => (pol.get(r.concept) === 'risk') === (rel === 'EXHIBITS')))
await batched('journey posture', `UNWIND $rows AS r MATCH (j:Journey {project: $p, id: r.journey}) SET j.authn = r.authn, j.authzPipeline = r.authzPipeline, j.authzHandler = r.authzHandler, j.validationPipeline = r.validationPipeline, j.validationHandler = r.validationHandler, j.rateLimit = r.rateLimit`, d.posture)
await batched('open-route verdicts', `UNWIND $rows AS r MATCH (j:Journey {project: $p, id: r.journey}) SET j.openRouteVerdict = r.verdict, j.openRouteNote = r.note`, d.openRoutes)
await batched('convergence points', `UNWIND $rows AS r MATCH (f:Function {project: $p, id: r.fn}) SET f:ConvergencePoint, f.convergenceJourneys = r.journeys, f.mergedJourneys = r.merged, f.incomingPaths = r.streams`, d.convergence)
await batched('CONVERGES_AT', `UNWIND $rows AS r MATCH (j:Journey {project: $p, id: r.journey}), (f:Function {project: $p, id: r.fn}) CREATE (j)-[:CONVERGES_AT {via: r.via}]->(f)`, d.arrivals)
await batched('BALANCES', `UNWIND $rows AS r MATCH (j:Journey {project: $p, id: r.job}), (e:ExternalDependency {project: $p, name: r.dep}) MERGE (j)-[:BALANCES]->(e)`, d.balances)
const counts = await run('MATCH (n {project: $p}) RETURN labels(n)[0] AS label, count(*) AS n ORDER BY n DESC')
console.log(counts.data.map((x) => x.row.join(': ')).join(', '))
