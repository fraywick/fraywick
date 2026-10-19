// Scorer v2 noise control on fixtures shaped like the live offenders (19 Oct): rotating 2000-item resource lists, counters in
// descriptions, enum order shuffles, PyPI file lists flapping, mass tool removals.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tempDir } from './helpers.mjs'

process.env.DATA_DIR = tempDir()
const { openStore } = await import('../store.mjs')
const { applyProbe, unstableKinds } = await import('../crawl.mjs')
const { observe } = await import('../observe.mjs')
const { rescoreAll, summary } = await import('../migrate.mjs')
const { createApi } = await import('../api.mjs')

const E = 497900
const T = Date.UTC(2026, 9, 19, 1)
const ok = (tools, extra = {}) => ({ status: 'ok', era: 'legacy', tools, prompts: null, resources: null, ...extra })
const tool = (name, description, extra = {}) => ({ name, description, inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, ...extra })
const fresh = (id) => { const s = openStore({ memory: true }); s.putServer({ id, version: '1' }, 1); return s }
const probe = (s, id, epoch, res, at = T + (epoch - E) * 3_600_000) => applyProbe(s, { serverId: id, url: 'u', type: 'x', epoch, at, res })

test('removed → re-added with the same hash within 24 h: both hidden as flap', () => {
  const s = fresh('io.x/a')
  const A = [tool('a', 'Alpha.'), tool('b', 'Beta.')]
  probe(s, 'io.x/a', E, ok(A))
  probe(s, 'io.x/a', E + 1, ok([A[0]]))
  assert.equal(s.feed().length, 1)
  probe(s, 'io.x/a', E + 2, ok(A))
  assert.equal(s.feed().length, 0)
  assert.equal(s.feed({ all: true }).filter((c) => c.suppressed === 'flap').length, 2)
})

test('A → B → A oscillation is a flap; a real change stays', () => {
  const s = fresh('io.x/o')
  probe(s, 'io.x/o', E, ok([tool('t', 'Version one of the tool.')]))
  probe(s, 'io.x/o', E + 1, ok([tool('t', 'Version two of the tool, different words.')]))
  probe(s, 'io.x/o', E + 2, ok([tool('t', 'Version one of the tool.')]))
  assert.equal(s.feed().length, 0)
  probe(s, 'io.x/o', E + 3, ok([tool('t', 'A genuinely new description.')]))
  assert.equal(s.feed().length, 1)
})

test('rotating subset at the 2000 cap: no item-level added/removed, one partial note per 24 h', () => {
  const s = fresh('io.x/rot')
  const res = (off) => ok([tool('t', 'x')], { resources: Array.from({ length: 2000 }, (_, i) => ({ uri: `r://${(i + off) % 2600}`, name: `r${(i + off) % 2600}` })), truncatedKinds: ['resource'] })
  probe(s, 'io.x/rot', E, res(0))
  probe(s, 'io.x/rot', E + 1, res(300))
  probe(s, 'io.x/rot', E + 2, res(600))
  const vis = s.feed({ limit: 5000 })
  assert.equal(vis.length, 1, JSON.stringify(vis.map((c) => c.change)))
  assert.equal(vis[0].change, 'listing_partial')
  assert.ok(s.feed({ all: true, limit: 5000 }).every((c) => c.change === 'listing_partial' || c.suppressed === 'partial_listing'))
  assert.deepEqual(unstableKinds({ tool_count: 30 }, ok(Array(100).fill(tool('t', 'x')))), ['tool'])
  assert.deepEqual(unstableKinds({ tool_count: 30 }, ok(Array(35).fill(tool('t', 'x')))), [])
})

test('volatile counters: cosmetic, first per item per day shown, not counted in changes24h', () => {
  const s = fresh('io.x/jobs')
  const d = (n) => [tool('search_jobs', `Search ${n}+ remote jobs.`)]
  probe(s, 'io.x/jobs', E, ok(d('131,782')))
  probe(s, 'io.x/jobs', E + 1, ok(d('131,786')))
  probe(s, 'io.x/jobs', E + 2, ok(d('131,966')))
  const vis = s.feed()
  assert.equal(vis.length, 1); assert.equal(vis[0].label, 'cosmetic'); assert.equal(vis[0].volatile, 1)
  assert.equal(s.feed({ all: true }).filter((c) => c.suppressed === 'volatile_repeat').length, 1)
  assert.equal(Object.values(s.changesSince(0)).reduce((a, b) => a + b, 0), 0)
})

