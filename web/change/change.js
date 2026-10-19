// /change/?id=<changeId>: one recorded change, before → after, and both hashes proven against their anchored hours on chain.
import { h, nf, short, fmtUtc, epochDate, txUrl, arrow } from '/shared/site.js'
import { getChange, getAnchors, serverHref } from '/shared/api.js'
import { chip } from '/shared/checkbox.js'
import { diffView, changeDiffs, reasonsList, visible } from '/shared/ui.js'
import { proveSide, itemName, stepList, addStep } from '/shared/proofkit.js'

const id = new URLSearchParams(location.search).get('id')
const title = document.getElementById('title'), body = document.getElementById('body')
const pretty = (t) => { try { return JSON.stringify(JSON.parse(t), null, 2) } catch { return t } }
const nextStamp = () => new Date((Math.floor((Date.now() / 1000 - 300) / 3600) + 1) * 3600e3 + 300e3)

async function main() {
  if (!id || !/^\d+$/.test(id)) { title.textContent = 'No change given'; body.append(h('p', null, 'Open a change from the ', h('a', { href: '/feed/' }, 'feed'), '.')); return }
  let c, anchors = []
  try { [c, { anchors }] = await Promise.all([getChange(id), getAnchors(200)]) } catch (e) { title.textContent = 'API not reachable'; body.append(h('p', { class: 'err' }, e.message)); return }
  if (!c) { title.textContent = `Change ${id} not found`; body.append(h('p', null, 'It may have been removed as noise. ', h('a', { href: '/feed/' }, 'Back to the feed'))); return }
  const subject = c.itemId, kind = c.itemKind || c.kind
  const name = itemName(c.rawItem || c.itemId, subject) || kind
  title.textContent = ''; title.append(visible(name || subject))
  document.title = `${name} changed · FRAYWICK`
  const onChain = anchors.filter((a) => a.onChain !== false && a.tx)
  const oldA = onChain.find((a) => a.epoch < c.epoch) || null
  const newA = onChain.find((a) => a.epoch === (c.anchorEpoch ?? c.epoch)) || null

  body.append(h('p', { class: 'lede' }, `${kind} on `, h('a', { href: serverHref(subject) }, visible(subject)), ` · ${c.change} · detected ${fmtUtc(c.at || epochDate(c.epoch), { date: true })} (epoch ${nf(c.epoch)})`))
  const head = h('div', { class: 'verdict-head' }, chip(c.label), c.score != null ? h('span', { class: 'score' }, 'score ', h('b', null, String(c.score)), '/100') : '')
  if (c.revisedLabel) head.append(h('span', { class: 'muted' }, `revised from ${c.originalLabel} ${c.originalScore ?? ''}`))
  body.append(head)
  if (c.revisedNote) body.append(h('p', { class: 'muted' }, visible(c.revisedNote)))
  if (c.suppressed) body.append(h('p', { class: 'muted' }, `Hidden from the default feed as noise (${c.suppressed}).`))
  const result = h('div', { class: 'card bigresult' }, h('p', { class: 'muted' }, 'Checking both hashes against Robinhood Chain in your browser…'))
  body.append(result)
  body.append(h('h2', { class: 'sec-h' }, 'Why this label'), reasonsList(c.reasons))

  // before / after text, from the exact stored bytes when we have them
  const diffBox = h('div')
  body.append(h('h2', { class: 'sec-h' }, 'Before → after'), h('p', { class: 'muted' }, 'Rendered as plain text. Hidden characters show as red U+ badges.'), diffBox)

  // proofs
  const colOld = h('div', { class: 'card' }), colNew = h('div', { class: 'card' })
  body.append(h('h2', { class: 'sec-h' }, 'Proof on chain'), h('div', { class: 'grid2' }, colOld, colNew))
  const side = (col, label, a, hash, absent) => {
    col.append(h('h3', { style: 'margin-top:0' }, label), h('p', { class: 'muted mono-break' }, hash ? `hash ${hash}` : absent))
    if (!a) { col.append(h('p', null, label.startsWith('After') ? `Not anchored yet. It goes into the root posted at about ${fmtUtc(nextStamp())}.` : 'No earlier anchored hour.')); return Promise.resolve(null) }
    col.append(h('p', null, `epoch ${nf(a.epoch)} · ${fmtUtc(epochDate(a.epoch), { date: true })} · `, h('a', { href: txUrl(a.tx), target: '_blank', rel: 'noopener' }, 'anchor tx', arrow())))
    const ul = stepList(); col.append(ul)
    return proveSide({ subject, kind, name, hash, epoch: a.epoch, tx: a.tx }, (s) => addStep(ul, s)).then((r) => { col.append(h('p', null, r.ok ? h('b', { class: 'ok' }, '✓ proven on chain') : h('b', { class: 'bad' }, '✗ not proven'))); return r })
  }
  const pOld = side(colOld, `Before · epoch ${oldA ? nf(oldA.epoch) : '—'}`, c.change === 'added' ? oldA : oldA, c.change === 'added' ? null : c.oldHash, `"${name}" did not exist yet`)
  const pNew = side(colNew, `After · epoch ${newA ? nf(newA.epoch) : nf(c.epoch)}`, c.change === 'removed' ? null : newA, c.change === 'removed' ? null : c.newHash, 'removed')
  const [rOld, rNew] = await Promise.all([pOld, pNew])

  // text diff: stored objects first, the change record's own diff as fallback
  const oldTxt = rOld?.object?.text, newTxt = rNew?.object?.text
  if (oldTxt || newTxt) diffBox.append(...[diffView(oldTxt ? pretty(oldTxt) : '', newTxt ? pretty(newTxt) : '', { beforeLabel: oldA ? `epoch ${nf(oldA.epoch)}` : 'before', afterLabel: newA ? `epoch ${nf(newA.epoch)}` : 'after' })].flat())
  else { const d = changeDiffs(c); diffBox.append(...(d.length ? d.flat() : [h('p', { class: 'muted' }, 'No stored text for this change.')])) }

  result.textContent = ''
  const both = rOld?.ok && rNew?.ok && c.change === 'changed'
  if (c.change === 'added' && rOld?.ok && rNew?.ok) result.append(h('p', { class: 'big-ok' }, h('b', { class: 'ok' }, '✓ New item proven on chain.')), h('p', null, `"${name}" is not listed in epoch ${nf(oldA.epoch)} and is listed with hash ${short(c.newHash, 8)} in epoch ${nf(newA.epoch)}; both checked against the chain here.`))
  else if (both) result.append(h('p', { class: 'big-ok' }, h('b', { class: 'ok' }, '✓ Both hashes proven on Robinhood Chain.')),
    h('p', { class: 'mono-break' }, `${short(c.oldHash, 8)} in epoch ${nf(oldA.epoch)} → ${short(c.newHash, 8)} in epoch ${nf(newA.epoch)}. Recomputed here from the stored bytes, the leaf, the merkle path and two eth_calls to the ToolAnchor contract.`))
  else if (!newA) result.append(h('p', null, h('b', null, 'Before proven; after waits for its anchor. '), `The new hash goes on chain at about ${fmtUtc(nextStamp())}.`))
  else result.append(h('p', null, h('b', { class: 'bad' }, 'Not fully proven. '), 'See the steps below; every failed step is marked.'))
}
main()
