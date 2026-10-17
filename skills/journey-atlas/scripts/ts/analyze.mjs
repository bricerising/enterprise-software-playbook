// journey-atlas TypeScript/JavaScript analyzer.
// Walks every source file with the TypeScript type checker and writes graph.json (see references/graph-schema.md):
// user journeys (entry points) → functions → external systems and tables, middleware chains, events, practice signals.
//
// Usage: node --max-old-space-size=8192 analyze.mjs --repo <dir> --config <config.json> --out <graph.json>
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classifyPackage, classifyHost, HTTP_CLIENT_PACKAGES } from '../lib/catalog.mjs'

// ---------------- arguments, config, typescript ----------------
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt }
const repo = path.resolve(arg('repo', '.'))
const configPath = arg('config', path.join(repo, '.journey-atlas/config.json'))
const outFile = arg('out', path.join(repo, '.journey-atlas/graph.json'))
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}
const here = path.dirname(fileURLToPath(import.meta.url))
let ts
for (const base of [repo, path.join(here, '..')]) {
  try { ts = createRequire(path.join(base, 'package.json'))('typescript'); break } catch {}
}
if (!ts) { console.error('typescript not found. Run `npm install --prefix ' + path.join(here, '..') + '` once, or add typescript to the repo.'); process.exit(2) }

const rel = (f) => path.relative(repo, f).split(path.sep).join('/')
const rx = (s) => (s instanceof RegExp ? s : new RegExp(s))
const DEFAULT_EXCLUDE = ['(^|/)(test|tests|__tests__|__mocks__|e2e|fixtures?|spec)/', '\\.(test|spec|stories|e2e)\\.[cm]?[jt]sx?$', '\\.d\\.ts$', '(^|/)(dist|build|out|coverage|\\.next|node_modules)/', '(^|/)generated/']
const excludes = [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])].map(rx)
const includes = (config.include ?? []).map(rx)
const isAnalyzed = (f) => {
  if (!f.startsWith(repo + path.sep) || f.includes(`${path.sep}node_modules${path.sep}`)) return false
  const r = rel(f)
  if (includes.length && !includes.some((re) => re.test(r))) return false
  return !excludes.some((re) => re.test(r))
}
const warn = []
// framework, ORM and SDK detection read types from installed packages; without them routes and tables silently vanish
if (!fs.existsSync(path.join(repo, 'node_modules')) && !fs.existsSync(path.join(path.dirname(repo), 'node_modules'))) {
  const msg = 'No node_modules in the repo: install dependencies first (e.g. npm ci --ignore-scripts), or Express/Prisma/SDK detection will miss most entries and systems'
  warn.push(msg); console.error(`WARNING: ${msg}`)
}

// ---------------- graph accumulators (shared across tsconfig projects) ----------------
const functions = new Map(), calls = new Map(), externalCalls = new Map(), modelQueries = new Map()
const events = new Map(), emits = new Map(), handles = new Map(), journeys = new Map(), externals = new Map()
const entries = [], throws = [], txCalls = [], unresolvedHttp = []
const signals = new Map()
const envReads = new Set() // `${fn}|${ENV_KEY}`: which functions read which environment variables
const mwNodes = new Map(), mwPasses = []
const frameworks = new Set()
const addCall = (from, to, kind = 'call') => { if (from && to && from !== to) calls.set(`${from}|${to}|${kind}`, { from, to, kind }) }
const ensureExternal = (name, kind) => { if (!externals.has(name)) externals.set(name, { name, kind }); return name }
function addSignal(fn, signal, sample) {
  if (!signals.has(fn)) signals.set(fn, new Map())
  const m = signals.get(fn), cur = m.get(signal) ?? { count: 0, samples: new Set() }
  cur.count++
  if (sample && cur.samples.size < 5) cur.samples.add(String(sample).slice(0, 80))
  m.set(signal, cur)
}
const addJourney = (j) => { if (!journeys.has(j.id)) journeys.set(j.id, j); return journeys.get(j.id) }

