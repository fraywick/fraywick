// /feed: dense change log (filters, live refresh, older pages) + 3D integrity swatches for recently changed items.
import { h, nf, short, fmtUtc, epochDate, txUrl, arrow } from '/shared/site.js'
import { getFeed, getStats, serverHref } from '/shared/api.js'
import { mountCheck, chip } from '/shared/checkbox.js'
import { visible } from '/shared/ui.js'
import { itemName } from '/shared/proofkit.js'

const Q = new URLSearchParams(location.search)
const form = document.getElementById('check')
form.addEventListener('submit', (e) => { e.preventDefault(); const t = form.querySelector('input').value.trim(); if (t) location.href = `/check/?t=${encodeURIComponent(t)}` }, true)
void mountCheck
const tbody = document.querySelector('#tbl tbody')
const state = document.getElementById('state'), more = document.getElementById('more'), live = document.getElementById('live')
let mode = ['suspicious', 'behavior', 'cosmetic', 'all'].includes(Q.get('label')) ? Q.get('label') : 'min', cursor = null, seen = new Set()
const epochOnly = Q.get('epoch') ? Number(Q.get('epoch')) : null
if (epochOnly) { const p = document.getElementById('epoch-filter'); p.hidden = false; p.append(`Showing changes detected in epoch ${nf(epochOnly)} (${fmtUtc(epochDate(epochOnly), { date: true })}). `, h('a', { href: '/feed/' }, 'Show all')) }

// one row per server per hour (group=1); every changed tool links to its proof page
function row(g, fresh) {
  const when = g.at || epochDate(g.epoch)
  const shown = g.changes.slice(0, 3)
  const extra = g.count - shown.length
  const what = h('td', { class: 'name' })
  shown.forEach((c, i) => {
    if (i) what.append(', ')
    const n = c.tool || itemName(c.rawItem, c.itemId) || c.change
    what.append(h('a', { href: `/change/?id=${c.raw.id}`, title: `${c.change} · ${c.label || ''} ${c.score ?? ''}` }, visible(n)), c.change !== 'changed' ? h('span', { class: 'faint' }, ` (${c.change})`) : '')
  })
  if (extra > 0) what.append(h('span', { class: 'faint' }, ` +${extra}`))
  return h('tr', { class: fresh ? 'fresh' : null },
    h('td', { class: 'name', title: g.subject }, h('a', { href: serverHref(g.subject) }, visible(g.subject))),
    what,
    h('td', { class: 'nw' }, fmtUtc(when).replace(' UTC', ''), h('span', { class: 'faint' }, ' ' + new Date(when).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }))),
    h('td', null, chip(g.label)),
    h('td', { class: 'nw' }, g.epoch != null ? h('a', { href: `/proof/#e${g.epoch}` }, nf(g.epoch)) : '—'),
    h('td', { class: 'nw tx' }, g.tx ? h('a', { href: txUrl(g.tx), target: '_blank', rel: 'noopener', title: 'anchor transaction' }, short(g.tx, 4)) : h('span', { class: 'faint', title: 'anchored at the next :05' }, 'pending')))
}
const qOf = () => (mode === 'min' ? { minLabel: 'behavior' } : mode === 'all' ? {} : { label: mode })
async function load(reset) {
  if (reset) { tbody.textContent = ''; cursor = null; seen = new Set() }
  state.hidden = true
  try {
    const r = await getFeed({ cursor, ...qOf(), group: true, limit: epochOnly ? 100 : 40 })
    let groups = r.groups || []
    if (epochOnly) groups = groups.filter((g) => g.epoch === epochOnly)
    for (const g of groups) { if (seen.has(g.id)) continue; seen.add(g.id); tbody.append(row(g)) }
    cursor = r.next
    more.hidden = !cursor || !!epochOnly
    if (!tbody.children.length) { state.hidden = false; state.textContent = mode === 'min' ? 'No behavior or suspicious changes recorded yet.' : 'No changes for this filter yet.' }
    if (reset) swatches(groups)
  } catch (e) {
    state.hidden = false; state.textContent = 'The feed API is not reachable right now.'; state.classList.add('err')
  }
}
async function refresh() {
  if (cursor === undefined || epochOnly) return
  try {
    const r = await getFeed({ ...qOf(), group: true, limit: 20 })
    const fresh = (r.groups || []).filter((g) => !seen.has(g.id))
    for (const g of fresh.reverse()) { seen.add(g.id); tbody.prepend(row(g, true)) }
    if (fresh.length) { state.hidden = true; swatches(r.groups) }
    live.textContent = `live · ${fmtUtc(new Date())}`
  } catch { live.textContent = 'offline' }
}

