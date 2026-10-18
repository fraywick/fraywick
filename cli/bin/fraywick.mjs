#!/usr/bin/env node
// fraywick verify <mcp-url | npm:<pkg> | pypi:<pkg> | github SKILL.md url> [--epoch N] [--api URL] [--anchor 0x…] [--rpc URL] [--json]
// Fetches the target yourself, recomputes its hashes locally, gets the merkle proof from the FRAYWICK API, checks the proof locally
// and calls ToolAnchor.verify(epoch, leaf, proof) on Robinhood Chain. It never runs the target: MCP servers are only asked for their
// tool / prompt / resource lists, packages only for registry metadata, skills only as text.
// Exit codes: 0 = live target matches the anchored leaf and the chain confirms the proof · 1 = mismatch (changed since the anchor,
// or the proof / chain check failed) · 2 = could not check (unreachable, not anchored, bad input, config missing).
import { readFileSync } from 'node:fs'
import { createPublicClient, http, keccak256 } from 'viem'
import { createProbe } from '../lib/mcp-client.mjs'
import { itemHash, listHash, leafHash, verifyProof, ZERO32, npmIntegrityHash, pypiIntegrityHash, maintainersHash } from '../lib/hash.mjs'

const VERSION = '1.0.0'
const UA = `fraywick-cli/${VERSION}`
const ABI = [
  { type: 'function', name: 'verify', stateMutability: 'view', inputs: [{ name: 'epoch', type: 'uint64' }, { name: 'leaf', type: 'bytes32' }, { name: 'proof', type: 'bytes32[]' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'anchors', stateMutability: 'view', inputs: [{ name: 'epoch', type: 'uint64' }], outputs: [{ name: 'root', type: 'bytes32' }, { name: 'leafCount', type: 'uint32' }, { name: 'postedAt', type: 'uint64' }] },
]

function args(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); o[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true) } else o._.push(a)
  }
  return o
}
const cfg = (() => { try { return JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')) } catch { return {} } })()

/** fetch adapter for the shared MCP client (timeouts, 8 MB cap) */
function fetchHttp({ timeoutMs = 15_000, maxBytes = 8_000_000 } = {}) {
  return async ({ url, method = 'GET', headers = {}, body }) => {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    const r = await fetch(url, { method, headers: { 'user-agent': UA, ...headers }, body, signal: ac.signal, redirect: 'follow' })
    const hdrs = Object.fromEntries([...r.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]))
    let buf = null
    const out = {
      status: r.status, headers: hdrs,
      async *chunks() {
        let n = 0
        try { if (r.body) for await (const c of r.body) { n += c.length; if (n > maxBytes) throw new Error('response too large'); yield c } } finally { clearTimeout(t) }
      },
      async load() { if (buf) return buf; const parts = []; for await (const c of out.chunks()) parts.push(Buffer.from(c)); buf = Buffer.concat(parts); return buf },
      text() { return (buf || Buffer.alloc(0)).toString('utf8') },
      close() { clearTimeout(t); ac.abort() },
    }
    return out
  }
}
const getJson = async (url) => { const h = fetchHttp(); const r = await h({ url, headers: { accept: 'application/json' } }); await r.load(); let j = null; try { j = JSON.parse(r.text()) } catch {} return { status: r.status, json: j } }

function parseTarget(t) {
  const m = String(t || '').match(/^(npm|pypi):(.+)$/i)
  if (m) {
    const eco = m[1].toLowerCase()
    const name = eco === 'pypi' ? m[2].trim().toLowerCase().replace(/[-_.]+/g, '-') : m[2].trim().toLowerCase()
    return { type: eco, name, key: `${eco}:${name}` }
  }
  let u
  try { u = new URL(t) } catch { return null }
  const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (u.hostname === 'github.com' && seg.length >= 5 && (seg[2] === 'blob' || seg[2] === 'raw')) return { type: 'skill', repo: `${seg[0]}/${seg[1]}`, ref: seg[3], path: seg.slice(4).join('/') }
  if (u.hostname === 'raw.githubusercontent.com' && seg.length >= 4) {
    const heads = seg[2] === 'refs' && seg[3] === 'heads'
    return { type: 'skill', repo: `${seg[0]}/${seg[1]}`, ref: heads ? seg[4] : seg[2], path: seg.slice(heads ? 5 : 3).join('/') }
  }
  if (u.protocol === 'https:' || u.protocol === 'http:') return { type: 'mcp', url: u.toString() }
  return null
}

/** same as server/sources/packages.mjs: "Jane Doe <jane@x.org>" → "Jane Doe"; bare emails dropped */
const names = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\S+@\S+/g, '').trim().split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean)

