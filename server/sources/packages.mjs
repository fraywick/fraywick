// Package metadata only (never installed, never executed): npm `/<pkg>/latest` and PyPI `/pypi/<pkg>/json`.
// npm: version, dist.integrity, maintainers (names), _npmUser · PyPI: version, sha256 of every file of the release, author/maintainer names,
// upload time. ETag / If-None-Match keeps hourly checks cheap.
import { request } from '../net.mjs'
import { userAgent } from '../config.mjs'
import { npmIntegrityHash, pypiIntegrityHash, pypiIntegrityText, maintainersHash } from '../lib/hash.mjs'

export const NPM = process.env.NPM_REGISTRY || 'https://registry.npmjs.org'
export const PYPI = process.env.PYPI_URL || 'https://pypi.org'
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const PYPI_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/

export function packageKey(eco, name) {
  if (eco === 'npm') { const n = String(name).trim().toLowerCase(); return NPM_NAME.test(n) && n.length <= 214 ? `npm:${n}` : null }
  if (eco === 'pypi') { const n = String(name).trim().toLowerCase().replace(/[-_.]+/g, '-'); return PYPI_NAME.test(n) && n.length <= 200 ? `pypi:${n}` : null }
  return null
}
/** "Jane Doe <jane@x.org>" → "Jane Doe"; bare emails are dropped (we keep names only) */
const nameOnly = (s) => {
  const t = String(s || '').replace(/<[^>]*>/g, '').replace(/\S+@\S+/g, '').trim()
  return t.split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean)
}

export async function fetchNpm(name, { etag = null, policy = { mode: 'crawl' }, deadline, timeoutMs = 15_000 } = {}) {
  const enc = name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name)
  const res = await request({ url: `${NPM}/${enc}/latest`, headers: { accept: 'application/json', 'user-agent': userAgent(), ...(etag ? { 'if-none-match': etag } : {}) },
    policy, deadline, timeoutMs, maxBytes: 4_000_000 })
  if (res.status === 304) return { notModified: true }
  if (res.status === 404) return { status: 'not_found' }
  if (res.status !== 200) return { status: 'error', error: `npm HTTP ${res.status}` }
  const j = res.json()
  if (!j || typeof j.version !== 'string') return { status: 'error', error: 'npm: unexpected body' }
  const maint = (Array.isArray(j.maintainers) ? j.maintainers : []).map((m) => (typeof m === 'string' ? nameOnly(m)[0] : m?.name)).filter(Boolean).map(String)
  const integrity = typeof j.dist?.integrity === 'string' ? j.dist.integrity.slice(0, 200) : (typeof j.dist?.shasum === 'string' ? `sha1-hex-${j.dist.shasum}` : null)
  return {
    status: 'ok', version: j.version.slice(0, 100), integrity, integrityHash: npmIntegrityHash(integrity), integrityText: integrity,
    maintainers: [...new Set(maint)].sort(), maintainersHash: maintainersHash(maint), publisher: typeof j._npmUser?.name === 'string' ? j._npmUser.name : null,
    publishedAt: null, etag: res.headers.etag || null,
  }
}

export async function fetchPypi(name, { etag = null, policy = { mode: 'crawl' }, deadline, timeoutMs = 15_000 } = {}) {
  const res = await request({ url: `${PYPI}/pypi/${encodeURIComponent(name)}/json`, headers: { accept: 'application/json', 'user-agent': userAgent(), ...(etag ? { 'if-none-match': etag } : {}) },
    policy, deadline, timeoutMs, maxBytes: 16_000_000 })
  if (res.status === 304) return { notModified: true }
  if (res.status === 404) return { status: 'not_found' }
  if (res.status !== 200) return { status: 'error', error: `PyPI HTTP ${res.status}` }
  const j = res.json()
  const info = j?.info
  if (!info || typeof info.version !== 'string') return { status: 'error', error: 'PyPI: unexpected body' }
  const files = Array.isArray(j.urls) ? j.urls : []
  const shas = files.map((f) => f?.digests?.sha256).filter((s) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s))
  const maint = [...nameOnly(info.author), ...nameOnly(info.maintainer), ...nameOnly(info.author_email), ...nameOnly(info.maintainer_email)]
  const uploaded = files.map((f) => f?.upload_time_iso_8601).filter((x) => typeof x === 'string').sort()[0] || null
  return {
    status: 'ok', version: info.version.slice(0, 100), integrity: shas.length ? `sha256:${[...shas].sort()[0]}${shas.length > 1 ? ` (+${shas.length - 1} files)` : ''}` : null,
    integrityHash: pypiIntegrityHash(shas), integrityText: shas.length ? pypiIntegrityText(shas) : null,
    files: files.filter((f) => typeof f?.filename === 'string' && /^[0-9a-f]{64}$/i.test(f?.digests?.sha256 || '')).map((f) => [f.filename.slice(0, 200), f.digests.sha256.toLowerCase()]).sort((a, b) => (a[0] < b[0] ? -1 : 1)), maintainers: [...new Set(maint)].sort(), maintainersHash: maintainersHash(maint),
    publishedAt: uploaded, etag: res.headers.etag || null,
  }
}

export async function fetchPackage(key, opts = {}) {
  const i = key.indexOf(':')
  const eco = key.slice(0, i), name = key.slice(i + 1)
  if (eco === 'npm') return fetchNpm(name, opts)
  if (eco === 'pypi') return fetchPypi(name, opts)
  return { status: 'error', error: 'unsupported registry' }
}
