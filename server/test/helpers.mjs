// Test helpers: local fake servers (allow-listed in the SSRF guard), temp data dirs.
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _testAllow, _setResolver } from '../net.mjs'

export function tempDir() { return mkdtempSync(join(tmpdir(), 'fraywick-test-')) }

/** start an http server on 127.0.0.1; fake host names resolve to it */
export async function serve(handler) {
  const srv = createServer(handler)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  return { port, url: (path = '/', host = 'mcp.fake-host.dev') => `http://${host}:${port}${path}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) }) }
}
export function allowLocal(map = {}) {
  _testAllow(['127.0.0.1'])
  _setResolver(async (host) => {
    if (map[host]) return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    if (host.endsWith('.fake-host.dev')) return [{ address: '127.0.0.1', family: 4 }]
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
  })
}
export function resetNet() { _testAllow([]); _setResolver(null) }

export async function body(req) {
  const c = []
  for await (const x of req) c.push(x)
  const s = Buffer.concat(c).toString('utf8')
  try { return JSON.parse(s) } catch { return s }
}

export const TOOLS_A = [
  { name: 'read_file', description: 'Read a file from the workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'search', description: 'Full-text search.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true }, _meta: { ignored: true } },
  { name: 'list_dir', description: 'List a directory.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
]

/** fake MCP servers of every era */
export function modernServer({ tools = TOOLS_A, pageSize = 2, prompts = null } = {}) {
  return async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    const m = await body(req)
    const pv = req.headers['mcp-protocol-version']
    const meta = m.params?._meta?.['io.modelcontextprotocol/protocolVersion']
    if (pv !== '2026-07-28' || meta !== pv || req.headers['mcp-method'] !== m.method) {
      res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32020, message: 'Header mismatch' } }))
    }
    const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', ...result } })) }
    if (m.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {}, ...(prompts ? { prompts: {} } : {}) }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fake-modern', version: '1' } } })
    if (m.method === 'tools/list') {
      const start = Number(m.params?.cursor || 0)
      const next = start + pageSize < tools.length ? String(start + pageSize) : undefined
      return reply({ tools: tools.slice(start, start + pageSize), ...(next ? { nextCursor: next } : {}), ttlMs: 1000, cacheScope: 'public' })
    }
    if (m.method === 'prompts/list' && prompts) return reply({ prompts })
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } }))
  }
}

/** legacy streamable HTTP: initialize + session id, answers as SSE */
export function legacyServer({ tools = TOOLS_A, sse = true } = {}) {
  const sessions = new Set()
  const log = []
  const h = async (req, res) => {
    if (req.method === 'DELETE') { sessions.delete(req.headers['mcp-session-id']); log.push('DELETE'); res.writeHead(200); return res.end() }
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }
    const m = await body(req)
    log.push(m.method)
    if (m.method === 'initialize') {
      const sid = 'sess-' + Math.random().toString(36).slice(2)
      sessions.add(sid)
      return answer(res, m.id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake-legacy', version: '2' } }, { 'mcp-session-id': sid })
    }
    if (!sessions.has(req.headers['mcp-session-id'])) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id ?? null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } })) }
    if (m.id === undefined) { res.writeHead(202); return res.end() }
    if (m.method === 'tools/list') {
      const start = Number(m.params?.cursor || 0)
      return answer(res, m.id, { tools: tools.slice(start, start + 2), ...(start + 2 < tools.length ? { nextCursor: String(start + 2) } : {}) })
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } }))
  }
  function answer(res, id, result, headers = {}) {
    if (sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...headers })
      res.write(': keep-alive\n\n')
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hi' } })}\n\n`)
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`)
    } else { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result })) }
  }
  h.log = log
  return h
}

/** deprecated HTTP+SSE transport (2024-11-05) */
export function oldSseServer({ tools = TOOLS_A } = {}) {
  let stream = null
  return async (req, res) => {
    const u = new URL(req.url, 'http://x')
    if (req.method === 'GET' && u.pathname === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      stream = res
      res.write('event: endpoint\ndata: /messages?sessionId=abc\n\n')
      return
    }
    if (req.method === 'POST' && u.pathname === '/messages') {
      const m = await body(req)
      res.writeHead(202); res.end('Accepted')
      if (m.id === undefined) return
      const result = m.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-sse', version: '0' } } : m.method === 'tools/list' ? { tools } : null
      stream?.write(`event: message\ndata: ${JSON.stringify(result ? { jsonrpc: '2.0', id: m.id, result } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'x' } })}\n\n`)
      return
    }
    if (req.method === 'POST') { res.writeHead(405); return res.end('Method Not Allowed') }
    res.writeHead(404); res.end()
  }
}
