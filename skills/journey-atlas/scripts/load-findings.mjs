// journey-atlas: load findings.json (verified findings structured with decision probes) and lenses.json
// (playbook-skill lens candidates and their verdicts) into Neo4j, linked to the code graph and to the
// playbook skills/references that address them; then print the cross-finding queries.
// See references/findings.md and references/lenses.md.
// Usage: node load-findings.mjs --dir <repo>/.journey-atlas [--query-only]
// Run after load-neo4j.mjs: that loader replaces every node of the project, findings included (run.sh does both).
import fs from 'node:fs'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const dir = path.resolve(arg('dir', '.journey-atlas'))
const envFile = path.join(dir, 'neo4j.env')
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) { const m = line.match(/^(\w+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2] }
const URL_ = `${process.env.NEO4J_URL ?? 'http://localhost:7474'}/db/${process.env.NEO4J_DB ?? 'neo4j'}/tx/commit`
const AUTH = 'Basic ' + Buffer.from(`${process.env.NEO4J_USER ?? 'neo4j'}:${process.env.NEO4J_PASSWORD ?? ''}`).toString('base64')
const g = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'))
const P = arg('project', g.meta?.project ?? path.basename(path.dirname(dir)))
const F = fs.existsSync(path.join(dir, 'findings.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8')) : { assumptions: [], findings: [], interactions: [] }
const L = fs.existsSync(path.join(dir, 'lenses.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'lenses.json'), 'utf8')) : { lenses: [] }

async function run(statement, parameters = {}) {
  const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: AUTH }, body: JSON.stringify({ statements: [{ statement, parameters: { p: P, ...parameters } }] }) })
  if (res.status === 401) throw new Error('Neo4j rejected the credentials (401). Check neo4j.env or NEO4J_PASSWORD.')
  const body = await res.json()
  if (body.errors?.length) throw new Error(`${body.errors[0].message}\n${statement.slice(0, 300)}`)
  const r = body.results[0]
  return r.data.map((d) => Object.fromEntries(r.columns.map((c, i) => [c, d.row[i]])))
}

const ANCHORS = [['functions', 'Function', 'id'], ['systems', 'ExternalDependency', 'name'], ['models', 'DataModel', 'name'], ['components', 'Component', 'name'], ['journeys', 'Journey', 'id']]

