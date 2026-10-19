// HTTP API (no framework). createApi(ctx) → async (req, res) → true when handled. JSON, CORS read-only, cache headers.
//   GET  /api/health                  { ok, mode, lastEpoch, crawl, registry, anchor, dryPost }
//   GET  /api/stats                   servers tracked, tools hashed, skills, packages, changes 24 h, suspicious 24 h, anchors, last tx
//   GET  /api/feed?cursor=&label=&minLabel=behavior|suspicious&group=1&include=suppressed&limit=   recent changes, newest first
//                                     (cursor = last id seen; group=1 → one entry per server per epoch; suppressed noise hidden by default)
//   GET  /api/flags                   every on-chain flag with its current (possibly revised) label
//   GET  /api/server/<id>             registry entry + last probe + current items + timeline
//   GET  /api/item/<id>/history       every distinct version of one item + its changes (id URL-encoded)
//   GET  /api/items?kind=&cursor=&limit=  tracked subjects (server / skill / package): name, first seen, current hash, last change
//   GET  /api/anchors?limit=&before=  epochs: root, leafCount, post status, tx, explorer link, snapshot
//   GET  /api/proof?epoch=&leafKey=   leaf values, leaf hash, proof[], root (epoch optional: latest containing the leaf)
//   GET  /api/lookup?url=             MCP URL → server id (CLI)
//   POST /api/check {target}          live check (SSRF guard, rate-limited)
//   POST /mcp                         read-only MCP server (mcp-server.mjs)
//   GET  /snapshots/<epoch>.json, /snapshots/objects/<hash>.(json|txt)   (nginx serves these in production)
import { gunzipSync } from 'node:zlib'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mode, token, anchorConfig, dryPost, iso, link, publicUrl, VERSION, epochOf, CHAIN_ID } from './config.mjs'
import { proofOf, snapshotBytes } from './epoch.mjs'
import { checkTarget, forAgents, latestAnchorWith, UserError } from './check.mjs'
import { handleMcp, SELF_ID } from './mcp-server.mjs'
import { createLimiter } from './ratelimit.mjs'
import { objectsDir } from './objects.mjs'

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, accept',
  'access-control-max-age': '86400' }
const send = (res, code, body, cache = 'no-store', extra = {}) => {
  const s = body == null ? '' : JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, 'x-content-type-options': 'nosniff', ...CORS, ...extra })
  res.end(s)
}
async function readBody(req, max) {
  let n = 0; const chunks = []
  for await (const c of req) { n += c.length; if (n > max) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }) }
}

export function publicChange(c, { bodies = false, anchorOf = null } = {}) {
  if (!c) return null
  const a = anchorOf ? anchorOf(c.epoch) : null
  return {
    id: c.id, epoch: c.epoch, hour: iso(c.epoch * 3_600_000), at: iso(c.at), subject: c.subject, item: c.item_id, kind: c.kind, change: c.change,
    score: c.score, label: c.label, reasons: c.reasons || [], oldHash: c.old_hash, newHash: c.new_hash, diff: c.diff || null,
    ...(bodies ? { old: c.old_body ?? null, new: c.new_body ?? null } : {}),
    flag: c.flag_status ? { status: c.flag_status, tx: c.flag_tx, explorer: c.flag_tx ? link.tx(c.flag_tx) : null } : null,
    // first on-chain anchor at or after the change's epoch (the anchor that proves the new state); null until posted
    anchorEpoch: a?.epoch ?? null, anchorTx: a?.tx ?? null, anchorExplorer: a?.tx ? link.tx(a.tx) : null,
    volatile: !!c.volatile, suppressed: c.suppressed || null,
    // re-scored after a scorer fix: label/score above are current; the original values (and any on-chain flag) stay as history
    ...(c.orig_label ? { revisedLabel: c.label, revisedScore: c.score, originalLabel: c.orig_label, originalScore: c.orig_score, revisedNote: c.revised_note, revisedAt: iso(c.revised_at) } : {}),
  }
}
const epochView = (r) => r && ({
  epoch: r.epoch, hour: iso(r.epoch * 3_600_000), root: r.root, leafCount: r.leaf_count, status: r.post_status, onChain: r.post_status === 'confirmed',
  tx: r.tx, explorer: r.tx ? link.tx(r.tx) : null, block: r.block, postedAt: iso(r.posted_at), builtAt: iso(r.built_at),
  snapshot: `/snapshots/${r.epoch}.json`, snapshotSha256Gz: r.snapshot_sha256, error: r.post_status === 'failed' ? r.error : undefined,
  stats: r.stats ? { remotesProbed: r.stats.remotes?.probed, status: r.stats.remotes?.status, packages: r.stats.packages?.ok, skills: r.stats.skills?.skills, ms: r.stats.ms } : null,
})

