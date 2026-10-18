// One crawl cycle for epoch E: probe due remotes → packages → skills → apply observations (diff engine).
// The registry itself is synced by syncRegistry() on its own schedule (incremental every 10 min, full every 24 h).
import { fetchRegistry } from './sources/registry.mjs'
import { fetchPackage, packageKey } from './sources/packages.mjs'
import { crawlSkills } from './sources/skills.mjs'
import { createScheduler, pickRemote, dueAt, hostOf } from './probe.mjs'
import { itemHash, viewOf, listHash, hashJson, textHash, ZERO32 } from './lib/hash.mjs'
import { observe } from './observe.mjs'
import { writeObject } from './objects.mjs'

const MAX_PER_HOST = Number(process.env.HOST_MAX_PER_EPOCH || 240)

/**
 * registry → servers table, page by page (a failed sync resumes from the saved cursor).
 * full: every latest entry; servers not seen in a completed full sync are marked removed. Else: updated_since the last sync.
 */
export async function syncRegistry({ store, full = false, log = console, now = Date.now() }) {
  const since = store.kv('registry_since')
  let prog = store.kv('registry_progress')
  const doFull = full || !since || !!prog
  if (doFull && !prog) prog = { startedAt: now, cursor: null, count: 0 }
  let count = prog?.count || 0
  const opts = {
    maxPages: 2000, cursor: doFull ? prog.cursor : null, updatedSince: doFull ? null : since,
    onBatch: (batch, cursor) => {
      store.tx(() => { for (const s of batch) store.putServer(s, now) })
      count += batch.length
      if (doFull) store.kv('registry_progress', { ...prog, cursor, count })
    },
    onPage: (_n, p) => { if (p % 50 === 0) log.log?.(`registry: ${p} pages, ${count} servers`) },
  }
  const r = await fetchRegistry(opts)
  let removed = 0
  if (doFull) {
    if (!r.truncated) removed = store.markRemoved(now, prog.startedAt)
    store.kv('registry_full_at', now)
    store.kv('registry_progress', null)
  }
  store.kv('registry_since', new Date((doFull ? prog.startedAt : now) - 10 * 60_000).toISOString())
  const stat = { at: now, full: doFull, servers: count, pages: r.pages, ms: r.ms, truncated: r.truncated, removed }
  store.kv('registry_last', stat)
  return stat
}

function serverItems(res) {
  const items = []
  for (const [kind, list, nameKey] of [['tool', res.tools, 'name'], ['prompt', res.prompts, 'name'], ['resource', res.resources, 'uri']]) {
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const body = viewOf(kind, raw)
      let hash
      try { hash = itemHash(kind, raw) } catch { continue }   // non-canonicalizable (lone surrogate, NaN): skipped and counted
      items.push({ kind, name: String(raw?.[nameKey] ?? '').slice(0, 300), hash, body })
    }
  }
  return items
}
const hashesOf = (items, kind, list) => (Array.isArray(list) ? items.filter((i) => i.kind === kind).map((i) => i.hash) : null)

/** apply one probe result for a server */
export function applyProbe(store, { serverId, url, type, epoch, at, res }) {
  const prev = store.getProbe(serverId)
  const ok = res.status === 'ok'
  let items = [], toolsHash = null, promptsHash = null, resourcesHash = null, obs = null
  if (ok) {
    items = serverItems(res)
    toolsHash = listHash(hashesOf(items, 'tool', res.tools))
    promptsHash = res.prompts ? listHash(hashesOf(items, 'prompt', res.prompts)) : ZERO32
    resourcesHash = res.resources ? listHash(hashesOf(items, 'resource', res.resources)) : ZERO32
    for (const it of items) writeObject(it.hash, it.body)
    const kinds = ['tool', ...(res.prompts ? ['prompt'] : []), ...(res.resources ? ['resource'] : [])]
    obs = observe(store, { subject: serverId, epoch, at, kinds, items, baseline: !prev?.last_ok_epoch && store.itemsOf(serverId, { bodies: false }).length === 0 })
  }
  store.putProbe({
    serverId, epoch, at, url, remoteType: type, status: res.status, era: res.era, protocolVersion: res.protocolVersion, httpStatus: res.httpStatus, error: res.error,
    ms: res.ms, serverInfo: ok ? clip(res.serverInfo) : null, capabilities: ok ? clip(res.capabilities) : null,
    instructionsHash: ok && res.instructions ? textHash(res.instructions) : null,
    toolsHash, promptsHash, resourcesHash, toolCount: ok ? items.filter((i) => i.kind === 'tool').length : null,
    promptCount: ok && res.prompts ? res.prompts.length : null, resourceCount: ok && res.resources ? res.resources.length : null,
    truncated: res.truncated, partial: res.partial || null, lastOkAt: ok ? at : null, lastOkEpoch: ok ? epoch : null,
    authScheme: res.authScheme, resourceMetadata: res.resourceMetadata,
  })
  return obs
}
const clip = (o) => { if (o == null) return null; const s = JSON.stringify(o); return s.length > 4000 ? { _truncated: true } : o }

