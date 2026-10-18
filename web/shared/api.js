// FRAYWICK API client (same origin: /api, /snapshots, owned by SERVER) with tolerant normalizers.
// Fixture mode for local work only: ?fixture=1 (sticky for the tab, ?fixture=0 clears) reads /dev/fixtures/*.json, which is
// fake data that never ships; a banner says so. Production never falls back to fixtures.

const q = new URLSearchParams(location.search)
try {
  if (q.get('fixture') === '0') sessionStorage.removeItem('fw-fixture')
  else if (q.has('fixture')) sessionStorage.setItem('fw-fixture', '1')
} catch {}
export const FIXTURE = (() => { try { return sessionStorage.getItem('fw-fixture') === '1' } catch { return q.has('fixture') } })()

// dev only: ?api=https://fraywick.xyz reads a remote API (CORS is open); ?api= clears. Production is same-origin.
let API = ''
try {
  if (q.has('api')) { const v = q.get('api'); if (/^https:\/\/[a-z0-9.-]+$/i.test(v)) sessionStorage.setItem('fw-api', v); else sessionStorage.removeItem('fw-api') }
  API = sessionStorage.getItem('fw-api') || ''
} catch {}
export const apiBase = API

if (FIXTURE) {
  const b = document.createElement('div')
  b.className = 'fixture-banner'
  b.textContent = 'FIXTURE DATA · fake local numbers, not the live watchtower · ?fixture=0 to leave'
  document.addEventListener('DOMContentLoaded', () => document.body.append(b))
}

async function j(url, opts = {}) {
  if (API && /^\/(api|snapshots)\//.test(url)) url = API + url
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), opts.timeout || 15000)
  try {
    const r = await fetch(url, { cache: 'no-store', ...opts, signal: ctl.signal })
    let body = null
    try { body = await r.json() } catch {}
    if (!r.ok) { const e = new Error((body && (body.error || body.message)) || `${r.status}`); e.status = r.status; e.body = body; throw e }
    return body
  } finally { clearTimeout(t) }
}

// ── fixtures: relative epochs rebased so the newest fixture hour is the current hour ──
const FX_TOP = 1000
const nowEpoch = () => Math.floor(Date.now() / 3600e3)
function rebase(v, d) {
  if (Array.isArray(v)) return v.map((x) => rebase(x, d))
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'number' && /(^epoch$|Epoch$)/.test(k)) o[k] = x + d
      else if (typeof x === 'string' && /^19[67]\d-/.test(x)) o[k] = new Date(new Date(x).getTime() + d * 3600e3).toISOString()
      else if (k === 'snapshotURI' && typeof x === 'string') o[k] = x.replace(/(\d+)\.json$/, (_, n) => `${Number(n) + d}.json`)
      else o[k] = rebase(x, d)
    }
    return o
  }
  return v
}
const fxCache = {}
async function fx(name) {
  fxCache[name] ||= j(`/dev/fixtures/${name}.json`).then((x) => rebase(x, nowEpoch() - FX_TOP))
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 200))
  return structuredClone(await fxCache[name])
}

// ── normalizers ──────────────────────────────────────────────────────────
const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v))
const arr = (x, ...keys) => { if (Array.isArray(x)) return x; for (const k of keys) if (Array.isArray(x?.[k])) return x[k]; return [] }
export const LABELS = ['cosmetic', 'behavior', 'suspicious']
export function labelOf(c) {
  const l = String(c?.label || '').toLowerCase()
  if (LABELS.includes(l)) return l
  const s = num(c?.score)
  if (s == null) return null
  return s >= 60 ? 'suspicious' : s >= 20 ? 'behavior' : 'cosmetic'
}
function epochOfTime(t) { const d = new Date(t); return isNaN(d) ? null : Math.floor(d / 3600e3) }