if (!process.argv.includes('--query-only')) {
  console.log(`loading ${F.findings.length} findings for "${P}"`)
  await run('MATCH (n {project:$p}) WHERE n:Finding OR n:Assumption OR n:LoopStep OR n:Skill OR n:Reference OR n:Lens OR n:LensCandidate DETACH DELETE n')
  await run('UNWIND $rows AS a CREATE (:Assumption {project:$p, id:a.id, text:a.text, status:a.status, evidence:a.evidence})', { rows: F.assumptions ?? [] })
  for (const f of F.findings) {
    const { assumptions = [], anchors = {}, loop, lenses = [], refs = [], ...props } = f
    props.loop_type = loop?.type ?? 'none'
    props.loop_delay = loop?.delay ?? null
    await run('CREATE (x:Finding {project:$p}) SET x += $props', { props })
    const linked = await run('MATCH (x:Finding {project:$p, id:$id}) UNWIND $ids AS aid MATCH (a:Assumption {project:$p, id:aid}) CREATE (x)-[:RESTS_ON]->(a) RETURN aid', { id: f.id, ids: assumptions })
    const missingA = assumptions.filter((a) => !linked.some((r) => r.aid === a))
    if (missingA.length) console.warn(`  WARN ${f.id}: unknown assumptions ${missingA.join(', ')}`)
    for (const [key, label, prop] of ANCHORS) {
      const ids = anchors[key] ?? []
      if (!ids.length) continue
      const got = await run(`MATCH (x:Finding {project:$p, id:$id}) UNWIND $ids AS k MATCH (t:${label} {project:$p, ${prop}:k}) CREATE (x)-[:ANCHORED_AT {kind:'${label}'}]->(t) RETURN k`, { id: f.id, ids })
      const missing = ids.filter((k) => !got.some((r) => r.k === k))
      if (missing.length) console.warn(`  WARN ${f.id}: no ${label} ${missing.join(', ')} (copy ids from graph.json)`)
    }
    if (loop?.steps?.length) {
      const steps = loop.steps.map(([text, fn], order) => ({ order, text, fn: fn ?? null }))
      await run('MATCH (x:Finding {project:$p, id:$id}) UNWIND $steps AS s CREATE (st:LoopStep {project:$p, finding:$id, order:s.order, text:s.text}) WITH x, st, s WHERE s.order = 0 CREATE (x)-[:LOOP]->(st)', { id: f.id, steps })
      // a reinforcing/balancing loop closes on itself; a chain (type 'chain') does not
      await run(`MATCH (a:LoopStep {project:$p, finding:$id}), (b:LoopStep {project:$p, finding:$id}) WHERE b.order = a.order + 1 ${loop.type === 'chain' ? '' : 'OR (a.order = $n - 1 AND b.order = 0)'} CREATE (a)-[:NEXT]->(b)`, { id: f.id, n: steps.length })
      await run('UNWIND $steps AS s MATCH (st:LoopStep {project:$p, finding:$id, order:s.order}), (fn:Function {project:$p, id:s.fn}) CREATE (st)-[:AT]->(fn)', { id: f.id, steps: steps.filter((s) => s.fn) })
    }
  }
  await run('UNWIND $rows AS r MATCH (a:Finding {project:$p, id:r.from}), (b:Finding {project:$p, id:r.to}) CREATE (a)-[:INTERACTS {kind:r.kind, how:r.how}]->(b)', { rows: F.interactions ?? [] })

  // playbook: skills and the references each lens cites; lens candidates with their review status
  const explicitRefs = F.findings.flatMap((f) => (f.refs ?? []).map((ref) => ({ f: f.id, ref })))
  const skillOfRef = (ref) => ref.split('/')[0]
  const skills = [...new Set([...L.lenses.map((l) => l.skill), ...F.findings.map((f) => f.skill).filter(Boolean),
    ...L.lenses.flatMap((l) => l.refs.map((r) => skillOfRef(r.ref))), ...explicitRefs.map((r) => skillOfRef(r.ref))])]
  await run('UNWIND $rows AS s CREATE (:Skill {project:$p, name:s.name, path:s.path})', { rows: skills.map((name) => ({ name, path: L.playbook ? path.join(L.playbook, name, 'SKILL.md') : null })) })
  const refTitle = (ref) => { const file = L.playbook && path.join(L.playbook, ref.split('#')[0]); return file && fs.existsSync(file) ? { title: fs.readFileSync(file, 'utf8').split('\n').find((l) => /^#\s/.test(l))?.replace(/^#\s+/, '') ?? ref, path: file, exists: true } : { title: ref, exists: false } }
  const refs = [...new Map([...L.lenses.flatMap((l) => l.refs), ...explicitRefs.map((r) => ({ ref: r.ref, ...refTitle(r.ref) }))].map((r) => [r.ref, r])).values()]
  await run(`UNWIND $rows AS r CREATE (ref:Reference {project:$p, ref:r.ref, title:r.title, path:r.path, exists:r.exists})
    WITH ref, r MATCH (s:Skill {project:$p, name:r.skill}) CREATE (ref)-[:PART_OF]->(s)`, { rows: refs.map((r) => ({ ...r, title: r.title ?? r.ref, path: r.path ?? null, skill: r.ref.split('/')[0] })) })
  await run(`UNWIND $rows AS l CREATE (x:Lens {project:$p, id:l.id, skill:l.skill, question:l.question, candidates:size(l.candidates)})
    WITH x, l MATCH (s:Skill {project:$p, name:l.skill}) CREATE (x)-[:OF]->(s)
    WITH x, l UNWIND l.refs AS r MATCH (ref:Reference {project:$p, ref:r.ref}) CREATE (x)-[:CITES]->(ref)`, { rows: L.lenses.map((l) => ({ ...l, candidates: l.candidates.map((c) => c.id) })) })
  const cands = L.lenses.flatMap((l) => l.candidates.map((c) => ({ ...c, question: l.question, refs: l.refs.map((r) => r.ref) })))
  await run(`UNWIND $rows AS c CREATE (x:LensCandidate {project:$p, id:c.id, lens:c.lens, skill:c.skill, title:c.title, evidence:c.evidence, question:c.question, status:c.status, verdict:c.verdict, note:c.note})
    WITH x, c MATCH (s:Skill {project:$p, name:c.skill}) CREATE (x)-[:LENS_OF]->(s)
    WITH x, c MATCH (l:Lens {project:$p, id:c.lens}) CREATE (l)-[:RAISED]->(x)
    WITH x, c UNWIND c.refs AS rr MATCH (ref:Reference {project:$p, ref:rr}) CREATE (x)-[:CITES]->(ref)`, { rows: cands })
  for (const [key, label, prop] of ANCHORS) {
    const rows = cands.flatMap((c) => (c.anchors?.[key] ?? []).map((k) => ({ id: c.id, k })))
    if (rows.length) await run(`UNWIND $rows AS r MATCH (x:LensCandidate {project:$p, id:r.id}), (t:${label} {project:$p, ${prop}:r.k}) CREATE (x)-[:ANCHORED_AT {kind:'${label}'}]->(t)`, { rows })
  }
  // findings link to the skill that fixes them, the lens candidates they came from, and (through those) the references
  await run('UNWIND $rows AS f MATCH (x:Finding {project:$p, id:f.id}), (s:Skill {project:$p, name:f.skill}) CREATE (x)-[:FIXED_BY]->(s)', { rows: F.findings.filter((f) => f.skill) })
  // a finding may name a candidate by the id it had before its lens was merged; resolve through `aliases`
  const aliasOf = new Map(L.lenses.flatMap((l) => l.candidates.flatMap((c) => (c.aliases ?? []).map((a) => [a, c.id]))))
  const promoted = [...new Map(F.findings.flatMap((f) => (f.lenses ?? []).map((c) => ({ f: f.id, c: aliasOf.get(c) ?? c }))).map((r) => [`${r.f}|${r.c}`, r])).values()]
  const linked = await run('UNWIND $rows AS r MATCH (x:Finding {project:$p, id:r.f}), (c:LensCandidate {project:$p, id:r.c}) CREATE (c)-[:PROMOTED_TO]->(x) RETURN r.c AS c', { rows: promoted })
  const missingC = promoted.filter((r) => !linked.some((l) => l.c === r.c))
  if (missingC.length) console.warn(`  WARN findings name lens candidates that lenses.json doesn't have: ${missingC.map((r) => `${r.f}:${r.c}`).join(', ')}`)
  await run('MATCH (x:Finding {project:$p})<-[:PROMOTED_TO]-(:LensCandidate)-[:CITES]->(ref:Reference) MERGE (x)-[:CITES]->(ref)')
  await run('UNWIND $rows AS r MATCH (x:Finding {project:$p, id:r.f}), (ref:Reference {project:$p, ref:r.ref}) MERGE (x)-[:CITES]->(ref)', { rows: explicitRefs })
  console.log((await run('MATCH (n {project:$p}) WHERE n:Finding OR n:Assumption OR n:LoopStep OR n:Skill OR n:Reference OR n:LensCandidate RETURN labels(n)[0] AS label, count(*) AS n')).map((r) => `  ${r.n} ${r.label}`).join('\n'))
}

// The questions a list of findings can't answer on its own. Read them in this order when writing up.
const QUERIES = {
  // reach = journeys whose call path reaches an anchor function, plus journeys anchored directly (as atlas.html counts it)
  'Reach vs severity (journeys and actors whose call path reaches each finding)': `
    MATCH (x:Finding {project:$p})
    CALL { WITH x OPTIONAL MATCH (j:Journey)-[:ENTERS]->(:Function)-[:CALLS*0..15]->(:Function)<-[:ANCHORED_AT]-(x) RETURN collect(DISTINCT j) AS viaCode }
    CALL { WITH x OPTIONAL MATCH (x)-[:ANCHORED_AT]->(j:Journey) RETURN collect(DISTINCT j) AS direct }
    UNWIND (CASE WHEN size(viaCode + direct) = 0 THEN [null] ELSE viaCode + direct END) AS j
    OPTIONAL MATCH (a:Actor {project:$p})-[:PERFORMS]->(j)
    RETURN x.id AS finding, x.severity AS severity, count(DISTINCT j) AS journeys, collect(DISTINCT a.name) AS actors ORDER BY journeys DESC`,
  'Assumptions shared by several findings (one false belief, many symptoms)': `
    MATCH (x:Finding {project:$p})-[:RESTS_ON]->(a:Assumption)
    WITH a, collect(x.id) AS findings WHERE size(findings) > 1
    RETURN a.text AS assumption, a.status AS status, findings ORDER BY size(findings) DESC`,
  'Functions where findings converge (one fix site, several findings)': `
    MATCH (x:Finding {project:$p})-[:ANCHORED_AT]->(fn:Function)
    WITH fn, collect(x.id) AS findings WHERE size(findings) > 1
    OPTIONAL MATCH (j:Journey {project:$p})-[:ENTERS]->(:Function)-[:CALLS*0..15]->(fn)
    RETURN fn.name AS function, findings, count(DISTINCT j) AS journeys ORDER BY size(findings) DESC, journeys DESC`,
  'Loops and where each step runs': `
    MATCH (x:Finding {project:$p})-[:LOOP]->(:LoopStep)
    MATCH (s:LoopStep {project:$p, finding:x.id}) OPTIONAL MATCH (s)-[:AT]->(fn)
    WITH x, s, fn ORDER BY s.order
    RETURN x.id AS finding, x.loop_type AS type, x.loop_delay AS delay, collect(s.text + coalesce(' @ ' + fn.name, '')) AS steps`,
  'Interactions (fix order: resolve the target of a fix-amplifies edge first)': `
    MATCH (a:Finding {project:$p})-[r:INTERACTS]->(b:Finding) RETURN a.id AS from, r.kind AS kind, b.id AS to, r.how AS how`,
  'By playbook skill: findings it fixes, lens candidates still open, journeys reached, references to read': `
    MATCH (s:Skill {project:$p})
    OPTIONAL MATCH (x:Finding)-[:FIXED_BY]->(s)
    OPTIONAL MATCH (x)-[:ANCHORED_AT]->(fn:Function)<-[:CALLS*0..15]-(:Function)<-[:ENTERS]-(j:Journey)
    OPTIONAL MATCH (o:LensCandidate {status:'open'})-[:LENS_OF]->(s)
    OPTIONAL MATCH (x)-[:CITES]->(ref:Reference)
    WITH s, collect(DISTINCT x.id) AS findings, count(DISTINCT j) AS journeys, count(DISTINCT o) AS open, collect(DISTINCT ref.ref) AS refs
    WHERE size(findings) > 0 OR open > 0
    RETURN s.name AS skill, findings, journeys, open, refs ORDER BY size(findings) DESC, journeys DESC`,
  'Lens coverage: what each skill checked, and what came of it (clean = checked, nothing found)': `
    MATCH (l:Lens {project:$p}) OPTIONAL MATCH (l)-[:RAISED]->(c:LensCandidate) OPTIONAL MATCH (c)-[:PROMOTED_TO]->(x:Finding)
    WITH l, count(DISTINCT c) AS n, collect(DISTINCT x.id) AS findings, sum(CASE c.status WHEN 'open' THEN 1 ELSE 0 END) AS open,
      [s IN collect(DISTINCT CASE WHEN c.status IN ['dismissed','accepted'] THEN c.status + ': ' + c.note END) WHERE s IS NOT NULL] AS notPromoted
    RETURN l.skill AS skill, l.id AS lens, CASE n WHEN 0 THEN 'clean' ELSE toString(n) + ' candidates' END AS result, findings, open, notPromoted
    ORDER BY skill, n DESC, lens`,
  'Findings per component (where fixes concentrate)': `
    MATCH (x:Finding {project:$p})-[:ANCHORED_AT]->(fn:Function)-[:BELONGS_TO]->(c:Component)
    RETURN c.name AS component, collect(DISTINCT x.id) AS findings, count(DISTINCT fn) AS functions ORDER BY size(findings) DESC`,
}
for (const [title, q] of Object.entries(QUERIES)) {
  console.log(`\n## ${title}`)
  for (const row of await run(q)) console.log('  ', JSON.stringify(row))
}
