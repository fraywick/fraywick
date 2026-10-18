// Writes test/vectors/merkle.json: leaves built exactly like the crawler builds them, the StandardMerkleTree root, and a proof per leaf.
// CONTRACTS copies it to contracts/test/vectors/merkle.json and checks ToolAnchor.verify() against it.
import { writeFileSync } from 'node:fs'
import { StandardMerkleTree } from '@openzeppelin/merkle-tree'
import { LEAF_ENCODING, ZERO32, serverLeaf, skillLeaf, packageLeaf, listHash, itemHash, leafHash, textHash, maintainersHash, npmIntegrityHash, EMPTY_LIST_HASH } from '../lib/hash.mjs'
import { canonicalize } from '../lib/jcs.mjs'

const tools = [
  { name: 'read_file', description: 'Read a file from the workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, annotations: { readOnlyHint: true } },
  { name: 'search', title: 'Search', description: 'Full-text search.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } } } },
]
const prompts = [{ name: 'summarize', description: 'Summarize a document', arguments: [{ name: 'doc', required: true }] }]
const toolHashes = tools.map((t) => itemHash('tool', t))
const leaves = [
  { key: 'io.github.example/files', values: serverLeaf('io.github.example/files', '1.2.0', listHash(toolHashes), listHash(prompts.map((p) => itemHash('prompt', p))), ZERO32) },
  { key: 'com.example/empty', values: serverLeaf('com.example/empty', '0.1.0', EMPTY_LIST_HASH, ZERO32, ZERO32) },
  { key: 'skill:anthropics/skills:skills/pdf/SKILL.md', values: skillLeaf('anthropics/skills', 'skills/pdf/SKILL.md', 'a'.repeat(40), textHash('---\nname: example\ndescription: Example skill\n---\n\n# Example\n')) },
  { key: 'npm:@modelcontextprotocol/server-everything', values: packageLeaf('npm', '@modelcontextprotocol/server-everything', '2026.7.1', npmIntegrityHash('sha512-AAAA'), maintainersHash(['alice', 'bob'])) },
  { key: 'pypi:mcp-server-fetch', values: packageLeaf('pypi', 'mcp-server-fetch', '0.6.3', textHash('sha256:' + 'b'.repeat(64)), maintainersHash(['Anthropic, PBC.'])) },
  { key: 'unicode:ünïcödé/日本', values: serverLeaf('unicode:ünïcödé/日本', 'v1-β', toolHashes[0], ZERO32, ZERO32) },
]
const tree = StandardMerkleTree.of(leaves.map((l) => l.values), LEAF_ENCODING)
const out = {
  ...tree.dump(),
  _doc: 'FRAYWICK merkle test vectors. Top level = StandardMerkleTree.dump() (format standard-v1: leafEncoding, tree, values[].value/treeIndex) + root. Leaf = keccak256(bytes.concat(keccak256(abi.encode(string,string,bytes32,bytes32,bytes32)))); OZ StandardMerkleTree (sorted pairs). epoch is arbitrary.',
  encoding: LEAF_ENCODING,
  epoch: 493000,
  root: tree.root,
  jcs: { input: tools[0], canonical: canonicalize(tools[0]), hash: toolHashes[0] },
  emptyListHash: EMPTY_LIST_HASH,
  leaves: leaves.map((l) => { let i; for (const [j, v] of tree.entries()) if (v[0] === l.key) i = j; return { key: l.key, values: l.values, leaf: tree.leafHash(l.values), proof: tree.getProof(i) } }),
  negative: { values: serverLeaf('io.github.example/files', '1.2.1', listHash(toolHashes), ZERO32, ZERO32), leaf: leafHash(serverLeaf('io.github.example/files', '1.2.1', listHash(toolHashes), ZERO32, ZERO32)), proofOf: 'io.github.example/files', expect: false },
}
for (const l of out.leaves) if (l.leaf !== leafHash(l.values)) throw new Error('leafHash mismatch')
writeFileSync(new URL('./vectors/merkle.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log('root', tree.root, 'leaves', leaves.length)
