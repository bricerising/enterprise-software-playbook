// A minimal stand-in for the dashboard runtime the atlas page was written against:
// data from the inlined JSON, calculated datasets, filter params and deep links.
;(() => {
  const DATA = JSON.parse(document.getElementById('atlas-data').textContent)
  const DEFAULTS = DATA.__params || {}
  const calcs = {}, subs = []
  let params = { ...DEFAULTS }, pending = false
  const notify = () => { for (const f of subs) { try { f() } catch (e) { console.error(e) } } }
  const schedule = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; notify() }) }
  window.dash = {
    data(id) {
      if (id in DATA) return { status: 'ok', data: DATA[id], meta: [] }
      const c = calcs[id]
      if (c) { if (!('value' in c)) c.value = c.fn(...c.inputs.map((i) => window.dash.data(i).data)); return { status: 'ok', data: c.value, meta: [] } }
      return { status: 'missing', data: [], meta: [] }
    },
    onData(fn) { subs.push(fn); try { fn() } catch (e) { console.error(e) } },
    calc(id, spec) { calcs[id] = { ...spec } },
    loader() {}, refresh() {},
    colors: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `var(--cds-chart-categorical-${i})`),
    params() { return params },
    setParams(p) { params = { ...params, ...p }; schedule() },
    resetParams() { params = { ...DEFAULTS }; schedule() },
    setLink(name) { try { history.replaceState(null, '', '#' + name) } catch {} },
  }
  let width = innerWidth
  addEventListener('resize', () => { if (Math.abs(innerWidth - width) > 24) { width = innerWidth; schedule() } })
})()
