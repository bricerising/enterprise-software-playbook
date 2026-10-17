// Views for the architecture atlas
const { fmt, $, el, CRIT, MUTED } = AK
const metaRow = () => (dash.data('meta').status === 'ok' ? dash.data('meta').data[0] || {} : {})
const coreSystems = () => String(metaRow().core_systems || '').split(', ').filter(Boolean)
const LANES = ['Handler', 'Logic', 'Data', 'External', 'Events', 'After response']
const LAYER_ORDER = ['entry', 'middleware', 'domain', 'shared', 'events', 'platform', 'foundation']
const LAYER_LABEL = { entry: 'Entry points', middleware: 'Middleware', domain: 'Domain services', shared: 'Shared services', events: 'Events', platform: 'Platform', foundation: 'Foundation' }

dash.calc('job_load', {
  inputs: ['jobs'],
  title: 'Job runs per hour by system',
  description: 'Sum of runs per hour of every scheduled job whose call path can reach each external system.',
  fn: (jobs) => {
    const m = new Map()
    for (const j of jobs) for (const s of String(j.systems || '').split(', ').filter(Boolean)) m.set(s, (m.get(s) || 0) + Number(j.runs_per_hour || 0))
    return [...m].map(([system, runs_per_hour]) => ({ system, runs_per_hour })).sort((a, b) => b.runs_per_hour - a.runs_per_hour)
  },
})

dash.calc('table_writers', {
  inputs: ['crud'],
  title: 'Writing components per table',
  description: 'Number of components that create, update or delete rows in each table.',
  fn: (crud) => {
    const m = new Map()
    for (const r of crud) if (Number(r.C) + Number(r.U) + Number(r.D) > 0) m.set(r.table, (m.get(r.table) || 0) + 1)
    return [...m].map(([table, writers]) => ({ table, writers })).sort((a, b) => b.writers - a.writers || a.table.localeCompare(b.table))
  },
})

dash.calc('variants_per_area', {
  inputs: ['chain_variants'],
  title: 'Middleware chain variants per area',
  description: 'Distinct router and route middleware chains per API area, and journeys whose chain runs the rate limiter after sign-in.',
  fn: (chain_variants) => {
    const m = new Map()
    for (const r of chain_variants) {
      const o = m.get(r.area) || { area: r.area, variants: 0, journeys: 0, rate_limit_after_auth: 0 }
      o.variants += 1; o.journeys += Number(r.journeys)
      if (r.rate_limit_after_auth === true || r.rate_limit_after_auth === 'true') o.rate_limit_after_auth += Number(r.journeys)
      m.set(r.area, o)
    }
    return [...m.values()].sort((a, b) => b.variants - a.variants || b.journeys - a.journeys)
  },
})

const KIND_COLOR = { authentication: () => dash.colors[0], authorization: () => dash.colors[1], validation: () => dash.colors[2], 'rate-limit': () => dash.colors[3], 'replay-protection': () => dash.colors[4] }
const kindColor = (k) => (KIND_COLOR[k] ? KIND_COLOR[k]() : MUTED)
const KIND_LABEL = { authentication: 'Sign-in', authorization: 'Permission', validation: 'Validation', 'rate-limit': 'Rate limit', 'replay-protection': 'Replay protection', cors: 'CORS', 'security-headers': 'Security headers', 'body-parsing': 'Body parsing', observability: 'Request ID and logging', 'error-handling': 'Error handling', other: 'Other' }

// consistent colors for kinds of user across views
// the seven busiest kinds of user get the series colors, in the same order on every tab
let actorOrder = null
const actorColor = (a) => {
  if (!actorOrder && dash.data('journeys_index').status === 'ok') actorOrder = [...d3.rollup(dash.data('journeys_index').data, (v) => v.length, (r) => r.actor)].sort((x, y) => y[1] - x[1]).map((x) => x[0]).slice(0, 7)
  const i = (actorOrder || []).indexOf(a)
  return i >= 0 ? dash.colors[i] : MUTED
}
const noRecoverySystems = () => new Set(dash.data('resilience').status === 'ok' ? dash.data('resilience').data.filter((r) => /^(None|Unknown)/.test(r.recovery)).map((r) => r.system) : [])
const actorLegend = (node, actors) => {
  const known = actors.filter((a) => actorColor(a) !== MUTED)
  AK.legend(node, [...known.map((a) => [a, actorColor(a)]), ...(known.length < actors.length ? [['Others', MUTED]] : [])])
}
const resolveColor = (c) => { const p = el('span'); p.style.color = c; $('.ak').append(p); const v = getComputedStyle(p).color; p.remove(); return v }

// ---------------- Overview ----------------
function drawHeader() {
  const m = metaRow()
  if (m.project) { $('#ak-project').textContent = m.project; $('#ak-provenance').textContent = [m.branch && `branch ${m.branch}`, m.commit && `commit ${m.commit}`, m.generated_at && `analyzed ${String(m.generated_at).slice(0, 10)}`, m.frameworks && `detected: ${m.frameworks}`].filter(Boolean).join(' · '); $('#ak-method-meta').textContent = `Kinds of user: ${m.actors}. Churn counts commits in the last ${m.churn_days} days.` }
}
function drawOverview() {
  $('#ak-core-names').textContent = coreSystems().length ? ` (${coreSystems().join(', ')})` : ''
  const s = dash.data('summary')
  document.querySelectorAll('#overview [data-source="summary"]').forEach((e) => { AK.setState(e, s.status); e.textContent = s.status === 'ok' && s.data[0] ? fmt(Number(s.data[0][e.dataset.field])) : '—' })

  const box = $('#ak-ctx')
  if (!AK.ready(box, 'context_flow')) return
  const core = dash.params().ctx_core === true
  $('#ak-ctx-core').checked = core
  const rows = dash.data('context_flow').data.map((r) => ({ ...r, journeys: Number(r.journeys), async_journeys: Number(r.async_journeys) })).filter((r) => core || !coreSystems().includes(r.system))
  actorLegend($('#ak-ctx-legend'), [...new Set(rows.map((r) => r.actor))])
  AK.flow(box, {
    rows, keys: ['actor', 'component', 'system'], value: (r) => r.journeys, color: (r) => actorColor(r.actor), height0: 560,
    rowTip: (r) => [`${fmt(r.journeys)} journeys`, r.async_journeys ? `${fmt(r.async_journeys)} only after an event` : ''],
    nodeTip: (k, nm, v) => [`${fmt(v)} journey paths`],
  })
}

