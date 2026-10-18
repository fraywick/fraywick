// /api/check and the MCP check_* tools: fetch a target live (SSRF guard, 10 s total, 2 MB cap), hash it now, compare with the latest
// anchored leaf and our history, score any difference.
//   target: https MCP URL · npm:<pkg> · pypi:<pkg> · GitHub SKILL.md URL (github.com/…/blob/… or raw.githubusercontent.com/…)
import { createProbe } from './lib/mcp-client.mjs'
import { guardedHttp } from './probe.mjs'
import { makeAgents, checkUrl, GuardError } from './net.mjs'
import { itemHash, viewOf, listHash, ZERO32 } from './lib/hash.mjs'
import { fetchPackage, packageKey } from './sources/packages.mjs'
import { parseSkillUrl, fetchRaw, skillKey } from './sources/skills.mjs'
import { loadSnapshot } from './epoch.mjs'
import { scoreChange, labelOf } from './score.mjs'
import { diffViews } from './diff.mjs'
import { itemId } from './observe.mjs'
import { userAgent, publicUrl, VERSION, link, iso } from './config.mjs'

export class UserError extends Error { constructor(m) { super(m); this.user = true } }

export function classify(target) {
  const t = String(target ?? '').trim()
  if (!t || t.length > 2048) throw new UserError('target must be an MCP URL, npm:<package>, pypi:<package> or a GitHub SKILL.md URL')
  const m = t.match(/^(npm|pypi):(.+)$/i)
  if (m) {
    const key = packageKey(m[1].toLowerCase(), m[2])
    if (!key) throw new UserError(`not a valid ${m[1].toLowerCase()} package name`)
    return { type: m[1].toLowerCase(), key }
  }
  const sk = parseSkillUrl(t)
  if (sk) {
    if (!/(^|\/)SKILL\.md$/i.test(sk.path)) throw new UserError('GitHub URLs must point at a SKILL.md file')
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sk.repo)) throw new UserError('not a GitHub repository URL')
    return { type: 'skill', ...sk, key: skillKey(sk.repo, sk.path) }
  }
  let u
  try { u = new URL(t) } catch { throw new UserError('target must be an MCP URL, npm:<package>, pypi:<package> or a GitHub SKILL.md URL') }
  try { checkUrl(u, { mode: 'check' }) } catch (e) { throw new UserError(e.message) }
  return { type: 'mcp', url: u.toString() }
}

/** last epoch in which a leaf key was observed (DB), so we load at most a few snapshots */
function lastOkEpochOf(store, leafKey) {
  const one = (sql, k) => store.db.prepare(sql).get(k)?.e ?? null
  if (leafKey.startsWith('skill:')) return one('SELECT last_ok_epoch e FROM skills WHERE key = ?', leafKey)
  if (/^(npm|pypi):/.test(leafKey)) return one('SELECT last_ok_epoch e FROM packages WHERE key = ?', leafKey)
  return one('SELECT last_ok_epoch e FROM probes WHERE server_id = ?', leafKey)
}

/** newest epoch whose snapshot holds leafKey: confirmed anchors first, else (preview / dry run) the newest built snapshot */
export function latestAnchorWith(store, leafKey, { limit = 72, tries = 4 } = {}) {
  const rows = store.epochs(limit)
  const anyConfirmed = rows.some((r) => r.post_status === 'confirmed')
  const lastOk = lastOkEpochOf(store, leafKey)
  const cands = rows.filter((r) => (!anyConfirmed || r.post_status === 'confirmed') && (lastOk == null || r.epoch <= lastOk)).slice(0, tries)
  for (const r of cands) {
    const e = loadSnapshot(r.epoch)
    if (e && e.index.has(leafKey)) return { row: r, entry: e, leaf: e.snap.leaves.find((l) => l.k === leafKey) }
  }
  return null
}

function anchorView(a, leafKey) {
  if (!a) return null
  const base = publicUrl() || ''
  const r = a.row
  return { epoch: r.epoch, hour: iso(r.epoch * 3_600_000), root: r.root, status: r.post_status, onChain: r.post_status === 'confirmed', tx: r.tx || null, explorer: r.tx ? link.tx(r.tx) : null,
    leafKey, values: a.leaf.v, leafHash: a.leaf.h, proof: `${base}/api/proof?epoch=${r.epoch}&leafKey=${encodeURIComponent(leafKey)}`, snapshot: `${base}/snapshots/${r.epoch}.json` }
}