const REASON = {
  removed: 'no longer listed', added: 'new', whitespace_or_case: 'whitespace or letter case only', hidden_unicode: 'hidden characters added',
  new_urls: 'new URLs / hosts', new_url_tunnel_or_ip: 'URL to a tunnel, paste or webhook service, or a raw IP', suspicious_params: 'new parameters that ask for sensitive data',
  shell_pipe: 'new shell pipe', description_jump: 'description length jump', input_schema_changed: 'input schema changed', output_schema_changed: 'output schema changed',
  annotations_widened: 'tool hints now allow side effects', text_changed: 'wording changed', new_version: 'new version', same_version_new_bytes: 'same version, different file bytes',
  maintainers_changed: 'maintainers changed', maintainers_replaced: 'every previous maintainer replaced', new_publisher: 'new publisher', cap: 'score cap',
}
export function normReasons(list) {
  return arr(list).map((r) => {
    if (typeof r === 'string') return { text: r }
    const code = r.code || r.id || null
    const base = r.text || r.reason || r.message || (code ? REASON[code] || code.replace(/_/g, ' ') : '')
    const detail = r.detail != null ? (typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)) : ''
    return { code, text: detail && !r.text ? `${base}: ${detail}` : base, weight: num(r.weight ?? r.points ?? r.score) }
  })
}
const kindOfKey = (k) => (String(k || '').startsWith('skill:') ? 'skill' : /^(npm|pypi):/.test(k || '') ? 'package' : 'server')

