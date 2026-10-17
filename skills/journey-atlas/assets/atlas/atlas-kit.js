// Shared drawing kit for the architecture atlas (window.AK)
(() => {
  const AK = (window.AK = {})
  AK.fmt = d3.format(',')
  AK.$ = (s, root = document) => root.querySelector(s)
  AK.CRIT = 'var(--cds-chart-status-critical)'
  AK.MUTED = 'var(--cds-chart-muted)'
  AK.el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  AK.setState = (el, status) => el.classList.toggle('dash-skeleton', status === 'loading')
  AK.fail = (el) => { const d = AK.el('div', 'ak-fail'); d.append(AK.el('span', 'ak-dot'), 'Failed to load'); el.replaceChildren(d) }
  // combine statuses of several datasets: 'ok' | 'error' | 'loading'
  AK.status = (...ids) => {
    const ss = ids.map((id) => dash.data(id).status)
    return ss.every((s) => s === 'ok') ? 'ok' : ss.some((s) => s === 'error' || s === 'connect' || s === 'declined' || s === 'missing') ? 'error' : 'loading'
  }
  // gate a chart container on datasets; returns true when ready to draw
  AK.ready = (el, ...ids) => {
    const st = AK.status(...ids)
    AK.setState(el, st)
    if (st === 'error') { AK.fail(el); return false }
    if (st !== 'ok') { el.replaceChildren(); return false }
    return true
  }
  AK.mark = (text, source, field, where) => {
    const s = AK.el('span', 'ak-v', text)
    s.setAttribute('data-source', source)
    if (field) s.setAttribute('data-field', field)
    if (where) s.setAttribute('data-where', Object.entries(where).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&'))
    return s
  }
  AK.legend = (el, items) => el.replaceChildren(...items.map(([label, color, opacity]) => {
    const s = AK.el('span')
    const sw = AK.el('span', 'ak-sw'); sw.style.background = color; if (opacity != null) sw.style.opacity = opacity
    s.append(sw, label); return s
  }))
  // tooltip bound to a positioned container
  AK.tip = (box) => {
    let t = box.querySelector(':scope > .ak-tip')
    if (!t) { t = AK.el('div', 'ak-tip'); t.hidden = true; box.append(t) }
    return {
      show(event, head, lines) {
        t.replaceChildren(AK.el('div', 'ak-tip-k', head), ...lines.filter(Boolean).map((l) => AK.el('div', null, l)))
        t.hidden = false
        const b = box.getBoundingClientRect()
        let left = event.clientX - b.left + 14, top = event.clientY - b.top + 14
        if (left + t.offsetWidth > b.width - 6) left = Math.max(6, event.clientX - b.left - t.offsetWidth - 14)
        if (top + t.offsetHeight > b.height - 6) top = Math.max(6, event.clientY - b.top - t.offsetHeight - 14)
        t.style.left = left + 'px'; t.style.top = top + 'px'
      },
      hide() { t.hidden = true },
    }
  }
  AK.fit = (textEl, maxW) => {
    let s = textEl.textContent
    if (textEl.getComputedTextLength() <= maxW) return
    while (s.length > 4 && textEl.getComputedTextLength() > maxW) { s = s.slice(0, -1); textEl.textContent = s + '…' }
  }
  // stacked horizontal bars: rows [{label, code, segs:[{v,color,opacity}], value, tip:[head,...lines], onClick}]
  AK.bars = (el, rows, tipBox, opts = {}) => {
    const tip = AK.tip(tipBox || el.parentElement)
    const max = d3.max(rows, (r) => d3.sum(r.segs, (s) => s.v)) || 1
    el.replaceChildren(...rows.map((r) => {
      const row = AK.el('div', 'ak-row' + (r.onClick ? ' ak-click' : ''))
      if (opts.labelWidth) row.style.gridTemplateColumns = `minmax(0, ${opts.labelWidth}) minmax(0, 1fr)`
      const label = AK.el('span', 'ak-row-label' + (r.code ? ' ak-code' : ''), r.label)
      const track = AK.el('span', 'ak-track')
      const stack = AK.el('span', 'ak-stack')
      stack.style.width = `calc((100% - 7.5rem) * ${d3.sum(r.segs, (s) => s.v) / max})`
      for (const s of r.segs) { if (!s.v) continue; const seg = AK.el('span'); seg.style.flex = String(s.v); seg.style.background = s.color; if (s.opacity != null) seg.style.opacity = s.opacity; stack.append(seg) }
      track.append(stack, AK.el('span', 'ak-val', r.value))
      row.append(label, track)
      row.addEventListener('mousemove', (e) => tip.show(e, r.tip[0], r.tip.slice(1)))
      row.addEventListener('mouseleave', () => tip.hide())
      if (r.onClick) row.addEventListener('click', r.onClick)
      return row
    }))
  }
  // multi-column flow: each row is one path through keys[0] -> keys[1] -> ... with width value(row)
  AK.flow = (el, { rows, keys, value, color, height0 = 500, rowTip, nodeTip }) => {
    el.replaceChildren()
    if (!rows.length) return
    const W = Math.max(320, el.clientWidth)
    const n = keys.length
    const totals = keys.map((k) => d3.rollup(rows, (v) => d3.sum(v, value), (r) => r[k]))
    const order = totals.map((t) => [...t].sort((a, b) => b[1] - a[1]).map((x) => x[0]))
    const svg = d3.select(el).append('svg').attr('width', '100%')
    const meas = svg.append('text').attr('class', 'ak-lbl')
    const wOf = (s) => { meas.text(s); return meas.node().getComputedTextLength() }
    const labL = Math.min(W * 0.2, d3.max(order[0], wOf) || 0) + 10
    const labR = Math.min(W * 0.26, d3.max(order[n - 1], wOf) || 0) + 10
    meas.remove()
    const nodeW = 8, pad = 4, minSlot = 17
    const total = d3.sum(rows, value)
    const maxN = d3.max(order, (o) => o.length)
    const k = Math.max(0.05, (height0 - pad * (maxN - 1)) / total)
    const xs = order.map((_, i) => labL + (W - labL - labR - nodeW) * (i / (n - 1)))
    const pos = order.map((names, i) => {
      let y = 0; const m = new Map()
      for (const nm of names) { const h = Math.max(totals[i].get(nm) * k, 1.5), slot = Math.max(h, minSlot); m.set(nm, { y0: y + (slot - h) / 2, h, cy: y + slot / 2, acc: 0 }); y += slot + pad }
      return { m, H: y - pad }
    })
    const H = d3.max(pos, (p) => p.H) + 8
    pos.forEach((p) => { const off = (H - p.H) / 2; for (const v of p.m.values()) { v.y0 += off; v.cy += off } })
    const idx = order.map((o) => new Map(o.map((nm, i) => [nm, i])))
    const R = rows.map((r) => ({ ...r, _v: value(r) }))
    for (let c = 0; c < n; c++) {
      const sorted = [...R].sort((a, b) => (c > 0 ? idx[c - 1].get(a[keys[c - 1]]) - idx[c - 1].get(b[keys[c - 1]]) : 0) || (c < n - 1 ? idx[c + 1].get(a[keys[c + 1]]) - idx[c + 1].get(b[keys[c + 1]]) : 0))
      for (const r of sorted) { const nd = pos[c].m.get(r[keys[c]]); r['_y' + c] = nd.y0 + nd.acc + (r._v * k) / 2; nd.acc += r._v * k }
    }
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H)
    el.style.minHeight = H + 'px'
    const tip = AK.tip(el)
    const g = svg.append('g')
    const segs = []
    for (let c = 0; c < n - 1; c++) for (const r of R) segs.push({ r, c })
    const curve = (x0, y0, x1, y1) => { const xm = (x0 + x1) / 2; return `M${x0},${y0}C${xm},${y0} ${xm},${y1} ${x1},${y1}` }
    const paths = g.selectAll('path').data(segs).join('path')
      .attr('d', (s) => curve(xs[s.c] + nodeW, s.r['_y' + s.c], xs[s.c + 1], s.r['_y' + (s.c + 1)]))
      .attr('fill', 'none').attr('stroke-width', (s) => Math.max(1, s.r._v * k))
      .style('stroke', (s) => color(s.r)).attr('stroke-opacity', 0.5)
    const emph = (pred) => paths.attr('stroke-opacity', (s) => (pred(s.r) ? 0.9 : 0.06))
    const reset = () => { paths.attr('stroke-opacity', 0.5); tip.hide() }
    paths.on('mousemove', (e, s) => { emph((r) => r === s.r); tip.show(e, keys.map((kk) => s.r[kk]).join(' → '), rowTip(s.r)) }).on('mouseleave', reset)
    for (let c = 0; c < n; c++) {
      const grp = svg.append('g').selectAll('g').data(order[c]).join('g')
        .on('mousemove', (e, nm) => { emph((r) => r[keys[c]] === nm); tip.show(e, nm, nodeTip ? nodeTip(keys[c], nm, totals[c].get(nm)) : [AK.fmt(totals[c].get(nm))]) })
        .on('mouseleave', reset)
      grp.append('rect').attr('x', xs[c]).attr('width', nodeW).attr('y', (nm) => pos[c].m.get(nm).y0).attr('height', (nm) => pos[c].m.get(nm).h).attr('rx', 2).style('fill', 'var(--color-fg-muted)')
      const t = grp.append('text').attr('class', c > 0 && c < n - 1 ? 'ak-lbl ak-halo' : 'ak-lbl').attr('y', (nm) => pos[c].m.get(nm).cy).attr('dy', '0.35em').style('fill', 'var(--color-fg)').text((nm) => nm)
      if (c === 0) t.attr('x', xs[c] - 6).attr('text-anchor', 'end').each(function () { AK.fit(this, labL - 10) })
      else if (c === n - 1) t.attr('x', xs[c] + nodeW + 6).each(function () { AK.fit(this, labR - 10) })
      else t.attr('x', xs[c] + nodeW + 4).each(function () { AK.fit(this, (xs[c + 1] - xs[c]) * 0.55) })
    }
  }
  AK.plural = (n, one, many) => `${AK.fmt(n)} ${n === 1 ? one : (many || one + 's')}`
  // tells the reader a capped table scrolls, and fades its last visible row until they reach the end
  AK.tableHint = (box) => {
    let cap = box.nextElementSibling
    if (!cap || !cap.classList.contains('ak-count')) { cap = AK.el('p', 'ak-count'); box.after(cap) }
    const sync = () => box.classList.toggle('ak-more', box.scrollTop + box.clientHeight < box.scrollHeight - 4)
    const over = box.scrollHeight > box.clientHeight + 4
    cap.textContent = over ? 'Scroll the table for more rows' : ''
    cap.hidden = !over
    sync()
    if (!box.dataset.hint) { box.dataset.hint = '1'; box.addEventListener('scroll', sync) }
  }
  // tabs
  AK.tabs = { active: null, draw: {} }
  AK.showTab = (id, fromHash) => {
    document.querySelectorAll('.ak-page').forEach((p) => { p.hidden = p.id !== id })
    document.querySelectorAll('.ak-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)))
    AK.tabs.active = id
    if (!fromHash) dash.setLink(id)
    AK.tabs.draw[id]?.()
    // with the tabs pinned, a switch made further down the page lands at the top of the new tab
    const nav = document.querySelector('.ak-tabs'), page = document.getElementById(id)
    if (nav && page && !fromHash) {
      nav.parentElement.style.setProperty('--ak-tabs-h', nav.offsetHeight + 'px')
      if (page.getBoundingClientRect().top < nav.getBoundingClientRect().bottom) page.scrollIntoView({ block: 'start' })
    }
  }
})()