/** compare live items with the anchored [name, hash] lists of a server leaf */
function compareItems(store, subject, live, leaf) {
  const out = []
  for (const [kind, key] of [['tool', 'tools'], ['prompt', 'prompts'], ['resource', 'resources']]) {
    const anchored = leaf?.d?.[key]
    const liveList = live.filter((i) => i.kind === kind)
    if (!Array.isArray(anchored)) { for (const i of liveList) out.push({ kind, name: i.name, status: leaf ? 'not_anchored' : 'new', liveHash: i.hash }); continue }
    const am = new Map(anchored.map(([n, h]) => [n, h]))
    const seen = new Set()
    for (const i of liveList) {
      seen.add(i.name)
      const h = am.get(i.name)
      if (h === undefined) { const s = scoreChange({ kind, change: 'added', old: null, new: i.body }); out.push({ kind, name: i.name, status: 'new', liveHash: i.hash, ...s }); continue }
      if (h === i.hash) { out.push({ kind, name: i.name, status: 'unchanged', liveHash: i.hash, anchoredHash: h }); continue }
      const old = store.versionByHash(itemId(subject, kind, i.name), h)
      const s = scoreChange({ kind, change: 'changed', old: old?.body ?? null, new: i.body })
      out.push({ kind, name: i.name, status: 'changed', liveHash: i.hash, anchoredHash: h, ...s, diff: old ? diffViews(old.body, i.body) : null })
    }
    for (const [n, h] of am) if (!seen.has(n)) out.push({ kind, name: n, status: 'missing', anchoredHash: h, ...scoreChange({ kind, change: 'removed' }) })
  }
  return out
}

function verdictOf(items, anchored) {
  if (!anchored) return 'not_anchored'
  return items.some((i) => i.status !== 'unchanged') ? 'changed' : 'match'
}
const worst = (items) => { const s = Math.max(0, ...items.map((i) => i.score || 0)); return { score: s, label: labelOf(s) } }

async function checkMcp(store, t) {
  const agents = makeAgents()
  try {
    const deadline = Date.now() + 10_000
    const probe = createProbe({ http: guardedHttp({ policy: { mode: 'check' }, deadline, timeoutMs: 10_000, agents }), clientInfo: { name: 'FraywickCheck', version: VERSION }, userAgent: userAgent() })
    const res = await probe(t.url)
    const norm = t.url.replace(/\/+$/, '')
    const known = store.probesByUrl(norm, norm + '/')[0] || null
    const subject = known?.server_id || null
    const base = { target: t.url, type: 'mcp', fetchedAt: new Date().toISOString(), serverId: subject, tracked: !!subject }
    if (res.status !== 'ok') {
      return { ...base, verdict: res.status === 'auth_required' ? 'auth_required' : 'unreachable', live: { status: res.status, error: res.error, httpStatus: res.httpStatus ?? null },
        message: res.status === 'auth_required' ? 'the server requires authentication; FRAYWICK only reads public tool lists (metadata only)' : `could not read the tool list (${res.error})` }
    }
    const live = []
    for (const [kind, list, nk] of [['tool', res.tools, 'name'], ['prompt', res.prompts, 'name'], ['resource', res.resources, 'uri']]) {
      for (const raw of list || []) { try { live.push({ kind, name: String(raw?.[nk] ?? '').slice(0, 300), hash: itemHash(kind, raw), body: viewOf(kind, raw) }) } catch {} }
    }
    const lh = (kind, list) => (Array.isArray(list) ? listHash(live.filter((i) => i.kind === kind).map((i) => i.hash)) : ZERO32)
    const liveView = { status: 'ok', era: res.era, protocolVersion: res.protocolVersion, toolsHash: lh('tool', res.tools), promptsHash: lh('prompt', res.prompts), resourcesHash: lh('resource', res.resources),
      counts: { tools: (res.tools || []).length, prompts: res.prompts ? res.prompts.length : null, resources: res.resources ? res.resources.length : null } }
    const a = subject ? latestAnchorWith(store, subject) : null
    const items = compareItems(store, subject, live, a?.leaf)
    const verdict = verdictOf(items, a)
    const w = worst(items)
    return { ...base, verdict, ...w, live: liveView, anchor: anchorView(a, subject), items: items.map(({ body, ...x }) => x),
      message: verdict === 'not_anchored' ? (subject ? 'tracked, but not in an anchor yet' : 'hashed now; this server is not in an anchor yet') : verdict === 'match' ? 'every definition matches the anchor' : 'definitions differ from the anchor' }
  } finally { agents.destroy() }
}