/** which servers to probe this epoch (due by schedule, ≤ MAX_PER_HOST per host, least recently probed first) */
export function dueTasks(store, epoch) {
  const tasks = [], needsConfig = []
  for (const s of store.activeServers()) {
    const r = pickRemote(s.remotes || [])
    if (!r) { if ((s.remotes || []).length) needsConfig.push(s.id); continue }
    const prev = store.getProbe(s.id)
    if (dueAt(prev, epoch) > epoch) continue
    tasks.push({ serverId: s.id, url: r.url, type: r.type, era: prev?.status === 'ok' && prev.url === r.url ? prev.era : null, lastAt: prev?.at || 0 })
  }
  tasks.sort((a, b) => a.lastAt - b.lastAt)
  const per = new Map(), out = []
  for (const t of tasks) { const h = hostOf(t.url); const n = per.get(h) || 0; if (n >= MAX_PER_HOST) continue; per.set(h, n + 1); out.push(t) }
  return { tasks: out, deferred: tasks.length - out.length, needsConfig }
}

async function pool(items, n, fn) {
  let i = 0
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (i < items.length) { const x = items[i++]; await fn(x) } }))
}

export async function crawlPackages({ store, epoch, now = Date.now(), concurrency = Number(process.env.PACKAGE_CONCURRENCY || 8), deadline = Infinity, log = console }) {
  const refs = new Map()
  for (const s of store.activeServers()) for (const p of s.packages || []) {
    const eco = p.registryType === 'npm' ? 'npm' : p.registryType === 'pypi' ? 'pypi' : null
    if (!eco) continue
    if (p.registryBaseUrl && !/^https:\/\/(registry\.npmjs\.org|pypi\.org)\/?$/.test(p.registryBaseUrl)) continue
    const key = packageKey(eco, p.identifier)
    if (!key) continue
    if (!refs.has(key)) refs.set(key, new Set())
    if (refs.get(key).size < 20) refs.get(key).add(s.id)
  }
  const stats = { packages: refs.size, ok: 0, notFound: 0, errors: 0, changes: 0, skipped: 0 }
  await pool([...refs.keys()], concurrency, async (key) => {
    if (Date.now() > deadline) { stats.skipped++; return }
    const prev = store.getPackage(key)
    const [eco, ...rest] = key.split(':'); const name = rest.join(':')
    let r
    try { r = await fetchPackage(key, { etag: prev?.etag }) } catch (e) { r = { status: 'error', error: String(e.message).slice(0, 200) } }
    if (r.notModified && prev?.version) r = { status: 'ok', version: prev.version, integrity: prev.integrity, integrityHash: prev.integrity_hash, maintainers: prev.maintainers, maintainersHash: prev.maintainers_hash, publishedAt: prev.published_at, etag: prev.etag, cached: true }
    const servers = [...refs.get(key)]
    if (r.status !== 'ok') {
      if (r.status === 'not_found') stats.notFound++; else stats.errors++
      store.putPackage({ key, eco, name, status: r.status, error: r.error, checkedAt: now, servers })
      return
    }
    stats.ok++
    store.putPackage({ key, eco, name, version: r.version, integrity: r.integrity, integrityHash: r.integrityHash, maintainers: r.maintainers, maintainersHash: r.maintainersHash,
      publishedAt: r.publishedAt, etag: r.etag, status: 'ok', checkedAt: now, lastOkEpoch: epoch, servers })
    writeObject(r.maintainersHash, r.maintainers ? [...new Set(r.maintainers.map((x) => String(x).trim()).filter(Boolean))].sort() : [])
    if (r.integrityText) writeObject(r.integrityHash, r.integrityText, 'txt')
    const body = { version: r.version, integrity: r.integrity, integrityHash: r.integrityHash, maintainers: r.maintainers, maintainersHash: r.maintainersHash, publisher: r.publisher ?? null }
    const o = observe(store, { subject: key, epoch, at: now, kinds: ['package'], items: [{ kind: 'package', name: key, hash: hashJson({ v: r.version, i: r.integrityHash, m: r.maintainersHash }), body }] })
    stats.changes += o.changes.length
  })
  return stats
}

