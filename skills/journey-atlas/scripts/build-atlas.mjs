// journey-atlas: assemble the architecture atlas as one self-contained HTML file from atlas-data/*.json.
// Usage: node build-atlas.mjs --dir <repo>/.journey-atlas [--out <file>] [--fragment]
//   --fragment omits <!doctype>/<html>/<head>/<body> so the file can be published as a claude.ai Artifact page.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const dir = path.resolve(arg('dir', '.journey-atlas'))
const fragment = process.argv.includes('--fragment')
const out = path.resolve(arg('out', path.join(dir, fragment ? 'atlas-artifact.html' : 'atlas.html')))
const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'atlas')
const dataDir = path.join(dir, 'atlas-data')
if (!fs.existsSync(dataDir)) { console.error(`No atlas-data in ${dir}. Run derive.mjs first.`); process.exit(2) }

const DATA = {}
for (const f of fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'))) DATA[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'))
// ---------------- review layer (optional): findings, lens coverage, practices ----------------
// findings.json and lenses.json come after derive, so their views are computed here. Without them the
// Findings tab says how to produce them and the overlays stay empty.
const readOpt = (f) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null)
const FND = readOpt('findings.json'), LNS = readOpt('lenses.json'), G = readOpt('graph.json'), DRV = readOpt('derived.json')
const SEV = { high: 3, medium: 2, low: 1 }
const actorOf = new Map((DATA.journeys_index ?? []).map((j) => [j.journey, j.actor]))
if (FND?.findings?.length && G) {
  // reach: journeys whose call path (entry → calls, up to 15 deep, as load-findings counts it) reaches an
  // anchor function, plus journeys anchored directly
  const adj = new Map(); for (const c of G.calls ?? []) (adj.get(c.from) ?? adj.set(c.from, []).get(c.from)).push(c.to)
  const entries = new Map(); for (const e of G.entries ?? []) (entries.get(e.journey) ?? entries.set(e.journey, []).get(e.journey)).push(e.fn)
  const anchorFns = new Set(FND.findings.flatMap((x) => x.anchors?.functions ?? []))
  const hits = new Map()
  for (const [jid, fns] of entries) {
    const depth = new Map(fns.map((f) => [f, 0])), q = [...fns], hit = new Set()
    while (q.length) { const f = q.shift(), dp = depth.get(f); if (anchorFns.has(f)) hit.add(f); if (dp >= 15) continue; for (const t of adj.get(f) ?? []) if (!depth.has(t)) { depth.set(t, dp + 1); q.push(t) } }
    if (hit.size) hits.set(jid, hit)
  }
  const assumption = new Map((FND.assumptions ?? []).map((a) => [a.id, a]))
  const refsOf = (x) => [...new Set([...(x.refs ?? []), ...(LNS?.lenses ?? []).filter((l) => l.candidates.some((c) => (x.lenses ?? []).includes(c.id) || (c.aliases ?? []).some((a) => (x.lenses ?? []).includes(a)))).flatMap((l) => l.refs.map((r) => r.ref))])]
  const pairs = []
  DATA.findings = FND.findings.map((x) => {
    const fns = new Set(x.anchors?.functions ?? [])
    const js = new Set([...(x.anchors?.journeys ?? []).filter((j) => actorOf.has(j)), ...[...hits].filter(([, h]) => [...h].some((f) => fns.has(f))).map(([j]) => j)])
    for (const j of js) pairs.push({ finding: x.id, journey: j, severity: x.severity ?? 'medium', title: x.title })
    return {
      id: x.id, title: x.title, severity: x.severity ?? 'medium', skill: x.skill ?? '', summary: x.summary ?? '', emergent: !!x.emergent,
      journeys: js.size, actors: [...new Set([...js].map((j) => actorOf.get(j)).filter(Boolean))], sample_journeys: [...js].slice(0, 12),
      assumptions: (x.assumptions ?? []).map((id) => assumption.get(id)).filter(Boolean).map((a) => ({ text: a.text, status: a.status, shared: FND.findings.filter((y) => y.id !== x.id && (y.assumptions ?? []).includes(a.id)).map((y) => y.id) })),
      near_term: x.near_term ?? '', long_term: x.long_term ?? '', pre_mortem: x.pre_mortem ?? '', opportunity_cost: x.opportunity_cost ?? '', deferred_cost_owner: x.deferred_cost_owner ?? '',
      next_control: x.next_control ?? '', control_owner: x.control_owner ?? '',
      loop: x.loop ? { type: x.loop.type, delay: x.loop.delay ?? '', steps: (x.loop.steps ?? []).map((s) => (Array.isArray(s) ? s[0] : s)) } : null,
      interactions: (FND.interactions ?? []).filter((i) => i.from === x.id || i.to === x.id).map((i) => ({ from: i.from, to: i.to, kind: i.kind, how: i.how ?? '' })),
      refs: refsOf(x),
    }
  }).sort((a, b) => (SEV[b.severity] ?? 0) - (SEV[a.severity] ?? 0) || b.journeys - a.journeys)
  DATA.finding_journeys = pairs
}
if (LNS?.lenses?.length) {
  DATA.lens_coverage = LNS.lenses.map((l) => {
    const by = (s) => l.candidates.filter((c) => c.status === s)
    const reasons = [...new Map(l.candidates.filter((c) => c.status !== 'promoted' && c.note).map((c) => [c.note, `${c.status}: ${c.note}`])).values()].slice(0, 3)
    return { lens: l.id, skill: l.skill, tier: l.tier ?? 'review', question: l.question ?? '', skipped: l.skipped ?? '', candidates: l.candidates.length,
      promoted: by('promoted').length, accepted: by('accepted').length, dismissed: by('dismissed').length, deferred: by('deferred').length, open: by('open').length,
      findings: [...new Set(by('promoted').map((c) => String(c.verdict).replace(/^finding\s+/i, '')))], reasons }
  })
}
if (DRV?.functionConcepts?.length) {
  // practices by component: how many functions in each component apply a control or exhibit a risk
  const compOf = new Map((DRV.functionComponents ?? []).map((r) => [r.fn, r.component]))
  const polarity = new Map((DRV.concepts ?? []).map((c) => [c.name, c.polarity]))
  const m = new Map()
  for (const r of DRV.functionConcepts) { const c = compOf.get(r.fn); if (!c) continue; const k = `${c}|${r.concept}`; const e = m.get(k) ?? m.set(k, { component: c, concept: r.concept, polarity: polarity.get(r.concept) ?? 'control', fns: new Set() }).get(k); e.fns.add(r.fn) }
  const size = new Map((DATA.components ?? []).map((c) => [c.component, Number(c.functions)]))
  DATA.practices = [...m.values()].map((e) => ({ component: e.component, concept: e.concept, polarity: e.polarity, functions: e.fns.size, component_functions: size.get(e.component) ?? 0 }))
}
const first = (k) => (DATA[k] ?? [])[0]
// opening state: the most telling example in each explorer
DATA.__params = {
  ctx_core: false,
  file: (DATA.hotspots ?? []).slice().sort((a, b) => b.journeys - a.journeys)[0]?.file ?? first('impact_files')?.file ?? null,
  journey: first('moments')?.journey ?? first('journeys_index')?.journey ?? null,
  chain_area: [...(DATA.chain_variants ?? []).reduce((m, r) => m.set(r.area, (m.get(r.area) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  bp_task: first('blueprint')?.task ?? null,
}
const project = first('meta')?.project ?? 'Project'
const read = (f) => fs.readFileSync(path.join(assets, f), 'utf8')
const inline = (code) => `<script>\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`
let page = read('page.html')
  .replace('<script src="atlas-kit.js"></script>', inline(read('atlas-kit.js')))
  .replace('<script src="atlas-views.js"></script>', inline(read('atlas-views.js')))
const json = JSON.stringify(DATA).replace(/</g, '\\u003c')
const head = `<title>${project.replace(/[<&]/g, '')} architecture atlas</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${read('tokens.css')}</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
<script id="atlas-data" type="application/json">${json}</script>
${inline(read('shim.js'))}`
const body = `<div id="dash-root">\n${page}\n</div>`
const html = fragment ? `${head}\n${body}\n` : `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`
fs.writeFileSync(out, html)
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB)`)