async function checkPackage(store, t) {
  const r = await fetchPackage(t.key, { policy: { mode: 'check' }, timeoutMs: 10_000 })
  const base = { target: t.key, type: t.type, fetchedAt: new Date().toISOString() }
  if (r.status !== 'ok') return { ...base, verdict: r.status === 'not_found' ? 'not_found' : 'unreachable', live: { status: r.status, error: r.error ?? null }, message: r.status === 'not_found' ? 'package not found' : 'registry read failed' }
  const live = { version: r.version, integrity: r.integrity, integrityHash: r.integrityHash, maintainers: r.maintainers, maintainersHash: r.maintainersHash, publisher: r.publisher ?? null }
  const a = latestAnchorWith(store, t.key)
  if (!a) return { ...base, verdict: 'not_anchored', score: 0, label: 'cosmetic', live, anchor: null, message: 'hashed now; this package is not in an anchor yet' }
  const [, version, integrityHash, maintainersHash] = a.leaf.v
  const same = version === r.version && integrityHash === r.integrityHash && maintainersHash === r.maintainersHash
  const old = store.getItem(`${t.key}#package`)
  const oldBody = old?.body && old.body.version === version ? old.body : { version, integrityHash, maintainers: a.leaf.d?.maintainers || [] }
  const s = same ? { score: 0, label: 'cosmetic', reasons: [] } : scoreChange({ kind: 'package', change: 'changed', old: oldBody, new: live })
  return { ...base, verdict: same ? 'match' : 'changed', ...s, live, anchored: { version, integrityHash, maintainersHash, maintainers: a.leaf.d?.maintainers ?? null }, anchor: anchorView(a, t.key),
    message: same ? 'version, file hashes and maintainers match the anchor' : 'package metadata differs from the anchor' }
}

async function checkSkill(store, t) {
  const r = await fetchRaw(t.repo, t.ref, t.path, { policy: { mode: 'check' }, timeoutMs: 10_000 })
  const base = { target: `https://github.com/${t.repo}/blob/${t.ref}/${t.path}`, type: 'skill', key: t.key, fetchedAt: new Date().toISOString() }
  if (r.status !== 'ok') return { ...base, verdict: r.status === 'not_found' ? 'not_found' : 'unreachable', live: { status: r.status, error: r.error ?? null }, message: 'could not read the file' }
  const live = { fileHash: r.fileHash, size: r.size }
  const a = latestAnchorWith(store, t.key)
  if (!a) return { ...base, verdict: 'not_anchored', score: 0, label: 'cosmetic', live, anchor: null, message: 'hashed now; this skill is not in an anchor yet' }
  const anchoredHash = a.leaf.v[2]
  if (anchoredHash === r.fileHash) return { ...base, verdict: 'match', score: 0, label: 'cosmetic', reasons: [], live, anchor: anchorView(a, t.key), message: 'SKILL.md matches the anchor byte for byte' }
  const old = store.versionByHash(`${t.key}#skill`, anchoredHash)
  const s = scoreChange({ kind: 'skill', change: 'changed', old: old?.body ?? { text: '' }, new: { text: r.text } })
  return { ...base, verdict: 'changed', ...s, live, anchoredHash, anchor: anchorView(a, t.key), diff: old?.body?.text != null ? diffViews(old.body, { text: r.text }) : null,
    message: 'SKILL.md differs from the anchor' }
}

export async function checkTarget(store, target) {
  const t = classify(target)
  try {
    if (t.type === 'mcp') return await checkMcp(store, t)
    if (t.type === 'skill') return await checkSkill(store, t)
    return await checkPackage(store, t)
  } catch (e) {
    if (e instanceof GuardError) throw new UserError(e.code === 'private_ip' ? 'target resolves to a non-public address' : e.message)
    throw e
  }
}

/** MCP-safe view: no raw text from other servers (names sanitized, reasons as codes, no diffs or snippets) */
export function forAgents(r) {
  const clean = (s) => String(s ?? '').replace(/[^\w.:/@-]/g, '_').slice(0, 80)
  const out = { target: r.target, type: r.type, verdict: r.verdict, score: r.score ?? 0, label: r.label ?? 'cosmetic', message: r.message, fetchedAt: r.fetchedAt,
    reasons: (r.reasons || []).filter((x) => x.points).map((x) => x.code), anchor: r.anchor ? { epoch: r.anchor.epoch, root: r.anchor.root, onChain: r.anchor.onChain, tx: r.anchor.tx, proof: r.anchor.proof } : null }
  if (r.items) out.items = r.items.filter((i) => i.status !== 'unchanged').slice(0, 100).map((i) => ({ kind: i.kind, name: clean(i.name), status: i.status, score: i.score ?? 0, label: i.label ?? null,
    reasons: (i.reasons || []).filter((x) => x.points).map((x) => x.code), liveHash: i.liveHash ?? null, anchoredHash: i.anchoredHash ?? null }))
  if (r.items) out.unchanged = r.items.filter((i) => i.status === 'unchanged').length
  if (r.live) out.live = { status: r.live.status ?? 'ok', toolsHash: r.live.toolsHash, fileHash: r.live.fileHash, version: r.live.version ? clean(r.live.version) : undefined }
  const base = publicUrl()
  if (base) out.page = `${base}/check?target=${encodeURIComponent(r.target)}`
  return out
}