export function normChange(c) {
  if (!c) return null
  // itemId = the tracked thing (server / skill / package = the leaf); rawItem may be a tool-level id under it
  const rawItem = (typeof c.item === 'string' ? c.item : null) ?? c.itemId ?? c.item_id ?? null
  const itemId = c.subject ?? c.serverId ?? c.server_id ?? c.leafKey ?? c.key ?? c.item?.id ?? rawItem
  const toolFromId = rawItem && itemId && rawItem !== itemId && rawItem.startsWith(itemId) ? rawItem.slice(itemId.length).replace(/^[#:/|@]+/, '').replace(/^(tool|prompt|resource)[:/]/, '') : null
  const epoch = num(c.epoch ?? c.anchorEpoch ?? c.anchor_epoch) ?? epochOfTime(c.at ?? c.detectedAt ?? c.detected_at)
  const reasons = normReasons(c.reasons)
  return {
    raw: c,
    id: c.id ?? `${itemId}:${epoch}:${c.tool || ''}`,
    itemId,
    kind: ['server', 'skill', 'package'].includes(c.kind) ? c.kind : kindOfKey(itemId),
    itemKind: c.kind || null,
    name: c.name || c.title || itemId,
    tool: c.tool ?? c.toolName ?? c.tool_name ?? toolFromId ?? null,
    rawItem,
    change: c.change || c.type || c.kindOfChange || 'changed',
    label: labelOf(c),
    score: num(c.score),
    reasons,
    epoch,
    at: c.at || c.hour || c.detectedAt || c.detected_at || c.time || (epoch != null ? new Date(epoch * 3600e3).toISOString() : null),
    oldHash: c.oldHash ?? c.old_hash ?? c.before?.hash ?? null,
    newHash: c.newHash ?? c.new_hash ?? c.after?.hash ?? c.hash ?? null,
    tx: c.tx ?? c.txHash ?? c.anchorTx ?? c.anchor_tx ?? null,
    flagTx: c.flagTx ?? c.flag_tx ?? c.flag?.tx ?? null,
    flagStatus: c.flag?.status ?? null,
    before: c.before ?? c.old ?? null,
    after: c.after ?? c.new ?? null,
    diff: c.diff ?? null,
  }
}
export function normAnchor(a) {
  if (!a) return null
  const epoch = num(a.epoch)
  return { raw: a, epoch, root: a.root || null, leafCount: num(a.leafCount ?? a.leaf_count ?? a.leaves), tx: a.tx ?? a.txHash ?? a.tx_hash ?? null,
    explorer: a.explorer ?? a.txUrl ?? null, postedAt: a.postedAt ?? a.posted_at ?? null, snapshotURI: a.snapshotURI ?? a.snapshot_uri ?? a.snapshot ?? (epoch != null ? `/snapshots/${epoch}.json` : null),
    onChain: a.onChain ?? (a.status ? a.status === 'confirmed' : !!a.tx), dry: !!(a.dry ?? a.dryRun ?? /dry/.test(a.status || '')), status: a.status || (a.tx ? 'confirmed' : null) }
}
export function normItem(i) {
  if (!i) return null
  const id = i.id ?? i.key ?? i.leafKey ?? i.serverId ?? i.name
  return { raw: i, id, kind: i.kind || i.type || (String(id).startsWith('skill:') ? 'skill' : /^(npm|pypi):/.test(id) ? 'package' : 'server'), name: i.name || i.title || id,
    title: i.title || null, firstSeenEpoch: num(i.firstSeenEpoch ?? i.first_seen_epoch) ?? epochOfTime(i.firstSeen ?? i.first_seen), version: i.version || null }
}
export function normStats(s) {
  s = s || {}
  const pick = (...k) => { for (const x of k) { const v = x.split('.').reduce((o, p) => o?.[p], s); if (v != null) return num(v) } return null }
  return {
    raw: s,
    servers: pick('serversTracked', 'servers', 'servers_tracked', 'counts.servers'),
    tools: pick('toolsHashed', 'tools', 'tools_hashed', 'counts.tools'),
    skills: pick('skills', 'counts.skills'),
    packages: pick('packages', 'counts.packages'),
    authRequired: pick('auth_required', 'authRequired', 'counts.auth_required'),
    changes24h: pick('changes24h', 'changes_24h', 'changes.h24'),
    suspicious24h: pick('suspicious24h', 'suspicious_24h', 'changes.suspicious24h'),
    anchors: pick('anchors', 'anchorCount', 'anchor_count'),
    lastEpoch: pick('lastAnchoredEpoch', 'lastEpoch', 'last_epoch', 'latestEpoch', 'last.epoch', 'lastAnchor.epoch'),
    lastBuiltEpoch: pick('lastBuiltEpoch'),
    readable: pick('serversReadable'),
    lastRoot: s.lastRoot ?? s.last_root ?? s.last?.root ?? s.lastAnchor?.root ?? null,
    lastLeafCount: pick('lastLeafCount', 'last_leaf_count', 'last.leafCount', 'lastAnchor.leafCount'),
    lastTx: s.lastTx ?? s.last_tx ?? s.last?.tx ?? s.lastAnchor?.tx ?? null,
  }
}
export function normCheck(r) {
  r = r || {}
  const V = { match: 'unchanged', changed: 'changed', not_anchored: 'unknown' }
  let status = r.status || (r.verdict ? V[r.verdict] || 'error' : r.known === false ? 'unknown' : r.changed ? 'changed' : 'unchanged')
  const live = r.live || r.current || r.now || {}
  const anc = r.anchor || r.anchored || r.lastAnchored || null
  const anchoredValues = anc?.values || null
  const itemId = r.serverId ?? r.key ?? r.itemId ?? r.item_id ?? (r.type === 'npm' || r.type === 'pypi' ? r.target : null)
  // per-item diffs (MCP: items[], skill: diff object)
  const diff = []
  for (const it of arr(r.items)) if (it.status && it.status !== 'unchanged') diff.push({ title: `${it.kind || 'item'} ${it.name || ''}`.trim(), status: it.status, score: num(it.score), label: it.label || null, reasons: normReasons(it.reasons), ops: it.diff || null })
  if (r.diff && !Array.isArray(r.diff) && typeof r.diff === 'object') diff.push({ title: r.type === 'skill' ? 'SKILL.md' : 'definition', status: 'changed', ops: r.diff })
  else if (Array.isArray(r.diff)) diff.push(...r.diff)
  const error = status === 'error' ? (r.error || r.message || r.verdict || 'unknown error') : r.error || null
  return {
    raw: r, target: r.target, kind: r.type || r.kind || null, verdict: r.verdict || null, itemId, known: r.tracked ?? r.known ?? !!anc, status,
    label: status === 'changed' ? labelOf(r) : null, score: num(r.score), reasons: normReasons(r.reasons),
    current: { hash: live.hash ?? live.toolsHash ?? live.fileHash ?? live.integrityHash ?? null, tools: live.counts?.tools ?? live.tools ?? null, version: live.version ?? null, at: r.fetchedAt ?? live.at ?? null, ...live },
    anchored: anc ? { epoch: num(anc.epoch), hash: anc.hash ?? (anchoredValues ? anchoredValues[2] : null), tx: anc.tx ?? null, onChain: anc.onChain ?? null, status: anc.status ?? null, root: anc.root ?? null } : null,
    diff, items: arr(r.items), history: arr(r.history, 'items').map(normChange).filter(Boolean),
    proof: r.proof && typeof r.proof === 'object' ? r.proof : anc?.leafKey ? { leafKey: anc.leafKey, epoch: num(anc.epoch) } : null,
    note: r.message || r.note || null, error,
  }
}

// ── calls ────────────────────────────────────────────────────────────────
export async function getHealth() { return FIXTURE ? fx('health') : j('/api/health') }
export async function getStats() { return normStats(FIXTURE ? await fx('stats') : await j('/api/stats')) }
export async function getAnchors(limit = 48) {
  const r = FIXTURE ? await fx('anchors') : await j(`/api/anchors?limit=${limit}`)
  return { contract: r?.contract ?? r?.address ?? null, anchors: arr(r, 'anchors', 'items').map(normAnchor).filter((a) => a && a.epoch != null).sort((a, b) => b.epoch - a.epoch).slice(0, limit) }
}
export async function getFeed({ cursor, label, limit = 50 } = {}) {
  if (FIXTURE) {
    const r = await fx('feed')
    let items = arr(r, 'items').map(normChange)
    if (label) items = items.filter((c) => c.label === label)
    return { items: items.slice(0, limit), next: null }
  }
  const p = new URLSearchParams()
  if (cursor) p.set('cursor', cursor)
  if (label) p.set('label', label)
  p.set('limit', limit)
  const r = await j(`/api/feed?${p}`)
  return { items: arr(r, 'items', 'changes', 'feed').map(normChange).filter(Boolean), next: r?.next ?? r?.nextCursor ?? r?.cursor ?? null }
}
// Tracked items ordered by first seen (warp threads). Needs GET /api/items; null when the endpoint is missing.
export async function getItems(limit = 160) {
  if (FIXTURE) { const r = await fx('items'); return { total: r.total, items: arr(r, 'items').slice(0, limit).map(normItem) } }
  try {
    const r = await j(`/api/items?limit=${limit}&order=first_seen`)
    return { total: num(r?.total), items: arr(r, 'items', 'servers').map(normItem).filter(Boolean) }
  } catch (e) { if (e.status === 404) return null; throw e }
}
export async function getServer(id) {
  if (FIXTURE) { const s = await fx('server'); s.id = id; s.name = id.replace(/^(npm:|pypi:|skill:)/, ''); s.leafKey = id; return s }
  return j(`/api/server/${encodeURIComponent(id)}`)
}
export async function getItemHistory(id) { return FIXTURE ? (await fx('server')).timeline : j(`/api/item/${encodeURIComponent(id)}/history`) }
export async function getProof(epoch, leafKey) {
  if (FIXTURE) return fx('proof')
  const p = new URLSearchParams({ leafKey }); if (epoch != null) p.set('epoch', epoch)
  return j(`/api/proof?${p}`)
}
export async function getSnapshot(a) {
  if (FIXTURE) return fx('snapshot')
  let url = a.snapshotURI || `/snapshots/${a.epoch}.json`
  // our own snapshots are served same-origin; an absolute URI on another host is fetched by path
  try { const u = new URL(url, location.href); if (u.origin !== location.origin) url = u.pathname } catch {}
  return j(url, { timeout: 30000 })
}
export async function postCheck(target) {
  if (FIXTURE) {
    const c = await fx('check')
    await new Promise((r) => setTimeout(r, 500))
    const t = target.trim()
    const r = /evil|poison|sus/i.test(t) || t === c.known.target ? c.known : /^https?:\/\/mcp\.unknown|new/i.test(t) ? c.unknown : c.unchanged
    return normCheck({ ...r, target: t })
  }
  try {
    return normCheck(await j('/api/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target }), timeout: 25000 }))
  } catch (e) {
    if (e.body) return normCheck({ ...e.body, status: 'error', error: e.body.error || e.message })
    throw e
  }
}

// Classify what the user typed (client side, only for hints; SERVER decides)
export function targetKind(t) {
  t = String(t || '').trim()
  if (/^npm:\S+/.test(t)) return 'npm package'
  if (/^pypi:\S+/.test(t)) return 'PyPI package'
  if (/^https:\/\/(github\.com|raw\.githubusercontent\.com)\/.+SKILL\.md/i.test(t)) return 'SKILL.md'
  if (/^https?:\/\//.test(t)) return 'MCP server URL'
  return null
}

// /server/<id> (path) or /server/?id=<id>
export const serverHref = (id) => `/server/${encodeURIComponent(id)}`
export const checkHref = (t) => `/check/?t=${encodeURIComponent(t)}`
