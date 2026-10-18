// Official MCP registry ingest: GET /v0/servers?version=latest (cursor pagination). Read-only, one page at a time.
import { request } from '../net.mjs'
import { userAgent } from '../config.mjs'

export const REGISTRY = process.env.REGISTRY_URL || 'https://registry.modelcontextprotocol.io'
const META = 'io.modelcontextprotocol.registry/official'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** normalize one registry entry (hostile data: only plain fields are kept, strings are length-capped) */
export function normalizeEntry(e) {
  const s = e?.server || {}
  const m = e?._meta?.[META] || {}
  const str = (x, n = 2000) => (typeof x === 'string' ? x.slice(0, n) : null)
  const remotes = (Array.isArray(s.remotes) ? s.remotes : []).filter((r) => r && typeof r.url === 'string').slice(0, 8).map((r) => ({
    type: str(r.type, 40), url: str(r.url, 2000),
    headers: Array.isArray(r.headers) ? r.headers.slice(0, 20).map((h) => ({ name: str(h?.name, 200), isRequired: !!h?.isRequired, isSecret: !!h?.isSecret })) : undefined,
  }))
  const packages = (Array.isArray(s.packages) ? s.packages : []).filter((p) => p && typeof p.identifier === 'string').slice(0, 8).map((p) => ({
    registryType: str(p.registryType || p.registry_type || p.registry_name, 40), identifier: str(p.identifier, 300), version: str(p.version, 100),
    registryBaseUrl: str(p.registryBaseUrl, 300), transport: str(p.transport?.type, 40),
  }))
  return {
    id: str(s.name, 300), version: str(s.version, 100), title: str(s.title, 300), description: str(s.description, 4000),
    websiteUrl: str(s.websiteUrl, 1000), repository: s.repository && typeof s.repository.url === 'string' ? { url: str(s.repository.url, 1000), source: str(s.repository.source, 40) } : null,
    remotes, packages, status: str(m.status, 40) || 'active', isLatest: m.isLatest !== false,
    publishedAt: str(m.publishedAt, 40), updatedAt: str(m.updatedAt, 40), statusChangedAt: str(m.statusChangedAt, 40),
  }
}

/** all latest entries; onPage(count) for progress */
export async function fetchRegistry({ limit = 100, maxPages = 2000, spacingMs = 250, updatedSince = null, onPage, onBatch, cursor: startCursor = null } = {}) {
  const out = new Map()
  let cursor = startCursor, pages = 0
  const started = Date.now()
  do {
    const u = new URL('/v0/servers', REGISTRY)
    u.searchParams.set('limit', String(limit)); u.searchParams.set('version', 'latest')
    if (cursor) u.searchParams.set('cursor', cursor)
    if (updatedSince) u.searchParams.set('updated_since', updatedSince)
    let res, tries = 0
    for (;;) {
      try {
        res = await request({ url: u, headers: { accept: 'application/json', 'user-agent': userAgent() }, policy: { mode: 'crawl', timeoutMs: 30_000, maxBytes: 16_000_000 } })
        if (res.status >= 500 || res.status === 429) throw new Error(`registry HTTP ${res.status}`)
        break
      } catch (e) { if (++tries >= 8) throw e; await sleep(Math.min(30_000, 2000 * 2 ** tries)) }
    }
    if (res.status !== 200) throw new Error(`registry HTTP ${res.status}`)
    const j = res.json()
    if (!j || !Array.isArray(j.servers)) throw new Error('registry: unexpected body')
    const batch = []
    for (const e of j.servers) {
      const n = normalizeEntry(e)
      if (!n.id || !n.isLatest) continue
      batch.push(n)
      if (!onBatch) out.set(n.id, n)
    }
    pages++
    const next = j.metadata?.nextCursor || j.metadata?.next_cursor || null
    cursor = next && next !== cursor ? next : null
    onBatch?.(batch, cursor)
    onPage?.(onBatch ? pages * limit : out.size, pages)
    if (cursor) await sleep(spacingMs)
  } while (cursor && pages < maxPages)
  return { servers: [...out.values()], pages, ms: Date.now() - started, truncated: !!cursor }
}
