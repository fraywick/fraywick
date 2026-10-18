// Agent Skills: SKILL.md files from the seed repos in sources/skills.json, read as text only.
// Per repo: HEAD commit (commits API, ETag → 304 is free) → git tree (only when the commit moved) → raw file for every SKILL.md whose
// blob sha changed. fileHash = keccak256(raw bytes). Optional GITHUB_TOKEN raises the API limit from 60 to 5000 requests/hour.
import { request } from '../net.mjs'
import { userAgent, readJson, paths } from '../config.mjs'
import { bytesHash } from '../lib/hash.mjs'

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const MAX_SKILL_BYTES = 512_000

export function seedRepos() {
  const j = readJson(paths.skills()) || { repos: [] }
  return (j.repos || []).filter((r) => REPO.test(r.repo || ''))
}
const ghHeaders = (accept, etag) => ({
  accept, 'user-agent': userAgent(), 'x-github-api-version': '2022-11-28',
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}), ...(etag ? { 'if-none-match': etag } : {}),
})
export const skillKey = (repo, path) => `skill:${repo}:${path}`
const wanted = (path, r) => /(^|\/)SKILL\.md$/.test(path) && (!r.include || r.include.some((p) => path.startsWith(p))) && !(r.exclude || []).some((p) => path.startsWith(p))

/** parse a GitHub SKILL.md URL (github.com blob/raw or raw.githubusercontent.com) → { repo, ref, path } */
export function parseSkillUrl(input) {
  let u
  try { u = new URL(String(input)) } catch { return null }
  if (u.protocol !== 'https:') return null
  const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (u.hostname === 'github.com' && seg.length >= 5 && (seg[2] === 'blob' || seg[2] === 'raw')) return { repo: `${seg[0]}/${seg[1]}`, ref: seg[3], path: seg.slice(4).join('/') }
  if (u.hostname === 'raw.githubusercontent.com' && seg.length >= 4) {
    if (seg[2] === 'refs' && seg[3] === 'heads' && seg.length >= 6) return { repo: `${seg[0]}/${seg[1]}`, ref: seg[4], path: seg.slice(5).join('/') }
    return { repo: `${seg[0]}/${seg[1]}`, ref: seg[2], path: seg.slice(3).join('/') }
  }
  return null
}
const rawUrl = (repo, ref, path) => `${RAW}/${repo}/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`

export async function fetchRaw(repo, ref, path, { policy = { mode: 'crawl' }, deadline, timeoutMs = 15_000 } = {}) {
  const res = await request({ url: rawUrl(repo, ref, path), headers: { 'user-agent': userAgent() }, policy, deadline, timeoutMs, maxBytes: MAX_SKILL_BYTES })
  if (res.status === 404) return { status: 'not_found' }
  if (res.status !== 200) return { status: 'error', error: `raw HTTP ${res.status}` }
  const buf = await res.load()
  return { status: 'ok', bytes: buf, fileHash: bytesHash(new Uint8Array(buf)), size: buf.length, text: buf.toString('utf8') }
}

/** HEAD commit of a ref (ETag-aware); { sha, etag, notModified } */
export async function headCommit(repo, ref, etag, opts = {}) {
  const res = await request({ url: `${API}/repos/${repo}/commits/${encodeURIComponent(ref)}`, headers: ghHeaders('application/vnd.github.sha', etag), policy: { mode: 'crawl' }, timeoutMs: 15_000, maxBytes: 10_000, ...opts })
  if (res.status === 304) return { notModified: true }
  if (res.status === 403 || res.status === 429) return { error: `GitHub API HTTP ${res.status}${res.headers['x-ratelimit-remaining'] === '0' ? ' (rate limit)' : ''}`, rateLimited: true }
  if (res.status !== 200) return { error: `GitHub API HTTP ${res.status}` }
  const sha = res.text().trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) return { error: 'GitHub API: unexpected commit body' }
  return { sha, etag: res.headers.etag || null }
}

