// FRAYWICK hashing (documented in server/README.md and /docs). Shared verbatim with cli/lib/hash.mjs.
//   item hash  = keccak256(utf8(JCS(view)))   view = the fields below, missing fields omitted
//     tool      {name, title, description, inputSchema, outputSchema, annotations}
//     prompt    {name, title, description, arguments}
//     resource  {uri, name, title, description, mimeType}
//   list hash  = keccak256(concat(sorted item hashes as 32-byte values)); an empty list → keccak256(0x);
//                a list the server does not advertise (or that could not be read) → bytes32(0)
//   leaf       StandardMerkleTree leaf over ["string","string","bytes32","bytes32","bytes32"]:
//     server    [serverId, version, toolsHash, promptsHash, resourcesHash]
//     skill     ["skill:"+repo+":"+path, commit, keccak256(SKILL.md bytes), 0, 0]
//     package   ["npm:"+name | "pypi:"+name, version, integrityHash, maintainersHash, 0]
//   leaf hash  = keccak256(bytes.concat(keccak256(abi.encode(values))))
import { keccak256, toBytes, concat, encodeAbiParameters } from 'viem'
import { canonicalize } from './jcs.mjs'

export const LEAF_ENCODING = ['string', 'string', 'bytes32', 'bytes32', 'bytes32']
export const ZERO32 = '0x' + '0'.repeat(64)
export const EMPTY_LIST_HASH = keccak256('0x')

const pick = (o, keys) => {
  const out = {}
  if (!o || typeof o !== 'object') return out
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined) out[k] = o[k]
  return out
}
export const VIEW_KEYS = {
  tool: ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'],
  prompt: ['name', 'title', 'description', 'arguments'],
  resource: ['uri', 'name', 'title', 'description', 'mimeType'],
}
export const viewOf = (kind, item) => pick(item, VIEW_KEYS[kind])
export const hashJson = (obj) => keccak256(toBytes(canonicalize(obj)))
export const itemHash = (kind, item) => hashJson(viewOf(kind, item))
export const textHash = (s) => keccak256(toBytes(String(s)))
export const bytesHash = (u8) => keccak256(u8)

/** sorted concatenation of 32-byte hashes; null → bytes32(0) (not advertised / unreadable) */
export function listHash(hashes) {
  if (hashes == null) return ZERO32
  if (!hashes.length) return EMPTY_LIST_HASH
  return keccak256(concat([...hashes].map((h) => h.toLowerCase()).sort()))
}

export const serverLeaf = (serverId, version, tools, prompts, resources) => [String(serverId), String(version ?? ''), tools, prompts, resources]
export const skillLeaf = (repo, path, commit, fileHash) => [`skill:${repo}:${path}`, String(commit), fileHash, ZERO32, ZERO32]
export const packageLeaf = (eco, name, version, integrityHash, maintainersHash) => [`${eco}:${name}`, String(version ?? ''), integrityHash, maintainersHash, ZERO32]

/** maintainers → keccak256(utf8(JCS(sorted unique names))) */
export const maintainersHash = (names) => hashJson([...new Set((names || []).map((n) => String(n).trim()).filter(Boolean))].sort())
/** npm: keccak256(utf8(dist.integrity)); PyPI: keccak256(utf8(sorted "sha256:<hex>" of every file of the release, joined by "\n")) */
export const npmIntegrityHash = (integrity) => (integrity ? textHash(integrity) : ZERO32)
export const pypiIntegrityText = (sha256s) => [...new Set((sha256s || []).map((s) => 'sha256:' + s.toLowerCase()))].sort().join('\n')
export const pypiIntegrityHash = (sha256s) => (sha256s && sha256s.length ? textHash(pypiIntegrityText(sha256s)) : ZERO32)

export function leafHash(values) {
  return keccak256(keccak256(encodeAbiParameters(LEAF_ENCODING.map((type) => ({ type })), values)))
}
/** OZ MerkleProof.verify (sorted pairs) */
export function processProof(leaf, proof) {
  let h = leaf
  for (const p of proof) h = h.toLowerCase() < p.toLowerCase() ? keccak256(concat([h, p])) : keccak256(concat([p, h]))
  return h
}
export const verifyProof = (root, leaf, proof) => processProof(leaf, proof).toLowerCase() === String(root).toLowerCase()
