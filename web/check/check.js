// /check: full verdict for one target (current hash vs last anchored hash, score + reasons, diff, history, proof).
import { h, nf, short, fmtUtc, epochDate, txUrl, arrow } from '/shared/site.js'
import { serverHref } from '/shared/api.js'
import { mountCheck, chip } from '/shared/checkbox.js'
import { changeDiffs, reasonsList, changeLine, verifyInBrowser, visible } from '/shared/ui.js'

const form = document.getElementById('check')
const full = document.getElementById('full')
const examples = document.getElementById('examples')
const ctl = mountCheck(form, document.getElementById('verdict'), { full: true, onResult: render })

function render(r, t) {
  full.textContent = ''
  examples.hidden = true
  history.replaceState(null, '', `/check/?t=${encodeURIComponent(t)}`)
  if (r.status === 'error' || r.error) {
    full.append(h('div', { class: 'card' }, h('div', { class: 'verdict-head' }, h('span', { class: 'big bad' }, 'Could not check')), h('p', null, visible(String(r.error || r.note || 'Unknown error.')))))
    return
  }
  const cur = r.current || {}, anc = r.anchored || {}
  const name = r.itemId || r.target || t
  const head = h('div', { class: 'verdict-head' })
  if (r.status === 'unknown' || r.known === false) head.append(h('span', { class: 'big' }, 'Not in an anchor yet'))
  else if (r.status === 'unchanged') head.append(h('span', { class: 'big ok' }, 'Matches the anchor'))
  else head.append(h('span', { class: 'big bad' }, 'Changed'), chip(r.label), r.score != null ? h('span', { class: 'score' }, 'score ', h('b', null, String(r.score)), '/100') : '')

  const kv = h('dl', { class: 'kv' },
    h('dt', null, 'target'), h('dd', null, visible(t)),
    r.kind ? [h('dt', null, 'kind'), h('dd', null, r.kind)] : '',
    r.known !== false && r.itemId ? [h('dt', null, 'tracked as'), h('dd', null, h('a', { href: serverHref(r.itemId) }, visible(r.itemId)))] : '',
    cur.version ? [h('dt', null, 'version now'), h('dd', null, visible(cur.version))] : '',
    h('dt', null, 'hash now'), h('dd', null, cur.hash || '—', cur.at ? h('span', { class: 'faint' }, ` · ${fmtUtc(cur.at, { date: true })}`) : '', cur.tools != null ? h('span', { class: 'faint' }, ` · ${nf(cur.tools)} tools`) : ''),
    h('dt', null, 'last anchored'), h('dd', null, anc.hash || '—', anc.epoch != null ? [' · epoch ', h('a', { href: `/proof/#e${anc.epoch}` }, nf(anc.epoch)), ` · ${fmtUtc(epochDate(anc.epoch), { date: true })}`] : '',
      anc.tx ? [' · ', h('a', { href: txUrl(anc.tx), target: '_blank', rel: 'noopener' }, 'tx', arrow())] : ''))
  const card = h('div', { class: 'card' }, head, kv)
  if (r.note) card.append(h('p', { class: 'muted', style: 'margin-top:12px' }, visible(r.note)))
  full.append(card)

  if (r.status === 'changed') {
    full.append(h('h2', { class: 'sec-h' }, 'Why this label'), reasonsList(r.reasons))
    const diffs = changeDiffs(r)
    if (diffs.length) full.append(h('h2', { class: 'sec-h' }, 'Diff'), h('p', { class: 'muted' }, 'Left: last anchored. Right: live now. Hidden characters are shown as red U+ badges.'), ...diffs.flat())
  }
  if (r.items?.length) {
    const tb = h('tbody')
    const order = { changed: 0, new: 1, missing: 2, not_anchored: 3, unchanged: 4 }
    for (const it of [...r.items].sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5))) {
      tb.append(h('tr', null, h('td', { class: 'nw' }, it.kind || ''), h('td', { class: 'name' }, h('b', null, visible(it.name || ''))),
        h('td', { class: 'nw' }, it.status === 'unchanged' ? h('span', { class: 'muted' }, 'matches') : it.status === 'not_anchored' ? h('span', { class: 'muted' }, 'not anchored') : it.status),
        h('td', { class: 'nw' }, it.label && it.status !== 'unchanged' && it.status !== 'not_anchored' ? [chip(it.label), it.score != null ? ` ${it.score}` : ''] : '')))
    }
    full.append(h('h2', { class: 'sec-h' }, `Items (${nf(r.items.length)})`), h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Kind'), h('th', null, 'Name'), h('th', null, 'Status'), h('th', null, 'Label'))), tb)))
  }
  const proof = r.proof || (r.known !== false && r.itemId ? { leafKey: r.itemId, epoch: anc.epoch } : null)
  if (proof && proof.leafKey) {
    const out = h('div', { class: 'verify-out' })
    const btn = h('button', { class: 'btn', type: 'button' }, 'Verify the anchored hash in your browser')
    btn.addEventListener('click', async () => { btn.disabled = true; await verifyInBrowser(proof.leafKey, proof.epoch, out); btn.disabled = false })
    full.append(h('h2', { class: 'sec-h' }, 'Proof'), h('div', { class: 'verify-box' }, btn, h('a', { href: `/proof/#e${proof.epoch ?? ''}` }, 'all anchors')), out)
  }
  if (r.history?.length) full.append(h('h2', { class: 'sec-h' }, 'History'), h('ul', { class: 'tl' }, r.history.map((c) => changeLine(c, { link: false }))))
}

const t0 = new URLSearchParams(location.search).get('t')
if (t0) { ctl.input.value = t0; ctl.run(t0) }
void short; void chip
