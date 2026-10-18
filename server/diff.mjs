// Text diff (Myers O(ND)) for change records. Word-level for prose fields, line-level for schemas and SKILL.md.
// Output: [[op, text], …] with op '=' | '+' | '-'; long unchanged runs are trimmed to context.

export function myers(a, b, maxD = 2000) {
  const n = a.length, m = b.length, max = n + m
  if (!n && !m) return []
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace = []
  let found = false
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(Math.max(0, off - d - 1), off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[off + k] = x
      if (x >= n && y >= m) { found = true; break }
    }
    if (found) break
  }
  if (!found) return null
  const ops = []
  let x = n, y = m
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const t = trace[d], base = Math.max(0, off - d - 1), at = (kk) => t[off + kk - base]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const px = at(prevK), py = px - prevK
    while (x > px && y > py) { ops.push(['=', a[x - 1]]); x--; y-- }
    if (d > 0) { if (x === px) ops.push(['+', b[y - 1]]); else ops.push(['-', a[x - 1]]); x = px; y = py }
  }
  while (x > 0 && y > 0) { ops.push(['=', a[x - 1]]); x--; y-- }
  return ops.reverse()
}

function merge(ops, joiner) {
  const out = []
  for (const [op, t] of ops) {
    const last = out[out.length - 1]
    if (last && last[0] === op) last[1] += joiner + t
    else out.push([op, t])
  }
  // joiner between runs (line mode keeps line ends)
  return out
}

function trimContext(ops, ctx) {
  return ops.map(([op, t], i) => {
    if (op !== '=' || t.length <= ctx * 2 + 20) return [op, t]
    const first = i === 0, last = i === ops.length - 1
    if (first) return [op, '…' + t.slice(-ctx)]
    if (last) return [op, t.slice(0, ctx) + '…']
    return [op, t.slice(0, ctx) + ' … ' + t.slice(-ctx)]
  })
}

const words = (s) => String(s ?? '').split(/(\s+)/).filter((x) => x !== '')
const lines = (s) => String(s ?? '').split('\n')

/** word diff for prose (description, title) */
export function diffText(a, b, { ctx = 120, maxTokens = 20_000 } = {}) {
  const A = words(a), B = words(b)
  if (A.length + B.length > maxTokens) return diffLines(a, b, { ctx })
  const ops = myers(A, B)
  if (!ops) return [['-', String(a ?? '')], ['+', String(b ?? '')]]
  const out = []
  for (const [op, t] of ops) { const last = out[out.length - 1]; if (last && last[0] === op) last[1] += t; else out.push([op, t]) }
  return trimContext(out, ctx)
}

/** line diff (schemas, SKILL.md) */
export function diffLines(a, b, { ctx = 400, maxLines = 6000 } = {}) {
  const A = lines(a), B = lines(b)
  if (A.length + B.length > maxLines) return [['-', String(a ?? '').slice(0, 20_000)], ['+', String(b ?? '').slice(0, 20_000)]]
  const ops = myers(A, B)
  if (!ops) return [['-', String(a ?? '')], ['+', String(b ?? '')]]
  return trimContext(merge(ops, '\n'), ctx)
}

/** stable pretty JSON (sorted keys) for schema diffs */
export function prettySorted(v) {
  const sort = (x) => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x)
  return v === undefined ? '' : JSON.stringify(sort(v), null, 2)
}

/** field-by-field diff of two item views → { field: ops } for fields that differ */
export function diffViews(oldV, newV) {
  const out = {}
  const keys = new Set([...Object.keys(oldV || {}), ...Object.keys(newV || {})])
  for (const k of keys) {
    const a = oldV?.[k], b = newV?.[k]
    const sa = typeof a === 'string' || a === undefined ? a : prettySorted(a)
    const sb = typeof b === 'string' || b === undefined ? b : prettySorted(b)
    if (sa === sb) continue
    out[k] = typeof a === 'object' || typeof b === 'object' || k === 'text' ? diffLines(sa ?? '', sb ?? '') : diffText(sa ?? '', sb ?? '')
  }
  return out
}
