// Module worker: download one snapshot, hash every leaf, rebuild the StandardMerkleTree, pick a sample leaf and its proof.
import { leafHash, buildTree, snapshotLeaves } from './chain.js'

self.onmessage = async (e) => {
  const { url } = e.data
  const post = (m) => self.postMessage(m)
  try {
    const t0 = performance.now()
    post({ stage: 'download', text: 'downloading snapshot…' })
    const r = await fetch(url)
    if (!r.ok) throw new Error(`snapshot ${r.status}`)
    const total = Number(r.headers.get('content-length')) || 0
    const reader = r.body.getReader()
    const chunks = []
    let got = 0, lastPost = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value); got += value.length
      if (performance.now() - lastPost > 200) { lastPost = performance.now(); post({ stage: 'download', got, total }) }
    }
    const bytes = new Uint8Array(got); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length }
    const tDl = performance.now()
    post({ stage: 'parse', text: `parsing ${(got / 1e6).toFixed(1)} MB…` })
    const snap = JSON.parse(new TextDecoder().decode(bytes))
    const values = snapshotLeaves(snap)
    const hashes = new Array(values.length)
    for (let i = 0; i < values.length; i++) {
      hashes[i] = leafHash(values[i])
      if (i % 2000 === 0) post({ stage: 'hash', done: i, total: values.length })
    }
    const listed = (snap.leaves || []).map((l) => l.h || null)
    const mismatched = listed.length === hashes.length ? hashes.filter((h, i) => listed[i] && h !== listed[i]).length : null
    post({ stage: 'tree', text: 'building the merkle tree…' })
    const tree = buildTree(hashes)
    // sample: a server leaf that lists tools (deterministic per epoch)
    const cands = []
    ;(snap.leaves || []).forEach((l, i) => { if (l.t === 'server' && l.d?.tools?.length && l.k !== 'fraywick:self') cands.push(i) })
    const si = cands.length ? cands[(Number(snap.epoch) * 7919) % cands.length] : 0
    const sample = values.length ? { key: values[si][0], values: values[si], leaf: hashes[si], proof: tree.proofFor(hashes[si]), tools: snap.leaves?.[si]?.d?.tools?.length ?? null } : null
    post({ stage: 'done', root: tree.root, fileRoot: snap.root || null, leaves: values.length, mismatched, bytes: got, msDownload: Math.round(tDl - t0), msCompute: Math.round(performance.now() - tDl), sample })
  } catch (err) {
    post({ stage: 'error', text: err.message })
  }
}
