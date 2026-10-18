// Read-only MCP client: lists tools / prompts / resources of a remote server. Never calls a tool.
// Shared verbatim with cli/lib/mcp-client.mjs. The caller injects `http(opts)` (server: SSRF-guarded net.request; CLI: fetch).
//   http({ url, method, headers, body, stream: true }) → { status, headers, chunks(), load(), text(), close() }
// Era detection (spec 2026-07-28 "Backward Compatibility"):
//   1. modern: POST server/discover with MCP-Protocol-Version 2026-07-28, Mcp-Method and _meta. A result or a recognized modern
//      error (-32020/-32021/-32022, or -32601 with HTTP 404) means a modern server; then tools/list (+ prompts/resources) statelessly.
//   2. legacy streamable HTTP: initialize → notifications/initialized → *list with Mcp-Session-Id → DELETE the session.
//   3. deprecated HTTP+SSE (2024-11-05): GET → `endpoint` event → POST to it, answers arrive on the GET stream.
// 401/403 anywhere → status auth_required (we never send credentials); 402 (paywalled, e.g. x402) too — we never pay.
// 429 → rate_limited (+ retry-after).
export const MODERN = '2026-07-28'
export const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const MODERN_ERRORS = new Set([-32020, -32021, -32022])
const MAX_PAGES = 25, MAX_ITEMS = 2000

export class ProbeError extends Error {
  constructor(status, msg, extra = {}) { super(msg); this.status = status; Object.assign(this, extra) }
}

/** SSE parser over an async iterator of byte chunks → yields { event, data } */
export async function* sseEvents(chunks) {
  const dec = new TextDecoder()
  let buf = '', data = [], event = 'message'
  const flush = function* () { if (data.length) { yield { event, data: data.join('\n') } } data = []; event = 'message' }
  const line = function* (l) {
    if (l === '') { yield* flush(); return }
    if (l.startsWith(':')) return
    const k = l.indexOf(':')
    const field = k < 0 ? l : l.slice(0, k)
    let val = k < 0 ? '' : l.slice(k + 1)
    if (val.startsWith(' ')) val = val.slice(1)
    if (field === 'data') data.push(val)
    else if (field === 'event') event = val || 'message'
  }
  for await (const c of chunks) {
    buf += dec.decode(c, { stream: true })
    let i
    while ((i = buf.search(/\r\n|\r|\n/)) >= 0) {
      if (buf[i] === '\r' && i === buf.length - 1) break   // a CR at the chunk end may be the first half of CRLF
      const l = buf.slice(0, i)
      buf = buf.slice(i + (buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1))
      yield* line(l)
    }
    if (buf.length > 4_000_000) throw new Error('SSE line too long')
  }
  buf += dec.decode()
  if (buf) for (const l of buf.split(/\r\n|\r|\n/)) yield* line(l)
  yield* flush()
}

const ctype = (res) => String(res.headers['content-type'] || '').toLowerCase()
const header = (res, name) => { const v = res.headers[name.toLowerCase()]; return Array.isArray(v) ? v[0] : v }

/** read one JSON-RPC answer (by id) from a JSON or SSE response */
async function readAnswer(res, id) {
  if (ctype(res).includes('text/event-stream')) {
    try {
      for await (const ev of sseEvents(res.chunks())) {
        if (ev.event !== 'message') continue
        let m
        try { m = JSON.parse(ev.data) } catch { continue }
        for (const x of Array.isArray(m) ? m : [m]) if (x && x.id === id && (x.result !== undefined || x.error !== undefined)) return x
      }
    } finally { res.close() }
    throw new ProbeError('error', 'SSE stream ended without an answer')
  }
  await res.load()
  const text = res.text()
  let m
  try { m = JSON.parse(text) } catch { return { _raw: text.slice(0, 300) } }
  if (Array.isArray(m)) m = m.find((x) => x && x.id === id) || m[0]
  return m && typeof m === 'object' ? m : { _raw: text.slice(0, 300) }
}

