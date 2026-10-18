// Epoch job: leaves from this epoch's fresh observations → StandardMerkleTree → data/snapshots/<epoch>.json.gz → post the root
// (unless DRY_POST) → flag() the top suspicious changes (max 10). Never re-posts an epoch at or below the chain's latestEpoch.
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { StandardMerkleTree } from '@openzeppelin/merkle-tree'
import { LEAF_ENCODING, ZERO32, serverLeaf, skillLeaf, packageLeaf, listHash, itemHash, leafHash, textHash, viewOf } from './lib/hash.mjs'
import { paths, publicUrl, dryPost, iso } from './config.mjs'
import { errName } from './chain.mjs'
import { selfServer } from './mcp-server.mjs'
import { writeObject } from './objects.mjs'

export const SNAPSHOT_FORMAT = 'fraywick-snapshot/1'
export const MAX_FLAGS = 10
const snapFile = (epoch) => join(paths.snapshots(), `${epoch}.json.gz`)

/** our own /mcp tools, hashed exactly like any other server (they appear in our own snapshot) */
export function selfLeaf() {
  const s = selfServer()
  const items = s.tools.map((t) => ({ name: t.name, hash: itemHash('tool', t) }))
  return { key: s.id, type: 'server', values: serverLeaf(s.id, s.version, listHash(items.map((i) => i.hash)), ZERO32, ZERO32), detail: { url: s.url, era: 'modern', tools: items.map((i) => [i.name, i.hash]), prompts: null, resources: null }, tools: s.tools }
}

export function collectLeaves(store, epoch) {
  const leaves = []
  const keys = new Set()
  const push = (l) => { if (keys.has(l.key)) return; keys.add(l.key); leaves.push(l) }
  const self = selfLeaf()
  for (const t of self.tools) writeObject(itemHash('tool', t), viewOf('tool', t))
  push({ key: self.key, type: self.type, values: self.values, detail: self.detail })
  for (const p of store.okProbes(epoch)) {
    const items = store.itemsOf(p.server_id, { live: true }).filter((i) => i.last_epoch === epoch)
    const pick = (kind) => items.filter((i) => i.kind === kind).map((i) => [i.name, i.hash])
    push({ key: p.server_id, type: 'server', values: serverLeaf(p.server_id, p.version ?? '', p.tools_hash, p.prompts_hash || ZERO32, p.resources_hash || ZERO32),
      detail: { url: p.url, era: p.era, pv: p.protocol_version, tools: pick('tool'), prompts: p.prompts_hash && p.prompts_hash !== ZERO32 ? pick('prompt') : null,
        resources: p.resources_hash && p.resources_hash !== ZERO32 ? pick('resource') : null } })
  }
  for (const s of store.skillsOk(epoch)) {
    if (!s.file_hash || !s.commit_sha) continue
    push({ key: `skill:${s.repo}:${s.path}`, type: 'skill', values: skillLeaf(s.repo, s.path, s.commit_sha, s.file_hash), detail: { repo: s.repo, path: s.path, blob: s.blob_sha, size: s.size } })
  }
  for (const k of store.packagesOk(epoch)) {
    if (!k.version) continue
    push({ key: k.key, type: 'package', values: packageLeaf(k.eco, k.name, k.version, k.integrity_hash || ZERO32, k.maintainers_hash || ZERO32), detail: { integrity: k.integrity, maintainers: k.maintainers } })
  }
  return leaves
}