async function liveValues(t) {
  if (t.type === 'mcp') {
    const probe = createProbe({ http: fetchHttp(), clientInfo: { name: 'fraywick-cli', version: VERSION }, userAgent: UA })
    const r = await probe(t.url)
    if (r.status !== 'ok') return { error: `${r.status}: ${r.error || ''}`.trim() }
    const h = (kind, list) => (Array.isArray(list) ? listHash(list.map((x) => itemHash(kind, x))) : ZERO32)
    return { lists: { tools: h('tool', r.tools), prompts: h('prompt', r.prompts), resources: h('resource', r.resources) }, toolHashes: (r.tools || []).map((x) => [x.name, itemHash('tool', x)]), era: r.era }
  }
  if (t.type === 'npm') {
    const enc = t.name.startsWith('@') ? '@' + encodeURIComponent(t.name.slice(1)) : encodeURIComponent(t.name)
    const { status, json: j } = await getJson(`https://registry.npmjs.org/${enc}/latest`)
    if (status !== 200 || !j?.version) return { error: `npm HTTP ${status}` }
    const integrity = j.dist?.integrity || (j.dist?.shasum ? `sha1-hex-${j.dist.shasum}` : null)
    const maint = (Array.isArray(j.maintainers) ? j.maintainers : []).map((m) => (typeof m === 'string' ? names(m)[0] : m?.name)).filter(Boolean).map(String)
    return { version: j.version, integrityHash: npmIntegrityHash(integrity), maintainersHash: maintainersHash(maint) }
  }
  if (t.type === 'pypi') {
    const { status, json: j } = await getJson(`https://pypi.org/pypi/${encodeURIComponent(t.name)}/json`)
    if (status !== 200 || !j?.info) return { error: `PyPI HTTP ${status}` }
    const i = j.info
    return { version: i.version, integrityHash: pypiIntegrityHash((j.urls || []).map((f) => f?.digests?.sha256).filter(Boolean)),
      maintainersHash: maintainersHash([...names(i.author), ...names(i.maintainer), ...names(i.author_email), ...names(i.maintainer_email)]) }
  }
  const h = fetchHttp()
  const r = await h({ url: `https://raw.githubusercontent.com/${t.repo}/${encodeURIComponent(t.ref)}/${t.path.split('/').map(encodeURIComponent).join('/')}` })
  const buf = await r.load()
  if (r.status !== 200) return { error: `raw.githubusercontent.com HTTP ${r.status}` }
  return { fileHash: keccak256(new Uint8Array(buf)) }
}

