// Chain + merkle helpers with no dependencies: keccak256, the StandardMerkleTree leaf encoding
// ["string","string","bytes32","bytes32","bytes32"], root rebuild, proof check, and eth_call against ToolAnchor on Robinhood Chain.
// Works in the browser and in node (used by web/dev scripts).

export const RPC = 'https://robinhood-rpc.publicnode.com'
export const CHAIN_ID = 4663

// ── keccak256 (Keccak-f[1600], 32-bit lane halves) ───────────────────────
const RC = [
  1, 0, 0x8082, 0, 0x808a, 0x80000000, 0x80008000, 0x80000000, 0x808b, 0, 0x80000001, 0, 0x80008081, 0x80000000, 0x8009, 0x80000000,
  0x8a, 0, 0x88, 0, 0x80008009, 0, 0x8000000a, 0, 0x8000808b, 0, 0x8b, 0x80000000, 0x8089, 0x80000000, 0x8003, 0x80000000,
  0x8002, 0x80000000, 0x80, 0x80000000, 0x800a, 0, 0x8000000a, 0x80000000, 0x80008081, 0x80000000, 0x8080, 0x80000000,
  0x80000001, 0, 0x80008008, 0x80000000,
]
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]
const PI = new Int32Array(25)
for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) PI[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5)

function keccakF(s, B, C) {
  for (let r = 0; r < 24; r++) {
    for (let x = 0; x < 5; x++) {
      C[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40]
      C[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41]
    }
    for (let x = 0; x < 5; x++) {
      const a = (x + 1) % 5, b = (x + 4) % 5
      const lo = C[2 * a], hi = C[2 * a + 1]
      const dl = C[2 * b] ^ ((lo << 1) | (hi >>> 31)), dh = C[2 * b + 1] ^ ((hi << 1) | (lo >>> 31))
      for (let y = 0; y < 25; y += 5) { s[2 * (x + y)] ^= dl; s[2 * (x + y) + 1] ^= dh }
    }
    for (let i = 0; i < 25; i++) {
      const lo = s[2 * i], hi = s[2 * i + 1], n = ROT[i], j = PI[i]
      if (n === 0) { B[2 * j] = lo; B[2 * j + 1] = hi }
      else if (n < 32) { B[2 * j] = (lo << n) | (hi >>> (32 - n)); B[2 * j + 1] = (hi << n) | (lo >>> (32 - n)) }
      else if (n === 32) { B[2 * j] = hi; B[2 * j + 1] = lo }
      else { const m = n - 32; B[2 * j] = (hi << m) | (lo >>> (32 - m)); B[2 * j + 1] = (lo << m) | (hi >>> (32 - m)) }
    }
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) {
      const i = x + y, a = (x + 1) % 5 + y, b = (x + 2) % 5 + y
      s[2 * i] = B[2 * i] ^ (~B[2 * a] & B[2 * b])
      s[2 * i + 1] = B[2 * i + 1] ^ (~B[2 * a + 1] & B[2 * b + 1])
    }
    s[0] ^= RC[2 * r]; s[1] ^= RC[2 * r + 1]
  }
}

export function keccak256(bytes) {
  if (typeof bytes === 'string') bytes = utf8(bytes)
  const rate = 136, s = new Int32Array(50), B = new Int32Array(50), C = new Int32Array(10)
  const padLen = rate - (bytes.length % rate)
  const msg = new Uint8Array(bytes.length + padLen)
  msg.set(bytes); msg[bytes.length] |= 0x01; msg[msg.length - 1] |= 0x80
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate; i += 4) s[i >> 2] ^= msg[off + i] | (msg[off + i + 1] << 8) | (msg[off + i + 2] << 16) | (msg[off + i + 3] << 24)
    keccakF(s, B, C)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = (s[i >> 2] >>> ((i & 3) * 8)) & 0xff
  return out
}

// ── bytes ────────────────────────────────────────────────────────────────
export const utf8 = (s) => new TextEncoder().encode(String(s))
export function hexToBytes(h) {
  const s = String(h).replace(/^0x/i, '')
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('bad hex')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16)
  return out
}
export const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const keccakHex = (b) => bytesToHex(keccak256(b))
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0))
  let o = 0
  for (const a of arrs) { out.set(a, o); o += a.length }
  return out
}
function word(n) { // uint → 32-byte big endian
  const out = new Uint8Array(32)
  let v = BigInt(n)
  for (let i = 31; i >= 0 && v > 0n; i--) { out[i] = Number(v & 0xffn); v >>= 8n }
  return out
}
const pad32 = (b) => concat(b, new Uint8Array((32 - (b.length % 32)) % 32))
const b32 = (h) => { const b = hexToBytes(h); if (b.length !== 32) throw new Error('bytes32 expected'); return b }

// ── StandardMerkleTree, leafEncoding ["string","string","bytes32","bytes32","bytes32"] ──
export const LEAF_ENCODING = ['string', 'string', 'bytes32', 'bytes32', 'bytes32']