/** build + store the snapshot for an epoch (idempotent: rebuilding gives the same root for the same observations) */
export function buildEpoch(store, epoch, { stats = null, now = Date.now() } = {}) {
  const leaves = collectLeaves(store, epoch)
  if (!leaves.length) throw new Error('no leaves')
  const tree = StandardMerkleTree.of(leaves.map((l) => l.values), LEAF_ENCODING)
  const changes = store.changesOfEpoch(epoch).map((c) => ({ id: c.id, item: c.item_id, kind: c.kind, change: c.change, score: c.score, label: c.label, old: c.old_hash, new: c.new_hash }))
  const base = publicUrl()
  const snapshot = {
    format: SNAPSHOT_FORMAT, epoch, hour: iso(epoch * 3_600_000), builtAt: iso(now), root: tree.root, leafCount: leaves.length,
    encoding: LEAF_ENCODING,
    hashing: {
      item: 'keccak256(utf8(JCS(view))) · tool view {name,title,description,inputSchema,outputSchema,annotations} · prompt {name,title,description,arguments} · resource {uri,name,title,description,mimeType}',
      list: 'keccak256(concat(sorted item hashes)); empty list = keccak256(0x); not advertised / unreadable = bytes32(0)',
      leaf: 'StandardMerkleTree leaf = keccak256(bytes.concat(keccak256(abi.encode(values)))) over ["string","string","bytes32","bytes32","bytes32"]',
      objects: `${base || ''}/snapshots/objects/<hash without 0x>.json (JCS bytes) or .txt (raw bytes); keccak256(file) = hash`,
      docs: `${base || ''}/docs#hashing`,
    },
    stats, changes,
    leaves: leaves.map((l) => ({ k: l.key, t: l.type, v: l.values, h: leafHash(l.values), d: l.detail })),
  }
  const gz = gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 })
  mkdirSync(paths.snapshots(), { recursive: true })
  const f = snapFile(epoch)
  writeFileSync(f + '.tmp', gz); renameSync(f + '.tmp', f)
  const sha = createHash('sha256').update(gz).digest('hex')
  store.putEpoch({ epoch, startedAt: stats?.startedAt ?? now, builtAt: now, root: tree.root, leafCount: leaves.length, snapshot: `${epoch}.json`, snapshotSha256: sha, stats,
    postStatus: dryPost() ? 'dry' : 'pending' })
  // an older epoch that never made it on chain is abandoned: epochs only move forward
  for (const p of store.pendingPosts()) if (p.epoch < epoch) store.setPost(p.epoch, { status: 'skipped', error: `superseded by epoch ${epoch}` })
  cache.delete(epoch)
  return { epoch, root: tree.root, leafCount: leaves.length, bytes: gz.length }
}

// ───────────────────────────── snapshot reading + proofs (API, MCP, CLI support)
const cache = new Map()
export function loadSnapshot(epoch) {
  if (cache.has(epoch)) return cache.get(epoch)
  const f = snapFile(epoch)
  if (!existsSync(f)) return null
  const snap = JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'))
  const tree = StandardMerkleTree.of(snap.leaves.map((l) => l.v), snap.encoding)
  const index = new Map()
  for (const [i, v] of tree.entries()) index.set(v[0], i)
  const entry = { snap, tree, index }
  cache.set(epoch, entry)
  while (cache.size > 3) cache.delete(cache.keys().next().value)
  return entry
}
export const snapshotBytes = (epoch) => { const f = snapFile(epoch); return existsSync(f) ? readFileSync(f) : null }

export function proofOf(epoch, leafKey) {
  const e = loadSnapshot(epoch)
  if (!e) return null
  const i = e.index.get(leafKey)
  if (i === undefined) return { epoch, root: e.tree.root, found: false }
  const values = e.tree.at(i)
  const leaf = e.snap.leaves.find((l) => l.k === leafKey)
  return { epoch, root: e.tree.root, found: true, leafKey, values, leafHash: e.tree.leafHash(values), proof: e.tree.getProof(i), encoding: LEAF_ENCODING, detail: leaf?.d ?? null }
}