export async function skillTree(repo, sha, opts = {}) {
  const res = await request({ url: `${API}/repos/${repo}/git/trees/${sha}?recursive=1`, headers: ghHeaders('application/vnd.github+json'), policy: { mode: 'crawl' }, timeoutMs: 30_000, maxBytes: 40_000_000, ...opts })
  if (res.status !== 200) return { error: `GitHub tree HTTP ${res.status}`, rateLimited: res.status === 403 || res.status === 429 }
  const j = res.json()
  if (!j || !Array.isArray(j.tree)) return { error: 'GitHub tree: unexpected body' }
  return { entries: j.tree.filter((e) => e.type === 'blob' && typeof e.path === 'string').map((e) => ({ path: e.path, sha: e.sha, size: e.size })), truncated: !!j.truncated }
}

/**
 * crawlSkills({ store, epoch }) → { observed: [{ key, repo, path, commit, blobSha, fileHash, size, text|null(unchanged) }], repos: {...}, errors }
 * Only skills of repos whose HEAD was read in this crawl count as observed.
 */
export async function crawlSkills({ store, epoch, log = console, now = Date.now() }) {
  const observed = [], repoStats = []
  let errors = 0
  for (const r of seedRepos()) {
    const ref = r.ref || 'main'
    const prev = store.getRepo(r.repo)
    try {
      const head = await headCommit(r.repo, ref, prev && prev.ref === ref && prev.tree ? prev.commit_etag : null)
      if (head.error) throw Object.assign(new Error(head.error), { rateLimited: head.rateLimited })
      let commit = prev?.commit_sha, tree = prev?.tree
      if (!head.notModified) {
        commit = head.sha
        if (!tree || tree.commit !== commit) {
          const t = await skillTree(r.repo, commit)
          if (t.error) throw Object.assign(new Error(t.error), { rateLimited: t.rateLimited })
          tree = { commit, truncated: t.truncated, files: t.entries.filter((e) => wanted(e.path, r)).slice(0, 2000) }
        }
      }
      store.putRepo({ repo: r.repo, ref, commit, etag: head.etag || prev?.commit_etag, tree, checkedAt: now, status: 'ok' })
      let n = 0
      const files = [...tree.files]
      let fi = 0
      await Promise.all(Array.from({ length: 6 }, async () => { while (fi < files.length) { const f = files[fi++]; await one(f) } }))
      async function one(f) {
        const key = skillKey(r.repo, f.path)
        const old = store.getSkill(key)
        let fileHash = old?.file_hash, size = old?.size, text = null, bytes = null
        if (!old || old.blob_sha !== f.sha || !fileHash) {
          const raw = await fetchRaw(r.repo, commit, f.path).catch((e) => ({ status: 'error', error: String(e.message).slice(0, 200) }))
          if (raw.status !== 'ok') { errors++; store.putSkill({ key, repo: r.repo, path: f.path, ref, status: raw.status, error: raw.error, checkedAt: now }); return }
          fileHash = raw.fileHash; size = raw.size; text = raw.text; bytes = raw.bytes
        }
        store.putSkill({ key, repo: r.repo, path: f.path, ref, commit, blobSha: f.sha, fileHash, size, status: 'ok', checkedAt: now, lastOkEpoch: epoch })
        observed.push({ key, repo: r.repo, path: f.path, commit, blobSha: f.sha, fileHash, size, text, bytes })
        n++
      }
      repoStats.push({ repo: r.repo, ok: true, commit, skills: n, cached: !!head.notModified })
    } catch (e) {
      errors++
      store.putRepo({ repo: r.repo, ref, checkedAt: now, status: e.rateLimited ? 'rate_limited' : 'error', error: String(e.message).slice(0, 200) })
      repoStats.push({ repo: r.repo, error: String(e.message).slice(0, 200) })
      log.error?.(`skills: ${r.repo}: ${e.message}`)
      if (e.rateLimited) break
    }
  }
  return { observed, repos: repoStats, errors }
}