async function main() {
  const a = args(process.argv.slice(2))
  const [cmd, target] = a._
  if (cmd !== 'verify' || !target) {
    console.log('usage: fraywick verify <mcp-url | npm:<pkg> | pypi:<pkg> | https://github.com/<owner>/<repo>/blob/<ref>/<path>/SKILL.md> [--epoch N] [--api URL] [--anchor 0x…] [--rpc URL] [--json]')
    return 2
  }
  const api = String(a.api || process.env.FRAYWICK_API || cfg.api || '').replace(/\/+$/, '')
  const rpc = a.rpc || process.env.FRAYWICK_RPC || cfg.rpc || 'https://robinhood-rpc.publicnode.com'
  if (!api) { console.error('✗ no API configured (config.json "api", --api or FRAYWICK_API)'); return 2 }
  const t = parseTarget(target)
  if (!t) { console.error('✗ target must be an MCP URL, npm:<pkg>, pypi:<pkg> or a GitHub SKILL.md URL'); return 2 }
  const report = { target, type: t.type }
  const out = (code, msg) => { report.result = msg; report.exit = code; if (a.json) console.log(JSON.stringify(report, null, 2)); else console.log(`${code === 0 ? '✓' : '✗'} ${msg}`); return code }

  if (t.type === 'skill') t.key = `skill:${t.repo}:${t.path}`
  if (t.type === 'mcp') {
    const l = await getJson(`${api}/api/lookup?url=${encodeURIComponent(t.url)}`)
    if (l.status !== 200 || !l.json?.leafKey) return out(2, 'this URL is not tracked by FRAYWICK (not in any anchor)')
    t.key = l.json.leafKey
  }
  report.leafKey = t.key
  const pq = new URLSearchParams({ leafKey: t.key, ...(a.epoch ? { epoch: String(a.epoch) } : {}) })
  const p = await getJson(`${api}/api/proof?${pq}`)
  if (p.status !== 200 || !p.json?.found) return out(2, `no anchored epoch contains ${t.key}`)
  const pr = p.json
  report.epoch = pr.epoch; report.root = pr.root; report.onChainPerApi = !!pr.onChain

  const live = await liveValues(t)
  if (live.error) return out(2, `could not read the target: ${live.error}`)
  const v = pr.values
  const checks = []
  if (t.type === 'mcp') { checks.push(['tools', live.lists.tools, v[2]], ['prompts', live.lists.prompts, v[3]], ['resources', live.lists.resources, v[4]]) }
  else if (t.type === 'skill') checks.push(['SKILL.md', live.fileHash, v[2]])
  else checks.push(['version', live.version, v[1]], ['file hashes', live.integrityHash, v[2]], ['maintainers', live.maintainersHash, v[3]])
  report.checks = checks.map(([name, liveV, anchored]) => ({ name, live: liveV, anchored, match: String(liveV).toLowerCase() === String(anchored).toLowerCase() }))

  const leaf = leafHash(v)
  const localOk = leaf === pr.leafHash && verifyProof(pr.root, leaf, pr.proof)
  report.leafHash = leaf; report.proofValidLocally = localOk
  const anchor = a.anchor || process.env.FRAYWICK_ANCHOR || (cfg.anchor && !/^0x0{40}$/i.test(cfg.anchor) ? cfg.anchor : null) || pr.contract
  if (!anchor) return out(2, 'no ToolAnchor address (config.json "anchor" or --anchor)')
  report.contract = anchor; report.contractSource = a.anchor || process.env.FRAYWICK_ANCHOR || (cfg.anchor && !/^0x0{40}$/i.test(cfg.anchor)) ? 'pinned' : 'from API (not pinned)'
  let chainOk = false, chainRoot = null
  try {
    const c = createPublicClient({ transport: http(rpc, { timeout: 20_000 }) })
    const [root] = await c.readContract({ address: anchor, abi: ABI, functionName: 'anchors', args: [BigInt(pr.epoch)] })
    chainRoot = root
    chainOk = await c.readContract({ address: anchor, abi: ABI, functionName: 'verify', args: [BigInt(pr.epoch), leaf, pr.proof] })
  } catch (e) { return out(2, `chain read failed (${(e.shortMessage || e.message).slice(0, 120)})`) }
  report.chainRoot = chainRoot; report.chainVerify = chainOk

  if (!a.json) {
    console.log(`  ${t.key} · epoch ${pr.epoch} (${new Date(pr.epoch * 3_600_000).toISOString()}) · root ${pr.root}`)
    for (const c of report.checks) console.log(`  ${c.match ? '=' : '≠'} ${c.name.padEnd(12)} live ${String(c.live).slice(0, 20)}…  anchored ${String(c.anchored).slice(0, 20)}…`)
    console.log(`  proof ${localOk ? 'valid' : 'INVALID'} locally · ToolAnchor.verify on Robinhood Chain: ${chainOk} (${report.contractSource} ${anchor})`)
  }
  if (localOk && /^0x0{64}$/i.test(String(chainRoot))) return out(2, `epoch ${pr.epoch} is not anchored on chain (yet)`)
  if (!localOk || !chainOk || (chainRoot && chainRoot.toLowerCase() !== pr.root.toLowerCase())) return out(1, 'the proof does not verify against the chain')
  const changed = report.checks.filter((c) => !c.match)
  if (changed.length) return out(1, `changed since epoch ${pr.epoch}: ${changed.map((c) => c.name).join(', ')}`)
  return out(0, `matches the anchor of epoch ${pr.epoch}, confirmed on Robinhood Chain`)
}

main().then((code) => process.exit(code), (e) => { console.error(`✗ ${e.message}`); process.exit(2) })
