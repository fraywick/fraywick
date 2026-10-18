import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeProber } from '../probe.mjs'
import { makeAgents } from '../net.mjs'
import { sseEvents } from '../lib/mcp-client.mjs'
import { serve, allowLocal, resetNet, modernServer, legacyServer, oldSseServer, TOOLS_A } from './helpers.mjs'

after(resetNet)
const probeOf = () => makeProber({ deadline: Date.now() + 10_000, agents: makeAgents() })

test('SSE parser: comments, multi-line data, CRLF, event names', async () => {
  const chunks = [Buffer.from(': ping\r\n\r\nevent: endpoint\r\ndata: /m?s=1\r\n\r\ndata: {"a":\ndata: 1}\n\n'), Buffer.from('data: tail')]
  const out = []
  for await (const e of sseEvents((async function* () { yield* chunks })())) out.push(e)
  assert.deepEqual(out, [{ event: 'endpoint', data: '/m?s=1' }, { event: 'message', data: '{"a":\n1}' }, { event: 'message', data: 'tail' }])
})

test('modern (2026-07-28 stateless): discover + paginated tools/list + prompts', async () => {
  const srv = await serve(modernServer({ prompts: [{ name: 'p1', description: 'x' }] }))
  allowLocal()
  const r = await probeOf()(srv.url('/mcp'))
  assert.equal(r.status, 'ok'); assert.equal(r.era, 'modern'); assert.equal(r.protocolVersion, '2026-07-28')
  assert.deepEqual(r.tools.map((t) => t.name), TOOLS_A.map((t) => t.name))
  assert.equal(r.prompts.length, 1); assert.equal(r.resources, null)
  assert.equal(r.serverInfo.name, 'fake-modern')
  await srv.close()
})

test('legacy streamable HTTP: initialize → initialized → tools/list (SSE answers, session id, pagination) → DELETE', async () => {
  const h = legacyServer()
  const srv = await serve(h)
  allowLocal()
  const r = await probeOf()(srv.url('/mcp'))
  assert.equal(r.status, 'ok'); assert.equal(r.era, 'legacy'); assert.equal(r.protocolVersion, '2025-06-18')
  assert.equal(r.tools.length, 3)
  assert.deepEqual(h.log.filter((x) => x !== 'server/discover'), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE'])
  await srv.close()
})

test('legacy JSON answers', async () => {
  const srv = await serve(legacyServer({ sse: false }))
  allowLocal()
  const r = await probeOf()(srv.url('/mcp'))
  assert.equal(r.status, 'ok'); assert.equal(r.tools.length, 3)
  await srv.close()
})

test('deprecated HTTP+SSE transport (GET stream + endpoint event)', async () => {
  const srv = await serve(oldSseServer())
  allowLocal()
  const viaType = await probeOf()(srv.url('/sse'), { type: 'sse' })
  assert.equal(viaType.status, 'ok'); assert.equal(viaType.era, 'sse'); assert.equal(viaType.tools.length, 3)
  const viaFallback = await probeOf()(srv.url('/sse'))
  assert.equal(viaFallback.status, 'ok'); assert.equal(viaFallback.era, 'sse')
  await srv.close()
})

test('401 / 403 → auth_required (metadata only), 429 → rate_limited, junk → error', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/auth') { res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="https://x.example/.well-known/oauth-protected-resource"' }); return res.end() }
    if (req.url === '/forbidden') { res.writeHead(403); return res.end() }
    if (req.url === '/slow-down') { res.writeHead(429, { 'retry-after': '120' }); return res.end() }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>hello</html>')
  })
  allowLocal()
  const a = await probeOf()(srv.url('/auth'))
  assert.equal(a.status, 'auth_required'); assert.equal(a.httpStatus, 401); assert.equal(a.authScheme, 'Bearer'); assert.match(a.resourceMetadata, /oauth-protected-resource/)
  assert.equal((await probeOf()(srv.url('/forbidden'))).status, 'auth_required')
  const l = await probeOf()(srv.url('/slow-down'))
  assert.equal(l.status, 'rate_limited'); assert.equal(l.retryAfterS, 120)
  assert.equal((await probeOf()(srv.url('/junk'))).status, 'error')
  await srv.close()
})

test('probe of a private address is refused by the guard', async () => {
  resetNet()
  const r = await probeOf()('http://127.0.0.1:9/mcp')
  assert.equal(r.status, 'error')
  assert.match(r.error, /private_ip|not public/)
})