// ───────────────────────────── posting
export function createPoster({ store, chain, log = console, now = () => Date.now() }) {
  let busy = false
  const lastTry = new Map()
  async function postOne(row) {
    lastTry.set(row.epoch, now())
    const epoch = row.epoch
    if (dryPost()) { store.setPost(epoch, { status: 'dry' }); return { status: 'dry' } }
    const base = publicUrl()
    if (!base) { store.setPost(epoch, { status: 'pending', error: 'PUBLIC_URL not set (snapshot URI unknown)' }); return { status: 'pending' } }
    if (!chain.canSend()) { store.setPost(epoch, { status: 'pending', error: chain.address() ? 'no poster key loaded' : 'no ToolAnchor address yet' }); return { status: 'pending' } }
    const latest = await chain.latestEpoch()
    if (latest >= epoch) {
      const a = await chain.anchorOf(epoch)
      if (a.root && a.root.toLowerCase() === row.root.toLowerCase()) { store.setPost(epoch, { status: 'confirmed', postedAt: a.postedAt * 1000, error: null }); return { status: 'confirmed' } }
      store.setPost(epoch, { status: 'skipped', error: `chain latestEpoch ${latest} ≥ ${epoch}` })
      return { status: 'skipped' }
    }
    if (row.post_status === 'sent' && row.tx) {
      const rc = await chain.receipt(row.tx)
      if (!rc) return { status: 'sent' }
      if (rc.status !== 'success') { store.setPost(epoch, { status: 'failed', error: 'tx reverted', attempt: 0 }) }
    }
    try {
      const r = await chain.write('post', [BigInt(epoch), row.root, Number(row.leaf_count), `${base}/snapshots/${epoch}.json`])
      store.setPost(epoch, { status: r.pending ? 'sent' : 'confirmed', tx: r.hash, block: r.block, postedAt: now(), error: null, attempt: 1 })
      log.log?.(`epoch ${epoch}: post ${r.pending ? 'sent' : 'confirmed'} ${r.hash}`)
      return { status: r.pending ? 'sent' : 'confirmed', tx: r.hash }
    } catch (e) {
      store.setPost(epoch, { status: 'failed', error: errName(e), attempt: 1 })
      log.error?.(`epoch ${epoch}: post failed: ${errName(e)}`)
      return { status: 'failed', error: errName(e) }
    }
  }

  async function flags(epoch) {
    if (dryPost() || !chain.canSend()) return
    const sus = store.changesOfEpoch(epoch).filter((c) => c.label === 'suspicious' && !c.flag_status).slice(0, MAX_FLAGS)
    const already = store.changesOfEpoch(epoch).filter((c) => c.flag_status === 'confirmed' || c.flag_status === 'sent').length
    for (const c of sus.slice(0, Math.max(0, MAX_FLAGS - already))) {
      const note = `${c.label} ${c.score}: ${(c.reasons || []).filter((r) => r.points > 0).map((r) => r.code).join(',')}`.slice(0, 180)
      try {
        const r = await chain.write('flag', [BigInt(epoch), textHash(c.item_id), c.old_hash || ZERO32, c.new_hash || ZERO32, Math.min(255, c.score), note])
        store.setFlag(c.id, r.pending ? 'sent' : 'confirmed', r.hash, null)
      } catch (e) { store.setFlag(c.id, 'failed', null, errName(e)); log.error?.(`flag ${c.id}: ${errName(e)}`) }
    }
  }

  /** post the newest built epoch if needed (retries with backoff); then its flags */
  async function tick() {
    if (busy) return
    busy = true
    try {
      const row = store.lastBuilt()
      if (!row) return
      if (['pending', 'failed', 'sent'].includes(row.post_status)) {
        if (row.post_status === 'failed' && row.attempts >= 8) return
        const wait = row.post_status === 'failed' ? Math.min(15, 2 ** row.attempts) * 60_000 : 0
        if (lastTry.has(row.epoch) && now() - lastTry.get(row.epoch) < Math.max(wait, row.post_status === 'sent' ? 30_000 : 0)) return
        const r = await postOne(row)
        if (r.status === 'confirmed') await flags(row.epoch)
      } else if (row.post_status === 'confirmed') await flags(row.epoch)
    } catch (e) { log.error?.(`poster: ${errName(e)}`) }
    finally { busy = false }
  }
  return { tick, postOne }
}
