// Diff engine: apply one observation of a subject (server / skill / package) to the item store and record changes.
// Compares every item hash with the last observed state (not just the previous epoch, so a server that was down for a few hours
// does not produce "removed" + "added" noise). Only the kinds that were actually read are compared (a prompts list that failed
// to load is not "all prompts removed"). The very first observation of a subject is the baseline: no change records.
import { scoreChange } from './score.mjs'
import { diffViews } from './diff.mjs'

export const itemId = (subject, kind, name) => (kind === 'skill' || kind === 'package' ? `${subject}#${kind}` : `${subject}#${kind}:${name}`)

/**
 * observe(store, { subject, epoch, at, kinds: ['tool', …], items: [{ kind, name, hash, body }], scoreBody? })
 * → { added, removed, changed, unchanged, changes: [change rows] }
 */
export function observe(store, { subject, epoch, at = Date.now(), kinds, items, baseline = null }) {
  const existing = store.itemsOf(subject, { bodies: false })
  const bodyOf = (r) => store.versionByHash(r.id, r.hash)?.body ?? null
  const byId = new Map(existing.map((r) => [r.id, r]))
  const isBaseline = baseline ?? existing.length === 0
  const seen = new Set()
  const out = { added: 0, removed: 0, changed: 0, unchanged: 0, changes: [] }
  const record = (c) => {
    const s = scoreChange({ kind: c.kind, change: c.change, old: c.oldBody, new: c.newBody })
    const diff = c.change === 'changed' ? diffViews(c.oldBody, c.newBody) : null
    const row = { epoch, at, subject, itemId: c.id, kind: c.kind, change: c.change, oldHash: c.oldHash, newHash: c.newHash, oldBody: c.oldBody, newBody: c.newBody, diff, ...s }
    row.id = store.putChange(row)
    out.changes.push(row)
  }
  store.tx(() => {
    const dup = new Map()
    for (const it of items) {
      let id = itemId(subject, it.kind, it.name)
      if (seen.has(id)) { const n = (dup.get(id) || 1) + 1; dup.set(id, n); id = `${id}~${n}` }
      seen.add(id)
      const prev = byId.get(id)
      store.putItem({ id, subject, kind: it.kind, name: it.name ?? null, hash: it.hash, body: it.body }, epoch)
      if (!prev) { out.added++; if (!isBaseline) record({ id, kind: it.kind, change: 'added', oldHash: null, newHash: it.hash, oldBody: null, newBody: it.body }) }
      else if (prev.removed_epoch != null) { out.added++; record({ id, kind: it.kind, change: prev.hash === it.hash ? 'added' : 'changed', oldHash: prev.hash, newHash: it.hash, oldBody: prev.hash === it.hash ? null : bodyOf(prev), newBody: it.body }) }
      else if (prev.hash !== it.hash) { out.changed++; record({ id, kind: it.kind, change: 'changed', oldHash: prev.hash, newHash: it.hash, oldBody: bodyOf(prev), newBody: it.body }) }
      else out.unchanged++
    }
    for (const r of existing) {
      if (r.removed_epoch != null || seen.has(r.id) || !kinds.includes(r.kind)) continue
      store.removeItem(r.id, epoch)
      out.removed++
      record({ id: r.id, kind: r.kind, change: 'removed', oldHash: r.hash, newHash: null, oldBody: bodyOf(r), newBody: null })
    }
  })
  return out
}
