// Diff engine: apply one observation of a subject (server / skill / package) to the item store and record changes.
// Compares every item hash with the last observed state (not just the previous epoch, so a server that was down for a few hours
// does not produce "removed" + "added" noise). Only the kinds that were actually read are compared (a prompts list that failed
// to load is not "all prompts removed"). The very first observation of a subject is the baseline: no change records.
// Noise control (scorer v2): hashes and leaves are never touched; only what the feed shows changes.
//   partialKinds  a list that was truncated (page / item cap) or swung wildly in size: no item-level added / removed for that kind,
//                 at most one server-level "listing_partial" note per 24 h
//   flap          an item returning to a hash it had within 24 h (removed → re-added, A → B → A): both changes are suppressed
//   volatile      only numbers / dates / list order changed: cosmetic, and only the first one per item per UTC day is shown
//   rolled_up     every tool of a server vanished at once: one server-level "all_tools_removed" entry instead of N removals
import { scoreChange, SCORER_VERSION } from './score.mjs'
import { diffViews } from './diff.mjs'
import { readObject } from './objects.mjs'

export const itemId = (subject, kind, name) => (kind === 'skill' || kind === 'package' ? `${subject}#${kind}` : `${subject}#${kind}:${name}`)
export const FLAP_EPOCHS = 24
const DAY = 86_400_000

/** stored body of an item version; package bodies get their integrity text from the objects store when filenames are missing */
function bodyOf(store, r) {
  const b = store.versionByHash(r.id, r.hash)?.body ?? null
  if (b && r.kind === 'package' && !b.files && b.integrityHash && !b.integrityText) {
    const t = readObject(b.integrityHash, 'txt')
    if (t) return { ...b, integrityText: t }
  }
  return b
}

/** score + classify one change row (shared with the re-score migration) */
export function classify(c) {
  const s = scoreChange({ kind: c.kind, change: c.change, old: c.oldBody, new: c.newBody })
  return { ...s, volatile: s.reasons.some((r) => r.code === 'volatile') }
}

/**
 * observe(store, { subject, epoch, at, kinds: ['tool', …], items: [{ kind, name, hash, body }], baseline?, partialKinds? })
 * → { added, removed, changed, unchanged, suppressed, changes: [visible change rows] }
 */