document.querySelectorAll('.filters button').forEach((b) => {
  b.setAttribute('aria-pressed', String(b.dataset.q === mode))
  b.addEventListener('click', () => {
    mode = b.dataset.q
    document.querySelectorAll('.filters button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
    const u = new URL(location.href); if (mode !== 'min') u.searchParams.set('label', mode); else u.searchParams.delete('label'); history.replaceState(null, '', u)
    load(true)
  })
})
more.addEventListener('click', () => load(false))

// swatches: one per recently changed item
let sw = null, swLast = ''
async function swatches(items) {
  const uniq = new Map()
  for (const c of items) if (c.itemId && c.label && !uniq.has(c.itemId)) uniq.set(c.itemId, { name: c.name || c.itemId, label: c.label, href: c.changes?.[0] ? `/change/?id=${c.changes[0].raw.id}` : serverHref(c.itemId) })
  const list = [...uniq.values()].slice(0, 12)
  const key = list.map((x) => x.href + x.label).join('|')
  if (key === swLast) return
  swLast = key
  const grid = document.getElementById('sw-grid'), canvas = document.getElementById('sw-gl')
  if (!list.length) { grid.textContent = ''; grid.append(h('p', { class: 'sw-empty' }, 'No changed items yet.')); return }
  if (!sw) {
    try { const m = await import('./swatches.js'); sw = m.createSwatches(canvas, grid) } catch (e) { console.warn('swatches off', e.message) }
  }
  const place = () => { const r = grid.getBoundingClientRect(), p = grid.parentElement.getBoundingClientRect(); Object.assign(canvas.style, { left: `${r.left - p.left}px`, top: `${r.top - p.top}px`, width: `${r.width}px`, height: `${r.height}px` }) }
  if (sw) { sw.set(list); place(); addEventListener('resize', place) }
  else { grid.textContent = ''; for (const x of list) grid.append(h('a', { class: `sw ${x.label}`, href: x.href }, h('span', { class: 'nm' }, x.name), h('span', { class: 'cap' }, x.label))) }
}

getStats().then((s) => {
  const n = s.noise24h
  if (n) {
    const p = document.getElementById('noise'); p.hidden = false
    const parts = [['partial_listing', 'partial listings'], ['flap', 'flaps'], ['volatile', 'volatile'], ['volatile_repeat', 'volatile repeats']].filter(([k]) => n[k]).map(([k, l]) => `${l} ${nf(n[k])}`)
    p.textContent = `Last 24 h: ${nf(s.changes24h)} real changes (${nf(s.byLabel24h?.cosmetic)} cosmetic, ${nf(s.byLabel24h?.behavior)} behavior, ${nf(s.byLabel24h?.suspicious)} suspicious); this list shows behavior and up unless you pick otherwise. Hidden as noise: ${parts.join(' · ') || 'none'}. `
    p.append(h('a', { href: '/docs/#scoring' }, 'What counts as noise'))
  }
  if (s.lastEpoch != null) document.getElementById('statusbar').textContent = `anchored on Robinhood Chain · epoch ${nf(s.lastEpoch)}` }).catch(() => {})
await load(true)
setInterval(refresh, 30000)