// ---------------- database naming ----------------
function detectPrismaProvider() {
  if (config.database) return config.database
  let files = []
  try { files = execSync('git ls-files "*schema.prisma" "*.prisma"', { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean) } catch {}
  for (const f of files) {
    const m = fs.readFileSync(path.join(repo, f), 'utf8').match(/provider\s*=\s*"(postgresql|mysql|sqlite|sqlserver|mongodb|cockroachdb)"/)
    if (m) return { postgresql: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite', sqlserver: 'SQL Server', mongodb: 'MongoDB', cockroachdb: 'CockroachDB' }[m[1]]
  }
  return 'Database'
}
const DATABASE = detectPrismaProvider()
const isPrismaClientFile = (f) => /[\\/](\.prisma[\\/]client|generated[\\/]prisma|@prisma[\\/]client)[\\/]/.test(f) || (config.prismaClientPaths ?? []).some((p) => f.includes(p))
const PRISMA_OPS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy'])
const ORM_OPS = /^(find\w*|count\w*|aggregate|exist\w*|save|insert\w*|create\w*|update\w*|upsert|delete\w*|remove|destroy|softDelete|restore|bulkCreate|bulkWrite|replaceOne)$/

const pkgOf = (file) => {
  const m = file.split(path.sep).join('/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)
  if (!m) return null
  let p = m[m.length - 1].replace('node_modules/', '')
  if (p.startsWith('@types/')) { const t = p.slice(7); p = t.includes('__') ? '@' + t.replace('__', '/') : t }
  return p
}
const ext = config.externals ?? {}
const classifyPkg = (pkg) => {
  const c = classifyPackage(pkg, ext.packages ?? [])
  if (!c) return null
  return ensureExternal(c.name ?? DATABASE, c.kind)
}

// ---------------- the per-project analysis ----------------
const tsconfigs = [].concat(config.tsconfig ?? (fs.existsSync(path.join(repo, 'tsconfig.json')) ? 'tsconfig.json' : []))
if (!tsconfigs.length) { console.error('No tsconfig.json found. Set "tsconfig" in the config (a path or a list of paths).'); process.exit(2) }
for (const tsconfig of tsconfigs) analyzeProject(path.resolve(repo, tsconfig))

function analyzeProject(cfgPath) {
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(cfgPath))
  const rootNames = parsed.fileNames.filter(isAnalyzed)
  const options = { ...parsed.options, allowJs: parsed.options.allowJs ?? true, incremental: false, composite: false, noEmit: true, tsBuildInfoFile: undefined }
  console.error(`[${rel(cfgPath)}] creating program over ${rootNames.length} files...`)
  const program = ts.createProgram({ rootNames, options })
  const checker = program.getTypeChecker()
  const sourceFiles = program.getSourceFiles().filter((sf) => isAnalyzed(sf.fileName))
  console.error(`[${rel(cfgPath)}] analyzing ${sourceFiles.length} source files`)
  const typeText = (node) => { try { return checker.typeToString(checker.getTypeAtLocation(node)) } catch { return '' } }

  // ---------- owners: the functions that become graph vertices ----------
  const isFnExpr = (n) => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))
  const REGISTRATION = /^(get|post|put|patch|delete|del|all|use|on|once|addListener|schedule|scheduleJob|setInterval|setTimeout|setImmediate|define|every|process|consume|subscribe|route|register\w*Handler|handle)$/
  const calleeName = (call) => { const e = call.expression; return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '' }
  const hasFunctionAncestor = (n) => { for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return true; return false }
  function isOwner(n) {
    if (ts.isFunctionDeclaration(n) && n.body) return true
    if ((ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) && n.body) return true
    if (ts.isPropertyDeclaration(n) && isFnExpr(n.initializer)) return true
    if (ts.isVariableDeclaration(n) && isFnExpr(n.initializer) && !hasFunctionAncestor(n)) return true
    if (ts.isPropertyAssignment(n) && isFnExpr(n.initializer)) return true
    if (isFnExpr(n) && (ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent)) && n.parent.arguments?.includes(n)) {
      if (ts.isNewExpression(n.parent) || REGISTRATION.test(calleeName(n.parent))) return true
      if (!hasFunctionAncestor(n)) return true
    }
    if (ts.isExportAssignment(n) && isFnExpr(n.expression)) return true
    return false
  }
  function containerName(n) {
    for (let p = n.parent; p; p = p.parent) {
      if ((ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name) return p.name.text
      if (ts.isObjectLiteralExpression(p)) {
        const v = p.parent
        if (v && ts.isVariableDeclaration(v) && ts.isIdentifier(v.name)) return v.name.text
        if (v && ts.isPropertyAssignment(v)) return v.name.getText()
        return null
      }
    }
    return null
  }
  function nameOf(n) {
    const line = n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1
    if (ts.isConstructorDeclaration(n)) return `${containerName(n) ?? '?'}.constructor`
    if (ts.isFunctionDeclaration(n)) return n.name ? n.name.text : 'default'
    if (ts.isExportAssignment(n)) return 'default'
    if (ts.isVariableDeclaration(n)) return n.name.getText()
    if (ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isPropertyAssignment(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) {
      const c = containerName(n), nm = n.name.getText().replace(/^['"]|['"]$/g, '')
      return c ? `${c}.${nm}` : nm
    }
    if (isFnExpr(n)) {
      const call = n.parent, first = call.arguments?.[0]
      return `${call.expression.getText().replace(/\s+/g, ' ').slice(0, 60)}(${first && first !== n ? first.getText().slice(0, 60) : ''}) callback@L${line}`
    }
    return `anon@L${line}`
  }
  const ownerIds = new WeakMap()
  function ownerId(n) {
    if (ownerIds.has(n)) return ownerIds.get(n)
    const sf = n.getSourceFile(), line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
    const name = nameOf(n), file = rel(sf.fileName), id = `${file}#${name}@${line}`
    ownerIds.set(n, id)
    if (!functions.has(id)) functions.set(id, { id, name, file, line })
    return id
  }
  function moduleOwner(sf) {
    const file = rel(sf.fileName), id = `${file}#<module>`
    if (!functions.has(id)) functions.set(id, { id, name: '<module>', file, line: 0 })
    return id
  }
  function enclosingOwner(n) { for (let p = n.parent; p; p = p.parent) if (isOwner(p)) return ownerId(p); return moduleOwner(n.getSourceFile()) }
  function ownerForDecl(d) {
    if (!isAnalyzed(d.getSourceFile().fileName)) return null
    if (isOwner(d)) return ownerId(d)
    if (ts.isVariableDeclaration(d) && isFnExpr(d.initializer)) return enclosingOwner(d)
    if (ts.isClassDeclaration(d)) { const ctor = d.members.find(ts.isConstructorDeclaration); return ctor ? ownerId(ctor) : null }
    if (isFnExpr(d)) return enclosingOwner(d)
    return null
  }
  function resolveSymbol(node) {
    let sym
    try { sym = checker.getSymbolAtLocation(node) } catch { return null }
    if (!sym) return null
    if (sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym) } catch { return null } }
    return sym
  }
  const calleeNode = (e) => (ts.isPropertyAccessExpression(e) ? e.name : ts.isElementAccessExpression(e) ? e.argumentExpression : e)
  const declOf = (node) => resolveSymbol(calleeNode(node))?.declarations?.[0]
  const targetOf = (a) => {
    if (!a) return null
    if (isFnExpr(a)) return ownerId(a)
    const d = ts.isCallExpression(a) ? declOf(a.expression) : declOf(a)
    return d ? ownerForDecl(d) : null
  }
  const literalText = (node) => {
    if (!node) return null
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    try { const t = checker.getTypeAtLocation(node); if (t.isStringLiteral()) return t.value; if (t.isNumberLiteral()) return String(t.value) } catch {}
    return null
  }

  // ---------- interface dispatch: interface member → implementing classes / typed object literals ----------
  const implIndex = new Map()
  const interfaceDeclsOf = (typeNode) => (resolveSymbol(ts.isExpressionWithTypeArguments(typeNode) ? typeNode.expression : typeNode.typeName ?? typeNode)?.declarations ?? []).filter((d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isClassDeclaration(d))
  for (const sf of sourceFiles) (function visit(n) {
    if ((ts.isClassDeclaration(n) || ts.isClassExpression(n)) && n.heritageClauses)
      for (const hc of n.heritageClauses) for (const t of hc.types) for (const idecl of interfaceDeclsOf(t)) (implIndex.get(idecl) ?? implIndex.set(idecl, []).get(idecl)).push(n)
    if (ts.isVariableDeclaration(n) && n.type && ts.isTypeReferenceNode(n.type) && n.initializer && ts.isObjectLiteralExpression(n.initializer))
      for (const idecl of interfaceDeclsOf(n.type)) (implIndex.get(idecl) ?? implIndex.set(idecl, []).get(idecl)).push(n.initializer)
    ts.forEachChild(n, visit)
  })(sf)
  function implementationsOf(memberDecl) {
    const parent = memberDecl.parent, name = memberDecl.name?.getText()
    const impls = implIndex.get(parent) ?? (parent?.parent && ts.isTypeAliasDeclaration(parent.parent) ? implIndex.get(parent.parent) : null) ?? []
    const out = []
    for (const impl of impls) for (const m of (impl.members ?? impl.properties ?? [])) if (m.name && m.name.getText() === name && isOwner(m)) out.push(ownerId(m))
    return out
  }

  // ---------- client types declared locally but backed by an SDK (e.g. a typed Redis wrapper) ----------
  const clientTypes = new Map() // type decl → {name, kind}
  const factoryRules = (ext.clientFactories ?? []).map((r) => ({ ...r, re: rx(r.factory) }))
  if (factoryRules.length) for (const sf of sourceFiles) (function visit(n) {
    if (ts.isCallExpression(n) && n.typeArguments?.[0]) {
      const rule = factoryRules.find((r) => r.re.test(calleeName(n)))
      if (rule) for (const d of resolveSymbol(ts.isTypeReferenceNode(n.typeArguments[0]) ? n.typeArguments[0].typeName : n.typeArguments[0])?.declarations ?? []) {
        clientTypes.set(d, rule); if (ts.isTypeAliasDeclaration(d)) clientTypes.set(d.type, rule)
      }
    }
    ts.forEachChild(n, visit)
  })(sf)
  const clientRuleFor = (d) => { for (let p = d.parent; p && !ts.isSourceFile(p); p = p.parent) if (clientTypes.has(p)) return clientTypes.get(p); return null }

  // ---------- HTTP host resolution for fetch / axios / got ----------
  const hostCache = new Map()
  function httpSystems(sf) {
    if (hostCache.has(sf.fileName)) return hostCache.get(sf.fileName)
    // hosts in string literals only (comments and doc links don't count); named hosts beat file mappings beat raw hostnames
    const hosts = new Set()
    ;(function visit(n) {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) for (const m of n.text.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) hosts.add(m[1])
      ts.forEachChild(n, visit)
    })(sf)
    const named = new Map(), raw = new Map()
    for (const h of hosts) { const c = classifyHost(h, ext.hosts ?? []); if (!c) continue; (c.name === h ? raw : named).set(c.name, c.kind) }
    const out = new Map(named)
    if (!out.size) for (const fb of ext.fileFallbacks ?? []) if (rx(fb.match).test(rel(sf.fileName))) out.set(fb.name, fb.kind ?? 'http-api')
    if (!out.size) for (const [k, v] of raw) out.set(k, v)
    hostCache.set(sf.fileName, out)
    return out
  }
  const missingCache = new Map()
  function missingDeps(sf) {
    if (missingCache.has(sf.fileName)) return missingCache.get(sf.fileName)
    const out = new Set()
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text.startsWith('.')) continue
      const spec = st.moduleSpecifier.text, pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (fs.existsSync(path.join(repo, 'node_modules', pkg))) continue
      const d = classifyPkg(pkg); if (d) out.add(d)
    }
    missingCache.set(sf.fileName, out)
    return out
  }

  // ---------- events ----------
  const EMITTER_INIT = rx(config.events?.emitterInit ?? 'EventEmitter|createEventEmitter|mitt\\(|Emittery|EventEmitter2|new Subject')
  const transportFor = (initText) => { for (const t of config.events?.transports ?? []) if (rx(t.match).test(initText)) return t.transport; return /redis|pubsub|distributed|broker/i.test(initText) ? 'pubsub' : 'in-process' }
  function emitterOf(call) {
    const e = call.expression
    if (!ts.isPropertyAccessExpression(e)) return null
    const d = resolveSymbol(e.expression)?.declarations?.[0]
    if (!d || !isAnalyzed(d.getSourceFile().fileName)) return null
    const init = ts.isVariableDeclaration(d) ? d.initializer?.getText() ?? '' : ts.isPropertyDeclaration(d) ? d.initializer?.getText() ?? '' : ''
    if (!EMITTER_INIT.test(init)) return null
    return { name: d.name.getText(), transport: transportFor(init) }
  }
  function eventIds(call) {
    const em = emitterOf(call); if (!em) return null
    const a = call.arguments[0]; if (!a) return null
    let names
    try { const t = checker.getTypeAtLocation(a); names = t.isStringLiteral() ? [t.value] : t.isUnion() && t.types.every((x) => x.isStringLiteral()) ? t.types.map((x) => x.value) : ['*'] } catch { names = ['*'] }
    return names.map((name) => { const id = `${em.name}:${name}`; if (!events.has(id)) events.set(id, { id, emitter: em.name, name, transport: em.transport }); return id })
  }
  const registryRules = (config.events?.registries ?? []).map((r) => ({ file: rx(r.file), register: rx(r.register ?? '^register'), notify: rx(r.notify ?? '^notify'), transport: r.transport ?? 'in-process' }))
  const listenerWrappers = new Map()

  // ---------- detached work, transactions ----------
  function isDetached(node) {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isAwaitExpression(p) || ts.isReturnStatement(p) || ts.isVariableDeclaration(p) || ts.isYieldExpression(p)) return false
      if (ts.isVoidExpression(p)) return true
      if (ts.isExpressionStatement(p)) return !ts.isBinaryExpression(p.expression) && /^Promise</.test(typeText(p.expression))
      if (ts.isBlock(p) || ts.isSourceFile(p) || isOwner(p)) return false
      if (isFnExpr(p)) {
        if (ts.isParenthesizedExpression(p.parent) && ts.isCallExpression(p.parent.parent) && p.parent.parent.expression === p.parent) { p = p.parent; continue }
        if (ts.isCallExpression(p.parent) && p.parent.expression === p) continue
        return false
      }
    }
    return false
  }
  function insideDetachedIIFE(node) {
    for (let p = node.parent; p && !isOwner(p); p = p.parent) if (isFnExpr(p)) {
      let call = p.parent; if (ts.isParenthesizedExpression(call)) call = call.parent
      return ts.isCallExpression(call) && (call.expression === p || call.expression === p.parent) ? isDetached(call) : false
    }
    return false
  }
  const TX_CALLEE = /^\$?transaction$|^withTransaction$|^runInTransaction$/
  function insideTransaction(node) {
    for (let p = node.parent; p; p = p.parent) {
      if (isFnExpr(p) && ts.isCallExpression(p.parent) && TX_CALLEE.test(calleeName(p.parent))) return true
      if (isOwner(p)) return false
    }
    return false
  }
  let inTx = false, detachedNow = false
  function recordExternal(from, dep, op) {
    const kind = externals.get(dep)?.kind
    if (inTx && !['database', 'observability'].includes(kind)) addSignal(from, 'side-effect-in-transaction', `${dep}: ${op ?? ''}`)
    const k = `${from}|${dep}`
    if (!externalCalls.has(k)) externalCalls.set(k, { from, dep, ops: new Set(), sync: false })
    if (!detachedNow) externalCalls.get(k).sync = true
    if (op) externalCalls.get(k).ops.add(op)
  }
  const fieldFns = new Map(), fieldCalls = []

  // ---------- the call pass ----------
  function handleCall(node, sf) {
    const expr = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression
    const from = enclosingOwner(node)
    const sym = resolveSymbol(calleeNode(expr))
    const decls = sym?.declarations ?? []
    const name = sym?.getName?.() ?? ''
    inTx = insideTransaction(node)
    detachedNow = ts.isCallExpression(node) && (isDetached(node) || insideDetachedIIFE(node))
    const declFiles = decls.map((d) => d.getSourceFile().fileName)
    // practice signals at the call
    if (/^(safe)?parse(Async)?$|^validate(Sync|Async)?$|^validateOrReject$/i.test(name) && (declFiles.some((f) => /node_modules[\\/](zod|joi|yup|class-validator|valibot|superstruct|ajv|@sinclair)/.test(f)) || (ts.isPropertyAccessExpression(expr) && /schema|validator|dto/i.test(expr.expression.getText())))) addSignal(from, 'input-validation', expr.getText().slice(0, 60))
    if (TX_CALLEE.test(name) && node.arguments?.some(isFnExpr)) addSignal(from, 'db-transaction')
    if (/^(upsert|createMany|createManyAndReturn|insertOrIgnore|onConflict\w*|bulkWrite)$/.test(name)) addSignal(from, 'idempotent-write', expr.getText().slice(0, 60))
    if (ts.isTaggedTemplateExpression(node) && /ON CONFLICT|ON DUPLICATE KEY/i.test(node.template.getText())) addSignal(from, 'idempotent-write', 'ON CONFLICT')
    // relative writes (balance += x): replaying them applies the change twice, unlike setting an absolute value
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(expr) && /^(update|updateMany|upsert)$/.test(name)) {
      // one sample per field: "model.op increment field" (fields tell a version counter from a balance)
      const a = node.arguments.map((x) => x.getText()).join(' '), model = ts.isPropertyAccessExpression(expr.expression) ? expr.expression.name.text : '?'
      for (const m of a.matchAll(/["']?(\w+)["']?\s*:\s*\{\s*(increment|decrement)\s*:/g)) addSignal(from, 'value-increment', `${model}.${name} ${m[2]} ${m[1]}`)
    }
    if (ts.isCallExpression(node) && /^(increment|decrement)$/.test(name) && declFiles.some((f) => f.includes('node_modules'))) addSignal(from, 'value-increment', `${expr.getText().slice(0, 50)} ${name}`)
    if (ts.isCallExpression(node) && node.arguments.some((x) => /\$inc\s*:/.test(x.getText()))) addSignal(from, 'value-increment', `${expr.getText().slice(0, 50)} $inc`)
    { const sql = ts.isTaggedTemplateExpression(node) ? node.template.getText() : ''; const m = sql.match(/\bSET\s+"?(\w+)"?\s*=\s*"?\1"?\s*([+-])/i); if (m) addSignal(from, 'value-increment', `SQL ${m[1]} ${m[2] === '+' ? 'increment' : 'decrement'}`) }
    if (declFiles.some(isAnalyzed) && /(^|[a-z])(acquire|with|try|release)\w*Lock|^withLock|LockClient|Lease$|^redlock/i.test(name)) addSignal(from, 'distributed-lock', name)
    if (!decls.length) for (const dep of missingDeps(sf)) recordExternal(from, dep, expr.getText().split('(')[0].slice(-40))
    // fetch through an injected or aliased reference: classify by the resolved signature
    if (ts.isCallExpression(node) && declFiles.every(isAnalyzed)) {
      let sd; try { sd = checker.getResolvedSignature(node)?.declaration } catch {}
      if (sd?.name?.getText?.() === 'fetch' && sd.getSourceFile().fileName.includes('node_modules')) recordHttp(from, sf, node)
    }
    for (const d of decls) {
      const f = d.getSourceFile().fileName
      if (isPrismaClientFile(f)) {
        ensureExternal(DATABASE, 'database')
        let op = name
        if (ts.isPropertyAccessExpression(expr) && PRISMA_OPS.has(name) && ts.isPropertyAccessExpression(expr.expression)) {
          const model = expr.expression.name.text, k = `${from}|${model}`
          if (!modelQueries.has(k)) modelQueries.set(k, { from, model, ops: new Set() })
          modelQueries.get(k).ops.add(name); op = `${model}.${name}`
        }
        recordExternal(from, DATABASE, op); return
      }
      if (f.includes('node_modules')) {
        const pkg = pkgOf(f)
        if (name === 'fetch' && /undici|@types[\\/]node|typescript[\\/]lib/.test(f)) { recordHttp(from, sf, node); return }
        if (pkg && HTTP_CLIENT_PACKAGES.test(pkg)) { recordHttp(from, sf, node); return }
        const dep = classifyPkg(pkg)
        if (dep) {
          // raw SQL drivers (better-sqlite3, pg, mysql2): tables named in the statement text
          if (externals.get(dep).kind === 'database' && /^(prepare|exec|query|execute|run|all|get|raw|unsafe)$/.test(name) && ts.isCallExpression(node)) recordSqlTables(from, sqlText(node.arguments[0]))
          // ORM model and operation, when the call reads like repository.findMany / Model.create
          if (externals.get(dep).kind === 'database' && ORM_OPS.test(name) && ts.isPropertyAccessExpression(expr)) {
            const recv = expr.expression, tt = typeText(recv)
            const model = (tt.match(/^(?:Repository|Model|EntityRepository|ModelStatic|Collection)<\s*([A-Za-z0-9_]+)/)?.[1]) ?? recv.getText().replace(/^this\./, '').replace(/(Repository|Repo|Model|Collection)$/i, '')
            if (model && /^[A-Za-z_][\w]*$/.test(model)) { const k = `${from}|${model}`; if (!modelQueries.has(k)) modelQueries.set(k, { from, model, ops: new Set() }); modelQueries.get(k).ops.add(name) }
          }
          recordExternal(from, dep, name); return
        }
        continue
      }
      if (f.startsWith(repo) && f.endsWith('.d.ts')) {
        for (let p = d.parent; p; p = p.parent) if (ts.isModuleDeclaration(p) && ts.isStringLiteral(p.name)) { const dep = classifyPkg(p.name.text); if (dep) { recordExternal(from, dep, name); return } }
        continue
      }
      if (!isAnalyzed(f)) continue
      if (ts.isPropertyDeclaration(d) || (ts.isParameter(d) && ts.isConstructorDeclaration(d.parent))) { fieldCalls.push({ from, field: d }); continue }
      if (ts.isMethodSignature(d) || ts.isPropertySignature(d)) {
        const rule = clientRuleFor(d)
        if (rule) { recordExternal(from, ensureExternal(rule.name, rule.kind ?? 'cache'), name); return }
        for (const impl of implementationsOf(d)) addCall(from, impl, 'dispatch')
        continue
      }
      const to = ownerForDecl(d)
      if (to) addCall(from, to, ts.isNewExpression(node) ? 'new' : detachedNow ? 'detached' : 'call')
      if (to && inTx) txCalls.push({ from, to, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
    }
    // in-process handler registries named in config (register*/notify* pairs in one file)
    const regDecl = decls.find((d) => ts.isFunctionDeclaration(d) && registryRules.some((r) => r.file.test(rel(d.getSourceFile().fileName))))
    if (regDecl && ts.isCallExpression(node)) {
      const rule = registryRules.find((r) => r.file.test(rel(regDecl.getSourceFile().fileName)))
      const emitter = path.basename(regDecl.getSourceFile().fileName).replace(/\.[cm]?[jt]sx?$/, ''), id = `${emitter}:WAKEUP`
      if (!events.has(id)) events.set(id, { id, emitter, name: 'WAKEUP', transport: rule.transport })
      if (rule.notify.test(name)) emits.set(`${from}|${id}`, { from, event: id })
      if (rule.register.test(name)) { const cb = node.arguments.find(isFnExpr); if (cb) handles.set(`${id}|${ownerId(cb)}`, { event: id, to: ownerId(cb) }) }
    }
    // event emit / subscribe
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(expr)) {
      const m = expr.name.text
      if (/^(emit|emitAsync|emitLocal|publish|next)$/.test(m)) for (const ev of eventIds(node) ?? []) { emits.set(`${from}|${ev}`, { from, event: ev }); if (inTx) addSignal(from, 'side-effect-in-transaction', `emit ${ev}`) }
      else if (/^(on|once|addListener|subscribe)$/.test(m)) {
        const cb = node.arguments[1] ?? node.arguments[0]
        let fnLike; for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) { fnLike = p; break }
        const paramIdx = (a) => (a && ts.isIdentifier(a) && fnLike ? fnLike.parameters.findIndex((pp) => pp.name.getText() === a.text) : -1)
        const ei = paramIdx(node.arguments[0]), hi = paramIdx(cb)
        if (ei >= 0 && hi >= 0) listenerWrappers.set(ts.isVariableDeclaration(fnLike.parent) ? fnLike.parent : fnLike, { emitterCall: node, ei, hi })
        const target = targetOf(cb)
        if (target) for (const ev of eventIds(node) ?? []) handles.set(`${ev}|${target}`, { event: ev, to: target })
      }
    }
    // functions passed as arguments
    if (!ts.isTaggedTemplateExpression(node)) {
      const isSubscribe = ts.isPropertyAccessExpression(expr) && /^(on|once|addListener)$/.test(expr.name.text) && !!emitterOf(node)
      for (const a of node.arguments ?? []) {
        if (isFnExpr(a) && isOwner(a)) { if (!isSubscribe) addCall(from, ownerId(a), /^(setTimeout|setImmediate|queueMicrotask|nextTick)$/.test(calleeName(node)) ? 'detached' : 'callback'); continue }
        if (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) for (const d of resolveSymbol(calleeNode(a))?.declarations ?? []) { const to = ownerForDecl(d); if (to && !isSubscribe) addCall(from, to, 'callback') }
      }
    }
  }
  function sqlText(a, depth = 0) {
    if (!a || depth > 3) return null
    if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return a.text
    if (ts.isTemplateExpression(a)) return a.head.text + a.templateSpans.map((s) => ' ? ' + s.literal.text).join('')
    if (ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.PlusToken) return [sqlText(a.left, depth + 1), sqlText(a.right, depth + 1)].filter(Boolean).join(' ')
    if (ts.isIdentifier(a)) { const d = resolveSymbol(a)?.declarations?.[0]; return d && ts.isVariableDeclaration(d) ? sqlText(d.initializer, depth + 1) : null }
    return null
  }
  const SQL_NOT_TABLES = /^(sqlite_master|sqlite_schema|sqlite_sequence|pragma_\w+|json_each|json_tree|generate_series|dual|unnest|select|values|lateral|set|where|on)$/i
  function recordSqlTables(from, sql) {
    if (!sql || !/\b(select|insert|update|delete|replace)\b/i.test(sql)) return
    const s = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ')
    const found = []
    const ident = '["`\\[]?([A-Za-z_][\\w]*)["`\\]]?'
    const ctes = new Set([...s.matchAll(/(?:\bWITH(?: RECURSIVE)?|,) ([A-Za-z_]\w*)(?: ?\([^)]*\))? AS (?:NOT )?(?:MATERIALIZED )?\(/gi)].map((m) => m[1].toLowerCase()))
    for (const m of s.matchAll(new RegExp(`\\b(INSERT(?: OR \\w+)? INTO|REPLACE INTO|UPDATE(?: OR \\w+)?|DELETE FROM|FROM|JOIN) ${ident}(?!\\w)`, 'gi'))) {
      const kw = m[1].toUpperCase(), t = m[2]
      if (SQL_NOT_TABLES.test(t) || ctes.has(t.toLowerCase())) continue
      if (/^(FROM|JOIN)$/.test(kw) && /^ ?\(/.test(s.slice(m.index + m[0].length))) continue // table-valued function
      if (kw === 'FROM' && /DELETE $/i.test(s.slice(0, m.index))) continue
      const op = /^(INSERT|REPLACE)/.test(kw) ? (/ON CONFLICT[^;]*DO UPDATE|^REPLACE|INSERT OR REPLACE/i.test(kw + s.slice(m.index)) ? 'upsert' : 'insert') : /^UPDATE/.test(kw) ? (/ SET /i.test(s.slice(m.index)) ? 'update' : null) : kw === 'DELETE FROM' ? 'delete' : 'select'
      if (op) found.push([t, op])
    }
    for (const [model, op] of found) { const k = `${from}|${model}`; if (!modelQueries.has(k)) modelQueries.set(k, { from, model, ops: new Set() }); modelQueries.get(k).ops.add(op) }
  }
  function recordHttp(from, sf, node) {
    const systems = httpSystems(sf)
    if (!systems.size) {
      const where = `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
      unresolvedHttp.push(where)
      recordExternal(from, ensureExternal(`HTTP (unresolved: ${path.basename(sf.fileName)})`, 'http-api'), 'fetch')
      return
    }
    for (const [name, kind] of systems) recordExternal(from, ensureExternal(name, kind), 'http')
  }
  function fieldReceiving(id) {
    let e = id
    while (e.parent && (ts.isParenthesizedExpression(e.parent) || ts.isConditionalExpression(e.parent) || (ts.isBinaryExpression(e.parent) && /^(\?\?|\|\|)$/.test(e.parent.operatorToken.getText())))) e = e.parent
    const p = e.parent
    if (p && ts.isPropertyDeclaration(p) && p.initializer === e) return p
    if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === e && ts.isPropertyAccessExpression(p.left) && p.left.expression.kind === ts.SyntaxKind.ThisKeyword)
      return resolveSymbol(p.left.name)?.declarations?.find((d) => ts.isPropertyDeclaration(d) || ts.isParameter(d)) ?? null
    return null
  }
  function handleValueRef(id) {
    const p = id.parent
    if (!p || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isExportSpecifier(p) || ts.isNamespaceImport(p)) return
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && (p.expression === id || p.arguments?.includes(id))) return
    if (ts.isPropertyAccessExpression(p) && p.expression === id) return
    if (ts.isPropertyAccessExpression(p) && p.name === id && (ts.isCallExpression(p.parent) || ts.isNewExpression(p.parent)) && (p.parent.expression === p || p.parent.arguments?.includes(p))) return
    if ((ts.isFunctionLike(p) || ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isParameter(p) || ts.isClassLike(p) || ts.isMethodDeclaration(p)) && p.name === id) return
    if (ts.isTypeReferenceNode(p) || ts.isExpressionWithTypeArguments(p) || ts.isTypeQueryNode(p) || ts.isQualifiedName(p) || ts.isExportAssignment(p) || ts.isDecorator(p)) return
    if (ts.isPropertyAssignment(p) && registryVarOf(p)) return
    for (const d of resolveSymbol(id)?.declarations ?? []) {
      if (ts.isClassDeclaration(d)) continue
      const to = ownerForDecl(d); if (!to) continue
      addCall(enclosingOwner(id), to, 'ref')
      const field = fieldReceiving(id)
      if (field) (fieldFns.get(field) ?? fieldFns.set(field, new Set()).get(field)).add(to)
    }
  }
  const TOKEN_SIGNALS = [['timeout', /timeout|abortsignal|abortcontroller|deadline/i], ['retry', /retr(y|ies)|backoff|jitter/i], ['idempotency-key', /idempoten|dedup/i], ['circuit-breaker', /breaker|circuit|opossum/i], ['concurrency-limit', /concurrency|semaphore|plimit|bottleneck|bulkhead|maxinflight|maxparallel/i], ['ssrf-control', /allowlist|allowedhost|blocklist|privateaddress|isprivate(ip|address)?|privateip|blockedhost|ssrf|linklocal/i]]
  function tokenSignals(id) {
    const t = id.text; if (t.length < 5) return
    const p = id.parent; if (p && (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isTypeReferenceNode(p))) return
    for (const [sig, re] of TOKEN_SIGNALS) if (re.test(t)) addSignal(enclosingOwner(id), sig, t)
  }
  // writes made on the error path (a catch block or a promise .catch handler). Blanking fields or deleting rows
  // there destroys data when the error came from our side (config, keys, deploys) rather than from bad data.
  const CATCH_WRITE = /^(update|updateMany|delete|deleteMany|upsert|create|createMany|save|remove|destroy|\$executeRaw\w*)$/
  const isClearing = (n) => n.kind === ts.SyntaxKind.NullKeyword || (ts.isStringLiteral(n) && n.text === '') || (ts.isArrayLiteralExpression(n) && !n.elements.length) || (ts.isNewExpression(n) && n.expression.getText() === 'Date' && n.arguments?.length === 1 && n.arguments[0].getText() === '0')
  function errorPathWrites(body, owner) {
    ;(function walk(n, conditional) {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && CATCH_WRITE.test(n.expression.name.text)) {
        const recv = n.expression.expression, model = ts.isPropertyAccessExpression(recv) ? recv.name.text : recv.getText().replace(/^this\./, '').slice(-30)
        const op = n.expression.name.text, args = n.arguments.map((a) => a.getText()).join(' ')
        const sqlDelete = /^\$executeRaw/.test(op) && /\b(DELETE\s+FROM|TRUNCATE)\b/i.test(args), sqlClear = /^\$executeRaw/.test(op) && /\bSET\b[^;]*=\s*(NULL|'')/i.test(args)
        // a wipe: every field the write sets (timestamps aside) is blanked. Setting status: 'FAILED' alongside a
        // null retry time is a state transition, not a wipe.
        const objArgs = n.arguments.filter(ts.isObjectLiteralExpression)
        const dataObj = objArgs.flatMap((o) => o.properties).find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'data' && ts.isObjectLiteralExpression(p.initializer))?.initializer ?? (op === 'update' || op === 'save' ? objArgs.at(-1) : undefined)
        const fields = (dataObj?.properties ?? []).filter(ts.isPropertyAssignment).filter((p) => !/(_at|At|updated|modified)$/.test(p.name.getText()) || isClearing(p.initializer))
        const clears = fields.length > 0 && fields.every((p) => isClearing(p.initializer))
        const sample = `${model}.${op}${conditional ? ' (conditional)' : ''}`
        addSignal(owner, 'write-in-catch', sample)
        if (clears || sqlClear || /^delete/.test(op) || op === 'remove' || op === 'destroy' || sqlDelete) addSignal(owner, 'clears-data-in-catch', sample)
      }
      if (ts.isFunctionLike(n)) return
      ts.forEachChild(n, (x) => walk(x, conditional || ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isSwitchStatement(n)))
    })(body, false)
  }
  function catchSignals(c) {
    let rethrows = false, logs = false, reports = false
    ;(function walk(n) {
      if (ts.isThrowStatement(n)) rethrows = true
      if (ts.isCallExpression(n)) { const t = n.expression.getText(); if (/logger\.|console\.|log\(/.test(t)) logs = true; if (/captureException|Sentry|report|notify/i.test(t)) reports = true; if (/^(reject|next|done|callback|cb)$/.test(t)) rethrows = true }
      if (ts.isFunctionLike(n)) return
      ts.forEachChild(n, walk)
    })(c.block)
    errorPathWrites(c.block, enclosingOwner(c))
    if (rethrows) return
    const owner = enclosingOwner(c)
    if (reports) addSignal(owner, 'error-reported-and-swallowed')
    else if (logs) addSignal(owner, 'error-logged-and-swallowed')
    else addSignal(owner, 'error-silently-swallowed', c.block.statements.length ? 'non-empty catch' : 'empty catch')
  }
  // error classes → HTTP status: config, then super(…, 4xx) in the constructor chain, then the class name
  const STATUS_NAME = { 400: '400 bad request', 401: '401 unauthorized', 403: '403 forbidden', 404: '404 not found', 405: '405 method not allowed', 408: '408 timeout', 409: '409 conflict', 410: '410 gone', 413: '413 too large', 415: '415 unsupported', 422: '422 validation', 429: '429 too many requests', 500: 'generic 500', 501: '501 not implemented', 502: '502 bad gateway', 503: '503 unavailable', 504: '504 gateway timeout' }
  const statusLabel = (n) => STATUS_NAME[n] ?? `${n}`
  const NAME_STATUS = [[/NotFound/, 404], [/Unauthori[sz]ed|Unauthenticated|InvalidToken/, 401], [/Forbidden|PermissionDenied|AccessDenied/, 403], [/Conflict|AlreadyExists|Duplicate/, 409], [/Unprocessable|ValidationError/, 422], [/BadRequest|Invalid|Validation/, 400], [/TooMany|RateLimit|Throttl/, 429], [/Timeout/, 504], [/Unavailable/, 503], [/NotImplemented/, 501]]
  const errorStatusMemo = new Map()
  function classStatus(cd, depth = 0) {
    if (!cd || depth > 8) return null
    if (errorStatusMemo.has(cd)) return errorStatusMemo.get(cd)
    const name = cd.name?.text ?? ''
    let st = config.errors?.classes?.[name] ?? null
    if (st == null && isAnalyzed(cd.getSourceFile().fileName)) {
      const ctor = cd.members?.find(ts.isConstructorDeclaration)
      ctor?.body && (function find(n) { if (st == null && ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) for (const a of n.arguments) { const v = Number(literalText(a)); if (v >= 400 && v <= 599) st = v } ts.forEachChild(n, find) })(ctor.body)
    }
    if (st == null) for (const [re, s] of NAME_STATUS) if (re.test(name)) { st = s; break }
    if (st == null) { const e2 = cd.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]; st = e2 ? classStatus(resolveSymbol(e2.expression)?.declarations?.find((x) => ts.isClassDeclaration(x)), depth + 1) : null }
    errorStatusMemo.set(cd, st)
    return st
  }
  function recordThrow(node) {
    const ne = node.expression, cls = ne.expression.getText()
    const cd = resolveSymbol(ne.expression)?.declarations?.find((x) => ts.isClassDeclaration(x))
    let st = cd ? classStatus(cd) : null
    if (st == null) for (const a of ne.arguments ?? []) { const v = Number(literalText(a)); if (v >= 400 && v <= 599) st = v } // new HttpException(msg, 404)
    if (st == null) for (const [re, s] of NAME_STATUS) if (re.test(cls)) { st = s; break }
    throws.push({ fn: enclosingOwner(node), cls, category: st ? statusLabel(st) : 'generic 500', message: ne.arguments?.[0]?.getText().replace(/\s+/g, ' ').slice(0, 90) ?? '' })
  }
  function recordStatusReply(node) {
    const code = Number(node.arguments[0].text)
    if (code < 400 || code > 599 || !/Response|Reply|Context|ServerResponse/.test(typeText(node.expression.expression))) return
    const outer = node.parent && ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent) ? node.parent.parent : null
    throws.push({ fn: enclosingOwner(node), cls: `${node.expression.name.text}(${code})`, category: statusLabel(code), message: outer?.arguments?.[0]?.getText().replace(/\s+/g, ' ').slice(0, 90) ?? '' })
  }

  // ---------- registry entry points (object literals typed as a handler map, from config) ----------
  const registryRules2 = (config.entries?.registries ?? []).map((r) => ({ ...r, re: rx(r.typePattern) }))
  function registryVarOf(prop) {
    const v = prop.parent?.parent
    return v && ts.isVariableDeclaration(v) && v.type && registryRules2.find((r) => r.re.test(v.type.getText()))
  }

  let count = 0
  for (const sf of sourceFiles) {
    ;(function visit(node) {
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) handleCall(node, sf)
      if (isOwner(node)) ownerId(node)
      if (ts.isIdentifier(node)) { handleValueRef(node); tokenSignals(node) }
      if (ts.isStringLiteral(node) && node.text === 'manual' && ts.isPropertyAssignment(node.parent) && node.parent.name.getText() === 'redirect') addSignal(enclosingOwner(node), 'ssrf-control', "redirect: 'manual'")
      if (ts.isVoidExpression(node) && (ts.isCallExpression(node.expression) || ts.isAwaitExpression(node.expression))) addSignal(enclosingOwner(node), 'fire-and-forget', node.expression.getText().slice(0, 70))
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === 'catch') addSignal(enclosingOwner(node), 'fire-and-forget', node.expression.getText().slice(0, 70))
      if (ts.isCatchClause(node)) catchSignals(node)
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch' && node.arguments[0] && isFnExpr(node.arguments[0])) errorPathWrites(node.arguments[0].body, enclosingOwner(node))
      if (ts.isPropertyAccessExpression(node) && /^[A-Z][A-Z0-9_]{2,}$/.test(node.name.text) && /(^|\.)env$/.test(node.expression.getText())) envReads.add(`${enclosingOwner(node)}|${node.name.text}`)
      if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && /^[A-Z][A-Z0-9_]{2,}$/.test(node.argumentExpression.text) && /(^|\.)env$/.test(node.expression.getText())) envReads.add(`${enclosingOwner(node)}|${node.argumentExpression.text}`)
      if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression)) recordThrow(node)
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^(status|code|sendStatus)$/.test(node.expression.name.text) && node.arguments[0] && ts.isNumericLiteral(node.arguments[0])) recordStatusReply(node)
      ts.forEachChild(node, visit)
    })(sf)
    if (++count % 300 === 0) console.error(`  ${count}/${sourceFiles.length}`)
  }
  for (const { from, field } of fieldCalls) for (const to of fieldFns.get(field) ?? []) addCall(from, to, 'dispatch')
  if (listenerWrappers.size) for (const sf of sourceFiles) (function visit(node) {
    if (ts.isCallExpression(node)) {
      const w = listenerWrappers.get(declOf(node.expression))
      if (w) {
        const evArg = node.arguments[w.ei], cb = node.arguments[w.hi], em = emitterOf(w.emitterCall)
        let t; try { t = evArg && checker.getTypeAtLocation(evArg) } catch {}
        const target = targetOf(cb)
        if (em && t?.isStringLiteral() && target) {
          const id = `${em.name}:${t.value}`
          if (!events.has(id)) events.set(id, { id, emitter: em.name, name: t.value, transport: em.transport })
          handles.set(`${id}|${target}`, { event: id, to: target })
        }
      }
    }
    ts.forEachChild(node, visit)
  })(sf)

  // ================= entry points =================
  const mwKind = (n) => /rate.?limit|throttl/i.test(n) ? 'rate-limit' : /cors/i.test(n) ? 'cors' : /helmet|csp|security.?headers/i.test(n) ? 'security-headers' : /json|urlencoded|body.?parser|multer|\braw\b|cookie.?parser/i.test(n) ? 'body-parsing'
    : /request.?id|logger|morgan|pino|trace|metrics/i.test(n) ? 'observability' : /error|exception.?filter/i.test(n) ? 'error-handling' : /token|auth(?!oriz)|jwt|passport|session|signature|activationcode|api.?key|(require|ensure|verify|check)(user|login|logged.?in|signed.?in|account|principal|identity)|current.?user|logged.?in|signed.?in/i.test(n) ? 'authentication'
    : /permission|role|access|tenant|toplevel|actor|policy|casl|guard|owner|scope/i.test(n) ? 'authorization' : /validat|schema|pipe|replay|zod|celebrate/i.test(n) ? (/replay/i.test(n) ? 'replay-protection' : 'validation') : 'other'
  const clean = (t) => (t ?? '').replace(/\s+/g, ' ').trim()
  function mwRec(name, impl, pkg, config2) {
    const n = clean(name).slice(0, 80), m = mwNodes.get(n) ?? { name: n, impl: null, package: null, kind: mwKind(n) }
    m.impl ??= impl ?? null; m.package ??= pkg ?? null; mwNodes.set(n, m)
    return { name: n, config: config2 ? clean(config2).slice(0, 160) : null }
  }
  const pkgOfDecl = (d) => { const f = d.getSourceFile().fileName; return f.includes('node_modules') ? pkgOf(f) : null }
  const isExported = (vd) => vd.parent?.parent?.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
  function resolveMw(a, depth = 0) {
    if (!a || depth > 5) return []
    if (ts.isSpreadElement(a) || ts.isAsExpression(a) || ts.isParenthesizedExpression(a) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(a))) return resolveMw(a.expression, depth + 1)
    if (ts.isArrayLiteralExpression(a)) return a.elements.flatMap((e) => resolveMw(e, depth + 1))
    if (isFnExpr(a)) { const sf = a.getSourceFile(); return [mwRec(`inline middleware (${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(a.getStart()).line + 1})`, ownerId(a))] }
    if (ts.isCallExpression(a) || ts.isNewExpression(a)) {
      const d = declOf(a.expression), args = (a.arguments ?? []).map((x) => x.getText()).join(', ')
      if (!d) return [mwRec(a.expression.getText(), null, null, args)]
      const pkg = pkgOfDecl(d)
      return [mwRec(a.expression.getText(), pkg ? null : ownerForDecl(d), pkg, args)]
    }
    if (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) {
      const d = declOf(a)
      if (!d) return [mwRec(a.getText(), null, null)]
      const pkg = pkgOfDecl(d)
      if (pkg) return [mwRec(a.getText(), null, pkg)]
      if (ts.isVariableDeclaration(d) && d.initializer && !isFnExpr(d.initializer)) {
        let init = d.initializer
        while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression
        if (ts.isArrayLiteralExpression(init)) return init.elements.flatMap((e) => resolveMw(e, depth + 1))
        if (ts.isCallExpression(init)) {
          const cd = declOf(init.expression), cpkg = cd ? pkgOfDecl(cd) : null
          return [mwRec(isExported(d) ? d.name.getText() : init.expression.getText(), cd && !cpkg ? ownerForDecl(cd) : null, cpkg, init.arguments.map((x) => x.getText()).join(', '))]
        }
        if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) return resolveMw(init, depth + 1)
      }
      if (ts.isClassDeclaration(d)) { const m = d.members.find((x) => ts.isMethodDeclaration(x) && /^(canActivate|use|intercept|transform|handle)$/.test(x.name?.getText())); return [mwRec(d.name?.text ?? a.getText(), m ? ownerId(m) : null, null)] }
      const o = ownerForDecl(d)
      return [mwRec(o ? functions.get(o).name : a.getText(), o, null)]
    }
    return []
  }
  const joinPath = (...parts) => ('/' + parts.join('/').split('/').filter(Boolean).join('/')).replace(/\/$/, '') || '/'
  const pathRegex = (p) => new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\?:[A-Za-z_]+/g, '[^/]+').replace(/\/$/, '') + '(/|$)')
  const addEntry = (journey, fn, role = 'handler', order = 0) => { if (fn) entries.push({ journey, fn, role, order }) }

  // ---------- Express ----------
  const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'all', 'options', 'head', 'use'])
  const isRouterExpr = (n) => /^(Router|IRouter|core\.Router|express\.Router)\b/.test(typeText(n))
  const isAppExpr = (n) => /^(Express|Application|core\.Express|express\.Application)\b/.test(typeText(n))
  // a router built by a factory: the identifier the factory returns
  function factoryReturn(call) {
    const fd = declOf(call.expression)
    let ret = null
    if (fd && (ts.isFunctionDeclaration(fd) || (ts.isVariableDeclaration(fd) && isFnExpr(fd.initializer))) && isAnalyzed(fd.getSourceFile().fileName)) {
      const body = ts.isFunctionDeclaration(fd) ? fd.body : fd.initializer.body
      body && (function find(n) { if (!ret && ts.isReturnStatement(n) && n.expression && ts.isIdentifier(n.expression)) ret = n.expression; if (!isFnExpr(n) || n === body) ts.forEachChild(n, find) })(body)
    }
    return ret
  }
  function routerDeclOf(node) {
    if (ts.isCallExpression(node)) node = factoryReturn(node) ?? node.expression
    let sym = resolveSymbol(node)
    for (let i = 0; i < 5 && sym; i++) {
      const d = sym.declarations?.[0]
      if (!d) return null
      if (ts.isExportAssignment(d)) { sym = resolveSymbol(d.expression); continue }
      if (ts.isVariableDeclaration(d)) {
        if (d.initializer && ts.isIdentifier(d.initializer)) { sym = resolveSymbol(d.initializer); continue }
        const ret = d.initializer && ts.isCallExpression(d.initializer) ? factoryReturn(d.initializer) : null
        if (ret) { sym = resolveSymbol(ret); continue }
        return d
      }
      if (ts.isExportSpecifier(d)) { sym = checker.getExportSpecifierLocalTargetSymbol(d); continue }
      if (ts.isFunctionDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isParameter(d)) return d
      return null
    }
    return null
  }
  const routerTable = new Map(), appCalls = []
  for (const sf of sourceFiles) (function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && HTTP_METHODS.has(node.expression.name.text)) {
      const recv = node.expression.expression
      const isRouter = isRouterExpr(recv), isApp = !isRouter && isAppExpr(recv)
      if (isRouter || isApp) {
        frameworks.add('express')
        const args = [...node.arguments]
        let p = ''
        const lit = args[0] && literalText(args[0])
        if (lit != null && (lit.startsWith('/') || lit === '' || lit === '*')) { p = lit; args.shift() }
        const item = { method: node.expression.name.text, path: p, args, node, sf }
        if (isRouter) { const rd = routerDeclOf(recv); if (rd) (routerTable.get(rd) ?? routerTable.set(rd, []).get(rd)).push(item) }
        else appCalls.push(item)
      }
    }
    ts.forEachChild(node, visit)
  })(sf)
  const reached = new Set()
  function walkRouter(rd, prefix, inheritedRecs, inheritedMw, seen) {
    if (seen.has(rd)) return
    seen = new Set(seen).add(rd); reached.add(rd)
    const routerRecs = [...inheritedRecs], routerMw = [...inheritedMw], pathed = []
    for (const it of routerTable.get(rd) ?? []) {
      if (it.method === 'use') {
        const children = [], recs = [], mws = []
        for (const a of it.args) {
          const child = (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a) || ts.isCallExpression(a)) && isRouterExpr(a) ? routerDeclOf(a) : null
          if (child && routerTable.has(child)) children.push(child)
          else { const t = targetOf(a); if (t) mws.push(t); recs.push(...resolveMw(a).map((r) => ({ ...r, scope: 'router' }))) }
        }
        if (children.length) for (const c of children) walkRouter(c, joinPath(prefix, it.path), [...routerRecs, ...recs], [...routerMw, ...mws], seen)
        else if (!it.path) { routerRecs.push(...recs); routerMw.push(...mws) }
        else pathed.push({ re: pathRegex(joinPath(prefix, it.path)), recs })
        continue
      }
      addRoute(it, prefix, [...routerRecs], routerMw, pathed)
    }
  }
  function addRoute(it, prefix, baseRecs, baseMw, pathed = []) {
    const full = joinPath(prefix, it.path), method = it.method === 'del' ? 'DELETE' : it.method.toUpperCase()
    const id = `HTTP ${method} ${full}`
    addJourney({ id, kind: 'http', method, path: full, name: `${method} ${full}`, source: `${rel(it.sf.fileName)}:${it.sf.getLineAndCharacterOfPosition(it.node.getStart()).line + 1}` })
    const handlers = it.args.map(targetOf).filter(Boolean)
    const chain = [...baseRecs, ...pathed.filter((p) => p.re.test(full)).flatMap((p) => p.recs), ...it.args.slice(0, -1).flatMap((a) => resolveMw(a)).map((r) => ({ ...r, scope: 'route' }))]
    routeChains.set(id, chain)
    baseMw.forEach((fn, i) => addEntry(id, fn, 'middleware', i))
    handlers.forEach((fn, i) => addEntry(id, fn, i === handlers.length - 1 ? 'handler' : 'middleware', baseMw.length + i))
  }
  const routeChains = new Map()
  // app-level: walk each file's app calls in order; middleware before the first mount applies to every route
  const appPre = [], appPost = []
  const pathsOf = (a) => {
    let n = a
    if (ts.isIdentifier(n)) { const d = declOf(n); if (d && ts.isVariableDeclaration(d) && d.initializer) n = d.initializer }
    while (n && (ts.isAsExpression(n) || ts.isParenthesizedExpression(n))) n = n.expression
    const lit = literalText(n); if (lit != null && lit.startsWith('/')) return [lit]
    if (n && ts.isArrayLiteralExpression(n) && n.elements.every((e) => ts.isStringLiteral(e))) return n.elements.map((e) => e.text)
    return null
  }
  // app calls in source order; a helper that receives the app (installParsers(app)) contributes its calls where it is invoked
  const appCallByNode = new Map(appCalls.map((c) => [c.node, c]))
  const helperBodies = new Set()
  const helperOf = (node) => {
    if (!ts.isCallExpression(node) || !node.arguments.some((x) => ts.isIdentifier(x) && isAppExpr(x))) return null
    const d = declOf(node.expression)
    return d && ts.isFunctionDeclaration(d) && d.body && isAnalyzed(d.getSourceFile().fileName) ? d.body : null
  }
  for (const sf of sourceFiles) (function visit(n) { const b = helperOf(n); if (b) helperBodies.add(b); ts.forEachChild(n, visit) })(sf)
  const insideHelper = (node) => { for (let p = node.parent; p; p = p.parent) if (helperBodies.has(p)) return true; return false }
  const ordered = []
  const collectIn = (root, depth) => (function visit(n) {
    if (appCallByNode.has(n)) ordered.push(appCallByNode.get(n))
    const b = depth < 3 ? helperOf(n) : null
    if (b) collectIn(b, depth + 1)
    ts.forEachChild(n, visit)
  })(root)
  for (const sf of sourceFiles) (function visit(n) {
    if (appCallByNode.has(n) && !insideHelper(n)) ordered.push(appCallByNode.get(n))
    const b = !insideHelper(n) ? helperOf(n) : null
    if (b) collectIn(b, 1)
    ts.forEachChild(n, visit)
  })(sf)
  const seenCall = new Set()
  let mounted = false
  const mounts = []
  for (const it of ordered) {
    if (seenCall.has(it.node)) continue
    seenCall.add(it.node)
    if (it.method !== 'use') { mounted = true; mounts.push({ route: it }); continue }
    let args = it.args, paths = it.path ? [it.path] : null
    if (!paths && args.length > 1) { const p0 = pathsOf(args[0]); if (p0) { paths = p0; args = args.slice(1) } }
    for (const a of args) {
      const child = (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a) || ts.isCallExpression(a)) && isRouterExpr(a) ? routerDeclOf(a) : null
      if (child && routerTable.has(child)) { mounted = true; mounts.push({ router: child, prefix: paths?.[0] ?? '' }); continue }
      if (mounted && isFnExpr(a) && a.parameters.length < 4) continue // 404 fallback
      const lp = paths
      for (const r of resolveMw(a)) {
        const named = lp ? mwRec(`${r.name} (${lp.join(', ')})`, mwNodes.get(r.name)?.impl, mwNodes.get(r.name)?.package, r.config) : r
        ;(mounted ? appPost : appPre).push({ ...named, scope: 'app', res: lp ? lp.map(pathRegex) : null })
      }
    }
  }
  for (const m of mounts) {
    if (m.router) walkRouter(m.router, m.prefix, [], [], new Set())
    else addRoute(m.route, '', [], [])
  }
  // routers never mounted from an app (or apps built elsewhere): walk them as roots and flag them
  for (const rd of routerTable.keys()) {
    if (reached.has(rd)) continue
    const mountedByOther = [...routerTable.values()].flat().some((it) => it.method === 'use' && it.args.some((a) => (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a) || ts.isCallExpression(a)) && routerDeclOf(a) === rd))
    if (mountedByOther) continue
    const root = (config.entries?.express?.roots ?? []).find((r) => rel(rd.getSourceFile().fileName) === r.file)
    walkRouter(rd, root?.prefix ?? '', [], [], new Set())
    if (!root && !mounts.length) continue
    if (!root) warn.push(`Express router in ${rel(rd.getSourceFile().fileName)} is not mounted from an app; its routes have no path prefix (set entries.express.roots)`)
  }

  // ---------- NestJS (decorators) ----------
  const decoratorsOf = (n) => (ts.canHaveDecorators?.(n) ? ts.getDecorators(n) ?? [] : n.decorators ?? [])
  const decoInfo = (d) => { const e = d.expression; if (ts.isCallExpression(e)) return { name: e.expression.getText().replace(/^.*\./, ''), args: [...e.arguments] }; return { name: e.getText(), args: [] } }
  let globalPrefix = ''
  for (const sf of sourceFiles) (function visit(n) { if (ts.isCallExpression(n) && calleeName(n) === 'setGlobalPrefix' && n.arguments[0]) globalPrefix = literalText(n.arguments[0]) ?? ''; ts.forEachChild(n, visit) })(sf)
  const nestGlobalMw = []
  for (const sf of sourceFiles) (function visit(n) {
    if (ts.isCallExpression(n) && /^useGlobal(Guards|Pipes|Interceptors|Filters)$/.test(calleeName(n))) for (const a of n.arguments) nestGlobalMw.push(...resolveMw(a).map((r) => ({ ...r, scope: 'app' })))
    ts.forEachChild(n, visit)
  })(sf)
  const nestMw = (decos) => decos.flatMap((d) => { const i = decoInfo(d); return /^Use(Guards|Pipes|Interceptors|Filters)$|^(Throttle|Roles|Permissions|Public|Auth)$/.test(i.name) ? (i.args.length && /^Use/.test(i.name) ? i.args.flatMap((a) => resolveMw(a)) : [mwRec(`${i.name}(${i.args.map((a) => a.getText()).join(', ').slice(0, 60)})`, null, null)]) : [] })
  const NEST_HTTP = /^(Get|Post|Put|Patch|Delete|All|Options|Head)$/
  for (const sf of sourceFiles) (function visit(n) {
    if (ts.isClassDeclaration(n)) {
      const cdecos = decoratorsOf(n).map((d) => ({ d, ...decoInfo(d) }))
      const ctrl = cdecos.find((x) => x.name === 'Controller'), gateway = cdecos.find((x) => x.name === 'WebSocketGateway'), processor = cdecos.find((x) => x.name === 'Processor')
      if (ctrl || gateway || processor) frameworks.add('nestjs')
      const prefix = ctrl ? (literalText(ctrl.args[0]) ?? (ctrl.args[0] && ts.isObjectLiteralExpression(ctrl.args[0]) ? literalText(ctrl.args[0].properties.find((p) => p.name?.getText() === 'path')?.initializer) : '') ?? '') : ''
      const classMw = nestMw(cdecos.map((x) => x.d)).map((r) => ({ ...r, scope: 'router' }))
      for (const m of n.members) {
        if (!ts.isMethodDeclaration(m)) continue
        const mdecos = decoratorsOf(m).map((d) => ({ d, ...decoInfo(d) }))
        const methodMw = nestMw(mdecos.map((x) => x.d)).map((r) => ({ ...r, scope: 'route' }))
        for (const md of mdecos) {
          let id = null, j = null
          if (ctrl && NEST_HTTP.test(md.name)) { const full = joinPath(globalPrefix, prefix, literalText(md.args[0]) ?? ''); const method = md.name.toUpperCase(); id = `HTTP ${method} ${full}`; j = { id, kind: 'http', method, path: full, name: `${method} ${full}` } }
          else if (md.name === 'SubscribeMessage') { const a = literalText(md.args[0]) ?? m.name.getText(); id = `WS ${a}`; j = { id, kind: 'websocket', action: a, path: a, name: a } }
          else if (/^(MessagePattern|EventPattern)$/.test(md.name)) { const a = literalText(md.args[0]) ?? md.args[0]?.getText() ?? m.name.getText(); id = `MSG ${a}`; j = { id, kind: 'consumer', path: a, name: a } }
          else if (/^(Cron|Interval|Timeout)$/.test(md.name)) { const a = md.args[0]?.getText() ?? ''; id = `JOB ${n.name?.text}.${m.name.getText()}`; j = { id, kind: 'scheduled', path: rel(sf.fileName), name: `${n.name?.text}.${m.name.getText()}`, schedule: a.replace(/^['"]|['"]$/g, '') } }
          else if (processor && md.name === 'Process') { const q = literalText(processor.args[0]) ?? 'queue'; id = `QUEUE ${q}${md.args[0] ? ':' + (literalText(md.args[0]) ?? '') : ''}`; j = { id, kind: 'consumer', path: q, name: id.slice(6) } }
          else if (md.name === 'OnEvent') { const evName = literalText(md.args[0]); if (evName) { const eid = `events:${evName}`; if (!events.has(eid)) events.set(eid, { id: eid, emitter: 'events', name: evName, transport: 'in-process' }); handles.set(`${eid}|${ownerId(m)}`, { event: eid, to: ownerId(m) }) } }
          if (j) {
            addJourney({ ...j, source: `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(m.getStart()).line + 1}` })
            addEntry(id, ownerId(m))
            if (j.kind === 'http' || j.kind === 'websocket') routeChains.set(id, [...nestGlobalMw, ...classMw, ...methodMw])
          }
        }
      }
    }
    ts.forEachChild(n, visit)
  })(sf)
  // EventEmitter2 in Nest: this.eventEmitter.emit('x') pairs with @OnEvent('x')
  for (const sf of sourceFiles) (function visit(n) {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'emit' && /EventEmitter2/.test(typeText(n.expression.expression))) {
      const evName = literalText(n.arguments[0]); if (evName) { const eid = `events:${evName}`; if (!events.has(eid)) events.set(eid, { id: eid, emitter: 'events', name: evName, transport: 'in-process' }); emits.set(`${enclosingOwner(n)}|${eid}`, { from: enclosingOwner(n), event: eid }) }
    }
    ts.forEachChild(n, visit)
  })(sf)

  // ---------- Fastify ----------
  for (const sf of sourceFiles) (function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^Fastify/.test(typeText(node.expression.expression))) {
      const m = node.expression.name.text
      if (HTTP_METHODS.has(m) && m !== 'use') {
        frameworks.add('fastify')
        const p = literalText(node.arguments[0]) ?? ''
        const method = m.toUpperCase(), id = `HTTP ${method} ${joinPath(p)}`
        addJourney({ id, kind: 'http', method, path: joinPath(p), name: `${method} ${joinPath(p)}`, source: `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}` })
        const opts = node.arguments.find((a) => ts.isObjectLiteralExpression(a))
        const hooks = opts ? opts.properties.filter((pp) => /^(preHandler|onRequest|preValidation)$/.test(pp.name?.getText())).flatMap((pp) => resolveMw(pp.initializer)) : []
        routeChains.set(id, hooks.map((r) => ({ ...r, scope: 'route' })))
        addEntry(id, targetOf(node.arguments[node.arguments.length - 1]))
      } else if (m === 'route' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        frameworks.add('fastify')
        const props = Object.fromEntries(node.arguments[0].properties.filter((pp) => pp.name).map((pp) => [pp.name.getText(), pp.initializer]))
        const methods = props.method ? (ts.isArrayLiteralExpression(props.method) ? props.method.elements.map(literalText) : [literalText(props.method)]) : ['GET']
        const p = joinPath(literalText(props.url ?? props.path) ?? '')
        for (const mm of methods.filter(Boolean)) {
          const id = `HTTP ${mm.toUpperCase()} ${p}`
          addJourney({ id, kind: 'http', method: mm.toUpperCase(), path: p, name: `${mm.toUpperCase()} ${p}`, source: `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}` })
          routeChains.set(id, ['onRequest', 'preValidation', 'preHandler'].flatMap((h) => (props[h] ? resolveMw(props[h]) : [])).map((r) => ({ ...r, scope: 'route' })))
          addEntry(id, targetOf(props.handler))
        }
      }
    }
    ts.forEachChild(node, visit)
  })(sf)

  // ---------- Next.js route handlers and API routes ----------
  for (const sf of sourceFiles) {
    const r = rel(sf.fileName)
    const app = r.match(/(?:^|\/)app\/(.*)\/route\.[cm]?[jt]sx?$/), pages = r.match(/(?:^|\/)pages\/(api\/.*)\.[cm]?[jt]sx?$/)
    if (!app && !pages) continue
    frameworks.add('nextjs')
    const route = '/' + (app ? app[1] : pages[1].replace(/\/index$/, '')).split('/').filter((s) => !/^\(.*\)$/.test(s)).map((s) => s.replace(/^\[\.\.\.(.+)\]$/, ':$1*').replace(/^\[(.+)\]$/, ':$1')).join('/')
    for (const st of sf.statements) {
      if (app && ts.isFunctionDeclaration(st) && st.name && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(st.name.text) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const id = `HTTP ${st.name.text} ${route}`
        addJourney({ id, kind: 'http', method: st.name.text, path: route, name: `${st.name.text} ${route}`, source: r }); addEntry(id, ownerId(st))
      }
      if (app && ts.isVariableStatement(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) for (const d of st.declarationList.declarations) if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(d.name.getText())) {
        const id = `HTTP ${d.name.getText()} ${route}`; addJourney({ id, kind: 'http', method: d.name.getText(), path: route, name: `${d.name.getText()} ${route}`, source: r }); addEntry(id, isOwner(d) ? ownerId(d) : targetOf(d.initializer))
      }
      if (pages && (ts.isExportAssignment(st) || (ts.isFunctionDeclaration(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)))) {
        const id = `HTTP * ${route}`; addJourney({ id, kind: 'http', method: '*', path: route, name: `* ${route}`, source: r })
        addEntry(id, ts.isExportAssignment(st) ? (isOwner(st) ? ownerId(st) : targetOf(st.expression)) : ownerId(st))
      }
    }
  }
  const nextMw = sourceFiles.find((sf) => /^(src\/)?middleware\.[cm]?[jt]s$/.test(rel(sf.fileName)))
  if (nextMw) { const d = nextMw.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'middleware'); if (d) nestGlobalMw.push({ ...mwRec('next middleware', ownerId(d), null), scope: 'app' }) }

  // ---------- Commander CLIs: program.command('db').command('prune <x>').action(fn) → CLI db prune ----------
  const fromPkg = (node, re) => { const d = declOf(node); return !!d && re.test(d.getSourceFile().fileName) }
  function commandPath(n, depth = 0) {
    while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n))) n = n.expression
    if (!n || depth > 12) return []
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const parent = commandPath(n.expression.expression, depth + 1)
      // .command('name <args>') opens a subcommand; builder calls (.description/.option/...) return the same command
      return n.expression.name.text === 'command' ? [...parent, ((literalText(n.arguments[0]) ?? '').trim().split(/\s+/)[0])].filter(Boolean) : parent
    }
    if (ts.isIdentifier(n)) { const d = resolveSymbol(n)?.declarations?.[0]; return d && ts.isVariableDeclaration(d) && d.initializer ? commandPath(d.initializer, depth + 1) : [] }
    return []
  }
  for (const sf of sourceFiles) (function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'action' && node.arguments[0] && fromPkg(node.expression, /node_modules[\\/]commander[\\/]/)) {
      frameworks.add('commander')
      const words = commandPath(node.expression.expression), name = words.join(' ') || '(default)', id = `CLI ${name}`
      addJourney({ id, kind: 'cli', name, path: words.join('/'), command: name, source: `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}` })
      addEntry(id, targetOf(node.arguments[0]))
    }
    ts.forEachChild(node, visit)
  })(sf)

  // ---------- MCP servers: McpServer.tool/registerTool/prompt/resource, or low-level setRequestHandler(CallToolRequestSchema) with a switch on the tool name ----------
  const MCP_PKG = /node_modules[\\/]@modelcontextprotocol[\\/]/
  const addMcp = (name, fn, sf, node, what = 'tool') => {
    frameworks.add('mcp')
    const id = `MCP ${name}`
    addJourney({ id, kind: 'mcp', name, path: name, mcp: what, source: `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}` })
    addEntry(id, fn)
  }
  // a case clause becomes its own function so each tool reaches only what its branch calls
  function caseOwner(sf, label, stmts) {
    const line = sf.getLineAndCharacterOfPosition(stmts[0]?.getStart() ?? 0).line + 1, id = `${rel(sf.fileName)}#case '${label}'@${line}`
    if (!functions.has(id)) functions.set(id, { id, name: `case '${label}'`, file: rel(sf.fileName), line })
    for (const st of stmts) (function visit(n) {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) { const d = declOf(n.expression); const to = d && ownerForDecl(d); if (to) addCall(id, to, ts.isNewExpression(n) ? 'new' : 'call') }
      if (isFnExpr(n) && isOwner(n)) { addCall(id, ownerId(n), 'callback'); return }
      ts.forEachChild(n, visit)
    })(st)
    return id
  }
  for (const sf of sourceFiles) (function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && fromPkg(node.expression, MCP_PKG)) {
      const m = node.expression.name.text, args = node.arguments
      if (/^(tool|registerTool|prompt|registerPrompt|resource|registerResource)$/.test(m) && literalText(args[0]) != null) {
        addMcp(literalText(args[0]), targetOf(args[args.length - 1]), sf, node, m.replace(/^register/, '').toLowerCase())
      } else if (m === 'setRequestHandler' && args[0] && args[1] && !/^List/.test(args[0].getText())) {
        const what = args[0].getText().replace(/RequestSchema$/, '').replace(/.*\./, '')
        const cb = args[1], body = isFnExpr(cb) ? cb.body : null
        let sw = null
        body && (function find(n) { if (!sw && ts.isSwitchStatement(n)) sw = n; if (!sw && !isFnExpr(n)) ts.forEachChild(n, find) })(body)
        const clauses = sw?.caseBlock.clauses ?? []
        const labelled = clauses.filter((c) => ts.isCaseClause(c) && literalText(c.expression) != null)
        if (labelled.length) clauses.forEach((c, i) => {
          if (!ts.isCaseClause(c) || literalText(c.expression) == null) return
          const target = clauses.slice(i).find((x) => x.statements.length) // fall-through shares the next body
          addMcp(literalText(c.expression), caseOwner(sf, literalText(c.expression), target?.statements ?? []), sf, c, /Tool/.test(what) ? 'tool' : what)
        })
        else addMcp(what, targetOf(cb), sf, node, what)
      }
    }
    ts.forEachChild(node, visit)
  })(sf)

  // ---------- configured entry points: handler registries and named functions ----------
  for (const sf of sourceFiles) (function visit(node) {
    if (ts.isVariableDeclaration(node) && node.type && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const rule = registryRules2.find((r) => r.re.test(node.type.getText()))
      if (rule) for (const p of node.initializer.properties) {
        if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue
        const action = p.name.getText().replace(/^['"]|['"]$/g, ''), id = `${rule.prefix ?? 'WS'} ${action}`
        addJourney({ id, kind: rule.kind ?? 'websocket', action, path: action, name: action, source: rel(sf.fileName) })
        addEntry(id, ts.isPropertyAssignment(p) ? (isOwner(p) ? ownerId(p) : targetOf(p.initializer)) : targetOf(p.name))
      }
    }
    ts.forEachChild(node, visit)
  })(sf)
  const fnRules = (config.entries?.functions ?? []).map((r) => ({ ...r, fileRe: rx(r.file), nameRe: rx(r.export ?? '.') }))
  const ruleFiles = new Set()
  for (const sf of sourceFiles) {
    const r = rel(sf.fileName), rule = fnRules.find((x) => x.fileRe.test(r)); if (!rule) continue
    ruleFiles.add(sf.fileName)
    for (const st of sf.statements) if (ts.isFunctionDeclaration(st) && st.name && rule.nameRe.test(st.name.text) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      const base = path.basename(r).replace(/\.[cm]?[jt]sx?$/, '').replace(rule.strip ? rx(rule.strip) : /$^/, '')
      const name = rule.nameFrom === 'function' ? st.name.text : base, id = `${rule.prefix ?? 'JOB'} ${name}`
      addJourney({ id, kind: rule.kind ?? 'scheduled', name, path: r, schedule: scheduleIn(sf), source: r })
      addEntry(id, ownerId(st))
    }
  }
  function scheduleIn(sf) {
    const found = []
    ;(function visit(n) {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const c = calleeName(n), e = n.expression?.getText?.() ?? ''
        if (/^(schedule|scheduleJob)$/.test(c) && n.arguments?.[0]) found.push(literalText(n.arguments[0]) ?? n.arguments[0].getText())
        if (/CronJob$/.test(e) && n.arguments?.[0]) found.push(literalText(n.arguments[0]) ?? n.arguments[0].getText())
        if (c === 'setInterval' && n.arguments?.[1]) found.push(`every ${literalText(n.arguments[1]) ?? n.arguments[1].getText()} ms`)
      }
      ts.forEachChild(n, visit)
    })(sf)
    return found.join(', ')
  }
  // ---------- generic schedulers and queue consumers (outside files a config rule already covers) ----------
  const jobCounts = new Map()
  for (const sf of sourceFiles) {
    if (ruleFiles.has(sf.fileName)) continue
    const r = rel(sf.fileName), base = path.basename(r).replace(/\.[cm]?[jt]sx?$/, '')
    ;(function visit(n) {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const c = calleeName(n), e = n.expression?.getText?.() ?? ''
        let kind = null, label = null, sched = null, cb = null
        if (/^(schedule|scheduleJob)$/.test(c) && /cron|schedule/i.test(e) && n.arguments?.length >= 2) { kind = 'scheduled'; sched = literalText(n.arguments[0]) ?? n.arguments[0].getText(); cb = n.arguments[1] }
        else if (/CronJob$/.test(e) && n.arguments?.length >= 2) { kind = 'scheduled'; sched = literalText(n.arguments[0]) ?? n.arguments[0].getText(); cb = n.arguments[1] }
        else if (c === 'setInterval' && n.arguments?.length >= 2) { const owner = enclosingOwner(n); const fname = functions.get(owner)?.name ?? ''; if (/<module>|^(init|start|setup|schedule|boot)/i.test(fname)) { kind = 'scheduled'; sched = `every ${literalText(n.arguments[1]) ?? n.arguments[1].getText()} ms`; cb = n.arguments[0] } }
        else if (/^Worker$/.test(e) && ts.isNewExpression(n) && n.arguments?.length >= 2 && /bullmq/.test(declOf(n.expression)?.getSourceFile().fileName ?? '')) { kind = 'consumer'; label = literalText(n.arguments[0]) ?? 'queue'; cb = n.arguments[1] }
        else if (c === 'process' && /Queue|Bull/.test(typeText(n.expression.expression ?? n.expression))) { kind = 'consumer'; label = base; cb = n.arguments[n.arguments.length - 1] }
        else if (c === 'run' && /Consumer/.test(typeText(n.expression.expression ?? n.expression)) && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) { kind = 'consumer'; label = base; cb = n.arguments[0].properties.find((p) => /^each(Message|Batch)$/.test(p.name?.getText()))?.initializer }
        else if (c === 'consume' && /Channel/.test(typeText(n.expression.expression ?? n.expression))) { kind = 'consumer'; label = literalText(n.arguments[0]) ?? base; cb = n.arguments[1] }
        else if (c === 'define' && /Agenda/.test(typeText(n.expression.expression ?? n.expression))) { kind = 'scheduled'; label = literalText(n.arguments[0]); cb = n.arguments[n.arguments.length - 1] }
        if (kind) {
          const k = `${kind}|${label ?? base}`, idx = (jobCounts.get(k) ?? 0) + 1; jobCounts.set(k, idx)
          const name = `${label ?? base}${idx > 1 ? `#${idx}` : ''}`, id = `${kind === 'consumer' ? 'QUEUE' : 'JOB'} ${name}`
          addJourney({ id, kind, name, path: r, schedule: sched ?? '', source: `${r}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}` })
          addEntry(id, targetOf(cb) ?? enclosingOwner(n))
          if (kind === 'consumer') frameworks.add('queue-consumers'); else frameworks.add('schedulers')
        }
      }
      ts.forEachChild(n, visit)
    })(sf)
  }

  // ---------- assemble HTTP chains: app-wide before, route chain, app-wide after ----------
  for (const j of journeys.values()) {
    if (!routeChains.has(j.id)) continue
    const applies = (r) => !r.res || r.res.some((re) => re.test(j.path))
    const chain = j.kind === 'http' ? [...appPre.filter(applies), ...routeChains.get(j.id), ...appPost.filter(applies)] : routeChains.get(j.id)
    chain.forEach((r, i) => mwPasses.push({ journey: j.id, mw: r.name ?? r.mw, order: i, scope: r.scope, config: r.config ?? null }))
  }
  // ---------- configured message pipelines (e.g. WebSocket connect + per-message checks before dispatch) ----------
  for (const pl of config.pipelines ?? []) {
    const psf = sourceFiles.find((s) => rel(s.fileName) === pl.file); if (!psf) { warn.push(`pipeline file not found: ${pl.file}`); continue }
    const fnDecl = (nm) => psf.statements.find((st) => ts.isFunctionDeclaration(st) && st.name?.text === nm)
    const stages = []
    const collect = (fn, scope, re, beforePos) => {
      if (!fn?.body) return
      const seenN = new Set()
      ;(function visit(node) {
        if (beforePos != null && node.getStart() >= beforePos) return
        if (ts.isCallExpression(node)) { const d = declOf(node.expression); if (d && isAnalyzed(d.getSourceFile().fileName)) { const o = ownerForDecl(d), nm = o ? functions.get(o).name : null; if (nm && re.test(nm) && !seenN.has(nm)) { seenN.add(nm); stages.push({ ...mwRec(nm, o, null), scope }) } } }
        ts.forEachChild(node, visit)
      })(fn.body)
    }
    if (pl.connect) collect(fnDecl(pl.connect), 'connect', /verify|validate|auth|token|check/i)
    if (pl.message) {
      const hm = fnDecl(pl.message); let hv = null, dp = null
      hm?.body && (function f(n) { if (!hv && ts.isVariableDeclaration(n) && n.initializer && ts.isElementAccessExpression(n.initializer) && (!pl.registryVar || n.initializer.expression.getText() === pl.registryVar)) hv = n.name.getText(); ts.forEachChild(n, f) })(hm.body)
      hm?.body && (function f(n) { if (dp == null && ts.isCallExpression(n) && n.expression.getText() === hv) dp = n.getStart(); ts.forEachChild(n, f) })(hm.body)
      collect(hm, 'per-message', /validate|ensure|verify|resolve\w*(Actor|Replay|User|Context)|authoriz|check|guard/i, dp)
    }
    for (const j of journeys.values()) if (j.kind === (pl.appliesTo ?? 'websocket')) stages.forEach((r, i) => mwPasses.push({ journey: j.id, mw: r.name, order: i, scope: r.scope, config: null }))
  }
}