export function observe(store, { subject, epoch, at = Date.now(), kinds, items, baseline = null, partialKinds = [] }) {
  const existing = store.itemsOf(subject, { bodies: false })
  const byId = new Map(existing.map((r) => [r.id, r]))
  const isBaseline = baseline ?? existing.length === 0
  const partial = new Set(partialKinds)
  const seen = new Set()
  const out = { added: 0, removed: 0, changed: 0, unchanged: 0, suppressed: 0, changes: [] }
  const dayStart = Math.floor(at / DAY) * DAY
  const record = (c, { suppressed = null } = {}) => {
    const s = classify(c)
    if (!suppressed && s.volatile && store.volatileOnDay(c.id, dayStart, dayStart + DAY)) suppressed = 'volatile_repeat'
    const diff = c.change === 'changed' ? diffViews(c.oldBody, c.newBody) : null
    const row = { epoch, at, subject, itemId: c.id, kind: c.kind, change: c.change, oldHash: c.oldHash, newHash: c.newHash, oldBody: c.oldBody, newBody: c.newBody, diff, ...s, suppressed, scorer: SCORER_VERSION }
    row.id = store.putChange(row)
    if (suppressed) out.suppressed++
    else out.changes.push(row)
    return row
  }
  /** returning to a hash seen within FLAP_EPOCHS: hide this change and the one that moved away from that hash */
  const flapOf = (id, hash, prev) => {
    const back = (prev.removed_epoch != null && prev.hash === hash && prev.removed_epoch >= epoch - FLAP_EPOCHS) ||
      (prev.hash !== hash && store.recentVersion(id, hash, epoch - FLAP_EPOCHS))
    if (!back) return false
    const away = store.leaving(id, hash, epoch - FLAP_EPOCHS)
    if (away) { if (store.setSuppressed(away.id, 'flap')) { out.suppressed++; out.changes = out.changes.filter((x) => x.id !== away.id) } }
    return true
  }
  store.tx(() => {
    const dup = new Map()
    const removedRows = []
    for (const it of items) {
      let id = itemId(subject, it.kind, it.name)
      if (seen.has(id)) { const n = (dup.get(id) || 1) + 1; dup.set(id, n); id = `${id}~${n}` }
      seen.add(id)
      const prev = byId.get(id)
      const flap = prev && (prev.removed_epoch != null || prev.hash !== it.hash) ? flapOf(id, it.hash, prev) : false
      const oldBody = prev && prev.hash !== it.hash ? bodyOf(store, prev) : null
      store.putItem({ id, subject, kind: it.kind, name: it.name ?? null, hash: it.hash, body: it.body }, epoch)
      if (!prev) {
        out.added++
        if (!isBaseline) record({ id, kind: it.kind, change: 'added', oldHash: null, newHash: it.hash, oldBody: null, newBody: it.body }, { suppressed: partial.has(it.kind) ? 'partial_listing' : null })
      } else if (prev.removed_epoch != null) {
        out.added++
        const same = prev.hash === it.hash
        record({ id, kind: it.kind, change: same ? 'added' : 'changed', oldHash: prev.hash, newHash: it.hash, oldBody: same ? null : oldBody, newBody: it.body },
          { suppressed: flap ? 'flap' : partial.has(it.kind) ? 'partial_listing' : null })
      } else if (prev.hash !== it.hash) {
        out.changed++
        record({ id, kind: it.kind, change: 'changed', oldHash: prev.hash, newHash: it.hash, oldBody, newBody: it.body }, { suppressed: flap ? 'flap' : null })
      } else out.unchanged++
    }
    for (const r of existing) {
      if (r.removed_epoch != null || seen.has(r.id) || !kinds.includes(r.kind) || partial.has(r.kind)) continue
      store.removeItem(r.id, epoch)
      out.removed++
      removedRows.push(record({ id: r.id, kind: r.kind, change: 'removed', oldHash: r.hash, newHash: null, oldBody: bodyOf(store, r), newBody: null }))
    }
    // every tool vanished at once (and the server answered): one server-level entry
    const liveToolsBefore = existing.filter((r) => r.kind === 'tool' && r.removed_epoch == null).length
    const toolsNow = items.filter((i) => i.kind === 'tool').length
    if (kinds.includes('tool') && !partial.has('tool') && liveToolsBefore >= 2 && toolsNow === 0) {
      for (const r of removedRows) if (r.kind === 'tool' && store.setSuppressed(r.id, 'rolled_up')) { out.suppressed++; out.changes = out.changes.filter((x) => x.id !== r.id) }
      const row = { epoch, at, subject, itemId: `${subject}#server`, kind: 'server', change: 'all_tools_removed', score: 20, label: 'behavior',
        reasons: [{ code: 'all_tools_removed', points: 20, detail: `all ${liveToolsBefore} tools disappeared from tools/list` }], scorer: SCORER_VERSION }
      row.id = store.putChange(row)
      out.changes.push(row)
    }
  })
  return out
}

/** one "listing is partial / unstable" note per server per 24 h (hidden kinds are named in the reason) */
export function notePartial(store, { subject, epoch, at = Date.now(), kinds, detail }) {
  if (store.lastNote(subject, 'listing_partial', epoch - FLAP_EPOCHS)) return null
  const row = { epoch, at, subject, itemId: `${subject}#server`, kind: 'server', change: 'listing_partial', score: 0, label: 'cosmetic',
    reasons: [{ code: 'listing_partial', points: 0, detail: `${kinds.join(', ')} list ${detail}; item-level added / removed are not reported for it` }], scorer: SCORER_VERSION }
  row.id = store.putChange(row)
  return row
}