function authOrLimit(res, stage) {
  if (res.status === 401 || res.status === 403) {
    const wa = header(res, 'www-authenticate') || ''
    const rm = /resource_metadata="?([^",\s]+)/i.exec(wa)
    throw new ProbeError('auth_required', `HTTP ${res.status} at ${stage}`, { httpStatus: res.status, authScheme: wa.split(/\s/)[0] || null, resourceMetadata: rm ? rm[1].slice(0, 500) : null })
  }
  if (res.status === 402) throw new ProbeError('auth_required', `HTTP 402 at ${stage} (payment required)`, { httpStatus: 402, authScheme: 'payment' })
  if (res.status === 429) {
    const ra = Number(header(res, 'retry-after'))
    throw new ProbeError('rate_limited', `HTTP 429 at ${stage}`, { httpStatus: 429, retryAfterS: Number.isFinite(ra) ? ra : null })
  }
}

export function createProbe({ http, clientInfo = { name: 'fraywick', version: '1.0.0' }, userAgent }) {
  let n = 0
  const nextId = () => ++n
  const base = (extra = {}) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(userAgent ? { 'user-agent': userAgent } : {}), ...extra })
  const meta = () => ({ 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': clientInfo, 'io.modelcontextprotocol/clientCapabilities': {} })

  async function rpc(url, method, params, headers, stage) {
    const id = nextId()
    const res = await http({ url, method: 'POST', headers: headers(method, params), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), stream: true })
    if ([401, 402, 403, 429].includes(res.status)) { res.close(); authOrLimit(res, stage || method) }
    const sid = header(res, 'mcp-session-id') || null
    const status = res.status
    if (status === 202 || status === 204) { res.close(); return { status, sid, msg: null } }
    const msg = await readAnswer(res, id).catch((e) => { if (e instanceof ProbeError) throw e; throw new ProbeError('error', `${method}: ${e.code || e.message}`) })
    return { status, sid, msg }
  }

  async function listAll(call, method, key) {
    const out = []
    let cursor
    for (let page = 0; page < MAX_PAGES; page++) {
      const { status, msg } = await call(method, cursor ? { cursor } : {})
      if (!msg || msg.error || msg.result === undefined) {
        const code = msg?.error?.code
        throw new ProbeError('error', `${method}: ${msg?.error ? `JSON-RPC ${code}` : `HTTP ${status}`}`, { rpcCode: code ?? null, httpStatus: status })
      }
      const r = msg.result
      if (r.resultType && r.resultType !== 'complete') throw new ProbeError('error', `${method}: resultType ${String(r.resultType).slice(0, 40)}`)
      const items = Array.isArray(r[key]) ? r[key] : []
      for (const it of items) { if (it && typeof it === 'object') out.push(it); if (out.length >= MAX_ITEMS) return { items: out, truncated: true } }
      const next = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null
      if (!next || next === cursor) return { items: out, truncated: false }
      cursor = next
    }
    return { items: out, truncated: true }
  }

  /** lists everything the capabilities advertise; prompts/resources failures are recorded, not fatal */
  async function collect(call, caps, out) {
    const t = await listAll(call, 'tools/list', 'tools')
    out.tools = t.items; out.truncated = t.truncated
    for (const [cap, method, key] of [['prompts', 'prompts/list', 'prompts'], ['resources', 'resources/list', 'resources']]) {
      if (!caps || !caps[cap]) { out[key] = null; continue }
      try { out[key] = (await listAll(call, method, key)).items } catch (e) {
        if (e.status === 'auth_required' || e.status === 'rate_limited') throw e
        out[key] = null; out.partial = [...(out.partial || []), `${method}: ${e.message}`.slice(0, 200)]
      }
    }
    return out
  }

  async function modern(url) {
    const headers = (method, params) => base({ 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(params?.name ? { 'mcp-name': params.name } : {}) })
    const withMeta = (params) => ({ ...params, _meta: meta() })
    const d = await rpc(url, 'server/discover', withMeta({}), headers)
    const m = d.msg
    if (m?.result && typeof m.result === 'object' && (Array.isArray(m.result.supportedVersions) || m.result.capabilities)) {
      const sv = m.result.supportedVersions || []
      if (sv.length && !sv.includes(MODERN)) return { fallback: true, supported: sv }
      const out = { era: 'modern', protocolVersion: MODERN, capabilities: m.result.capabilities || {}, serverInfo: m.result._meta?.['io.modelcontextprotocol/serverInfo'] || null,
        instructions: typeof m.result.instructions === 'string' ? m.result.instructions : null }
      return collect((method, params) => rpc(url, method, withMeta(params), headers).then((r) => r), out.capabilities, out)
    }
    const code = m?.error?.code
    if (code === -32022) {
      const sv = Array.isArray(m.error.data?.supported) ? m.error.data.supported : []
      return { fallback: true, supported: sv }
    }
    if (MODERN_ERRORS.has(code) || (code === -32601 && d.status === 404)) {
      // modern server that rejected discover: list tools anyway, statelessly
      const out = { era: 'modern', protocolVersion: MODERN, capabilities: { tools: {} }, serverInfo: null, instructions: null }
      return collect((method, params) => rpc(url, method, withMeta(params), headers), { tools: {} }, out)
    }
    return { fallback: true, status: d.status }
  }

  async function legacy(url, supported) {
    const want = (supported || []).find((v) => LEGACY.includes(v)) || LEGACY[0]
    let sid = null, pv = null
    const headers = (method) => base({ ...(sid ? { 'mcp-session-id': sid } : {}), ...(pv && pv >= '2025-06-18' ? { 'mcp-protocol-version': pv } : {}) })
    const init = await rpc(url, 'initialize', { protocolVersion: want, capabilities: {}, clientInfo }, headers)
    const r = init.msg?.result
    if (!r || typeof r !== 'object' || init.msg?.error) {
      if ([400, 404, 405].includes(init.status) || init.msg?._raw !== undefined || !init.msg) return { fallback: true, status: init.status }
      throw new ProbeError('error', `initialize: ${init.msg?.error ? `JSON-RPC ${init.msg.error.code}` : `HTTP ${init.status}`}`, { httpStatus: init.status, rpcCode: init.msg?.error?.code ?? null })
    }
    sid = init.sid
    pv = typeof r.protocolVersion === 'string' ? r.protocolVersion.slice(0, 20) : want
    const out = { era: 'legacy', protocolVersion: pv, capabilities: r.capabilities || {}, serverInfo: r.serverInfo || null, instructions: typeof r.instructions === 'string' ? r.instructions : null }
    try {
      const nres = await http({ url, method: 'POST', headers: headers('notifications/initialized'), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), stream: true })
      nres.close()
    } catch {}
    try { return await collect((method, params) => rpc(url, method, params, headers), out.capabilities, out) }
    finally {
      if (sid) { try { (await http({ url, method: 'DELETE', headers: headers(), stream: true })).close() } catch {} }
    }
  }

  /** deprecated HTTP+SSE transport: one GET stream carries every answer */
  async function oldSse(url) {
    const res = await http({ url, method: 'GET', headers: { accept: 'text/event-stream', ...(userAgent ? { 'user-agent': userAgent } : {}) }, stream: true })
    if ([401, 402, 403, 429].includes(res.status)) { res.close(); authOrLimit(res, 'sse') }
    if (res.status !== 200 || !ctype(res).includes('text/event-stream')) { res.close(); throw new ProbeError('error', `not an MCP endpoint (HTTP ${res.status})`, { httpStatus: res.status }) }
    const it = sseEvents(res.chunks())[Symbol.asyncIterator]()
    const pending = new Map()
    let endpoint = null, done = false, failed = null
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done: d } = await it.next()
          if (d) break
          if (value.event === 'endpoint' && !endpoint) {
            const e = new URL(value.data.trim(), url)
            if (e.origin !== new URL(url).origin) throw new ProbeError('error', 'SSE endpoint on another origin (refused)')
            endpoint = e.toString(); pending.get('endpoint')?.(); continue
          }
          if (value.event !== 'message') continue
          let m; try { m = JSON.parse(value.data) } catch { continue }
          if (m && m.id != null && pending.has(m.id)) pending.get(m.id)(m)
        }
      } catch (e) { failed = e } finally { done = true; for (const f of pending.values()) f(null) }
    })()
    const wait = (key) => new Promise((resolve) => { if (done) return resolve(null); pending.set(key, (v) => { pending.delete(key); resolve(v) }) })
    try {
      if (!endpoint) await wait('endpoint')
      if (!endpoint) throw failed instanceof ProbeError ? failed : new ProbeError('error', 'SSE stream sent no endpoint event')
      const send = async (method, params, isNote) => {
        const id = isNote ? undefined : nextId()
        const p = isNote ? null : wait(id)
        const pr = await http({ url: endpoint, method: 'POST', headers: base(), body: JSON.stringify(isNote ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', id, method, params }), stream: true })
        pr.close()
        if ([401, 402, 403, 429].includes(pr.status)) authOrLimit(pr, method)
        if (isNote) return null
        const msg = await p
        if (!msg) throw failed instanceof ProbeError ? failed : new ProbeError('error', `${method}: SSE stream closed`)
        return { status: 200, msg }
      }
      const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo })
      const r = init.msg.result
      if (!r) throw new ProbeError('error', `initialize: JSON-RPC ${init.msg.error?.code ?? '?'}`)
      await send('notifications/initialized', null, true)
      const out = { era: 'sse', protocolVersion: typeof r.protocolVersion === 'string' ? r.protocolVersion.slice(0, 20) : '2024-11-05', capabilities: r.capabilities || {}, serverInfo: r.serverInfo || null,
        instructions: typeof r.instructions === 'string' ? r.instructions : null }
      return await collect((method, params) => send(method, params), out.capabilities, out)
    } finally { res.close(); await pump.catch(() => {}) }
  }

  /** probe(url, { type }) → result object (never throws for server-side problems) */
  return async function probe(url, { type = 'streamable-http', era = null } = {}) {
    const started = Date.now()
    const finish = (o) => ({ url, ...o, ms: Date.now() - started })
    try {
      if (type === 'sse') {
        try { return finish({ status: 'ok', ...(await oldSse(url)) }) } catch (e) {
          if (e instanceof ProbeError && e.status !== 'error') throw e
          // some "sse" remotes also speak streamable HTTP on the same URL
          const m = await modern(url).catch(() => ({ fallback: true }))
          if (!m.fallback) return finish({ status: 'ok', ...m })
          throw e
        }
      }
      if (era === 'legacy') {
        // cached era (spec: clients SHOULD cache it per origin): skip the modern probe, re-detect if it no longer works
        const l0 = await legacy(url)
        if (!l0.fallback) return finish({ status: 'ok', ...l0 })
      }
      const m = await modern(url)
      if (!m.fallback) return finish({ status: 'ok', ...m })
      const l = await legacy(url, m.supported)
      if (!l.fallback) return finish({ status: 'ok', ...l })
      return finish({ status: 'ok', ...(await oldSse(url)) })
    } catch (e) {
      if (e instanceof ProbeError) return finish({ status: e.status, error: e.message, httpStatus: e.httpStatus ?? null, retryAfterS: e.retryAfterS ?? null, authScheme: e.authScheme ?? null, resourceMetadata: e.resourceMetadata ?? null })
      return finish({ status: 'error', error: String(e.code && e.code !== 'network' ? `${e.code}: ${e.message}` : e.message || e).slice(0, 200) })
    }
  }
}