export function createApi({ store, chain = null, log = console, trustProxy = process.env.TRUST_PROXY === '1', now = () => Date.now(), check = checkTarget }) {
  const ipOf = (req) => (trustProxy && (req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || req.socket?.remoteAddress || '?'
  const general = createLimiter({ rate: 4, burst: 120, now })
  const checks = createLimiter({ rate: 1 / 6, burst: 5, now })
  const mcpLimit = createLimiter({ rate: 1, burst: 30, now })
  const statsCache = { at: 0, v: null }
  const anchorStmt = store.db.prepare("SELECT epoch, tx FROM epochs WHERE epoch >= ? AND post_status = 'confirmed' ORDER BY epoch ASC LIMIT 1")
  const anchorMemo = new Map()
  /** confirmed anchors never change, so a hit is cached; a miss is re-read (the next post may land any minute) */
  const anchorOf = (epoch) => {
    if (anchorMemo.has(epoch)) return anchorMemo.get(epoch)
    const r = anchorStmt.get(epoch) || null
    if (r) { if (anchorMemo.size > 5000) anchorMemo.clear(); anchorMemo.set(epoch, r) }
    return r
  }
  const pc = (c, o = {}) => publicChange(c, { ...o, anchorOf })

  function stats() {
    if (statsCache.v && now() - statsCache.at < 30_000) return statsCache.v
    const db = store.db
    const one = (sql, ...a) => db.prepare(sql).get(...a)
    const items = store.itemCounts()
    const since = now() - 24 * 3_600_000
    const ch = store.changesSince(since)
    const last = store.lastConfirmed()
    const lastBuilt = store.lastBuilt()
    const v = {
      // registry entries: latest version only (version=latest + isLatest), one row per server name
      serversTracked: one("SELECT COUNT(*) n FROM servers WHERE removed_at IS NULL AND status = 'active'").n,
      serversDeprecated: one("SELECT COUNT(*) n FROM servers WHERE removed_at IS NULL AND status <> 'active'").n,
      serversWithRemote: one("SELECT COUNT(*) n FROM servers WHERE removed_at IS NULL AND remotes <> '[]'").n,
      remotes: one("SELECT COUNT(*) n FROM probes WHERE status <> 'needs_config'").n,
      serversReadable: one("SELECT COUNT(*) n FROM probes WHERE status = 'ok'").n,
      authRequired: one("SELECT COUNT(*) n FROM probes WHERE status = 'auth_required'").n,
      toolsHashed: items.tool || 0, prompts: items.prompt || 0, resources: items.resource || 0, skills: items.skill || 0, packages: items.package || 0,
      // changes24h: visible, non-volatile changes (flaps, partial listings and repeated volatile edits are counted in noise24h)
      changes24h: (ch.cosmetic || 0) + (ch.behavior || 0) + (ch.suspicious || 0), byLabel24h: { cosmetic: ch.cosmetic || 0, behavior: ch.behavior || 0, suspicious: ch.suspicious || 0 },
      noise24h: store.noiseSince(since),
      suspicious24h: ch.suspicious || 0, anchors: store.countConfirmed(), lastTx: last?.tx || null, lastTxExplorer: last?.tx ? link.tx(last.tx) : null,
      lastAnchoredEpoch: last?.epoch ?? null, lastBuiltEpoch: lastBuilt?.epoch ?? null, lastLeafCount: lastBuilt?.leaf_count ?? null,
    }
    statsCache.at = now(); statsCache.v = v
    return v
  }

  async function toolCall(name, args, { ip }) {
    if (name === 'check_server' || name === 'check_skill') {
      if (!checks.take(ip)) throw new UserError('rate limited: try again in a minute')
      if (typeof args.url !== 'string') throw new UserError('url is required')
      if (name === 'check_skill' && !/github(usercontent)?\.com\//i.test(args.url)) throw new UserError('check_skill takes a GitHub SKILL.md URL')
      if (name === 'check_server' && /github(usercontent)?\.com\/.*SKILL\.md/i.test(args.url)) throw new UserError('that is a skill URL: use check_skill')
      return forAgents(await check(store, args.url))
    }
    if (name === 'recent_changes') {
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 20))
      const label = ['cosmetic', 'behavior', 'suspicious'].includes(args.label) ? args.label : null
      const base = publicUrl() || ''
      const clean = (s) => String(s ?? '').replace(/[^\w.:/@#~-]/g, '_').slice(0, 160)
      return { changes: store.feed({ label, limit }).map((c) => ({ id: c.id, epoch: c.epoch, at: iso(c.at), subject: clean(c.subject), item: clean(c.item_id), kind: c.kind, change: c.change, score: c.score, label: c.label,
        reasons: (c.reasons || []).filter((r) => r.points).map((r) => r.code), page: `${base}/feed#${c.id}` })) }
    }
    if (name === 'get_proof') {
      if (typeof args.leafKey !== 'string' || !args.leafKey) throw new UserError('leafKey is required')
      const p = proofFor(args.leafKey, args.epoch)
      if (!p) throw new UserError('no anchored epoch contains that leaf')
      return { epoch: p.epoch, root: p.root, found: p.found, leafKey: p.leafKey, values: p.values, leafHash: p.leafHash, proof: p.proof, onChain: p.onChain, contract: anchorConfig().address, chainId: CHAIN_ID }
    }
    throw new UserError('unknown tool')
  }

  function proofFor(leafKey, epoch) {
    if (epoch != null && epoch !== '') {
      const e = Number(epoch)
      if (!Number.isSafeInteger(e) || e < 0) throw new UserError('epoch must be an integer')
      const row = store.getEpoch(e)
      if (!row?.root) return null
      const p = proofOf(e, leafKey)
      return p ? { ...p, status: row.post_status, onChain: row.post_status === 'confirmed', tx: row.tx } : null
    }
    const a = latestAnchorWith(store, leafKey)
    if (!a) return null
    const p = proofOf(a.row.epoch, leafKey)
    return { ...p, status: a.row.post_status, onChain: a.row.post_status === 'confirmed', tx: a.row.tx }
  }

  function serveSnapshot(res, path, req) {
    const m = path.match(/^\/snapshots\/(\d{1,9})\.json$/)
    if (m) {
      const gz = snapshotBytes(Number(m[1]))
      if (!gz) return send(res, 404, { error: 'no snapshot for that epoch' })
      const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600', ...CORS, ...(acceptsGzip ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}) })
      return res.end(acceptsGzip ? gz : gunzipSync(gz))
    }
    const o = path.match(/^\/snapshots\/objects\/([0-9a-f]{64})\.(json|txt)$/)
    if (o) {
      const f = join(objectsDir(), `${o[1]}.${o[2]}`)
      if (!existsSync(f)) return send(res, 404, { error: 'no such object' })
      res.writeHead(200, { 'content-type': o[2] === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', ...CORS })
      return res.end(readFileSync(f))
    }
    return send(res, 404, { error: 'not found' })
  }

  return async function api(req, res) {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname
    if (!(path.startsWith('/api/') || path === '/mcp' || path.startsWith('/snapshots/'))) return false
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return true }
    const ip = ipOf(req)
    try {
      if (path === '/mcp') {
        if (!mcpLimit.take(ip)) { send(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'rate limited' } }, 'no-store', { 'retry-after': String(mcpLimit.retryAfter(ip)) }); return true }
        let body = null
        if (req.method === 'POST') { try { body = await readBody(req, 64_000) } catch (e) { send(res, e.status || 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } }); return true } }
        const r = await handleMcp({ method: req.method, headers: req.headers, body, ip }, { call: toolCall })
        if (r.status === 202) { res.writeHead(202, CORS); res.end(); return true }
        send(res, r.status, r.body, 'no-store', r.headers || {})
        return true
      }
      if (!general.take(ip)) { send(res, 429, { error: 'rate limited' }, 'no-store', { 'retry-after': String(general.retryAfter(ip)) }); return true }
      if (path.startsWith('/snapshots/')) { if (req.method !== 'GET' && req.method !== 'HEAD') send(res, 405, { error: 'GET only' }); else serveSnapshot(res, path, req); return true }

      if (path === '/api/check') {
        if (req.method !== 'POST') { send(res, 405, { error: 'POST {"target": "…"}' }, 'no-store', { allow: 'POST, OPTIONS' }); return true }
        if (!checks.take(ip)) { send(res, 429, { error: 'rate limited: at most 10 checks per minute' }, 'no-store', { 'retry-after': String(checks.retryAfter(ip)) }); return true }
        const body = await readBody(req, 8_000)
        const r = await check(store, body?.target)
        send(res, 200, r)
        return true
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { error: 'GET only' }); return true }

      if (path === '/api/health') {
        const lb = store.lastBuilt(), lc = store.lastConfirmed()
        const a = anchorConfig()
        const t = token()
        send(res, 200, {
          ok: true, name: 'FRAYWICK', version: VERSION, mode: mode(), launchAt: t.launch_at ?? null, now: iso(now()), currentEpoch: epochOf(now()),
          lastEpoch: epochView(lb), lastAnchored: lc ? { epoch: lc.epoch, tx: lc.tx, explorer: lc.tx ? link.tx(lc.tx) : null } : null,
          crawl: store.kv('crawl_last'), registry: store.kv('registry_last'), crawler: store.kv('crawler_state'),
          anchor: { address: a.address, chainId: CHAIN_ID, explorer: a.address ? link.address(a.address) : null }, dryPost: dryPost(),
          optedOutHosts: store.optedOutHosts().length, selfLeaf: SELF_ID,
        })
        return true
      }
      if (path === '/api/stats') { send(res, 200, stats(), 'public, max-age=30'); return true }
      if (path === '/api/feed') {
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50))
        const cursor = Number(url.searchParams.get('cursor')) || Number.MAX_SAFE_INTEGER
        const label = url.searchParams.get('label')
        if (label && !['cosmetic', 'behavior', 'suspicious'].includes(label)) { send(res, 400, { error: 'label must be cosmetic, behavior or suspicious' }); return true }
        const minLabel = url.searchParams.get('minLabel')
        if (minLabel && !['behavior', 'suspicious'].includes(minLabel)) { send(res, 400, { error: 'minLabel must be behavior or suspicious' }); return true }
        const q = { label, minScore: minLabel === 'suspicious' ? 60 : minLabel === 'behavior' ? 20 : null, all: url.searchParams.get('include') === 'suppressed' }
        if (url.searchParams.get('group') === '1') {
          // one entry per server (subject) per epoch; rows of one observation are contiguous ids
          const groups = []
          let before = cursor, last = null, done = false
          while (groups.length <= limit && !done) {
            const rows = store.feed({ ...q, before, limit: 500 })
            if (rows.length < 500) done = true
            for (const c of rows) {
              before = c.id
              const key = `${c.subject}|${c.epoch}`
              if (!last || last.key !== key) {
                if (groups.length === limit) { done = true; break }
                last = { key, subject: c.subject, epoch: c.epoch, hour: iso(c.epoch * 3_600_000), at: iso(c.at), count: 0, score: 0, label: 'cosmetic', labels: { cosmetic: 0, behavior: 0, suspicious: 0 }, changes: [], more: 0, lastId: c.id }
                groups.push(last)
              }
              last.count++; last.labels[c.label]++; last.lastId = c.id
              if (c.score > last.score) { last.score = c.score; last.label = c.label }
              if (last.changes.length < 20) last.changes.push(pc(c)); else last.more++
            }
            if (!rows.length) done = true
          }
          const full = groups.length === limit
          for (const g of groups) { delete g.key }
          send(res, 200, { groups: groups.map(({ lastId, ...g }) => ({ ...g, anchorEpoch: anchorOf(g.epoch)?.epoch ?? null, anchorTx: anchorOf(g.epoch)?.tx ?? null })), next: full ? groups[groups.length - 1].lastId : null }, 'public, max-age=30')
          return true
        }
        const rows = store.feed({ ...q, before: cursor, limit })
        send(res, 200, { changes: rows.map((c) => pc(c)), next: rows.length === limit ? rows[rows.length - 1].id : null }, 'public, max-age=30')
        return true
      }
      if (path === '/api/flags') {
        // every change flagged on chain, including ones later re-scored or hidden as noise (honest history)
        const rows = store.db.prepare('SELECT * FROM changes WHERE flag_status IS NOT NULL ORDER BY id DESC LIMIT 500').all()
          .map((r) => ({ ...r, reasons: store.J(r.reasons), diff: store.J(r.diff), old_body: null, new_body: null }))
        send(res, 200, { flags: rows.map((c) => pc(c)) }, 'public, max-age=60')
        return true
      }
      if (path.startsWith('/api/server/')) {
        const id = decodeURIComponent(path.slice('/api/server/'.length))
        const s = store.getServer(id)
        if (!s) { send(res, 404, { error: 'unknown server' }); return true }
        const p = store.getProbe(id)
        const items = store.itemsOf(id).map((i) => ({ id: i.id, kind: i.kind, name: i.name, hash: i.hash, body: i.body, firstEpoch: i.first_epoch, lastEpoch: i.last_epoch, changedEpoch: i.changed_epoch, removedEpoch: i.removed_epoch }))
        const pk = (s.packages || []).map((x) => x.registryType === 'npm' || x.registryType === 'pypi' ? `${x.registryType}:${String(x.identifier).toLowerCase()}` : null).filter(Boolean)
        send(res, 200, {
          id, leafKey: id, registry: { version: s.version, title: s.title, description: s.description, website: s.website, repository: s.repository, remotes: s.remotes, packages: s.packages, status: s.status,
            publishedAt: s.published_at, updatedAt: s.updated_at, removedAt: iso(s.removed_at) },
          probe: p && { epoch: p.epoch, at: iso(p.at), url: p.url, status: p.status, era: p.era, protocolVersion: p.protocol_version, httpStatus: p.http_status, error: p.error, ms: p.ms,
            serverInfo: p.server_info, toolsHash: p.tools_hash, promptsHash: p.prompts_hash, resourcesHash: p.resources_hash, toolCount: p.tool_count, promptCount: p.prompt_count,
            resourceCount: p.resource_count, lastOkAt: iso(p.last_ok_at), lastOkEpoch: p.last_ok_epoch, truncated: !!p.truncated, partial: p.partial },
          items, timeline: store.changesOfSubject(id, 200).map((c) => pc(c)),
          packages: pk.map((k) => { const r = store.getPackage(k); return r && { key: k, version: r.version, maintainers: r.maintainers, integrity: r.integrity, status: r.status, timeline: store.changesOfSubject(k, 50).map((c) => pc(c)) } }).filter(Boolean),
        }, 'public, max-age=60')
        return true
      }
      const ih = path.match(/^\/api\/item\/(.+)\/history$/)
      if (ih) {
        const id = decodeURIComponent(ih[1])
        const it = store.getItem(id)
        if (!it) { send(res, 404, { error: 'unknown item' }); return true }
        send(res, 200, { id, subject: it.subject, kind: it.kind, name: it.name, current: { hash: it.hash, removedEpoch: it.removed_epoch },
          versions: store.versionsOf(id, 100).map((v) => ({ hash: v.hash, firstEpoch: v.first_epoch, lastEpoch: v.last_epoch, body: v.body })),
          changes: store.changesOfItem(id, 100).map((c) => pc(c, { bodies: true })) }, 'public, max-age=60')
        return true
      }
      if (path === '/api/items') {
        // tracked subjects (servers read at least once, skills, packages), ordered by id; cursor = last id of the previous page
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100))
        const cursor = String(url.searchParams.get('cursor') || '')
        const kind = url.searchParams.get('kind')
        if (kind && !['server', 'skill', 'package'].includes(kind)) { send(res, 400, { error: 'kind must be server, skill or package' }); return true }
        const parts = []
        if (!kind || kind === 'server') parts.push(`SELECT p.server_id id, 'server' kind, COALESCE(s.title, p.server_id) name, s.first_seen first_seen, p.tools_hash hash, p.tool_count n, p.last_ok_epoch last_epoch
          FROM probes p JOIN servers s ON s.id = p.server_id WHERE p.last_ok_epoch IS NOT NULL AND s.removed_at IS NULL`)
        if (!kind || kind === 'skill') parts.push(`SELECT key id, 'skill' kind, path name, first_seen, file_hash hash, NULL n, last_ok_epoch last_epoch FROM skills WHERE status = 'ok'`)
        if (!kind || kind === 'package') parts.push(`SELECT key id, 'package' kind, name, first_seen, maintainers_hash hash, NULL n, last_ok_epoch last_epoch FROM packages WHERE status = 'ok'`)
        const rows = store.db.prepare(`SELECT * FROM (${parts.join(' UNION ALL ')}) WHERE id > ? ORDER BY id LIMIT ?`).all(cursor, limit)
        const last = store.db.prepare('SELECT label, at, epoch, change FROM changes WHERE subject = ? ORDER BY id DESC LIMIT 1')
        const items = rows.map((r) => {
          const c = last.get(r.id)
          const name = r.kind === 'skill' ? (r.name.split('/').slice(-2, -1)[0] || r.name) : r.name
          return { id: r.id, kind: r.kind, name: String(name).slice(0, 120), firstSeen: iso(r.first_seen), hash: r.hash, toolCount: r.n ?? undefined, lastEpoch: r.last_epoch,
            lastChange: c ? { label: c.label, change: c.change, at: iso(c.at), epoch: c.epoch } : null }
        })
        send(res, 200, { items, next: rows.length === limit ? rows[rows.length - 1].id : null }, 'public, max-age=60')
        return true
      }
      if (path === '/api/anchors') {
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 48))
        const before = Number(url.searchParams.get('before')) || null
        send(res, 200, { contract: anchorConfig().address, chainId: CHAIN_ID, anchors: store.epochs(limit, before).map(epochView) }, 'public, max-age=60')
        return true
      }
      if (path === '/api/proof') {
        const leafKey = url.searchParams.get('leafKey')
        if (!leafKey) { send(res, 400, { error: 'leafKey is required' }); return true }
        const p = proofFor(leafKey, url.searchParams.get('epoch'))
        if (!p) { send(res, 404, { error: 'no anchored epoch contains that leaf' }); return true }
        send(res, p.found ? 200 : 404, { ...p, contract: anchorConfig().address, chainId: CHAIN_ID, explorer: p.tx ? link.tx(p.tx) : null }, p.onChain ? 'public, max-age=86400' : 'public, max-age=60')
        return true
      }
      if (path === '/api/lookup') {
        const u = String(url.searchParams.get('url') || '').trim().replace(/\/+$/, '')
        const p = u ? store.probesByUrl(u, u + '/')[0] : null
        send(res, p ? 200 : 404, p ? { url: p.url, serverId: p.server_id, leafKey: p.server_id } : { error: 'URL not tracked' }, 'public, max-age=300')
        return true
      }
      send(res, 404, { error: 'not found' })
      return true
    } catch (e) {
      if (e.user) { send(res, 400, { error: e.message }); return true }
      if (e.status) { send(res, e.status, { error: e.message }); return true }
      log.error?.(`api ${path}: ${e.stack || e.message}`)
      send(res, 500, { error: 'server error' })
      return true
    }
  }
}