// ---------------- Structure ----------------
function drawStructure() {
  const lay = $('#ak-layers')
  if (AK.ready(lay, 'components', 'dsm')) {
    const comps = dash.data('components').data
    const dsm = dash.data('dsm').data
    const upOut = d3.rollup(dsm.filter((d) => d.direction === 'up'), (v) => d3.sum(v, (d) => Number(d.calls)), (d) => d.from)
    const tip = AK.tip($('#ak-layers-card'))
    lay.replaceChildren(...LAYER_ORDER.map((L) => {
      const row = el('div', 'ak-layer')
      row.append(el('div', 'ak-layer-name', LAYER_LABEL[L]))
      const chips = el('div', 'ak-chips')
      for (const c of comps.filter((x) => x.layer === L)) {
        const ch = el('div', 'ak-chip' + ((upOut.get(c.component) || 0) >= 5 ? ' ak-up' : ''))
        ch.style.flex = `${Math.sqrt(Number(c.functions))} 1 auto`
        ch.append(el('b', null, c.component), el('span', null, `${fmt(Number(c.functions))} fns · ${fmt(Number(c.journeys))} journeys`))
        if (upOut.get(c.component)) ch.append(el('span', (upOut.get(c.component) >= 5 ? 'ak-upn' : 'ak-upn-minor'), `${AK.plural(upOut.get(c.component), 'call')} upward`))
        ch.addEventListener('mousemove', (e) => tip.show(e, c.component, [`${fmt(Number(c.files))} files, ${fmt(Number(c.functions))} functions`, `${fmt(Number(c.calls_in))} calls in, ${fmt(Number(c.calls_out))} calls out`, `Instability ${c.instability} (0 stable, 1 depends on others)`]))
        ch.addEventListener('mouseleave', () => tip.hide())
        chips.append(ch)
      }
      row.append(chips)
      return row
    }))
  }

  const box = $('#ak-dsm')
  if (AK.ready(box, 'dsm', 'components')) {
    const comps = dash.data('components').data.map((c) => c.component)
    const layerOf = new Map(dash.data('components').data.map((c) => [c.component, c.layer]))
    const cells = new Map(dash.data('dsm').data.map((d) => [d.from + '|' + d.to, { ...d, calls: Number(d.calls) }]))
    const max = d3.max([...cells.values()], (d) => d.calls) || 1
    const cs = 15, n = comps.length
    box.replaceChildren()
    const svg = d3.select(box).append('svg')
    const meas = svg.append('text').attr('class', 'ak-lbl')
    const lw = d3.max(comps, (c) => { meas.text(c); return meas.node().getComputedTextLength() }) + 10
    meas.remove()
    const top = lw * 0.75 + 6
    const W = lw + n * cs + 8, H = top + n * cs + 8
    svg.attr('width', W).attr('height', H).attr('viewBox', `0 0 ${W} ${H}`)
    box.style.minHeight = H + 'px'; box.style.width = W + 'px'
    const lo = resolveColor('var(--color-bg)'), hi = resolveColor(dash.colors[0])
    const ramp = d3.interpolateRgb(lo, hi)
    const tip = AK.tip(box)
    AK.legend($('#ak-dsm-legend'), [['Calls down or across', dash.colors[0]], ['Calls up against the layering', CRIT], ['Two-way dependency (outlined)', 'transparent']])
    // layer bands
    let start = 0
    LAYER_ORDER.forEach((L) => {
      const cnt = comps.filter((c) => layerOf.get(c) === L).length
      if (!cnt) return
      svg.append('rect').attr('x', lw + start * cs).attr('y', top + start * cs).attr('width', cnt * cs).attr('height', cnt * cs).style('fill', 'none').style('stroke', 'var(--cds-chart-axis)').attr('stroke-dasharray', '3 2')
      start += cnt
    })
    comps.forEach((r, i) => {
      svg.append('text').attr('class', 'ak-lbl').attr('x', lw - 6).attr('y', top + i * cs + cs / 2).attr('dy', '0.35em').attr('text-anchor', 'end').style('fill', 'var(--color-fg)').text(r)
      svg.append('text').attr('class', 'ak-lbl').attr('transform', `translate(${lw + i * cs + cs / 2},${top - 6}) rotate(-50)`).style('fill', 'var(--color-fg)').text(r)
      comps.forEach((c, j) => {
        const d = cells.get(r + '|' + c)
        if (!d) return
        const t = Math.log1p(d.calls) / Math.log1p(max)
        const rect = svg.append('rect').attr('x', lw + j * cs + 1).attr('y', top + i * cs + 1).attr('width', cs - 2).attr('height', cs - 2).attr('rx', 2)
        if (d.direction === 'up') rect.style('fill', CRIT).style('opacity', 0.35 + 0.65 * t)
        else rect.style('fill', ramp(0.2 + 0.8 * t))
        if (d.cycle === true || d.cycle === 'true') rect.style('stroke', 'var(--color-fg)').style('stroke-width', 1.2)
        rect.on('mousemove', (e) => tip.show(e, `${r} → ${c}`, [`${fmt(d.calls)} calls`, d.direction === 'up' ? 'Points up against the layering' : d.direction === 'lateral' ? 'Same layer' : 'Points down', d.cycle === true || d.cycle === 'true' ? 'The two components call each other' : ''])).on('mouseleave', () => tip.hide())
      })
    })
  }

  const cb = $('#ak-conv'), cf = $('#ak-conv-find')
  if (AK.ready(cb, 'convergence', 'convergence_mix')) {
    const pts = dash.data('convergence').data
    const mix = dash.data('convergence_mix').data.map((r) => ({ ...r, journeys: Number(r.journeys) }))
    const actors = [...d3.rollup(mix, (v) => d3.sum(v, (r) => r.journeys), (r) => r.actor)].sort((a, b) => b[1] - a[1]).map((x) => x[0])
    actorLegend($('#ak-conv-legend'), actors)
    const top = pts[0]
    AK.setState(cf, 'ok')
    if (!top) cf.replaceChildren('No function joins enough separate call paths to stand out.')
    else cf.replaceChildren('Functions where separate call paths join, so a change there reaches every path at once. ', AK.mark(top.point, 'convergence', 'point', { point: top.point }), ' leads with ', AK.mark(fmt(Number(top.incoming_paths)), 'convergence', 'incoming_paths', { point: top.point }), ' incoming paths.')
    const byPoint = d3.group(mix, (r) => r.point)
    AK.bars(cb, pts.map((p) => ({
      label: p.point, code: true,
      segs: actors.map((a) => ({ v: (byPoint.get(p.point) || []).filter((r) => r.actor === a).reduce((s, r) => s + r.journeys, 0), color: actorColor(a) })),
      value: `${fmt(Number(p.journeys))} · ${fmt(Number(p.incoming_paths))} paths`,
      tip: [p.point, p.file, `${fmt(Number(p.merged_journeys))} journeys merged here`, p.reaches ? `Then reaches ${p.reaches}` : ''],
    })), $('#ak-conv-card'), { labelWidth: '20rem' })
  } else { AK.setState(cf, AK.status('convergence')); cf.textContent = '—' }
}

// ---------------- Change risk ----------------
let impactQuery = ''
function drawRisk() {
  const box = $('#ak-hot')
  if (AK.ready(box, 'hotspots')) {
    const rows = dash.data('hotspots').data.map((r) => ({ ...r, journeys: Number(r.journeys), commits_90d: Number(r.commits_90d), quiet_gaps: Number(r.quiet_gaps) }))
    const W = Math.max(320, box.clientWidth), H = 400
    const m = { l: 44, r: 16, t: 12, b: 36 }
    const x = d3.scaleLog([3, d3.max(rows, (r) => r.journeys) * 1.1], [m.l, W - m.r])
    const y = d3.scaleSqrt([0, d3.max(rows, (r) => r.commits_90d) * 1.08], [H - m.b, m.t])
    const rs = (g) => Math.min(13, 3 + Math.sqrt(g) * 1.8)
    box.replaceChildren()
    const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H)
    const gx = svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(W < 500 ? 3 : 6, '~s')).attr('font-size', null).attr('font-family', null)
    const gy = svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5)).attr('font-size', null).attr('font-family', null)
    for (const g of [gx, gy]) { g.selectAll('text').attr('class', 'ak-lbl').style('fill', 'var(--color-fg-muted)'); g.selectAll('line,path').style('stroke', 'var(--cds-chart-axis)') }
    svg.append('text').attr('class', 'ak-lbl').attr('x', W - m.r).attr('y', H - 4).attr('text-anchor', 'end').style('fill', 'var(--color-fg-muted)').text('Journeys through the file (log)')
    svg.append('text').attr('class', 'ak-lbl').attr('x', m.l + 4).attr('y', m.t + 10).style('fill', 'var(--color-fg-muted)').text('Commits, last 90 days')
    const mx = d3.median(rows, (r) => r.journeys), my = d3.median(rows, (r) => r.commits_90d)
    svg.append('line').attr('x1', x(mx)).attr('x2', x(mx)).attr('y1', m.t).attr('y2', H - m.b).style('stroke', 'var(--cds-chart-reference)').attr('stroke-dasharray', '4 3')
    svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(my)).attr('y2', y(my)).style('stroke', 'var(--cds-chart-reference)').attr('stroke-dasharray', '4 3')
    const tip = AK.tip(box)
    AK.legend($('#ak-hot-legend'), [['Has failure-handling gaps', CRIT, 0.6], ['No gaps found', MUTED, 0.6], ['Dashed lines: medians', 'var(--cds-chart-reference)']])
    svg.append('g').selectAll('circle').data([...rows].sort((a, b) => b.quiet_gaps - a.quiet_gaps)).join('circle')
      .attr('cx', (r) => x(Math.max(3, r.journeys))).attr('cy', (r) => y(r.commits_90d)).attr('r', (r) => rs(r.quiet_gaps))
      .style('fill', (r) => (r.quiet_gaps ? CRIT : MUTED)).style('fill-opacity', 0.55).style('stroke', 'var(--color-panel)').style('cursor', 'pointer')
      .on('mousemove', (e, r) => tip.show(e, r.file, [`${r.component}`, `${fmt(r.journeys)} journeys from ${fmt(Number(r.user_types))} kinds of user`, `${fmt(r.commits_90d)} commits in 90 days`, `${fmt(r.quiet_gaps)} failure-handling gaps`]))
      .on('mouseleave', () => tip.hide())
      .on('click', (e, r) => { dash.setParams({ file: r.file }); $('#ak-impact-card').scrollIntoView({ behavior: 'smooth', block: 'start' }) })
    const lab = [...rows].sort((a, b) => b.journeys * (b.commits_90d + 1) - a.journeys * (a.commits_90d + 1)).slice(0, W < 560 ? 4 : 8)
    const placed = []
    for (const r of lab) {
      const cx = x(Math.max(3, r.journeys)), cy = y(r.commits_90d)
      const name = r.file.split('/').pop().replace(/\.ts$/, '')
      const t = svg.append('text').attr('class', 'ak-lbl ak-halo').style('fill', 'var(--color-fg)').text(name)
      const w = t.node().getComputedTextLength()
      let tx = cx + rs(r.quiet_gaps) + 4, ty = cy + 4
      if (tx + w > W - m.r) tx = cx - rs(r.quiet_gaps) - 4 - w
      while (placed.some((p) => Math.abs(p.y - ty) < 12 && tx < p.x + p.w && tx + w > p.x)) ty += 12
      placed.push({ x: tx, y: ty, w })
      t.attr('x', tx).attr('y', ty)
    }
  }

  // impact finder
  const sugg = $('#ak-impact-sugg'), find = $('#ak-impact-find'), bars = $('#ak-impact-actors'), body = $('#ak-impact-table tbody')
  const st = AK.status('impact_files', 'journeys_index')
  AK.setState(find, st); AK.setState(bars, st)
  if (st !== 'ok') { if (st === 'error') AK.fail(bars); else bars.replaceChildren(); body.replaceChildren(); sugg.replaceChildren(); find.textContent = '—'; return }
  const files = dash.data('impact_files').data
  const jix = dash.data('journeys_index').data
  const sel = dash.params().file
  const q = impactQuery.trim().toLowerCase()
  const NOISE_FILE = /^(utils\/(errors|request-validation-error|logger)|lib\/logger|middleware\/)/
  const matches = (q ? files.filter((f) => f.file.toLowerCase().includes(q)) : [...files].filter((f) => !NOISE_FILE.test(f.file)).sort((a, b) => Number(b.journeys) - Number(a.journeys))).slice(0, 10)
  sugg.replaceChildren(...matches.map((f) => {
    const b = el('button', null, f.file)
    b.type = 'button'
    b.setAttribute('aria-pressed', String(f.file === sel))
    b.addEventListener('click', () => dash.setParams({ file: f.file }))
    return b
  }))
  const f = files.find((x) => x.file === sel)
  if (!f) { find.textContent = 'Pick a file above.'; bars.replaceChildren(); body.replaceChildren(); return }
  const ids = String(f.journey_ids).split(' ').filter(Boolean).map(Number)
  const js = ids.map((i) => jix[i]).filter(Boolean)
  find.replaceChildren(AK.mark(fmt(Number(f.journeys)), 'impact_files', 'journeys', { file: f.file }), (Number(f.journeys) === 1 ? ' journey runs through ' : ' journeys run through '), AK.mark(f.file, 'impact_files', 'file', { file: f.file }), ' (', AK.mark(f.component, 'impact_files', 'component', { file: f.file }), ').')
  const byActor = [...d3.rollup(js, (v) => v.length, (j) => j.actor)].sort((a, b) => b[1] - a[1])
  AK.bars(bars, byActor.map(([a, nn]) => ({ label: a, segs: [{ v: nn, color: actorColor(a) }], value: fmt(nn), tip: [a, `${fmt(nn)} journeys`] })), $('#ak-impact-card'))
  body.replaceChildren(...js.sort((a, b) => a.actor.localeCompare(b.actor) || a.journey.localeCompare(b.journey)).map((j) => {
    const tr = el('tr')
    const c1 = el('td', 'ak-code', j.journey)
    tr.append(c1, el('td', null, j.actor))
    return tr
  }))
}