test('all tools vanished: one server-level entry; single removals are cosmetic', () => {
  const s = fresh('io.x/gone')
  probe(s, 'io.x/gone', E, ok([tool('a', 'A.'), tool('b', 'B.'), tool('c', 'C.')]))
  probe(s, 'io.x/gone', E + 1, ok([tool('a', 'A.'), tool('b', 'B.')]))
  assert.equal(s.feed()[0].label, 'cosmetic'); assert.equal(s.feed()[0].score, 2)
  probe(s, 'io.x/gone', E + 2, ok([]))
  const vis = s.feed()
  assert.equal(vis[0].change, 'all_tools_removed'); assert.equal(vis[0].label, 'behavior')
  assert.equal(s.feed({ all: true }).filter((c) => c.suppressed === 'rolled_up').length, 2)
})

test('migration: re-scores old rows, hides flaps / churn, keeps on-chain flag history with a revised note', () => {
  const s = openStore({ memory: true })
  const put = (o) => s.putChange({ epoch: E, at: T, subject: 'x', kind: 'tool', change: 'removed', score: 20, label: 'behavior', reasons: [{ code: 'removed', points: 20 }], ...o })
  for (let i = 0; i < 25; i++) { put({ subject: 'rot', itemId: `rot#resource:a${i}`, kind: 'resource', change: 'added', newHash: `0xa${i}`, score: 5, label: 'cosmetic', newBody: { uri: `a${i}` } }); put({ subject: 'rot', itemId: `rot#resource:b${i}`, kind: 'resource', oldHash: `0xb${i}`, oldBody: { uri: `b${i}` } }) }
  put({ itemId: 'x#tool:t', oldHash: '0x1', oldBody: { name: 't' } })
  const pk = { eco: 'pypi', version: '3.14.776', integrity: 'sha256:aa', integrityHash: '0x10', maintainers: ['m'], sha256s: ['aa'] }
  const id1 = put({ epoch: E + 1, subject: 'pypi:s', itemId: 'pypi:s#package', kind: 'package', change: 'changed', oldHash: '0xA', newHash: '0xB', score: 60, label: 'suspicious', reasons: [{ code: 'same_version_new_bytes', points: 60 }],
    oldBody: pk, newBody: { ...pk, integrityHash: '0x11', sha256s: ['aa', 'bb'] } })
  s.setFlag(id1, 'confirmed', '0xflagtx', null)
  const before = summary(s.db)
  const r = rescoreAll(s, { log: { log() {} } })
  assert.equal(before.removedBehavior, 26)
  assert.equal(r.after.removedBehavior, 0)
  assert.equal(r.after.suppressed.partial_listing, 50)
  const f = s.getChange(id1)
  assert.equal(f.label, 'cosmetic'); assert.equal(f.orig_label, 'suspicious'); assert.match(f.revised_note, /on-chain flag for epoch 497901 .* kept as history/)
  assert.equal(rescoreAll(s), null, 'runs once per scorer version')
  // API exposes the revision and the flag list
  const api = createApi({ store: s, log: { error() {} } })
  let body
  const res = { writeHead() {}, end(x) { body = JSON.parse(x) } }
  return api({ method: 'GET', url: '/api/flags', headers: {}, socket: {} }, res).then(() => {
    assert.equal(body.flags[0].revisedLabel, 'cosmetic'); assert.equal(body.flags[0].originalLabel, 'suspicious'); assert.match(body.flags[0].revisedNote, /kept as history/)
  })
})

test('grouped feed: one entry per server per epoch', async () => {
  const s = fresh('io.x/g')
  probe(s, 'io.x/g', E, ok([tool('a', 'A.'), tool('b', 'B.')]))
  probe(s, 'io.x/g', E + 1, ok([tool('a', 'A changed a lot here.'), tool('b', 'B changed a lot too.'), tool('c', 'C new.')]))
  const api = createApi({ store: s, log: { error() {} } })
  let body
  const res = { writeHead() {}, end(x) { body = JSON.parse(x) } }
  await api({ method: 'GET', url: '/api/feed?group=1', headers: {}, socket: {} }, res)
  assert.equal(body.groups.length, 1); assert.equal(body.groups[0].count, 3); assert.equal(body.groups[0].subject, 'io.x/g')
  await api({ method: 'GET', url: '/api/feed?minLabel=behavior', headers: {}, socket: {} }, res)
  assert.ok(body.changes.every((c) => c.score >= 20))
})
