// Re-score stored changes after a scorer change (runs once per SCORER_VERSION, at start of either process, in one transaction).
// Hashes, leaves, snapshots and on-chain flags are never touched: only score / label / reasons / suppression of change rows.
// A row whose label changes keeps its original values (orig_score, orig_label) and gets a revised_note, so a change that was already
// flagged on chain is shown with its new label next to the kept on-chain history.
//   node migrate.mjs [--force]      (DATA_DIR as usual)
import { classify, FLAP_EPOCHS } from './observe.mjs'
import { SCORER_VERSION } from './score.mjs'
import { readObject } from './objects.mjs'
import { fileURLToPath } from 'node:url'

const DAY = 86_400_000

export function rescoreAll(store, { log = console, force = false, now = Date.now() } = {}) {
  const db = store.db
  const done = store.kv('scorer_version')
  if (!force && done != null && done >= SCORER_VERSION) return null
  const before = summary(db)
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!force && (store.kv('scorer_version') ?? 0) >= SCORER_VERSION) { db.exec('ROLLBACK'); return null }
    const upd = db.prepare(`UPDATE changes SET score = ?, label = ?, reasons = ?, volatile = ?, suppressed = ?, scorer = ?,
      orig_score = CASE WHEN ? THEN COALESCE(orig_score, score) ELSE orig_score END, orig_label = CASE WHEN ? THEN COALESCE(orig_label, label) ELSE orig_label END,
      revised_note = CASE WHEN ? THEN ? ELSE revised_note END, revised_at = CASE WHEN ? THEN ? ELSE revised_at END WHERE id = ?`)
    const J = store.J
    const enrich = (b) => (b && b.integrityHash && !b.files && !b.integrityText ? { ...b, integrityText: readObject(b.integrityHash, 'txt') || undefined } : b)
    const rows = db.prepare("SELECT id, epoch, at, subject, item_id, kind, change, old_hash, new_hash, old_body, new_body, score, label, flag_status, flag_tx FROM changes WHERE kind <> 'server' ORDER BY id").all()
    // rotating subsets: ≥ 20 added and ≥ 20 removed of one kind for one server in one epoch
    const churn = new Map()
    for (const r of rows) {
      if (r.change !== 'added' && r.change !== 'removed') continue
      const k = `${r.subject}|${r.kind}|${r.epoch}`
      const c = churn.get(k) || { added: 0, removed: 0 }
      c[r.change]++; churn.set(k, c)
    }
    const partialKey = new Set([...churn].filter(([, c]) => c.added >= 20 && c.removed >= 20).map(([k]) => k))
    const state = new Map()      // id → { suppressed, label, ... } decided so far
    const history = new Map()    // item → [{ id, epoch, old, new }] visible rows
    const volDay = new Set()
    let revised = 0
    for (const r of rows) {
      const oldBody = r.kind === 'package' ? enrich(J(r.old_body)) : J(r.old_body)
      const newBody = r.kind === 'package' ? enrich(J(r.new_body)) : J(r.new_body)
      const s = classify({ kind: r.kind, change: r.change, oldBody, newBody })
      let suppressed = null
      if ((r.change === 'added' || r.change === 'removed') && partialKey.has(`${r.subject}|${r.kind}|${r.epoch}`)) suppressed = 'partial_listing'
      const h = history.get(r.item_id) || []
      if (!suppressed && r.new_hash) {
        const away = [...h].reverse().find((x) => x.old === r.new_hash && x.epoch >= r.epoch - FLAP_EPOCHS && !state.get(x.id)?.suppressed)
        if (away) { suppressed = 'flap'; state.get(away.id).suppressed = 'flap' }
      }
      if (!suppressed && s.volatile) {
        const k = `${r.item_id}|${Math.floor(r.at / DAY)}`
        if (volDay.has(k)) suppressed = 'volatile_repeat'
        else volDay.add(k)
      }
      state.set(r.id, { ...s, suppressed, row: r })
      if (!suppressed) { h.push({ id: r.id, epoch: r.epoch, old: r.old_hash, new: r.new_hash }); history.set(r.item_id, h) }
    }
    for (const [id, x] of state) {
      const r = x.row
      const relabel = x.label !== r.label
      if (relabel) revised++
      const note = relabel ? `re-scored after a scorer fix (v${SCORER_VERSION}): ${r.label} ${r.score} → ${x.label} ${x.score}` +
        (r.flag_status === 'confirmed' || r.flag_status === 'sent' ? `; the on-chain flag for epoch ${r.epoch} (tx ${r.flag_tx}) is kept as history` : '') : null
      upd.run(x.score, x.label, JSON.stringify(x.reasons), x.volatile ? 1 : 0, x.suppressed, SCORER_VERSION, relabel ? 1 : 0, relabel ? 1 : 0, relabel ? 1 : 0, note, relabel ? 1 : 0, now, id)
    }
    store.kv('scorer_version', SCORER_VERSION)
    db.exec('COMMIT')
    const after = summary(db)
    log.log?.(`migrate: re-scored ${rows.length} changes with scorer v${SCORER_VERSION} (${revised} relabelled) · visible ${before.visible} → ${after.visible}`)
    return { rows: rows.length, revised, before, after }
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

export function summary(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(changes)').all().map((c) => c.name))
  const vis = cols.has('suppressed') ? 'suppressed IS NULL' : '1'
  const nonVol = cols.has('volatile') ? 'COALESCE(volatile, 0) = 0' : '1'
  const one = (sql) => db.prepare(sql).get().n
  return {
    total: one('SELECT COUNT(*) n FROM changes'),
    visible: one(`SELECT COUNT(*) n FROM changes WHERE ${vis}`),
    visibleNonVolatile: one(`SELECT COUNT(*) n FROM changes WHERE ${vis} AND ${nonVol}`),
    byLabel: Object.fromEntries(db.prepare(`SELECT label, COUNT(*) n FROM changes WHERE ${vis} GROUP BY label`).all().map((r) => [r.label, r.n])),
    suppressed: cols.has('suppressed') ? Object.fromEntries(db.prepare('SELECT suppressed k, COUNT(*) n FROM changes WHERE suppressed IS NOT NULL GROUP BY k').all().map((r) => [r.k, r.n])) : {},
    removedBehavior: one(`SELECT COUNT(*) n FROM changes WHERE change = 'removed' AND label <> 'cosmetic' AND ${vis}`),
    suspicious: db.prepare(`SELECT item_id, epoch, score FROM changes WHERE label = 'suspicious' AND ${vis}`).all().map((r) => `${r.item_id}@${r.epoch}:${r.score}`),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { openStore } = await import('./store.mjs')
  const store = openStore()
  const r = rescoreAll(store, { force: process.argv.includes('--force') })
  console.log(JSON.stringify(r ?? { skipped: 'already at scorer v' + SCORER_VERSION }, null, 2))
  store.close()
}
