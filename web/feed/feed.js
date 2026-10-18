// /feed: dense change log (filters, live refresh, older pages) + 3D integrity swatches for recently changed items.
import { h, nf, short, fmtUtc, epochDate, txUrl, arrow } from '/shared/site.js'
import { getFeed, getStats, serverHref } from '/shared/api.js'
import { mountCheck, chip } from '/shared/checkbox.js'
import { visible } from '/shared/ui.js'

const Q = new URLSearchParams(location.search)
const form = document.getElementById('check')
form.addEventListener('submit', (e) => { e.preventDefault(); const t = form.querySelector('input').value.trim(); if (t) location.href = `/check/?t=${encodeURIComponent(t)}` }, true)
void mountCheck
const tbody = document.querySelector('#tbl tbody')
const state = document.getElementById('state'), more = document.getElementById('more'), live = document.getElementById('live')
let label = Q.get('label') || '', cursor = null, seen = new Set()
const epochOnly = Q.get('epoch') ? Number(Q.get('epoch')) : null
if (epochOnly) { const p = document.getElementById('epoch-filter'); p.hidden = false; p.append(`Showing changes detected in epoch ${nf(epochOnly)} (${fmtUtc(epochDate(epochOnly), { date: true })}). `, h('a', { href: '/feed/' }, 'Show all')) }

function row(c, fresh) {
  const tr = h('tr', { class: fresh ? 'fresh' : null },
    h('td', { class: 'name', title: c.itemId || '' }, h('a', { href: serverHref(c.itemId) }, visible(c.name || c.itemId || '—'))),
    h('td', { class: 'name' }, c.tool ? visible(c.tool) : h('span', { class: 'faint' }, c.change === 'changed' ? '—' : c.change)),
    h('td', { class: 'nw' }, fmtUtc(c.at || epochDate(c.epoch)).replace(' UTC', ''), h('span', { class: 'faint' }, ' ' + new Date(c.at || epochDate(c.epoch)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }))),
    h('td', null, c.change === 'added' ? h('span', { class: 'chip added' }, 'added') : c.change === 'removed' ? h('span', { class: 'chip removed' }, 'removed') : chip(c.label)),
    h('td', { class: 'nw' }, c.epoch != null ? h('a', { href: `/proof/#e${c.epoch}` }, nf(c.epoch)) : '—'),
    h('td', { class: 'nw tx' }, c.flagTx ? h('a', { href: txUrl(c.flagTx), target: '_blank', rel: 'noopener', title: 'flag() transaction' }, short(c.flagTx, 4)) : c.tx ? h('a', { href: txUrl(c.tx), target: '_blank', rel: 'noopener', title: 'anchor transaction' }, short(c.tx, 4)) : h('span', { class: 'faint', title: 'not anchored yet' }, 'pending')))
  return tr
}

async function load(reset) {
  if (reset) { tbody.textContent = ''; cursor = null; seen = new Set() }
  state.hidden = true
  try {
    const r = await getFeed({ cursor, label, limit: epochOnly ? 200 : 60 })
    let items = r.items
    if (epochOnly) items = items.filter((c) => c.epoch === epochOnly)
    for (const c of items) { if (seen.has(c.id)) continue; seen.add(c.id); tbody.append(row(c)) }
    cursor = r.next
    more.hidden = !cursor || !!epochOnly
    if (!tbody.children.length) { state.hidden = false; state.textContent = label ? `No ${label} changes recorded yet.` : 'No changes recorded yet. Every tracked definition still matches its first hash.' }
    if (reset) swatches(items)
  } catch (e) {
    state.hidden = false; state.textContent = 'The feed API is not reachable right now.'; state.classList.add('err')
  }
}

async function refresh() {
  if (cursor === undefined || epochOnly) return
  try {
    const r = await getFeed({ label, limit: 30 })
    const fresh = r.items.filter((c) => !seen.has(c.id))
    for (const c of fresh.reverse()) { seen.add(c.id); tbody.prepend(row(c, true)) }
    if (fresh.length) { state.hidden = true; swatches(r.items) }
    live.textContent = `live · ${fmtUtc(new Date())}`
  } catch { live.textContent = 'offline' }
}

document.querySelectorAll('.filters button').forEach((b) => {
  if (b.dataset.label === label) document.querySelectorAll('.filters button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
  b.addEventListener('click', () => {
    label = b.dataset.label
    document.querySelectorAll('.filters button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
    const u = new URL(location.href); if (label) u.searchParams.set('label', label); else u.searchParams.delete('label'); history.replaceState(null, '', u)
    load(true)
  })
})
more.addEventListener('click', () => load(false))

// swatches: one per recently changed item
let sw = null, swLast = ''
async function swatches(items) {
  const uniq = new Map()
  for (const c of items) if (c.itemId && c.label && !uniq.has(c.itemId)) uniq.set(c.itemId, { name: c.name || c.itemId, label: c.label, href: serverHref(c.itemId) })
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

getStats().then((s) => { if (s.lastEpoch != null) document.getElementById('statusbar').textContent = `anchored on Robinhood Chain · epoch ${nf(s.lastEpoch)}` }).catch(() => {})
await load(true)
setInterval(refresh, 30000)