export async function crawlSkillSources({ store, epoch, now = Date.now(), log = console }) {
  const r = await crawlSkills({ store, epoch, now, log })
  let changes = 0
  const byRepo = new Map(r.repos.filter((x) => x.ok).map((x) => [x.repo, new Set()]))
  for (const s of r.observed) {
    if (s.bytes) writeObject(s.fileHash, s.bytes, 'txt')
    const prevItem = store.getItem(`${s.key}#skill`)
    const body = s.text != null ? { text: s.text } : prevItem?.body ?? { text: null }
    const o = observe(store, { subject: s.key, epoch, at: now, kinds: ['skill'], items: [{ kind: 'skill', name: s.path, hash: s.fileHash, body }] })
    changes += o.changes.length
    byRepo.get(s.repo)?.add(s.key)
  }
  // a SKILL.md that disappeared from a repo we read successfully → removed
  for (const sk of store.allSkills()) {
    const seen = byRepo.get(sk.repo)
    if (!seen || seen.has(sk.key) || sk.status !== 'ok') continue
    const o = observe(store, { subject: sk.key, epoch, at: now, kinds: ['skill'], items: [] })
    store.putSkill({ key: sk.key, repo: sk.repo, path: sk.path, ref: sk.ref, status: 'removed', checkedAt: now })
    changes += o.changes.length
  }
  return { skills: r.observed.length, repos: r.repos.length, repoErrors: r.errors, changes, detail: r.repos }
}

/** full crawl for one epoch; returns stats (stored in the epoch row) */
export async function crawlEpoch({ store, epoch, log = console, deadline = Infinity, scheduler = null, now = () => Date.now(), limit = Infinity, packages: doPackages = true, skills: doSkills = true }) {
  const started = now()
  const stats = { epoch, startedAt: started }
  const due = dueTasks(store, epoch)
  const { deferred, needsConfig } = due
  const tasks = due.tasks.slice(0, limit)
  stats.remotes = { due: tasks.length, deferredHostCap: deferred, needsConfig: needsConfig.length }
  for (const id of needsConfig) {
    const p = store.getProbe(id)
    if (!p || p.status !== 'needs_config') store.putProbe({ serverId: id, epoch, at: started, url: null, remoteType: null, status: 'needs_config', error: 'remote URL has template variables' })
  }
  const sched = scheduler || createScheduler({ store, log })
  const counts = {}
  let probeChanges = 0, done = 0
  const pkgP = doPackages ? crawlPackages({ store, epoch, now: started, deadline, log }).catch((e) => ({ error: e.message })) : Promise.resolve(null)
  const probeP = sched.run(tasks, {
    deadline,
    onResult: (t, res) => {
      counts[res.status] = (counts[res.status] || 0) + 1
      try { const o = applyProbe(store, { serverId: t.serverId, url: t.url, type: t.type, epoch, at: now(), res }); probeChanges += o?.changes.length || 0 } catch (e) { log.error?.(`apply ${t.serverId}: ${e.message}`) }
      if (++done % 500 === 0) log.log?.(`crawl ${epoch}: ${done}/${tasks.length} probed ${JSON.stringify(counts)}`)
    },
  })
  const skillsP = doSkills ? crawlSkillSources({ store, epoch, now: now(), log }).catch((e) => ({ error: e.message })) : Promise.resolve(null)
  const [probe, packages, skills] = await Promise.all([probeP, pkgP, skillsP])
  stats.remotes.probed = done
  stats.remotes.status = counts
  stats.remotes.hosts = probe.hosts
  stats.remotes.skippedHosts = probe.skipped.length
  stats.remotes.changes = probeChanges
  stats.packages = packages
  stats.skills = skills
  stats.ms = now() - started
  return stats
}