// ---------------- Data ownership ----------------
function drawData() {
  const box = $('#ak-crud'), find = $('#ak-crud-find')
  if (!AK.ready(box, 'crud', 'components')) { find.textContent = '—'; AK.setState(find, AK.status('crud')); return }
  AK.setState(find, 'ok')
  const rows = dash.data('crud').data.map((r) => ({ ...r, C: Number(r.C), R: Number(r.R), U: Number(r.U), D: Number(r.D) }))
  const rank = new Map(dash.data('components').data.map((c, i) => [c.component, i]))
  const writers = d3.rollup(rows.filter((r) => r.C + r.U + r.D > 0), (v) => v.length, (r) => r.table)
  const tables = [...new Set(rows.map((r) => r.table))].sort((a, b) => (writers.get(b) || 0) - (writers.get(a) || 0) || a.localeCompare(b))
  const comps = [...new Set(rows.map((r) => r.component))].sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99))
  const cell = new Map(rows.map((r) => [r.table + '|' + r.component, r]))
  const maxW = d3.max(rows, (r) => r.C + r.U + r.D) || 1
  const lo = resolveColor('var(--color-bg)'), hi = resolveColor(dash.colors[0])
  const ramp = d3.interpolateRgb(lo, hi)
  box.style.gridTemplateColumns = `minmax(10rem, max-content) repeat(${comps.length}, 2.6rem)`
  const kids = [el('div')]
  for (const c of comps) kids.push(el('div', 'ak-ch', c))
  const tip = AK.tip($('#ak-crud-card'))
  for (const t of tables) {
    kids.push(el('div', 'ak-rh', t))
    for (const c of comps) {
      const r = cell.get(t + '|' + c)
      const d = el('div', 'ak-cell', r ? ['C', 'R', 'U', 'D'].filter((k) => r[k] > 0).join('') : '')
      if (r) {
        const wv = r.C + r.U + r.D
        if (wv) { const s = Math.sqrt(wv / maxW); d.style.background = ramp(0.15 + 0.85 * s); d.style.color = s > 0.55 ? 'var(--color-bg)' : 'var(--color-fg)' }
        else { d.style.background = 'var(--cds-chart-grid)'; d.style.color = 'var(--color-fg-muted)' }
        d.addEventListener('mousemove', (e) => tip.show(e, `${c} on ${t}`, [`${fmt(r.C)} creates, ${fmt(r.R)} reads`, `${fmt(r.U)} updates, ${fmt(r.D)} deletes`]))
        d.addEventListener('mouseleave', () => tip.hide())
      }
      kids.push(d)
    }
  }
  box.replaceChildren(...kids)
  const tw = dash.data('table_writers')
  const top = tw.status === 'ok' ? tw.data.slice(0, 3) : []
  const parts = ['The most widely written tables are ']
  top.forEach((t, i) => { if (i) parts.push(i === top.length - 1 ? ' and ' : ', '); parts.push(AK.mark(t.table, 'table_writers', 'table', { table: t.table }), ' (', AK.mark(fmt(t.writers), 'table_writers', 'writers', { table: t.table }), ' components)') })
  parts.push('. No single component owns them, so schema or invariant changes need every writer to agree. Candidates for an owning module that others call instead of writing directly.')
  find.replaceChildren(...parts)
}

// ---------------- Async & jobs ----------------
function drawAsync() {
  const box = $('#ak-events')
  if (AK.ready(box, 'event_flow')) {
    const rows = dash.data('event_flow').data.map((r) => ({ ...r, links: Number(r.links), event: r.event.replace(/Events?:/, ': ') }))
    const transports = [...new Set(rows.map((r) => r.transport))]
    const tColor = (t) => dash.colors[(transports.indexOf(t) * 2) % 8]
    AK.legend($('#ak-events-legend'), transports.map((t) => [t === 'in-process' ? 'In-process (same instance only)' : `${t} (crosses instances)`, tColor(t)]))
    AK.flow(box, {
      rows, keys: ['emitter', 'event', 'effect'], value: (r) => r.links, color: (r) => tColor(r.transport), height0: 520,
      rowTip: (r) => [`${fmt(r.links)} publish-to-listener links`, `Transport: ${r.transport}`],
      nodeTip: (k, nm, v) => [`${fmt(v)} links`],
    })
  }
  const jb = $('#ak-jobs')
  if (AK.ready(jb, 'jobs')) {
    const jobs = dash.data('jobs').data.map((j) => ({ ...j, every_seconds: Number(j.every_seconds) })).filter((j) => j.every_seconds).sort((a, b) => a.every_seconds - b.every_seconds || a.job.localeCompare(b.job))
    const W = Math.max(300, jb.clientWidth), rowH = 21
    jb.replaceChildren()
    const svg = d3.select(jb).append('svg').attr('width', '100%')
    const meas = svg.append('text').attr('class', 'ak-lbl')
    const lw = Math.min(W * 0.48, d3.max(jobs, (j) => { meas.text(j.job); return meas.node().getComputedTextLength() })) + 10
    meas.remove()
    const H = jobs.length * rowH + 34
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H)
    jb.style.minHeight = H + 'px'
    const x = d3.scaleLog([10, 7200], [lw + 6, W - 14])
    const ticks = [[15, '15s'], [30, '30s'], [60, '1m'], [900, '15m'], [3600, '1h']]
    for (const [v, l] of ticks) {
      svg.append('line').attr('x1', x(v)).attr('x2', x(v)).attr('y1', 4).attr('y2', H - 24).style('stroke', 'var(--cds-chart-grid)')
      svg.append('text').attr('class', 'ak-lbl').attr('x', x(v)).attr('y', H - 8).attr('text-anchor', 'middle').style('fill', 'var(--color-fg-muted)').text(l)
    }
    const tip = AK.tip(jb)
    jobs.forEach((j, i) => {
      const cy = 12 + i * rowH
      const t = svg.append('text').attr('class', 'ak-lbl').attr('x', lw).attr('y', cy).attr('dy', '0.35em').attr('text-anchor', 'end').style('fill', 'var(--color-fg)').text(j.job)
      AK.fit(t.node(), lw - 10)
      svg.append('line').attr('x1', lw + 6).attr('x2', x(j.every_seconds)).attr('y1', cy).attr('y2', cy).style('stroke', 'var(--cds-chart-grid)').style('stroke-width', 2)
      svg.append('circle').attr('cx', x(j.every_seconds)).attr('cy', cy).attr('r', 5).style('fill', j.systems ? dash.colors[0] : MUTED).style('cursor', 'default')
        .on('mousemove', (e) => tip.show(e, j.job, [j.purpose, `Every ${j.every_seconds >= 60 ? fmt(j.every_seconds / 60) + ' min' : fmt(j.every_seconds) + ' s'} (${fmt(Number(j.runs_per_hour))} runs per hour)`, j.systems ? `Can call ${j.systems}` : 'Database only', `Writes ${fmt(Number(j.tables_written))} tables`]))
        .on('mouseleave', () => tip.hide())
    })
  }
  const lb = $('#ak-jobload')
  if (AK.ready(lb, 'job_load')) {
    const rows = dash.data('job_load').data.filter((r) => !['Sentry'].includes(r.system))
    AK.bars(lb, rows.map((r) => ({ label: r.system, segs: [{ v: Number(r.runs_per_hour), color: dash.colors[0] }], value: `${fmt(Number(r.runs_per_hour))} runs/h`, tip: [r.system, `${fmt(Number(r.runs_per_hour))} job runs per hour can reach it`] })), $('#ak-jobload-card'))
  }
}