// ---------------- wildcard events: `emitter:*` subscribers handle every event of that emitter ----------------
for (const h of [...handles.values()]) { const ev = events.get(h.event); if (ev?.name !== '*') continue; for (const e of events.values()) if (e.emitter === ev.emitter && e.name !== '*') handles.set(`${e.id}|${h.to}`, { event: e.id, to: h.to }) }
for (const e of [...emits.values()]) { const ev = events.get(e.event); if (ev?.name !== '*') continue; for (const x of events.values()) if (x.emitter === ev.emitter && x.name !== '*') emits.set(`${e.from}|${x.id}`, { from: e.from, event: x.id }) }

// ---------------- write graph.json ----------------
const git = (cmd) => { try { return execSync(cmd, { cwd: repo, encoding: 'utf8' }).trim() } catch { return null } }
const withEntry = new Set(entries.filter((e) => e.role === 'handler').map((e) => e.journey))
const noHandler = [...journeys.values()].filter((j) => !withEntry.has(j.id)).map((j) => j.id)
const out = {
  meta: {
    schema: 1, analyzer: 'journey-atlas/ts', project: config.name ?? path.basename(repo), root: repo,
    commit: git('git rev-parse --short HEAD'), branch: git('git rev-parse --abbrev-ref HEAD'), generated_at: new Date().toISOString(),
    database: DATABASE, frameworks: [...frameworks], warnings: [...new Set(warn)], unresolved_http: unresolvedHttp.slice(0, 50), journeys_without_handler: noHandler.slice(0, 50),
  },
  functions: [...functions.values()],
  calls: [...calls.values()],
  externals: [...externals.values()],
  externalCalls: [...externalCalls.values()].map((e) => ({ ...e, ops: [...e.ops].sort() })),
  modelQueries: [...modelQueries.values()].map((e) => ({ ...e, ops: [...e.ops].sort() })),
  envReads: [...envReads].map((k) => { const i = k.lastIndexOf('|'); return { fn: k.slice(0, i), key: k.slice(i + 1) } }),
  events: [...events.values()].filter((e) => e.name !== '*'),
  emits: [...emits.values()].filter((e) => events.get(e.event)?.name !== '*'),
  handles: [...handles.values()].filter((h) => events.get(h.event)?.name !== '*'),
  journeys: [...journeys.values()],
  entries,
  middleware: [...mwNodes.values()].filter((m) => mwPasses.some((p) => p.mw === m.name)),
  mwPasses,
  throws,
  signals: [...signals].flatMap(([fn, m]) => [...m].map(([signal, v]) => ({ fn, signal, count: v.count, samples: [...v.samples] }))),
  txCalls,
}
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(out))
const byKind = {}; for (const j of out.journeys) byKind[j.kind] = (byKind[j.kind] ?? 0) + 1
console.log(JSON.stringify({
  wrote: outFile, frameworks: out.meta.frameworks, journeys: byKind, functions: out.functions.length, calls: out.calls.length,
  externals: out.externals.map((e) => `${e.name} (${e.kind})`), tables: new Set(out.modelQueries.map((m) => m.model)).size,
  events: out.events.length, middleware: out.middleware.length, unresolved_http: unresolvedHttp.length, journeys_without_handler: noHandler.length, warnings: out.meta.warnings,
}, null, 2))