export function encodeLeaf(values) {
  const [s1, s2, h1, h2, h3] = values
  const a = utf8(s1), b = utf8(s2)
  const tailA = concat(word(a.length), pad32(a))
  const tailB = concat(word(b.length), pad32(b))
  return concat(word(160), word(160 + tailA.length), b32(h1), b32(h2), b32(h3), tailA, tailB)
}
export const leafHash = (values) => keccakHex(keccak256(encodeLeaf(values)))

function cmp(a, b) { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0 }
function hashPair(a, b) { return cmp(a, b) <= 0 ? keccak256(concat(a, b)) : keccak256(concat(b, a)) }

// Same layout as @openzeppelin/merkle-tree makeMerkleTree with sorted leaves → root hex
export function merkleRoot(leafHashes) {
  if (!leafHashes.length) throw new Error('no leaves')
  const leaves = leafHashes.map(hexToBytes).sort(cmp)
  const tree = new Array(2 * leaves.length - 1)
  leaves.forEach((l, i) => (tree[tree.length - 1 - i] = l))
  for (let i = tree.length - 1 - leaves.length; i >= 0; i--) tree[i] = hashPair(tree[2 * i + 1], tree[2 * i + 2])
  return bytesToHex(tree[0])
}
// full OZ layout (sorted leaves) → { root, proofFor(leafHex) }
export function buildTree(leafHashes) {
  const leaves = leafHashes.map(hexToBytes).sort(cmp)
  const n = leaves.length
  const tree = new Array(2 * n - 1)
  leaves.forEach((l, i) => (tree[tree.length - 1 - i] = l))
  for (let i = tree.length - 1 - n; i >= 0; i--) tree[i] = hashPair(tree[2 * i + 1], tree[2 * i + 2])
  return {
    root: bytesToHex(tree[0]),
    proofFor(leafHex) {
      const b = hexToBytes(leafHex)
      let i = -1
      for (let k = tree.length - n; k < tree.length; k++) if (cmp(tree[k], b) === 0) { i = k; break }
      if (i < 0) return null
      const proof = []
      while (i > 0) { proof.push(bytesToHex(tree[i % 2 ? i + 1 : i - 1])); i = Math.floor((i - 1) / 2) }
      return proof
    },
  }
}
// list hash used for toolsHash / promptsHash / resourcesHash: keccak256(concat(sorted 32-byte hashes)); empty → keccak256(0x)
export function listHash(hashes) {
  const hs = hashes.map((h) => String(h).toLowerCase()).sort()
  const cat = new Uint8Array(hs.length * 32)
  hs.forEach((h, i) => cat.set(hexToBytes(h), i * 32))
  return keccakHex(cat)
}
export const word32 = (n) => bytesToHex(word(n)).slice(2)

export function processProof(leaf, proof) {
  let h = hexToBytes(leaf)
  for (const p of proof) h = hashPair(h, hexToBytes(p))
  return bytesToHex(h)
}

// Pull the leaf value arrays out of a snapshot file, whatever shape SERVER used (OZ dump, {leaves:[{values}]}, plain arrays).
export function snapshotLeaves(snap) {
  const src = snap?.tree?.values || snap?.values || snap?.leaves || snap?.items || []
  const out = []
  for (const l of src) {
    const v = Array.isArray(l) ? l : l.v || l.value || l.values || l.leaf?.values || null
    if (Array.isArray(v) && v.length === 5) out.push(v.map(String))
  }
  return out
}

// ── eth_call ─────────────────────────────────────────────────────────────
const SEL = {}
export const selector = (sig) => (SEL[sig] ||= bytesToHex(keccak256(sig)).slice(0, 10))

let rpcId = 1
export async function ethCall(to, data, rpc = RPC) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 12000)
  try {
    const r = await fetch(rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    })
    const j = await r.json()
    if (j.error) throw new Error(j.error.message || 'eth_call failed')
    return j.result
  } finally { clearTimeout(t) }
}

export async function chainVerify(contract, epoch, leaf, proof, rpc) {
  const head = concat(word(epoch), b32(leaf), word(96), word(proof.length), ...proof.map(b32))
  const res = await ethCall(contract, selector('verify(uint64,bytes32,bytes32[])') + bytesToHex(head).slice(2), rpc)
  return BigInt(res) === 1n
}

export async function chainAnchor(contract, epoch, rpc) {
  const res = await ethCall(contract, selector('anchors(uint64)') + bytesToHex(word(epoch)).slice(2), rpc)
  const h = String(res).slice(2)
  if (h.length < 192) return null
  return { root: '0x' + h.slice(0, 64), leafCount: Number(BigInt('0x' + h.slice(64, 128))), postedAt: Number(BigInt('0x' + h.slice(128, 192))) }
}

export async function chainLatestEpoch(contract, rpc) {
  return Number(BigInt(await ethCall(contract, selector('latestEpoch()'), rpc)))
}