// ---------------- Resilience & security ----------------
function drawPosture() {
  const body = $('#ak-res-table tbody')
  if (AK.status('resilience') === 'ok') {
    const rows = dash.data('resilience').data
    body.replaceChildren(...rows.map((r) => {
      const tr = el('tr')
      const sites = Number(r.call_sites)
      const cov = (v, bad) => { const td = el('td'); const s = el('span', 'ak-cov', `${fmt(Number(v))} of ${fmt(sites)}`); if (bad) { s.style.background = CRIT; s.style.color = 'var(--color-bg)' } else if (Number(v) === 0) s.style.color = 'var(--color-fg-muted)'; td.append(s); return td }
      const rec = el('td'); const rs = el('span', 'ak-cov', r.recovery); if (r.recovery === 'None') { rs.style.background = CRIT; rs.style.color = 'var(--color-bg)' } else if (/^(Partial|Unknown)/.test(r.recovery)) rs.style.color = 'var(--color-warn)'; rec.append(rs)
      tr.append(el('td', null, r.system), el('td', 'ak-n', fmt(Number(r.journeys))), el('td', 'ak-n', fmt(sites)),
        cov(r.timeout, Number(r.timeout) < sites && !(r.timeout_exempt === true || r.timeout_exempt === 'true')), cov(r.retry, false), cov(r.idempotency, false), cov(r.circuit_breaker, false), rec,
        el('td', 'ak-n', r.quiet_sites == null || r.quiet_sites === '' ? '' : fmt(Number(r.quiet_sites))))
      return tr
    }))
  } else body.replaceChildren()

  // practices by component: share of functions per component that apply a control / exhibit a risk
  const pt = $('#ak-prac-table'), pf = $('#ak-prac-find')
  if (AK.status('practices') !== 'ok' || !dash.data('practices').data.length) { pt.tHead.replaceChildren(); pt.tBodies[0].replaceChildren(); pf.textContent = 'No practice signals in this build.'; return }
  const pr = dash.data('practices').data
  const concepts = [...d3.rollup(pr, (v) => ({ polarity: v[0].polarity, n: d3.sum(v, (r) => r.functions) }), (r) => r.concept)].sort((a, b) => (a[1].polarity === b[1].polarity ? b[1].n - a[1].n : a[1].polarity === 'control' ? -1 : 1)).map(([c, v]) => ({ concept: c, ...v }))
  const comps = [...d3.rollup(pr, (v) => Number(v[0].component_functions) || d3.max(v, (r) => r.functions), (r) => r.component)].sort((a, b) => b[1] - a[1])
  const cellOf = new Map(pr.map((r) => [`${r.component}|${r.concept}`, r]))
  const hr = el('tr'); hr.append(el('th', null, 'Component'), el('th', 'ak-n', 'Functions'), ...concepts.map((c) => { const th = el('th', null, c.concept); th.title = c.polarity === 'risk' ? 'Risk pattern' : 'Control'; if (c.polarity === 'risk') th.style.color = 'var(--color-bad)'; return th }))
  pt.tHead.replaceChildren(hr)
  pt.tBodies[0].replaceChildren(...comps.map(([comp, n]) => {
    const tr = el('tr'); tr.append(el('td', 'ak-code', comp), el('td', 'ak-n', fmt(n)))
    for (const c of concepts) {
      const r = cellOf.get(`${comp}|${c.concept}`), share = r && n ? r.functions / n : 0, td = el('td', 'ak-hc')
      if (r) {
        td.textContent = share >= 0.005 ? `${Math.round(share * 100)}%` : '<1%'
        td.style.background = `color-mix(in srgb, ${c.polarity === 'risk' ? 'var(--cds-chart-status-critical)' : 'var(--color-ok)'} ${Math.round(8 + Math.min(1, share * 2.5) * 52)}%, transparent)`
        td.title = `${comp}: ${fmt(r.functions)} of ${fmt(n)} functions ${c.polarity === 'risk' ? 'show' : 'apply'} ${c.concept}`
      } else td.append(el('span', 'ak-empty', '·'))
      tr.append(td)
    }
    return tr
  }))
  const risky = comps.map(([comp, n]) => ({ comp, n, sw: (cellOf.get(`${comp}|error-swallowed`)?.functions || 0) })).filter((x) => x.n >= 25 && x.sw).sort((a, b) => b.sw / b.n - a.sw / a.n)[0]
  const total = (c) => concepts.find((x) => x.concept === c)?.n || 0
  pf.replaceChildren(...(risky ? ['Errors are swallowed most densely in ', AK.mark(risky.comp, 'practices', 'component', { component: risky.comp }), ` (${Math.round((100 * risky.sw) / risky.n)}% of its functions). `] : []),
    `Across the codebase: ${fmt(total('timeout'))} functions set a timeout, ${fmt(total('circuit-breaker'))} use a circuit breaker, ${fmt(total('error-swallowed'))} swallow an error.`)
}

