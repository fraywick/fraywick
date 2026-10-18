import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { StandardMerkleTree } from '@openzeppelin/merkle-tree'
import { keccak256, toBytes } from 'viem'
import { canonicalize } from '../lib/jcs.mjs'
import { itemHash, listHash, leafHash, LEAF_ENCODING, ZERO32, EMPTY_LIST_HASH, serverLeaf, skillLeaf, packageLeaf, verifyProof, viewOf, maintainersHash } from '../lib/hash.mjs'

test('JCS: RFC 8785 examples', () => {
  // RFC 8785 §3.2.2 / Appendix B number serialization
  const nums = [[0, '0'], [-0, '0'], [1e21, '1e+21'], [1e-7, '1e-7'], [333333333.33333329, '333333333.3333333'], [5e-324, '5e-324'], [9007199254740992, '9007199254740992'], [1.7976931348623157e308, '1.7976931348623157e+308']]
  for (const [n, s] of nums) assert.equal(canonicalize(n), s)
  // §3.2.3 sorting by UTF-16 code units
  const c = String.fromCharCode, k = { euro: c(0x20ac), dalet: c(0xfb33), emoji: c(0xd83d, 0xde00), ctl: c(0x80), o: c(0xf6) }
  const sorted = canonicalize({ [k.euro]: 'Euro Sign', '\r': 'Carriage Return', [k.dalet]: 'Hebrew Letter Dalet With Dagesh', '1': 'One', [k.emoji]: 'Emoji: Grinning Face', [k.ctl]: 'Control', [k.o]: 'Latin Small Letter O With Diaeresis' })
  assert.equal(sorted, `{"\\r":"Carriage Return","1":"One","${k.ctl}":"Control","${k.o}":"Latin Small Letter O With Diaeresis","${k.euro}":"Euro Sign","${k.emoji}":"Emoji: Grinning Face","${k.dalet}":"Hebrew Letter Dalet With Dagesh"}`)
  // §3.2.4 example
  const input = { numbers: [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], string: k.euro + '$' + c(0x0f) + c(0x0a) + 'A' + c(0x27) + 'B' + c(0x22) + c(0x5c) + c(0x5c) + c(0x22) + '/', literals: [null, true, false] }
  const bs = c(0x5c), q = c(0x22)
  assert.equal(canonicalize(input), '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"' + k.euro + '$' + bs + 'u000f' + bs + 'nA' + c(0x27) + 'B' + bs + q + bs + bs + bs + bs + bs + q + '/"}')
  assert.throws(() => canonicalize({ a: NaN }))
  assert.throws(() => canonicalize(c(0xd800)))
  assert.equal(canonicalize({ b: undefined, a: [undefined] }), '{"a":[null]}')
})

test('tool hash: view fields only, key order and extra fields do not matter', () => {
  const a = { name: 'x', description: 'd', inputSchema: { type: 'object', properties: { b: { type: 'string' }, a: { type: 'number' } } } }
  const b = { inputSchema: { properties: { a: { type: 'number' }, b: { type: 'string' } }, type: 'object' }, description: 'd', name: 'x', _meta: { x: 1 }, icons: [] }
  assert.equal(itemHash('tool', a), itemHash('tool', b))
  assert.equal(itemHash('tool', a), keccak256(toBytes(canonicalize(viewOf('tool', a)))))
  assert.notEqual(itemHash('tool', a), itemHash('tool', { ...a, description: 'd ' }))
  assert.deepEqual(Object.keys(viewOf('tool', { name: 'n', title: null })), ['name', 'title'])
})

test('list hash: order independent; empty vs not advertised', () => {
  const h = ['0x' + '11'.repeat(32), '0x' + 'ab'.repeat(32), '0x' + '02'.repeat(32)]
  assert.equal(listHash(h), listHash([...h].reverse()))
  assert.equal(listHash([]), EMPTY_LIST_HASH)
  assert.equal(listHash(null), ZERO32)
  assert.equal(EMPTY_LIST_HASH, keccak256('0x'))
})

test('leaf hash equals @openzeppelin/merkle-tree and proofs verify (sorted pairs)', () => {
  const values = [
    serverLeaf('io.github.a/b', '1.0.0', listHash(['0x' + '01'.repeat(32)]), ZERO32, ZERO32),
    skillLeaf('anthropics/skills', 'skills/pdf/SKILL.md', 'f'.repeat(40), '0x' + '22'.repeat(32)),
    packageLeaf('npm', 'left-pad', '1.3.0', '0x' + '33'.repeat(32), maintainersHash(['b', 'a', 'a'])),
  ]
  const tree = StandardMerkleTree.of(values, LEAF_ENCODING)
  for (const [i, v] of tree.entries()) {
    assert.equal(leafHash(v), tree.leafHash(v))
    assert.ok(verifyProof(tree.root, leafHash(v), tree.getProof(i)))
    assert.ok(!verifyProof(tree.root, leafHash([...v.slice(0, 1), 'x', ...v.slice(2)]), tree.getProof(i)))
  }
  assert.equal(maintainersHash(['b', 'a', 'a']), maintainersHash(['a', 'b']))
})

test('vectors file matches the current code', () => {
  const v = JSON.parse(readFileSync(new URL('./vectors/merkle.json', import.meta.url), 'utf8'))
  const tree = StandardMerkleTree.of(v.leaves.map((l) => l.values), v.encoding)
  assert.equal(tree.root, v.root)
  assert.equal(StandardMerkleTree.load({ format: v.format, leafEncoding: v.leafEncoding, tree: v.tree, values: v.values }).root, v.root)
  for (const l of v.leaves) { assert.equal(leafHash(l.values), l.leaf); assert.ok(verifyProof(v.root, l.leaf, l.proof)) }
  const p = v.leaves.find((l) => l.key === v.negative.proofOf).proof
  assert.equal(verifyProof(v.root, v.negative.leaf, p), false)
  assert.equal(canonicalize(v.jcs.input), v.jcs.canonical)
  assert.equal(itemHash('tool', v.jcs.input), v.jcs.hash)
})
