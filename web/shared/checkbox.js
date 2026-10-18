// The check box (landing + /check): POST /api/check and a short verdict. Works without JS as a GET form to /check/?t=…
import { h, short, nf, fmtUtc, epochDate, txUrl, arrow, ICON } from './site.js'
import { postCheck, targetKind, checkHref, serverHref } from './api.js'

export const LABEL_TEXT = { cosmetic: 'cosmetic', behavior: 'behavior', suspicious: 'suspicious' }
export const chip = (label) => h('span', { class: `chip ${label || 'none'}` }, label ? LABEL_TEXT[label] : 'no label')

export function mountCheck(form, out, { full = false, onResult } = {}) {
  const input = form.querySelector('input')
  const btn = form.querySelector('button')
  const hint = form.parentElement.querySelector('[data-hint]')
  const updHint = () => { if (hint) { const k = targetKind(input.value); hint.textContent = k ? `reads as: ${k}` : '' } }
  input.addEventListener('input', updHint)
  let busy = false
  async function run(t) {
    t = String(t || '').trim()
    if (!t || busy) return
    if (t.length > 600) { show(h('p', { class: 'v-err' }, 'That is longer than any URL we accept.')); return }
    busy = true; btn.disabled = true; form.classList.add('busy')
    btn.dataset.label ||= btn.textContent
    btn.textContent = 'Checking…'
    show(h('p', { class: 'v-wait' }, 'Fetching the live definition and comparing it with the last anchor…'))
    try {
      const r = await postCheck(t)
      show(full ? null : summary(r, t))
      onResult && onResult(r, t)
    } catch (e) {
      show(h('p', { class: 'v-err' }, e.name === 'AbortError' ? 'The check timed out. The target may be slow or unreachable.' : 'The check service is not reachable right now. Try again in a minute.'))
    } finally { busy = false; btn.disabled = false; btn.textContent = btn.dataset.label; form.classList.remove('busy') }
  }
  function show(node) { out.textContent = ''; if (node) out.append(node); out.hidden = !node }
  form.addEventListener('submit', (e) => { e.preventDefault(); run(input.value) })
  return { run, input, show }
}

// one-glance verdict under the landing headline
export function summary(r, t) {
  const more = h('a', { class: 'v-more', href: checkHref(t) }, r.status === 'changed' ? 'See the diff →' : 'Full detail →')
  const name = r.itemId || r.target || t
  if (r.status === 'error' || r.error) return h('div', { class: 'v v-error' }, h('p', null, h('b', null, 'Could not check this. '), String(r.error || r.note || 'Unknown error.')))
  if (r.status === 'unknown' || r.known === false) {
    const cur = r.current || {}
    return h('div', { class: 'v v-unknown' },
      h('p', null, h('b', null, 'Not in an anchor yet. '), 'We hashed it just now', cur.hash ? [': ', h('code', null, short(cur.hash, 6))] : '', cur.tools != null ? ` (${nf(cur.tools)} tools)` : '', '.'),
      more)
  }
  const anc = r.anchored || {}
  const ep = anc.epoch
  const proofBits = ep != null ? [' · epoch ', h('a', { href: `/proof/#e${ep}` }, nf(ep)), ' · ', fmtUtc(epochDate(ep))] : []
  const tx = anc.tx ? [' · ', h('a', { href: txUrl(anc.tx), target: '_blank', rel: 'noopener' }, 'tx', arrow())] : []
  if (r.status === 'unchanged') {
    return h('div', { class: 'v v-ok' },
      h('p', null, h('span', { class: 'v-ic ok', html: ICON.check }), h('b', null, 'Matches the last anchor. '), h('a', { href: serverHref(name) }, name)),
      h('p', { class: 'v-meta' }, 'hash ', h('code', null, short((r.current || {}).hash || anc.hash, 6)), proofBits, tx),
      more)
  }
  const reasons = r.reasons || []
  return h('div', { class: `v v-changed ${r.label || ''}` },
    h('p', null, chip(r.label), h('b', null, ' Changed since the last anchor. '), h('a', { href: serverHref(name) }, name)),
    h('p', { class: 'v-meta' }, 'score ', h('b', null, r.score != null ? `${r.score}/100` : '—'), reasons.length ? [' · ', reasons[0].text, reasons.length > 1 ? ` (+${reasons.length - 1} more)` : ''] : '', proofBits, tx),
    more)
}