// ---------------- User impact ----------------
const CODE_NAME = { 400: 'bad request', 401: 'not signed in', 403: 'not allowed', 404: 'not found', 409: 'conflict with current state', 422: 'invalid input', 429: 'too many requests', 500: 'server error, deliberately returned', generic: 'unclassified server error (generic 500)' }
const INFRA = new Set(['cors', 'security-headers', 'body-parsing', 'observability', 'error-handling', 'other'])
// a thrown message as a reader would see it: literal text, a template with its variables elided, or a runtime value
const readableMessage = (m) => {
  const s = String(m || '').trim()
  if (/^['"]/.test(s)) return s.slice(1, -1)
  if (/^`/.test(s)) return s.slice(1, -1).replace(/\$\{[^}]*\}/g, '…')
  return 'Message built at runtime'
}
dash.calc('generic_error_sites', {
  inputs: ['generic_errors'],
  title: 'Generic error sites',
  description: 'Plain errors grouped by the function that throws them: distinct messages, an example, and the most journeys any of them reaches.',
  fn: (generic_errors) => {
    const m = new Map()
    for (const r of generic_errors) {
      const o = m.get(r.site) || { site: r.site, messages: 0, journeys: 0, example: r.message }
      o.messages += 1
      if (Number(r.journeys) > o.journeys) o.journeys = Number(r.journeys)
      if (/^['"`]/.test(o.example) === false && /^['"`]/.test(r.message)) o.example = r.message
      m.set(r.site, o)
    }
    return [...m.values()].sort((a, b) => b.journeys - a.journeys || b.messages - a.messages)
  },
})
const BP_LANES = ['User', 'Request', 'Checks', 'Logic', 'Data written', 'Waits on', 'After response', 'Can fail with', 'Findings']
const chipFor = (text, flag) => {
  const c = el('span', 'ak-chipx' + (flag === 'no-timeout' || flag === 'no-recovery' ? ' ak-bad' : flag === 'generic' ? ' ak-warn' : ''), text)
  if (flag === 'no-timeout') c.title = 'No timeout on this call'
  if (flag === 'no-recovery') c.title = 'No job retries this if it fails'
  if (flag === 'generic') c.title = 'Can end in a generic 500'
  return c
}
function drawUx() {
  // blueprint
  const box = $('#ak-bp'), tasks = $('#ak-bp-tasks')
  if (AK.ready(box, 'blueprint')) {
    const rows = dash.data('blueprint').data
    const names = [...new Set(rows.map((r) => r.task))]
    if (!names.length) { tasks.replaceChildren(); $('#ak-bp-legend').replaceChildren(); box.replaceChildren(el('p', 'ak-empty', 'No tasks were curated for this read-out. Add them to review.json under "tasks" and rebuild the atlas.')); box.style.gridTemplateColumns = '1fr' } else {
    const sel = names.includes(dash.params().bp_task) ? dash.params().bp_task : names[0]
    const groupOf = (t) => rows.find((r) => r.task === t && Number(r.order) === 0)?.actor || 'Other'
    const groups = d3.group(names, groupOf)
    tasks.replaceChildren(...[...groups].map(([g, ts]) => {
      const wrap = el('div', 'ak-taskgroup'); wrap.append(el('span', 'ak-taskgroup-label', g))
      for (const t of ts) { const b = el('button', 'ak-pill', t); b.type = 'button'; b.setAttribute('aria-pressed', String(t === sel)); b.addEventListener('click', () => dash.setParams({ bp_task: t })); wrap.append(b) }
      return wrap
    }))
    const lg = $('#ak-bp-legend')
    const withFindings = findingRows().length > 0
    lg.replaceChildren(chipFor('no timeout', 'no-timeout'), ' a wait with no timeout ', chipFor('no retry', 'no-recovery'), ' work nothing retries if it fails ', chipFor('generic', 'generic'), ' can end in an unclassified server error. Hover a status code for its meaning.',
      ...(withFindings ? [' Findings: verified problems in code this step runs through (red high, amber medium, grey low); click one to open it.'] : []))
    const lanes = withFindings ? BP_LANES : BP_LANES.filter((l) => l !== 'Findings')
    const rs = rows.filter((r) => r.task === sel)
    const steps = [...new Map(rs.map((r) => [Number(r.order), r])).values()].sort((a, b) => Number(a.order) - Number(b.order))
    box.style.gridTemplateColumns = `7.5rem repeat(${steps.length}, 9.5rem)`
    const kids = []
    const tip = AK.tip($('#ak-bp-card'))
    for (const lane of lanes) {
      if (lane === 'Request') { const l = el('div', 'ak-line', 'line of interaction'); kids.push(l) }
      if (lane === 'Checks') { const l = el('div', 'ak-line', 'line of visibility'); kids.push(l) }
      if (lane === 'Findings') { const l = el('div', 'ak-line', 'verified findings on this path'); kids.push(l) }
      kids.push(el('div', 'ak-bpl', lane))
      for (const st of steps) {
        const items = rs.filter((r) => Number(r.order) === Number(st.order) && r.lane === lane)
        const cell = el('div', 'ak-bpc' + (lane === 'User' ? ' ak-user' : lane === 'Request' ? ' ak-req' : ''))
        if (lane === 'Findings') { const fs = findingsOn(st.journey); const wrap = el('div', 'ak-codes'); wrap.append(...(fs.length ? fs.map(findingChip) : [el('span', 'ak-empty', 'none')])); cell.append(wrap); kids.push(cell); continue }
        if (lane === 'User') cell.append(el('div', null, st.step), el('span', 'ak-empty', st.actor))
        else if (!items.length) cell.append(el('span', 'ak-empty', lane === 'Waits on' ? 'nothing external' : lane === 'After response' ? 'nothing' : '—'))
        else for (const it of items) {
          if (lane === 'Can fail with') { const wrap = el('div', 'ak-codes'); String(it.item).split(' · ').forEach((code) => { const c = chipFor(code, code === 'generic' ? 'generic' : ''); if (CODE_NAME[code]) c.title = `${code}: ${CODE_NAME[code]}`; wrap.append(c) }); cell.append(wrap) }
          else if (lane === 'Request') cell.append(el('div', null, String(it.item).replace(/\//g, '/\u200b')))
          else if (lane === 'Waits on' || lane === 'After response') cell.append(chipFor(it.item, it.flag))
          else cell.append(el('div', null, it.item))
        }
        if (lane === 'Request') { cell.addEventListener('mousemove', (e) => tip.show(e, st.journey, ['Open it in the Journey explorer tab for the full path'])); cell.addEventListener('mouseleave', () => tip.hide()) }
        kids.push(cell)
      }
    }
    box.replaceChildren(...kids)
    }
  } else tasks.replaceChildren()

  // moments
  const mb = $('#ak-mom-table tbody'), mf = $('#ak-mom-find')
  const mst = AK.status('moments')
  AK.setState(mf, mst)
  if (mst === 'ok') {
    const rows = dash.data('moments').data.slice(0, 20)
    const noRec = noRecoverySystems()
    const top = rows[0]
    if (!top) { mf.replaceChildren('No journeys depend on third parties or move money.'); mb.replaceChildren() } else {
    const why = [top.money && 'money moves', top.customer_facing && 'a customer is waiting'].filter(Boolean)
    mf.replaceChildren('The journeys where a failure costs most. ', AK.mark(top.journey, 'moments', 'journey', { journey: top.journey }), ' ranks first', ...(why.length ? [': ', why.join(', ')] : []), ...(top.waits_on ? [why.length ? ', and it depends on ' : ': it depends on ', AK.mark(top.waits_on, 'moments', 'waits_on', { journey: top.journey }), ' during the request.'] : ['.']))
    const max = d3.max(rows, (r) => Number(r.score)) || 1
    mb.replaceChildren(...rows.map((r) => {
      const tr = el('tr')
      const jd = el('td', 'ak-code', r.journey)
      const tags = el('div')
      if (r.money === true || r.money === 'true') tags.append(chipFor('money'))
      if (r.customer_facing === true || r.customer_facing === 'true') { tags.append(' '); tags.append(chipFor('customer')) }
      jd.append(tags)
      const wd = el('td'); String(r.waits_on || '').split(', ').filter(Boolean).forEach((x, i) => { if (i) wd.append(' '); const bad = / \(no timeout\)$/.test(x); wd.append(chipFor(x.replace(/ \(no timeout\)$/, ''), bad ? 'no-timeout' : '')) })
      const ad = el('td'); String(r.after_response || '').split(', ').filter(Boolean).forEach((x, i) => { if (i) ad.append(' '); ad.append(chipFor(x, noRec.has(x) ? 'no-recovery' : '')) })
      const sd = el('td'); const tr2 = el('div', 'ak-track'); const bar = el('span', 'ak-stack'); bar.style.width = `${Math.max(0.3, (Number(r.score) / max) * 6)}rem`; const f = el('span'); f.style.flex = '1'; f.style.background = CRIT; f.style.opacity = 0.35 + 0.65 * (Number(r.score) / max); bar.append(f); tr2.append(bar, el('span', 'ak-val', fmt(Number(r.score)))); sd.append(tr2)
      tr.append(jd, el('td', null, r.actor), wd, ad, el('td', 'ak-n', fmt(Number(r.quiet_sites))), sd)
      return tr
    }))
    AK.tableHint(mb.closest('.ak-tablebox'))
    }
  } else { mb.replaceChildren(); mf.textContent = '—' }

  // error experience
  const eb = $('#ak-err')
  if (AK.ready(eb, 'error_experience')) {
    AK.legend($('#ak-err-legend'), [['Clear errors only', MUTED], ['Can end in a generic 500', 'var(--cds-chart-status-warning)'], ['No error paths found', MUTED, 0.35]])
    AK.bars(eb, dash.data('error_experience').data.map((r) => ({
      label: r.area, code: true,
      segs: [{ v: Number(r.can_hit_generic), color: 'var(--cds-chart-status-warning)' }, { v: Number(r.typed_only), color: MUTED }, { v: Number(r.no_errors_found), color: MUTED, opacity: 0.35 }],
      value: `${Math.round((100 * Number(r.can_hit_generic)) / Number(r.journeys))}% can go generic`,
      tip: [r.area, `${fmt(Number(r.typed_only))} clear errors only`, `${fmt(Number(r.can_hit_generic))} can end in a generic 500`, `${fmt(Number(r.no_errors_found))} with no error paths found`],
    })), $('#ak-err-card'))
  }
  const gb = $('#ak-gen-table tbody')
  if (AK.status('generic_error_sites') === 'ok') {
    gb.replaceChildren(...dash.data('generic_error_sites').data.map((r) => {
      const tr = el('tr'); tr.dataset.key = encodeURIComponent(r.site)
      const [fn, file] = String(r.site).split(' @ ')
      const sd = el('td'); sd.append(el('div', 'ak-code', fn), el('div', 'ak-pt-file', file))
      tr.append(sd, el('td', null, readableMessage(r.example)), el('td', 'ak-n', fmt(Number(r.messages))), el('td', 'ak-n', fmt(Number(r.journeys))))
      return tr
    }))
    AK.tableHint(gb.closest('.ak-tablebox'))
  } else gb.replaceChildren()

  // heuristics
  const hb = $('#ak-heur-table tbody')
  if (AK.status('heuristics') === 'ok') {
    const shade = (td, good, of, invert) => { if (!of) return; const share = good / of; const bad = invert ? share > 0 : share < 0.5; if (bad) { td.style.color = 'var(--color-bad)'; td.style.fontWeight = 'var(--cds-font-weight-medium)' } }
    hb.replaceChildren(...dash.data('heuristics').data.map((r) => {
      const tr = el('tr')
      const n = (v) => Number(v)
      const ds = el('td', 'ak-n', n(r.creating_writes) ? `${fmt(n(r.double_submit_protected))} of ${fmt(n(r.creating_writes))}` : '—'); shade(ds, n(r.double_submit_protected), n(r.creating_writes))
      const ar = el('td', 'ak-n', fmt(n(r.after_response_unrecovered))); shade(ar, n(r.after_response_unrecovered), n(r.journeys), true)
      const te = el('td', 'ak-n', n(r.with_errors) ? `${fmt(n(r.typed_errors))} of ${fmt(n(r.with_errors))}` : '—'); shade(te, n(r.typed_errors), n(r.with_errors))
      tr.append(el('td', 'ak-code', r.area), el('td', 'ak-n', fmt(n(r.journeys))), el('td', 'ak-n', fmt(n(r.creating_writes))), ds, ar, el('td', 'ak-n', fmt(n(r.with_errors))), te)
      return tr
    }))
  } else hb.replaceChildren()
}

// ---------------- Request pipeline ----------------
let mwKindFilter = null
function drawPipeline() {
  // coverage matrix
  const cb = $('#ak-cov tbody')
  if (AK.status('pipeline_coverage') === 'ok') {
    const accent = d3.color(resolveColor(dash.colors[0]))
    const tint = (share) => { const c = accent.copy(); c.opacity = 0.1 + 0.55 * share; return c.formatRgb() }
    const unguardedAreas = new Set(dash.data('open_routes').status === 'ok' ? dash.data('open_routes').data.filter((x) => x.verdict === 'No guard').map((x) => x.area) : [])
    const cols = ['authentication', 'authorization_pipeline', 'authorization_handler', 'validation_pipeline', 'validation_handler', 'rate_limit']
    cb.replaceChildren(...dash.data('pipeline_coverage').data.map((r) => {
      const n = Number(r.journeys), tr = el('tr')
      tr.append(el('td', 'ak-code', r.area), el('td', 'ak-n', fmt(n)))
      for (const c of cols) {
        const v = Number(r[c]), td = el('td', 'ak-n', fmt(v))
        const share = n ? v / n : 0
        if (v) td.style.background = tint(share)
        if ((c === 'authentication' || c === 'rate_limit') && v === 0 && unguardedAreas.has(r.area)) { td.style.background = CRIT; td.style.color = 'var(--color-bg)'; td.title = 'Routes here have no guard at all' }
        tr.append(td)
      }
      return tr
    }))
  } else cb.replaceChildren()

  // chain consistency
  const va = $('#ak-var-areas'), vf = $('#ak-var-find'), vt = $('#ak-var-table tbody')
  if (AK.ready(va, 'variants_per_area', 'chain_variants')) {
    const allVpa = dash.data('variants_per_area').data, vpa = allVpa.length > 12 ? allVpa.filter((r) => Number(r.journeys) >= 3) : allVpa
    const sel = dash.params().chain_area || vpa[0]?.area
    AK.setState(vf, 'ok')
    const late = vpa.reduce((a, r) => a + Number(r.rate_limit_after_auth), 0)
    if (!vpa.length) vf.replaceChildren('No route-level middleware chains found.')
    else vf.replaceChildren('Areas that apply the same controls through many different chains are harder to keep correct. ', AK.mark(vpa[0].area, 'variants_per_area', 'area', { area: vpa[0].area }), ' has ', AK.mark(fmt(Number(vpa[0].variants)), 'variants_per_area', 'variants', { area: vpa[0].area }), ' distinct chains.', late ? ' In red: chains that rate limit only after sign-in.' : '')
    AK.bars(va, vpa.map((r) => ({
      label: r.area, code: true,
      segs: [{ v: Number(r.variants), color: r.area === sel ? dash.colors[0] : MUTED }],
      value: AK.plural(Number(r.variants), 'chain'),
      tip: [r.area, `${fmt(Number(r.variants))} distinct chains over ${fmt(Number(r.journeys))} journeys`, Number(r.rate_limit_after_auth) ? `${fmt(Number(r.rate_limit_after_auth))} rate limit after sign-in` : ''],
      onClick: () => dash.setParams({ chain_area: r.area }),
    })), $('#ak-var-card'))
    vt.replaceChildren(...dash.data('chain_variants').data.filter((r) => r.area === sel).map((r) => {
      const tr = el('tr')
      tr.dataset.key = encodeURIComponent(r.area) + ',' + encodeURIComponent(r.chain)
      const c1 = el('td', 'ak-code' + (r.rate_limit_after_auth === true || r.rate_limit_after_auth === 'true' ? ' ak-flag' : ''), r.chain)
      c1.title = 'Example: ' + r.example
      tr.append(c1, el('td', 'ak-n', fmt(Number(r.journeys))))
      return tr
    }))
    AK.tableHint(vt.closest('.ak-tablebox'))
  } else { vt.replaceChildren(); vf.textContent = '—' }

  // inventory
  const mb = $('#ak-mw-table tbody')
  if (AK.status('middleware') === 'ok') {
    const rows = dash.data('middleware').data
    const kinds = [...new Set(rows.map((r) => (INFRA.has(r.kind) ? 'infrastructure' : r.kind)))]
    const lg = $('#ak-mw-legend')
    lg.replaceChildren(...kinds.map((k) => {
      const b = el('span'); b.className = 'ak-click'; b.setAttribute('role', 'button'); b.tabIndex = 0
      const sw = el('span', 'ak-sw'); sw.style.background = kindColor(k); if (mwKindFilter && mwKindFilter !== k) b.style.opacity = 0.45
      b.append(sw, k === 'infrastructure' ? 'Infrastructure (request ID, headers, CORS, parsing, logging, errors)' : KIND_LABEL[k] || k)
      const toggle = () => { mwKindFilter = mwKindFilter === k ? null : k; drawPipeline() }
      b.addEventListener('click', toggle); b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } })
      return b
    }))
    const max = d3.max(rows, (r) => Number(r.journeys)) || 1
    mb.replaceChildren(...rows.filter((r) => !mwKindFilter || r.kind === mwKindFilter || (mwKindFilter === 'infrastructure' && INFRA.has(r.kind))).map((r) => {
      const tr = el('tr')
      const kd = el('td'); const sw = el('span', 'ak-sw'); sw.style.background = kindColor(r.kind); sw.style.display = 'inline-block'; sw.style.marginRight = '4px'; kd.append(sw, KIND_LABEL[r.kind] || r.kind)
      const jd = el('td'); const wrap = el('div', 'ak-track'); const bar = el('span', 'ak-stack'); bar.style.width = `${Math.max(2, (Number(r.journeys) / max) * 6)}rem`; const fill = el('span'); fill.style.flex = '1'; fill.style.background = kindColor(r.kind); bar.append(fill); wrap.append(bar, el('span', 'ak-val', fmt(Number(r.journeys)))); jd.append(wrap)
      jd.title = r.areas
      tr.append(el('td', 'ak-code', r.middleware), kd, jd, el('td', null, r.scope), el('td', 'ak-n', fmt(Number(r.config_variants))), el('td', 'ak-code', r.implemented_in))
      return tr
    }))
    AK.tableHint(mb.closest('.ak-tablebox'))
  } else mb.replaceChildren()

  // open routes
  const ob = $('#ak-open-table tbody'), of = $('#ak-open-find')
  const ost = AK.status('open_routes', 'summary')
  AK.setState(of, ost)
  if (ost === 'ok') {
    const rows = dash.data('open_routes').data
    const VCOL = { 'No guard': CRIT, 'Verified in handler': dash.colors[1], 'Pre-sign-in, rate limited': dash.colors[3], 'Public content': MUTED }
    AK.legend($('#ak-open-legend'), Object.entries(VCOL).map(([k, c]) => [k, c]))
    of.replaceChildren('Every HTTP route whose chain has no sign-in middleware, with an assessment. ', AK.mark(fmt(Number(dash.data('summary').data[0].unguarded_routes)), 'summary', 'unguarded_routes', null), ' have no guard at all: no sign-in, no rate limit and no credential checked in the handler. The rest are public content, pre-sign-in endpoints that are rate limited, or verify a code, token or signature in the handler.')
    ob.replaceChildren(...rows.map((r) => {
      const tr = el('tr')
      const vd = el('td'); const sw = el('span', 'ak-sw'); sw.style.background = VCOL[r.verdict] || MUTED; sw.style.display = 'inline-block'; sw.style.marginRight = '4px'; vd.append(sw, r.verdict)
      if (r.verdict === 'No guard') vd.className = 'ak-flag'
      tr.append(el('td', 'ak-code', r.journey), vd, el('td', 'ak-code', r.route_middleware), el('td', null, r.note))
      return tr
    }))
    AK.tableHint(ob.closest('.ak-tablebox'))
  } else { ob.replaceChildren(); of.textContent = '—' }
}

// ---------------- Journey explorer ----------------
let journeyQuery = ''
function drawExplore() {
  const sugg = $('#ak-j-sugg'), title = $('#ak-j-title'), lanes = $('#ak-lanes')
  const st = AK.status('anatomy', 'journeys_index')
  AK.setState(lanes, st)
  AK.setState($('#ak-pipe'), st)
  if (st !== 'ok') { if (st === 'error') AK.fail(lanes); else lanes.replaceChildren(); sugg.replaceChildren(); $('#ak-pipe').replaceChildren(); return }
  const jix = dash.data('journeys_index').data
  const sel = dash.params().journey
  const q = journeyQuery.trim().toLowerCase()
  const mom = dash.data('moments').status === 'ok' ? dash.data('moments').data.map((r) => r.journey) : []
  const firstOfKind = [...d3.group(jix, (j) => j.kind).values()].map((v) => v[0].journey)
  const PICKS = [...new Set([...mom.slice(0, 5), ...firstOfKind])].slice(0, 8)
  const matches = q ? jix.filter((j) => j.journey.toLowerCase().includes(q)).slice(0, 12) : jix.filter((j) => PICKS.includes(j.journey))
  sugg.replaceChildren(...matches.map((j) => { const b = el('button', null, j.journey); b.type = 'button'; b.setAttribute('aria-pressed', String(j.journey === sel)); b.addEventListener('click', () => dash.setParams({ journey: j.journey })); return b }))
  const meta = jix.find((j) => j.journey === sel)
  if (!meta) { title.textContent = 'Pick a journey above.'; lanes.replaceChildren(); return }
  title.replaceChildren(AK.mark(meta.journey, 'journeys_index', 'journey', { journey: meta.journey }), ' · ', AK.mark(meta.actor, 'journeys_index', 'actor', { journey: meta.journey }))
  const onPath = findingsOn(sel), jf = $('#ak-j-findings')
  if (!findingRows().length) jf.replaceChildren()
  else if (!onPath.length) jf.replaceChildren('No verified finding sits on this path.')
  else jf.replaceChildren('Verified findings on this path: ', ...onPath.flatMap((p, i) => [findingChip(p), ` ${p.title}${i < onPath.length - 1 ? '; ' : ''}`]))
  const items = dash.data('anatomy').data.filter((r) => r.journey === sel)
  const byLane = d3.group(items, (r) => r.lane)
  const pipe = $('#ak-pipe')
  AK.setState(pipe, 'ok')
  const steps = (byLane.get('Pipeline') || []).sort((a, b) => Number(a.order) - Number(b.order))
  const kids = []
  const appSteps = steps.filter((r) => String(r.detail).startsWith('app · ') && !/error-handling/.test(r.detail))
  let appShown = false
  steps.forEach((r) => {
    const [scope, kind, ...cfg] = String(r.detail).split(' · ')
    if (appSteps.includes(r)) {
      if (appShown) return
      appShown = true
      if (kids.length) kids.push(el('span', 'ak-parrow', '→'))
      const st = el('div', 'ak-pstep ak-pstep-app')
      st.append(el('b', null, 'app-wide stack'), el('span', null, `${AK.plural(appSteps.length, 'step')} · same on every route`))
      st.title = appSteps.map((x) => x.item).join(' → ')
      kids.push(st)
      return
    }
    if (kids.length) kids.push(el('span', 'ak-parrow', '→'))
    const st = el('div', 'ak-pstep')
    st.style.borderLeftColor = kindColor(kind)
    st.append(el('b', null, r.item), el('span', null, `${scope} · ${KIND_LABEL[kind] || kind}`))
    if (cfg.length) st.title = cfg.join(' · ')
    kids.push(st)
  })
  if (steps.length) { kids.push(el('span', 'ak-parrow', '→')); const h = el('div', 'ak-pstep'); h.style.borderLeftColor = 'var(--color-fg)'; h.append(el('b', null, 'handler'), el('span', null, 'business logic')); kids.push(h) }
  pipe.replaceChildren(...(kids.length ? kids : [el('span', 'ak-empty', 'No request pipeline (scheduled job or server)')]))
  lanes.replaceChildren(...LANES.map((L) => {
    const col = el('div', 'ak-lane' + (L === 'After response' ? ' ak-async' : ''))
    let list = (byLane.get(L) || []).sort((a, b) => Number(a.order) - Number(b.order))
    let reads = []
    if (L === 'Data') { reads = list.filter((r) => r.detail === 'R'); list = list.filter((r) => r.detail !== 'R') }
    col.append(el('h3', null, L === 'Data' ? `Data · ${fmt(list.length)} written, ${fmt(reads.length)} read` : `${L}${list.length ? ' · ' + fmt(list.length) : ''}`))
    if (!list.length && !reads.length) col.append(el('span', 'ak-empty', 'None'))
    for (const r of list) { const it = el('div', 'ak-item'); it.append(el('b', null, r.item)); if (r.detail) it.append(el('span', null, r.detail)); col.append(it) }
    if (reads.length) { const it = el('div', 'ak-item ak-reads'); it.append(el('b', null, `Reads ${AK.plural(reads.length, 'table')}`), el('span', null, reads.map((r) => r.item).join(', '))); col.append(it) }
    return col
  }))
}

// ---------------- Findings ----------------
const SEV_RANK = { high: 3, medium: 2, low: 1 }
const findingRows = () => (dash.data('findings').status === 'ok' ? dash.data('findings').data : [])
// findings whose code a journey passes through, most severe first
const findingsOn = (journey) => {
  const pairs = dash.data('finding_journeys').status === 'ok' ? dash.data('finding_journeys').data : []
  return pairs.filter((p) => p.journey === journey).sort((a, b) => (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0) || a.finding.localeCompare(b.finding, undefined, { numeric: true }))
}
const goToFinding = (id) => { AK.showTab('findings'); const c = document.getElementById(`ak-f-${id}`); if (c) { c.scrollIntoView({ block: 'start' }); const d = c.querySelector('details'); if (d) d.open = true } }
const goToJourney = (j) => { dash.setParams({ journey: j }); AK.showTab('explore') }
const findingChip = (p) => {
  const c = el('span', `ak-chipx ak-fchip ak-sev-${p.severity}` + (p.severity === 'high' ? ' ak-bad' : p.severity === 'medium' ? ' ak-warn' : ''), p.finding)
  c.title = `${p.finding} (${p.severity}): ${p.title}. Open in the Findings tab`
  c.setAttribute('role', 'button'); c.tabIndex = 0
  c.addEventListener('click', () => goToFinding(p.finding)); c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToFinding(p.finding) } })
  return c
}
// fix order: severity then reach; a fix-amplifies edge (fixing `from` naively worsens `to`) puts `to` first
const fixOrder = (rows) => {
  const order = rows.slice().sort((a, b) => (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0) || b.journeys - a.journeys).map((r) => r.id)
  for (const r of rows) for (const i of r.interactions) if (i.kind === 'fix-amplifies' && i.from === r.id) { const f = order.indexOf(i.from), t = order.indexOf(i.to); if (t > f) { order.splice(t, 1); order.splice(f, 0, i.to) } }
  return order
}
function drawFindings() {
  const list = $('#ak-f-list'), find = $('#ak-f-find'), ord = $('#ak-f-order'), kpis = $('#ak-f-kpis')
  const rows = findingRows()
  const cov = dash.data('lens_coverage').status === 'ok' ? dash.data('lens_coverage').data : []
  AK.setState(list, 'ok')
  if (!rows.length) {
    kpis.replaceChildren(); ord.replaceChildren(); find.textContent = 'No verified findings in this build.'
    list.replaceChildren(el('p', 'ak-empty', 'Findings appear here once findings.json sits next to the atlas data (see the skill\'s references/findings.md). Then rebuild the atlas.'))
  } else {
    const sev = d3.rollup(rows, (v) => v.length, (r) => r.severity)
    const assumptions = [...new Map(rows.flatMap((r) => r.assumptions).map((a) => [a.text, a])).values()]
    const kpi = (label, v, alert) => { const d = el('div', 'ak-kpi'); d.append(el('span', 'ak-kpi-label', label), el('span', 'ak-num' + (alert ? ' ak-alert' : ''), fmt(v))); return d }
    kpis.replaceChildren(kpi('Findings', rows.length), kpi('High severity', sev.get('high') || 0, (sev.get('high') || 0) > 0), kpi('Medium', sev.get('medium') || 0), kpi('Low', sev.get('low') || 0),
      kpi('False beliefs behind them', assumptions.filter((a) => a.status === 'false').length), ...(cov.length ? [kpi('Lenses that ran clean', cov.filter((c) => !c.skipped && !c.candidates).length)] : []))
    const widest = rows.slice().sort((a, b) => b.journeys - a.journeys)[0], top = rows[0]
    const shared = assumptions.filter((a) => a.shared.length)
    find.replaceChildren('Start with ', AK.mark(top.id, 'findings', 'id', { id: top.id }), ` (${top.severity}): ${top.title}. `,
      ...(widest.id !== top.id ? ['The widest reach is ', AK.mark(widest.id, 'findings', 'id', { id: widest.id }), `, through ${AK.plural(widest.journeys, 'journey')}${widest.severity !== 'high' ? ` despite ${widest.severity} severity` : ''}. `] : []),
      shared.length ? `${AK.plural(shared.length, 'false belief')} sit${shared.length === 1 ? 's' : ''} under more than one finding.` : 'Each finding rests on its own assumption, so they can be fixed independently.')
    const byId = new Map(rows.map((r) => [r.id, r]))
    ord.replaceChildren(...fixOrder(rows).map((id) => {
      const r = byId.get(id), li = el('li')
      const together = r.interactions.filter((i) => i.kind === 'shares-fix').map((i) => (i.from === id ? i.to : i.from))
      li.append(findingChip({ finding: id, severity: r.severity, title: r.title }), ` ${r.title} `, el('span', 'ak-empty', `· ${r.severity} · ${AK.plural(r.journeys, 'journey')}${r.skill ? ` · ${r.skill}` : ''}${together.length ? ` · fix with ${together.join(', ')}` : ''}`))
      return li
    }))
    list.replaceChildren(...rows.map((r) => {
      const card = el('article', `ak-fcard ak-sev-${r.severity}`); card.id = `ak-f-${r.id}`
      const h = el('h3'); h.append(el('span', `ak-sev ak-sev-${r.severity}`, r.severity), `${r.id} · ${r.title}`); if (r.emergent) h.append(el('span', 'ak-chipx', 'emergent'))
      const meta = el('div', 'ak-fmeta')
      meta.append(el('span', null, `${AK.plural(r.journeys, 'journey')}${r.actors.length ? ` · ${r.actors.join(', ')}` : ''}`))
      if (r.skill) meta.append(el('span', null, `Fix with the ${r.skill} skill`))
      if (r.control_owner) meta.append(el('span', null, `Owner: ${r.control_owner}`))
      const grid = el('div', 'ak-fgrid')
      const cell = (label, ...content) => { const c = content.filter(Boolean); if (!c.length) return; const d = el('div'); d.append(el('b', null, label), ...c); grid.append(d) }
      cell('Rests on', ...r.assumptions.map((a) => el('span', null, `${a.status === 'false' ? 'False' : a.status === 'unverified' ? 'Unverified' : 'Holds'}: ${a.text}${a.shared.length ? ` (also ${a.shared.join(', ')})` : ''}`)))
      cell('Next', r.near_term && el('span', null, r.near_term))
      cell('Later', r.long_term && el('span', null, r.long_term))
      cell('Pre-mortem', r.pre_mortem && el('span', null, r.pre_mortem))
      cell('What would have caught it', r.next_control && el('span', null, r.next_control))
      cell('Cost of leaving it', r.opportunity_cost && el('span', null, r.opportunity_cost), r.deferred_cost_owner && el('span', 'ak-empty', `Paid by: ${r.deferred_cost_owner}`))
      if (r.loop) cell(`Loop (${r.loop.type}${r.loop.delay ? `, ${r.loop.delay}` : ''})`, el('span', null, r.loop.steps.join(' → ')))
      cell('Interacts with', ...r.interactions.map((i) => el('span', null, `${i.kind} ${i.from === r.id ? i.to : i.from}: ${i.how}`)))
      cell('Read first', ...r.refs.slice(0, 4).map((x) => el('span', 'ak-code', x)))
      const det = el('details'); det.append(el('summary', null, 'Reasoning, consequences and fix'), grid)
      const js = el('div', 'ak-sugg')
      for (const j of r.sample_journeys) { const b = el('button', null, j); b.type = 'button'; b.title = 'Open in the Journey explorer'; b.addEventListener('click', () => goToJourney(j)); js.append(b) }
      if (r.journeys > r.sample_journeys.length) js.append(el('span', 'ak-empty', `+${fmt(r.journeys - r.sample_journeys.length)} more`))
      card.append(h, meta, el('p', null, r.summary), det, ...(r.sample_journeys.length ? [js] : []))
      return card
    }))
  }
  // what was checked
  const lb = $('#ak-lens-table tbody'), lf = $('#ak-lens-find')
  if (!cov.length) { lf.textContent = 'No lens results in this build (lenses.json not found).'; lb.replaceChildren(); return }
  const clean = cov.filter((c) => !c.skipped && !c.candidates), raised = cov.filter((c) => c.findings.length), skipped = cov.filter((c) => c.skipped), open = d3.sum(cov, (c) => c.open)
  lf.replaceChildren(`${AK.plural(cov.length, 'lens', 'lenses')} raised ${fmt(d3.sum(cov, (c) => c.candidates))} candidates. `, `${fmt(raised.length)} led to findings; ${fmt(clean.length)} came back clean${clean.length ? ` (${clean.map((c) => c.lens).join(', ')})` : ''}. `,
    skipped.length ? `${fmt(skipped.length)} skipped as experimental. ` : '', open ? `${fmt(open)} candidates are still unreviewed.` : 'Every candidate has a verdict.')
  const SK = [...new Set(cov.map((c) => c.skill))]
  lb.replaceChildren(...cov.slice().sort((a, b) => SK.indexOf(a.skill) - SK.indexOf(b.skill) || b.findings.length - a.findings.length || b.candidates - a.candidates).map((c) => {
    const tr = el('tr'), n = (v, bad) => { const td = el('td', 'ak-n', v ? fmt(v) : ''); if (bad && v) td.style.color = 'var(--color-bad)'; return td }
    const name = el('td'); name.append(el('span', 'ak-code', c.lens)); if (c.tier === 'inventory') name.append(el('span', 'ak-empty', ' inventory')); name.title = c.question
    const fs = el('td', 'ak-n'); if (c.findings.length) fs.append(...c.findings.map((id) => { const f = findingRows().find((r) => r.id === id); return findingChip({ finding: id, severity: f?.severity || 'medium', title: f?.title || '' }) }))
    const why = el('td'); why.append(...(c.skipped ? [el('span', 'ak-empty', `skipped: ${c.skipped}`)] : !c.candidates ? [el('span', 'ak-empty', 'clean')] : c.reasons.map((x) => el('div', null, x))))
    tr.append(name, el('td', null, c.skill), n(c.candidates), fs, n(c.accepted), n(c.dismissed), n(c.open, true), why)
    return tr
  }))
}

// ---------------- wiring ----------------
AK.tabs.draw = { overview: drawOverview, findings: drawFindings, ux: drawUx, structure: drawStructure, pipeline: drawPipeline, risk: drawRisk, data: drawData, async: drawAsync, posture: drawPosture, explore: drawExplore }
document.querySelectorAll('.ak-tab').forEach((b) => b.addEventListener('click', () => AK.showTab(b.dataset.tab)))
$('#ak-ctx-core').addEventListener('change', (e) => dash.setParams({ ctx_core: e.target.checked }))
$('#ak-impact-q').addEventListener('input', (e) => { impactQuery = e.target.value; drawRisk() })
$('#ak-j-q').addEventListener('input', (e) => { journeyQuery = e.target.value; drawExplore() })
const start = location.hash.slice(1)
// the tab id doubles as an anchor; keep the header in view instead of jumping past it
if (start) addEventListener('load', () => setTimeout(() => scrollTo(0, 0)))
AK.tabs.active = AK.tabs.draw[start] ? start : 'overview'
document.querySelectorAll('.ak-page').forEach((p) => { p.hidden = p.id !== AK.tabs.active })
document.querySelectorAll('.ak-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === AK.tabs.active)))
// small or unusual codebases leave some views with nothing to show: say so instead of an empty frame
function markEmpty() {
  const page = document.getElementById(AK.tabs.active)
  if (!page) return
  page.querySelectorAll('table[data-source] tbody').forEach((tb) => {
    if (tb.children.length) return
    const tr = el('tr'), td = el('td', 'ak-empty', 'Nothing found in this codebase.'); td.colSpan = tb.closest('table').querySelectorAll('thead th').length || 1
    tr.append(td); tb.append(tr)
  })
  page.querySelectorAll('div[data-source]').forEach((box) => {
    if (box.childElementCount || box.textContent.trim() || box.closest('.ak-card')?.querySelector('.ak-empty')) return
    if (!box.dataset.source.split(' ').every((id) => dash.data(id).status === 'ok')) return
    box.classList.remove('dash-skeleton'); box.append(el('p', 'ak-empty', 'Nothing found in this codebase.'))
  })
}
const drawActive = AK.showTab
AK.showTab = (...a) => { drawActive(...a); markEmpty() }
dash.onData(() => { drawHeader(); AK.tabs.draw[AK.tabs.active]?.(); markEmpty() })
